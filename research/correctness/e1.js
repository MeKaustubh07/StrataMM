#!/usr/bin/env node
'use strict';

// E1: exact differential trials of base() vs dgemm.ndarray (research protocol §5.3; 100,000 trials, --tiny: 2,000),
// sharded over 4 processes; appends one `e1` record to research/data/<campaign>/e1.jsonl. Usage:
//
//   node research/correctness/e1.js --campaign <id> [--tiny] [--trials n] [--procs 4] [--master-seed s] [--data-root d]
//
// Exit code: 0 = all trials agree; 1 = a mismatch or an input mutation (a library bug), or an error.
// A partial last line of e1.jsonl (an interrupted write) is newline-terminated before the append (records.repairTail).

// MODULES //

var fork = require( 'child_process' ).fork;
var path = require( 'path' );
var paths = require( './../accuracy/paths.js' );
var records = require( './../accuracy/records.js' );
var trial = require( './e1_trial.js' );


// VARIABLES //

var MAX_EXAMPLES = 5;


// FUNCTIONS //

function fail( msg ) {
	console.error( 'E1 ERROR: ' + msg );
	process.exit( 1 );
}

/**
* Parses command-line arguments.
*
* @private
* @param {Array<string>} argv - arguments
* @returns {Object} options
*/
function parseArgs( argv ) {
	var o = {
		'campaign': null,
		'tiny': false,
		'trials': null,
		'procs': 4,
		'masterSeed': null,
		'dataRoot': paths.DATA,
		'worker': false,
		'shard': 0
	};
	var a;
	var i;
	for ( i = 0; i < argv.length; i++ ) {
		a = argv[ i ];
		if ( a === '--tiny' ) {
			o.tiny = true;
		} else if ( a === '--worker' ) {
			o.worker = true;
		} else if ( a === '--campaign' ) {
			o.campaign = argv[ ++i ];
		} else if ( a === '--trials' ) {
			o.trials = Number( argv[ ++i ] );
		} else if ( a === '--procs' ) {
			o.procs = Number( argv[ ++i ] );
		} else if ( a === '--shard' ) {
			o.shard = Number( argv[ ++i ] );
		} else if ( a === '--master-seed' ) {
			o.masterSeed = Number( argv[ ++i ] );
		} else if ( a === '--data-root' ) {
			o.dataRoot = path.resolve( argv[ ++i ] );
		} else if ( a === '--help' || a === '-h' ) {
			console.log( 'usage: node research/correctness/e1.js --campaign <id> [--tiny] [--trials n] [--procs 4] [--master-seed s] [--data-root d]' );
			process.exit( 0 );
		} else {
			fail( 'unknown argument ' + a );
		}
	}
	[ 'trials', 'procs', 'masterSeed' ].forEach( function check( k ) {
		if ( o[ k ] !== null && !( Number.isInteger( o[ k ] ) && o[ k ] >= 1 ) ) {
			fail( '--' + k + ' must be a positive integer' );
		}
	});
	if ( o.campaign !== null && !/^[A-Za-z0-9._-]+$/.test( o.campaign || '' ) ) {
		fail( '--campaign must match [A-Za-z0-9._-]+' );
	}
	o.campaign = o.campaign || ( ( o.tiny ) ? 'tiny-e1' : 'dev-e1' );
	o.trials = o.trials || ( ( o.tiny ) ? 2000 : 100000 );
	o.masterSeed = o.masterSeed || records.protocolMasterSeed();
	return o;
}

/**
* Runs the trials of one shard (t ≡ shard mod procs) and returns a summary.
*
* @private
* @param {Object} o - options
* @returns {Object} summary
*/
function runShard( o ) {
	var s = {
		'trials': 0,
		'mismatches': 0,
		'input_mutations': 0,
		'recursive': 0,
		'max_depth': 0,
		'shapes_max': { 'M': 0, 'N': 0, 'K': 0 },
		'by_mode': {},
		'examples': []
	};
	var tr;
	var r;
	var t;
	for ( t = o.shard; t < o.trials; t += o.procs ) {
		tr = trial.makeTrial( t, o.masterSeed );
		r = trial.runTrial( tr );
		s.trials += 1;
		s.by_mode[ tr.mode ] = ( s.by_mode[ tr.mode ] || 0 ) + 1;
		s.shapes_max.M = Math.max( s.shapes_max.M, tr.M );
		s.shapes_max.N = Math.max( s.shapes_max.N, tr.N );
		s.shapes_max.K = Math.max( s.shapes_max.K, tr.K );
		if ( r.recursive ) {
			s.recursive += 1;
			s.max_depth = Math.max( s.max_depth, tr.L );
		}
		if ( !r.ok || r.mutated ) {
			if ( !r.ok ) {
				s.mismatches += 1;
			}
			if ( r.mutated ) {
				s.input_mutations += 1;
			}
			if ( s.examples.length < MAX_EXAMPLES ) {
				s.examples.push( Object.assign( trial.describe( tr ), {
					'index': r.index,
					'expected': String( r.expected ),
					'actual': String( r.actual ),
					'mutated': r.mutated
				}) );
			}
		}
	}
	return s;
}

/**
* Forks the shard workers and aggregates their summaries.
*
* @private
* @param {Object} o - options
* @returns {Promise<Object>} aggregate summary
*/
function runAll( o ) {
	var procs = Math.min( o.procs, o.trials );
	var results = [];
	return new Promise( function exec( resolve, reject ) {
		var pending = procs;
		var i;
		for ( i = 0; i < procs; i++ ) {
			start( i );
		}

		function start( k ) {
			var args = [ '--worker', '--shard', String( k ), '--procs', String( procs ), '--trials', String( o.trials ), '--master-seed', String( o.masterSeed ) ];
			var child = fork( __filename, args, {
				'execArgv': [],
				'stdio': [ 'ignore', 'inherit', 'inherit', 'ipc' ]
			});
			var got = false;
			child.on( 'message', function onMessage( msg ) {
				got = true;
				results.push( msg );
			});
			child.on( 'exit', function onExit( code ) {
				if ( code !== 0 || !got ) {
					return reject( new Error( 'E1 worker ' + k + ' failed (exit ' + code + ')' ) );
				}
				pending -= 1;
				if ( pending === 0 ) {
					resolve( merge( results ) );
				}
			});
		}
	});
}

/**
* Merges shard summaries.
*
* @private
* @param {Array<Object>} parts - summaries
* @returns {Object} aggregate
*/
function merge( parts ) {
	var out = {
		'trials': 0,
		'mismatches': 0,
		'input_mutations': 0,
		'recursive': 0,
		'max_depth': 0,
		'shapes_max': { 'M': 0, 'N': 0, 'K': 0 },
		'by_mode': {},
		'examples': []
	};
	parts.forEach( function add( p ) {
		out.trials += p.trials;
		out.mismatches += p.mismatches;
		out.input_mutations += p.input_mutations;
		out.recursive += p.recursive;
		out.max_depth = Math.max( out.max_depth, p.max_depth );
		out.shapes_max.M = Math.max( out.shapes_max.M, p.shapes_max.M );
		out.shapes_max.N = Math.max( out.shapes_max.N, p.shapes_max.N );
		out.shapes_max.K = Math.max( out.shapes_max.K, p.shapes_max.K );
		Object.keys( p.by_mode ).forEach( function m( k ) {
			out.by_mode[ k ] = ( out.by_mode[ k ] || 0 ) + p.by_mode[ k ];
		});
		out.examples = out.examples.concat( p.examples ).slice( 0, MAX_EXAMPLES );
	});
	return out;
}

/**
* Main execution sequence.
*
* @private
* @returns {Promise} completion
*/
async function main() {
	var o = parseArgs( process.argv.slice( 2 ) );
	var file;
	var rep;
	var rec;
	var res;
	var t0;
	if ( o.worker ) {
		process.send( runShard( o ), function sent() {
			process.disconnect();
		});
		return;
	}
	t0 = Date.now();
	console.log( '[E1] campaign ' + o.campaign + ': ' + o.trials + ' trials over ' + Math.min( o.procs, o.trials ) + ' processes (master seed ' + o.masterSeed + ')' );
	res = await runAll( o );
	file = path.join( o.dataRoot, o.campaign, 'e1.jsonl' );
	rec = records.record( 'e1', o.campaign, {
		'trials': res.trials,
		'mismatches': res.mismatches,
		'recursive_fraction': res.recursive / res.trials,
		'shapes_max': res.shapes_max,
		'input_mutations': res.input_mutations,
		'max_depth': res.max_depth,
		'by_mode': res.by_mode,
		'examples': res.examples,
		'tiny': o.tiny,
		'procs': Math.min( o.procs, o.trials ),
		'master_seed': o.masterSeed,
		'pkg_sha256': records.packageHash(),
		'base_path': path.relative( paths.ROOT, paths.BASE ),
		'dgemm_path': path.relative( paths.ROOT, require.resolve( '@stdlib/blas/base/dgemm' ) ),
		'wall_ms': Date.now() - t0
	});
	rep = records.repairTail( file );
	if ( rep ) {
		console.log( '[E1] WARNING ' + path.relative( paths.ROOT, file ) + ': line ' + rep.line + ' was cut short by an interrupted write (' + rep.bytes + ' bytes); newline-terminated, ' + ( ( rep.kept ) ? 'the record is complete and kept' : 'readers skip the torn record' ) );
	}
	records.appendLine( file, rec );
	console.log( '[E1] trials ' + res.trials + ', mismatches ' + res.mismatches + ', input mutations ' + res.input_mutations + ', recursive fraction ' + rec.recursive_fraction.toFixed( 3 ) + ', max depth ' + res.max_depth + ', shapes max ' + JSON.stringify( res.shapes_max ) + ', ' + ( rec.wall_ms/1000 ).toFixed( 1 ) + ' s -> ' + path.relative( paths.ROOT, file ) );
	if ( res.mismatches || res.input_mutations ) {
		console.error( 'E1 FAILED: ' + JSON.stringify( res.examples ) );
		process.exitCode = 1;
		return;
	}
	console.log( 'E1 PASS' );
}

main().catch( function onError( err ) {
	console.error( 'E1 ERROR: ' + ( err && err.stack || err ) );
	process.exit( 1 );
});
