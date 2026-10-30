'use strict';

// End-to-end E6 resume (run.js on F11, n = 32, L <= 1, 2 shards × 3 arms, scratch cache and data root): hard gates
// are sticky across runs, an already recorded arm that violates on re-evaluation stops the run, a torn last line is
// repaired, a package change stops a resume, and the exit codes are 0 complete / 2 gate-cert-precondition / 1 other.
// Library defects are planted in the evaluation children only, with a `--require` preload (nothing on disk changes).

// MODULES //

var tape = require( 'tape' );
var spawnSync = require( 'child_process' ).spawnSync;
var path = require( 'path' );
var fs = require( 'fs' );
var os = require( 'os' );
var paths = require( './../paths.js' );
var records = require( './../records.js' );


// VARIABLES //

var RUN = path.join( __dirname, '..', 'run.js' );
var DIR = fs.mkdtempSync( path.join( os.tmpdir(), 'stratamm-e6-resume-' ) );
var PLANT = path.join( DIR, 'plant.js' );


// FUNCTIONS //

/**
* Writes the preload that wraps base(): mode `perturb` adds 1 to C[offsetC] after every recursive call (F11 becomes
* inexact), mode `throw` throws.
*/
function writePlant() {
	fs.writeFileSync( PLANT, [
		'\'use strict\';',
		'var base = require( ' + JSON.stringify( paths.BASE ) + ' );',
		'require.cache[ require.resolve( ' + JSON.stringify( paths.BASE ) + ' ) ].exports = function planted() {',
		'\tvar out;',
		'\tif ( process.env.STRATAMM_PLANT === \'throw\' ) {',
		'\t\tthrow new Error( \'planted failure\' );',
		'\t}',
		'\tout = base.apply( null, arguments );',
		'\tif ( arguments[ 20 ] >= 1 ) {',
		'\t\targuments[ 15 ][ arguments[ 18 ] ] += 1.0;',
		'\t}',
		'\treturn out;',
		'};',
		''
	].join( '\n' ) );
}

function run( campaign, extra, plant ) {
	var env = Object.assign( {}, process.env );
	var r;
	if ( plant ) {
		env.NODE_OPTIONS = ( ( env.NODE_OPTIONS ) ? env.NODE_OPTIONS + ' ' : '' ) + '--require ' + JSON.stringify( PLANT );
		env.STRATAMM_PLANT = plant;
	}
	r = spawnSync( process.execPath, [ RUN, '--campaign', campaign, '--families', 'F11', '--sizes', '32', '--seeds', '1', '--levels', '1', '--procs', '1', '--workers', '1', '--cache-dir', path.join( DIR, 'cache' ), '--data-root', path.join( DIR, 'data' ) ].concat( extra || [] ), {
		'encoding': 'utf8',
		'env': env,
		'timeout': 120000
	});
	return {
		'code': r.status,
		'out': String( r.stdout ) + String( r.stderr )
	};
}

function file( campaign ) {
	return path.join( DIR, 'data', campaign, 'accuracy.jsonl' );
}

function read( campaign ) {
	var bad = [];
	var recs = records.readJsonl( file( campaign ), bad );
	return {
		'bad': bad,
		'types': recs.reduce( function count( acc, r ) {
			acc[ r.type ] = ( acc[ r.type ] || 0 ) + 1;
			return acc;
		}, {} )
	};
}

/**
* Rewrites accuracy.jsonl through `fn( record )` (return the record, a changed record, or null to drop it).
*/
function rewrite( campaign, fn ) {
	var out = [];
	fs.readFileSync( file( campaign ), 'utf8' ).split( '\n' ).filter( Boolean ).forEach( function each( l ) {
		var r = fn( JSON.parse( l ) );
		if ( r ) {
			out.push( JSON.stringify( r ) + '\n' );
		}
	});
	fs.writeFileSync( file( campaign ), out.join( '' ) );
}

function isIntArm( alg ) {
	return function test( r ) {
		return r.type === 'accuracy' && r.alg === alg && r.params.kind === 'int';
	};
}


// TESTS //

tape( 'setup: a clean campaign completes (exit 0) and a rerun has nothing to do', function test( t ) {
	var r;
	writePlant();
	r = run( 'clean' );
	t.strictEqual( r.code, 0, 'exit 0' );
	t.ok( /E6 COMPLETE: 6 accuracy records/.test( r.out ), 'E6 COMPLETE with 6 records' );
	r = run( 'clean' );
	t.ok( r.code === 0 && /nothing to do/.test( r.out ), 'rerun: nothing to do, exit 0' );
	t.end();
});

tape( 'hard gates are sticky: a violation recorded earlier stops every later run (exit 2), also with --accept-violations', function test( t ) {
	var cases = [
		[ 'persisted', function persisted( r ) {
			if ( isIntArm( 'SW' )( r ) ) {
				r.gate_violations = [ 'F11 inexact (SW L=1: max E = 1)' ];
			}
			return r;
		} ],
		[ 'recomputed', function recomputed( r ) {
			if ( isIntArm( 'V1' )( r ) ) {
				r.metrics.rho_N = null; // what JSON makes of ±Infinity
			}
			return r;
		} ]
	];
	var r;
	var i;
	for ( i = 0; i < cases.length; i++ ) {
		t.strictEqual( run( 'sticky-' + i ).code, 0, cases[ i ][ 0 ] + ': first run completes' );
		rewrite( 'sticky-' + i, cases[ i ][ 1 ] );
		r = run( 'sticky-' + i );
		t.strictEqual( r.code, 2, cases[ i ][ 0 ] + ': exit 2' );
		t.ok( /HARD GATE VIOLATION recorded earlier/.test( r.out ) && /Remedy: .*new campaign id/.test( r.out ), cases[ i ][ 0 ] + ': names the violation and the remedy' );
		t.ok( !/reference pass/.test( r.out ) && !/E6 COMPLETE/.test( r.out ), cases[ i ][ 0 ] + ': stops before any work, never COMPLETE' );
		r = run( 'sticky-' + i, [ '--accept-violations' ] );
		t.ok( r.code === 2 && /E6 is not complete/.test( r.out ) && !/E6 COMPLETE/.test( r.out ), cases[ i ][ 0 ] + ': --accept-violations runs but still exits 2' );
	}
	t.end();
});

tape( 'an already recorded arm that violates on re-evaluation stops the run, and the stop stays sticky', function test( t ) {
	var r;
	t.strictEqual( run( 'reeval' ).code, 0, 'clean run' );
	rewrite( 'reeval', function drop( x ) {
		return ( isIntArm( 'A0' )( x ) ) ? null : x; // the int shard is evaluated again
	});
	r = run( 'reeval', [], 'perturb' );
	t.strictEqual( r.code, 2, 'planted defect: exit 2' );
	t.ok( /E6 HARD GATE VIOLATION: F11\|int\|\d+\|32\|SW\|1: /.test( r.out ), 'the recorded SW arm is gated on re-evaluation' );
	t.deepEqual( read( 'reeval' ).types, { 'accuracy': 6, 'accuracy_reeval_violation': 1 }, 'one record per arm; the violation is kept separately' );
	r = run( 'reeval' );
	t.ok( r.code === 2 && /\(re-evaluation\)/.test( r.out ), 'defect removed: still exit 2 (sticky)' );
	t.end();
});

tape( 'new violations: stop at once (exit 2); --accept-violations evaluates every shard and still exits 2', function test( t ) {
	var r = run( 'fresh', [], 'perturb' );
	t.ok( r.code === 2 && /E6 HARD GATE VIOLATION: F11/.test( r.out ), 'stop, exit 2' );
	r = run( 'fresh-all', [ '--accept-violations' ], 'perturb' );
	t.strictEqual( r.code, 2, '--accept-violations: exit 2' );
	t.ok( /continuing/.test( r.out ) && /E6 HARD GATE VIOLATION: 2 record\(s\)/.test( r.out ) && !/E6 COMPLETE/.test( r.out ), 'both shards evaluated, both violations reported, never COMPLETE' );
	t.strictEqual( read( 'fresh-all' ).types.accuracy, 6, 'every arm recorded' );
	t.end();
});

tape( 'a torn last line is newline-terminated, its arm evaluated again, and E6 completes; later runs still resume', function test( t ) {
	var size;
	var r;
	t.strictEqual( run( 'torn' ).code, 0, 'clean run' );
	size = fs.statSync( file( 'torn' ) ).size;
	fs.truncateSync( file( 'torn' ), size - 500 );
	r = run( 'torn' );
	t.strictEqual( r.code, 0, 'exit 0' );
	t.ok( /line 6 was cut short by an interrupted write/.test( r.out ) && /E6 COMPLETE: 6 accuracy records/.test( r.out ), 'repaired and completed with every arm' );
	t.deepEqual( read( 'torn' ), { 'bad': [ 6 ], 'types': { 'accuracy': 6 } }, 'the torn line stays (append-only) and is skipped' );
	r = run( 'torn' );
	t.ok( r.code === 0 && /nothing to do/.test( r.out ), 'a later run resumes (no corrupt-line error)' );
	size = fs.statSync( file( 'torn' ) ).size;
	fs.truncateSync( file( 'torn' ), size - 1 ); // the last record lost only its newline
	r = run( 'torn' );
	t.ok( r.code === 0 && /the record is complete and kept/.test( r.out ) && /nothing to do/.test( r.out ), 'a complete record without its newline is kept' );
	t.end();
});

tape( 'records from other package sources stop a resume (exit 2) unless --accept-pkg-change', function test( t ) {
	var r;
	t.strictEqual( run( 'pkg' ).code, 0, 'clean run' );
	rewrite( 'pkg', function other( x ) {
		x.pkg_sha256 = '0123456789abcdef';
		return ( isIntArm( 'A0' )( x ) ) ? null : x;
	});
	r = run( 'pkg' );
	t.ok( r.code === 2 && /package sources changed/.test( r.out ), 'exit 2' );
	r = run( 'pkg', [ '--accept-pkg-change' ] );
	t.ok( r.code === 0 && /--accept-pkg-change/.test( r.out ) && /E6 COMPLETE/.test( r.out ), '--accept-pkg-change: resumes and completes' );
	t.end();
});

tape( 'exit codes: 1 for errors that are not a gate, certification or precondition stop', function test( t ) {
	var r = run( 'err', [ '--bogus' ] );
	t.strictEqual( r.code, 1, 'unknown argument: exit 1' );
	r = run( 'err', [], 'throw' );
	t.strictEqual( r.code, 1, 'an evaluation child error: exit 1' );
	t.ok( /planted failure/.test( r.out ) && /E6 FAILED \(exit 1\)/.test( r.out ), 'reported as a failure, not a stop' );
	fs.rmSync( DIR, { 'recursive': true, 'force': true } );
	t.end();
});
