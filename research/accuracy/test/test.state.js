'use strict';

// E6 resume state: torn-tail repair, recorded arms, sticky hard gates (persisted ∪ recomputed, also re-evaluations)
// and the one-code-version precondition, each with its override flag.

// MODULES //

var tape = require( 'tape' );
var path = require( 'path' );
var fs = require( 'fs' );
var os = require( 'os' );
var design = require( './../design.js' );
var records = require( './../records.js' );
var state = require( './../state.js' );


// VARIABLES //

var SHARDS = design.shards( { 'masterSeed': 1, 'sizes': [ 32 ], 'families': [ 'F11' ], 'seeds': 1, 'Lmax': 1 } );


// FUNCTIONS //

/**
* Returns an accuracy record of one arm of a shard (healthy unless `metrics`/`fields` say otherwise).
*/
function rec( s, alg, levels, fields, metrics ) {
	return Object.assign( records.record( 'accuracy', 'c', {
		'family': s.family,
		'params': s.params,
		'seed': s.seed,
		'M': s.n,
		'N': s.n,
		'K': s.n,
		'alg': alg,
		'L': levels,
		'levels': levels,
		'pkg_sha256': 'aaa',
		'warnings': [],
		'metrics': Object.assign( { 'eta_N': 1, 'rho_N': 1e-3, 'f_W': 1e3, 'eta_C': { 'max': 1 }, 'exact': true, 'max_E': 0, 'n_nonfinite': 0 }, metrics )
	}), fields );
}

function allArms( s ) {
	return s.arms.map( function f( a ) {
		return rec( s, a.alg, a.levels );
	});
}

function write( recs, tail ) {
	var f = path.join( fs.mkdtempSync( path.join( os.tmpdir(), 'stratamm-state-' ) ), 'accuracy.jsonl' );
	fs.writeFileSync( f, recs.map( function line( r ) {
		return JSON.stringify( r ) + '\n';
	}).join( '' ) + ( tail || '' ) );
	return f;
}

function opts( extra ) {
	return Object.assign( { 'campaign': 'c', 'pkgSha': 'aaa', 'acceptViolations': false, 'acceptPkgChange': false }, extra );
}

function cleanup( f ) {
	fs.rmSync( path.dirname( f ), { 'recursive': true, 'force': true } );
}

function caught( fn ) {
	try {
		fn();
	} catch ( err ) {
		return err;
	}
	return null;
}


// TESTS //

tape( 'state.load repairs a torn tail, skips malformed lines and collects the arms recorded for the campaign', function test( t ) {
	var recs = allArms( SHARDS[ 0 ] ).concat( [ rec( SHARDS[ 1 ], 'A0', 0, { 'campaign': 'other' } ) ] );
	var f = write( recs, '{"schema":"sw-bench/2","type":"accu' );
	var logs = [];
	var st = state.load( f, 'c' );
	t.strictEqual( st.repaired.line, recs.length + 1, 'torn last line repaired' );
	t.deepEqual( st.bad, [ recs.length + 1 ], 'and reported as malformed' );
	t.strictEqual( st.accuracy.length, recs.length, 'accuracy records of any campaign' );
	t.strictEqual( st.done.size, SHARDS[ 0 ].arms.length, 'only the campaign\'s arms count as recorded' );
	t.deepEqual( state.missing( SHARDS, st.done ), SHARDS[ 1 ].arms.map( function k( a ) {
		return design.armKey( SHARDS[ 1 ].key, a.alg, a.levels );
	}), 'the other shard is missing' );
	state.report( st, f, function log( m ) {
		logs.push( m );
	});
	t.ok( /cut short by an interrupted write/.test( logs[ 0 ] ) && /malformed line\(s\) skipped/.test( logs[ 1 ] ), 'both are logged' );
	t.strictEqual( state.load( f, 'c' ).repaired, null, 'a second load finds nothing to repair' );
	cleanup( f );
	t.end();
});

tape( 'state.check: hard gates are sticky (persisted or recomputed, also re-evaluations) unless --accept-violations', function test( t ) {
	var s = SHARDS[ 0 ];
	var cases = [
		[ 'persisted gate_violations', rec( s, 'SW', 1, { 'gate_violations': [ 'F11 inexact (SW L=1: max E = 1)' ] } ) ],
		[ 'recomputed from stored metrics (Infinity stored as null)', rec( s, 'SW', 1, {}, { 'rho_N': null } ) ],
		[ 'a violating re-evaluation', state.reevalRecord( rec( s, 'SW', 1, { 'gate_violations': [ 'SW rho_N >= 1 (eta_N 9 vs f_W 1)' ] } ) ) ]
	];
	var logs;
	var err;
	var st;
	var f;
	var i;
	for ( i = 0; i < cases.length; i++ ) {
		f = write( [ rec( s, 'A0', 0 ), cases[ i ][ 1 ] ] );
		st = state.load( f, 'c' );
		logs = [];
		err = caught( function stop() {
			state.check( st, opts(), f, function log( m ) {
				logs.push( m );
			});
		});
		t.ok( err && err.exitCode === 2 && /HARD GATE VIOLATION recorded earlier/.test( err.message ) && /Remedy: .*new campaign id/.test( err.message ), cases[ i ][ 0 ] + ': stops with exit code 2 and a remedy' );
		t.ok( /recorded HARD GATE VIOLATION F11\|/.test( logs[ 0 ] ), cases[ i ][ 0 ] + ': violation logged' );
		logs = [];
		state.check( st, opts( { 'acceptViolations': true } ), f, function log( m ) {
			logs.push( m );
		});
		t.ok( /--accept-violations/.test( logs[ logs.length-1 ] ), cases[ i ][ 0 ] + ': --accept-violations continues (logged)' );
		cleanup( f );
	}
	t.strictEqual( cases[ 2 ][ 1 ].type, state.REEVAL, 're-evaluations are kept under their own record type' );
	f = write( allArms( s ) );
	t.doesNotThrow( function ok() {
		state.check( state.load( f, 'c' ), opts(), f, function log() {} );
	}, 'healthy records pass' );
	cleanup( f );
	t.end();
});

tape( 'state.check: records from other package sources stop a resume unless --accept-pkg-change', function test( t ) {
	var f = write( allArms( SHARDS[ 0 ] ) );
	var st = state.load( f, 'c' );
	var logs = [];
	var err = caught( function stop() {
		state.check( st, opts( { 'pkgSha': 'bbb' } ), f, function log() {} );
	});
	t.ok( err && err.exitCode === 2 && /package sources changed/.test( err.message ) && /3 record\(s\) with pkg_sha256 aaa/.test( err.message ), 'stops with exit code 2' );
	state.check( st, opts( { 'pkgSha': 'bbb', 'acceptPkgChange': true } ), f, function log( m ) {
		logs.push( m );
	});
	t.ok( /--accept-pkg-change/.test( logs[ 0 ] ), '--accept-pkg-change continues (logged)' );
	t.deepEqual( state.otherPackages( st.accuracy, 'aaa' ), {}, 'same package: nothing to report' );
	cleanup( f );
	t.end();
});
