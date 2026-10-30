#!/usr/bin/env node
'use strict';

// E6 accuracy experiment (research protocol §8). Usage:
//
//   node research/accuracy/run.js --campaign <id> [--tiny] [--families F1,F4] [--sizes 64,128] [--seeds k]
//        [--levels L] [--workers 4] [--procs 4] [--master-seed s] [--cache-dir d] [--data-root d] [--dry-run]
//        [--summary] [--accept-violations] [--accept-pkg-change]
//
// 1. Reference pass: Dot2 double-double references for every (family, params, seed, n) with 4 worker_threads,
//    cached in research/cache/ref/ (+ .sha256); valid cache entries are reused.
// 2. Evaluation: 4 single-threaded child processes over the shards (largest first); this process is the single
//    writer of research/data/<campaign>/accuracy.jsonl (append-only; resumable: arms already recorded are skipped,
//    a torn last line is newline-terminated and its arm evaluated again; see state.js).
// 3. Hard gates / certification / precondition failures stop the run (exit 2); warnings are recorded. Hard gates
//    are sticky: a resumed run first re-checks every record already in accuracy.jsonl (persisted `gate_violations`
//    ∪ gates recomputed from the stored metrics) and stops, and the final check before COMPLETE does the same. An
//    arm re-evaluated on resume although already recorded is gated too (a violation is kept as an
//    `accuracy_reeval_violation` record, never as a second `accuracy` record).
//    --accept-violations: evaluate the remaining arms anyway (new violations are recorded, not stopping); still exit 2.
//    --accept-pkg-change: resume although the records come from other package sources (pkg_sha256).
//
// Exit codes: 0 = E6 COMPLETE (every arm of the design recorded, no hard-gate violation in accuracy.jsonl);
//             2 = stopped by a hard gate (new or recorded earlier), a failed reference certification, a violated input
//                 precondition, or a resume precondition (package sources changed);
//             1 = any other error (arguments, I/O, a crashed evaluation child, records missing after evaluation).

// MODULES //

var fork = require( 'child_process' ).fork;
var path = require( 'path' );
var paths = require( './paths.js' );
var records = require( './records.js' );
var design = require( './design.js' );
var families = require( './families.js' );
var reference = require( './reference.js' );
var gates = require( './gates.js' );
var state = require( './state.js' );
var summary = require( './summary.js' );


// VARIABLES //

var EXIT_GATE = state.EXIT_GATE;
var EXIT_ERROR = 1;
var GATE_STOP = /HARD GATE|CERTIFICATION|precondition violated/;


// FUNCTIONS //

function log( msg ) {
	console.log( '[E6 ' + new Date().toISOString() + '] ' + msg );
}

function fail( msg ) {
	console.error( 'E6 ERROR: ' + msg );
	process.exit( 1 );
}

function parseList( v, numeric ) {
	return String( v ).split( ',' ).filter( Boolean ).map( function f( x ) {
		return ( numeric ) ? Number( x ) : x.trim();
	});
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
		'sizes': null,
		'families': null,
		'seeds': null,
		'Lmax': null,
		'workers': 4,
		'procs': 4,
		'masterSeed': null,
		'cacheDir': paths.CACHE_REF,
		'dataRoot': paths.DATA,
		'dryRun': false,
		'summary': false,
		'acceptViolations': false,
		'acceptPkgChange': false
	};
	var a;
	var i;
	for ( i = 0; i < argv.length; i++ ) {
		a = argv[ i ];
		if ( a === '--tiny' ) {
			o.tiny = true;
		} else if ( a === '--dry-run' ) {
			o.dryRun = true;
		} else if ( a === '--summary' ) {
			o.summary = true;
		} else if ( a === '--accept-violations' ) {
			o.acceptViolations = true;
		} else if ( a === '--accept-pkg-change' ) {
			o.acceptPkgChange = true;
		} else if ( a === '--campaign' ) {
			o.campaign = argv[ ++i ];
		} else if ( a === '--families' ) {
			o.families = parseList( argv[ ++i ], false );
		} else if ( a === '--sizes' ) {
			o.sizes = parseList( argv[ ++i ], true );
		} else if ( a === '--seeds' ) {
			o.seeds = Number( argv[ ++i ] );
		} else if ( a === '--levels' ) {
			o.Lmax = Number( argv[ ++i ] );
		} else if ( a === '--workers' ) {
			o.workers = Number( argv[ ++i ] );
		} else if ( a === '--procs' ) {
			o.procs = Number( argv[ ++i ] );
		} else if ( a === '--master-seed' ) {
			o.masterSeed = Number( argv[ ++i ] );
		} else if ( a === '--cache-dir' ) {
			o.cacheDir = path.resolve( argv[ ++i ] );
		} else if ( a === '--data-root' ) {
			o.dataRoot = path.resolve( argv[ ++i ] );
		} else if ( a === '--help' || a === '-h' ) {
			console.log( 'usage: node research/accuracy/run.js --campaign <id> [--tiny] [--families F1,...] [--sizes 64,...] [--seeds k] [--levels L] [--workers 4] [--procs 4] [--master-seed s] [--cache-dir d] [--data-root d] [--dry-run] [--summary] [--accept-violations] [--accept-pkg-change]\nexit codes: 0 complete; 2 hard gate (new or recorded earlier), certification, input or resume precondition; 1 other error' );
			process.exit( 0 );
		} else {
			fail( 'unknown argument ' + a );
		}
	}
	if ( o.families ) {
		o.families.forEach( function check( f ) {
			if ( families.FAMILIES.indexOf( f ) < 0 ) {
				fail( 'unknown family ' + f + ' (known: ' + families.FAMILIES.join( ',' ) + ')' );
			}
		});
	}
	if ( o.sizes && o.sizes.some( function bad( n ) {
		return !( Number.isInteger( n ) && n >= 2 );
	}) ) {
		fail( '--sizes must be integers >= 2' );
	}
	[ 'seeds', 'Lmax', 'workers', 'procs', 'masterSeed' ].forEach( function check( k ) {
		if ( o[ k ] !== null && !( Number.isInteger( o[ k ] ) && o[ k ] >= 1 ) ) {
			fail( '--' + k + ' must be a positive integer' );
		}
	});
	if ( o.campaign !== null && !/^[A-Za-z0-9._-]+$/.test( o.campaign || '' ) ) {
		fail( '--campaign must match [A-Za-z0-9._-]+' );
	}
	o.campaign = o.campaign || ( ( o.tiny ) ? 'tiny-accuracy' : 'dev-accuracy' );
	o.masterSeed = o.masterSeed || records.protocolMasterSeed();
	o.summary = o.summary || o.tiny;
	return o;
}

/**
* Computes (or reuses) the cached reference of every shard with a persistent worker pool.
*
* @private
* @param {Array<Object>} shards - shards
* @param {Object} o - options
* @returns {Promise<Object>} counts `{ computed, cached }`
*/
async function referencePass( shards, o ) {
	var pool = reference.createPool( o.workers );
	var counts = {
		'computed': 0,
		'cached': 0,
		'seconds': 0
	};
	var seen = {};
	var inputs;
	var ref;
	var gen;
	var res;
	var t0;
	var s;
	var i;
	try {
		for ( i = 0; i < shards.length; i++ ) {
			s = shards[ i ];
			if ( seen[ s.name ] ) {
				continue;
			}
			seen[ s.name ] = true;
			gen = families.generate( s.family, s.params, s.n, s.seed );
			inputs = records.sha256Arrays( [ gen.A, gen.B ] );
			try {
				ref = reference.loadReference( o.cacheDir, s.name, {
					'M': s.n,
					'N': s.n,
					'inputs_sha256': inputs
				});
			} catch ( err ) {
				log( 'cache entry ' + s.name + ' rejected (' + err.message + '); recomputing' );
				ref = null;
			}
			if ( ref ) {
				counts.cached += 1;
				continue;
			}
			families.checkPreconditions( s.n, gen.A, gen.B, null );
			t0 = Date.now();
			res = await pool.run( s.n, s.n, s.n, gen.A, gen.B );
			reference.saveReference( o.cacheDir, s.name, res, {
				'family': s.family,
				'params': s.params,
				'seed': s.seed,
				'n': s.n,
				'M': s.n,
				'N': s.n,
				'K': s.n,
				'inputs_sha256': inputs,
				'workers': o.workers,
				'wall_ms': Date.now() - t0
			});
			counts.computed += 1;
			counts.seconds += ( Date.now() - t0 ) / 1000;
			if ( s.n >= 512 ) {
				log( 'reference ' + s.name + ' (' + ( ( Date.now()-t0 )/1000 ).toFixed( 2 ) + ' s)' );
			}
		}
	} finally {
		await pool.close();
	}
	return counts;
}

/**
* Runs the evaluation children over the shards; resolves when all are done, rejects on the first stop condition.
*
* @private
* @param {Array<Object>} shards - shards to evaluate
* @param {Object} o - options
* @param {Function} onRecords - callback `( msg ) => Array<string>` (violations; non-empty stops the run unless
*   `o.acceptViolations`)
* @returns {Promise} completion
*/
function evaluationPass( shards, o, onRecords ) {
	return new Promise( function exec( resolve, reject ) {
		var queue = shards.slice().sort( function cmp( a, b ) {
			return design.cost( b ) - design.cost( a );
		});
		var nprocs = Math.min( o.procs, queue.length );
		var children = [];
		var active = 0;
		var stopped = false;
		var done = 0;
		var copts = {
			'campaign': o.campaign,
			'cacheDir': o.cacheDir,
			'masterSeed': o.masterSeed,
			'pkgSha': o.pkgSha
		};
		var i;
		if ( nprocs === 0 ) {
			return resolve();
		}
		for ( i = 0; i < nprocs; i++ ) {
			spawn();
		}

		function spawn() {
			var child = fork( path.join( __dirname, 'eval_child.js' ), [], {
				'execArgv': [],
				'stdio': [ 'ignore', 'inherit', 'inherit', 'ipc' ]
			});
			child.current = null;
			children.push( child );
			active += 1;
			child.on( 'message', function onMessage( msg ) {
				var v;
				if ( stopped ) {
					return;
				}
				if ( msg.type === 'fatal' ) {
					// Certification and precondition failures exit 2 (GATE_STOP); other child errors exit 1...
					return stop( new Error( 'E6 STOP (' + msg.key + '): ' + msg.message ) );
				}
				if ( msg.type === 'records' ) {
					try {
						v = onRecords( msg, child.current );
					} catch ( err ) {
						return stop( err );
					}
					done += 1;
					if ( v.length && !o.acceptViolations ) {
						return stop( state.stopError( 'E6 HARD GATE VIOLATION: ' + v.join( ' | ' ) ) );
					}
					if ( v.length ) {
						log( 'HARD GATE VIOLATION (recorded; --accept-violations: continuing): ' + v.join( ' | ' ) );
					}
					progress( child.current );
				}
				next( child );
			});
			child.on( 'exit', function onExit( code ) {
				active -= 1;
				if ( stopped ) {
					return;
				}
				if ( child.current !== null || code !== 0 ) {
					return stop( new Error( 'E6 STOP: evaluation child exited (code ' + code + ')' + ( ( child.current ) ? ' while evaluating ' + child.current.key : '' ) ) );
				}
				if ( active === 0 ) {
					if ( queue.length ) {
						return stop( new Error( 'E6 STOP: all evaluation children exited with ' + queue.length + ' shard(s) unevaluated' ) );
					}
					resolve();
				}
			});
		}

		function next( child ) {
			var s = queue.shift();
			child.current = s || null;
			if ( !s ) {
				child.send({
					'type': 'exit'
				});
				return;
			}
			child.t0 = Date.now();
			child.send({
				'type': 'shard',
				'shard': s,
				'opts': copts
			});
		}

		function progress( s ) {
			if ( s.n >= 1024 || done % Math.max( 1, Math.ceil( shards.length/20 ) ) === 0 || done === shards.length ) {
				log( 'evaluated ' + done + '/' + shards.length + ' (' + s.key + ')' );
			}
		}

		function stop( err ) {
			stopped = true;
			children.forEach( function kill( c ) {
				try {
					c.kill( 'SIGKILL' );
				} catch ( e ) { // eslint-disable-line no-unused-vars
					// already gone
				}
			});
			reject( err );
		}
	});
}

/**
* Main execution sequence.
*
* @private
* @returns {Promise} completion
*/
async function main() {
	var o = parseArgs( process.argv.slice( 2 ) );
	var outFile = path.join( o.dataRoot, o.campaign, 'accuracy.jsonl' );
	var t0 = Date.now();
	var missing;
	var shards;
	var todo;
	var refc;
	var mine;
	var acc;
	var viol;
	var st;
	var gw;
	var nw;

	shards = design.shards( o );
	if ( o.dryRun ) {
		console.log( 'E6_BUDGET ' + JSON.stringify( summary.budget( shards, o ) ) );
		return;
	}
	o.pkgSha = records.packageHash();

	// Resume: repair a torn last line, then re-check the records already written (sticky gates, one code version)...
	st = state.load( outFile, o.campaign );
	state.report( st, outFile, log );
	state.check( st, o, outFile, log );
	todo = shards.filter( function pending( s ) {
		return s.arms.some( function absent( a ) {
			return !st.done.has( design.armKey( s.key, a.alg, a.levels ) );
		});
	});
	log( 'campaign ' + o.campaign + ( ( o.tiny ) ? ' (tiny)' : '' ) + ': ' + shards.length + ' shards, ' + todo.length + ' to evaluate; master seed ' + o.masterSeed + '; output ' + path.relative( paths.ROOT, outFile ) );
	if ( todo.length === 0 ) {
		log( 'nothing to do' );
	}

	// 1. Reference pass (4 worker threads)...
	refc = await referencePass( todo, o );
	log( 'reference pass: ' + refc.computed + ' computed (' + refc.seconds.toFixed( 1 ) + ' s), ' + refc.cached + ' reused from cache' );

	// 2. Evaluation pass (4 single-threaded processes); every received record is gated, also one already recorded...
	await evaluationPass( todo, o, function onRecords( msg ) {
		var v = [];
		msg.records.forEach( function write( r ) {
			var key = state.recordKey( r );
			var rv = gates.recordViolations( r ); // the child's gate_violations ∪ recomputed (IPC turns ±Infinity into null)
			if ( rv.length ) {
				r.gate_violations = rv;
				v.push( key + ': ' + rv.join( '; ' ) );
			}
			if ( st.done.has( key ) ) {
				// Recorded by an earlier run: no second `accuracy` record, but a violation still counts and is kept...
				if ( rv.length ) {
					records.appendLine( outFile, state.reevalRecord( r ) );
				}
				return;
			}
			records.appendLine( outFile, r );
			st.done.add( key );
			if ( r.warnings.length ) {
				log( 'WARNING ' + key + ': ' + r.warnings.join( '; ' ) );
			}
		});
		return v;
	});

	// Completeness: every arm of every shard of the design must be in the file as re-read (not just in memory)...
	st = state.load( outFile, o.campaign );
	missing = state.missing( shards, st.done );
	if ( missing.length ) {
		throw new Error( 'E6 FAILED: ' + missing.length + ' arm record(s) missing from ' + path.relative( paths.ROOT, outFile ) + ' after evaluation (first: ' + missing[ 0 ] + ')' );
	}

	// 3. Aggregate warnings (growth factor g on F2/F3)...
	mine = st.all.filter( function isMine( r ) {
		return r.campaign === o.campaign;
	});
	acc = mine.filter( function isAccuracy( r ) {
		return r.type === 'accuracy';
	});
	gw = gates.growthWarnings( acc );
	nw = summary.writeGrowthWarnings( outFile, o.campaign, gw, mine, log );
	if ( o.summary ) {
		summary.print( acc );
	}

	// 4. Hard gates are sticky: never COMPLETE while any record in the file violates one...
	viol = state.violations( st.gated );
	if ( viol.length ) {
		throw state.stopError( 'E6 HARD GATE VIOLATION: ' + viol.length + ' record(s) in ' + path.relative( paths.ROOT, outFile ) + ' violate a hard gate' + ( ( o.acceptViolations ) ? ' (remaining arms evaluated under --accept-violations)' : '' ) + '; first: ' + viol[ 0 ] + '. E6 is not complete. ' + state.remedy( outFile ) );
	}
	log( 'E6 COMPLETE: ' + acc.length + ' accuracy records, ' + nw + ' growth warning(s)' + ( ( st.bad.length ) ? ', ' + st.bad.length + ' malformed line(s) skipped' : '' ) + ', ' + ( ( Date.now()-t0 )/1000 ).toFixed( 1 ) + ' s' );
}

main().catch( function onError( err ) {
	var msg = String( err && err.message || err );
	var code = ( ( err && err.exitCode === EXIT_GATE ) || GATE_STOP.test( msg ) ) ? EXIT_GATE : EXIT_ERROR;
	console.error( msg );
	if ( code === EXIT_GATE ) {
		console.error( 'E6 STOPPED (exit ' + EXIT_GATE + ')' );
	} else {
		console.error( err && err.stack );
		console.error( 'E6 FAILED (exit ' + EXIT_ERROR + ')' );
	}
	process.exit( code );
});
