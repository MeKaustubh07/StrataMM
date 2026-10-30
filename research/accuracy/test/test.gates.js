'use strict';

// Hard gates and warnings on records read back from accuracy.jsonl: NaN/±Infinity metrics are stored as null and
// must still fail their gate; persisted `gate_violations` and recomputed gates are united (sticky gates on resume);
// every message carries a stable rule name.

// MODULES //

var tape = require( 'tape' );
var gates = require( './../gates.js' );


// FUNCTIONS //

function rec( fields, metrics ) {
	return Object.assign({
		'type': 'accuracy',
		'family': 'F2',
		'params': {},
		'K': 64,
		'N': 64,
		'L': 2,
		'seed': 1,
		'alg': 'SW',
		'levels': 2,
		'k0': 16,
		'warnings': [],
		'metrics': Object.assign({
			'eta_N': 10,
			'rho_N': 1e-4,
			'f_W': 1e5,
			'eta_C': { 'max': 2 },
			'eta_F': 1,
			'exact': false,
			'max_E': 1e-15,
			'n_nonfinite': 0
		}, metrics )
	}, fields );
}

function roundTrip( r ) {
	return JSON.parse( JSON.stringify( r ) );
}

function rules( msgs ) {
	return msgs.map( gates.ruleOf );
}


// TESTS //

tape( 'gates survive a JSON round trip: NaN/±Infinity metrics (stored as null) still fail their gate', function test( t ) {
	var cases = [
		[ rec( { 'alg': 'A0', 'L': 0, 'levels': 0 }, { 'eta_N': Infinity } ), [ 'classic eta_N >= K^2' ] ],
		[ rec( { 'alg': 'A0', 'L': 0, 'levels': 0 }, { 'eta_N': NaN } ), [ 'classic eta_N >= K^2' ] ],
		[ rec( { 'alg': 'A0', 'L': 0, 'levels': 0 }, { 'eta_C': { 'max': Infinity } } ), [ 'classic eta_C > K' ] ],
		[ rec( {}, { 'rho_N': Infinity } ), [ 'SW rho_N >= 1' ] ],
		[ rec( { 'alg': 'V1' }, { 'rho_N': NaN } ), [ 'V1 rho_N >= 1' ] ]
	];
	var i;
	for ( i = 0; i < cases.length; i++ ) {
		t.deepEqual( rules( gates.violations( cases[ i ][ 0 ] ) ), cases[ i ][ 1 ], 'in memory: ' + cases[ i ][ 1 ][ 0 ] );
		t.deepEqual( rules( gates.violations( roundTrip( cases[ i ][ 0 ] ) ) ), cases[ i ][ 1 ], 'after JSON (null): ' + cases[ i ][ 1 ][ 0 ] );
	}
	t.deepEqual( gates.violations( roundTrip( rec( {}, {} ) ) ), [], 'a healthy record still passes after JSON' );
	t.deepEqual( gates.violations( rec( { 'alg': 'V2' }, { 'rho_N': null } ) ), [], 'V2 is not gated on rho_N' );
	t.deepEqual( rules( gates.violations( rec( { 'family': 'F11' }, { 'exact': null } ) ) ), [ 'F11 inexact' ], 'F11: exactness must be recorded as true' );
	t.end();
});

tape( 'recordViolations unites persisted gate_violations with recomputed gates, one message per rule', function test( t ) {
	var persisted = 'F11 inexact (SW L=2: max E = 1)';
	var r;
	t.deepEqual( gates.recordViolations( rec( {}, {} ) ), [], 'healthy record, nothing persisted' );
	r = rec( { 'family': 'F11', 'gate_violations': [ persisted ] }, { 'exact': true } );
	t.deepEqual( gates.recordViolations( r ), [ persisted ], 'a persisted violation counts although the stored metrics pass' );
	r = roundTrip( rec( {}, { 'rho_N': Infinity } ) );
	t.deepEqual( rules( gates.recordViolations( r ) ), [ 'SW rho_N >= 1' ], 'a recomputed violation counts although nothing was persisted' );
	r = rec( { 'family': 'F11', 'gate_violations': [ persisted ] }, { 'exact': false, 'rho_N': 2 } );
	t.deepEqual( gates.recordViolations( r ), [ persisted, gates.violations( r )[ 0 ] ], 'persisted message wins per rule; other rules are added' );
	t.deepEqual( rules( gates.recordViolations( r ) ), [ 'F11 inexact', 'SW rho_N >= 1' ], 'rules' );
	t.end();
});

tape( 'every gate and warning message starts with a stable rule name (RULES)', function test( t ) {
	var names = Object.keys( gates.RULES ).map( function f( k ) {
		return gates.RULES[ k ];
	});
	var shard = [
		rec( { 'family': 'F1', 'alg': 'A0', 'L': 0, 'k0': 64 }, { 'eta_N': 10, 'eta_C': { 'max': 2 } } ),
		rec( { 'family': 'F1', 'alg': 'SW', 'L': 1, 'k0': 32 }, { 'eta_N': 25, 'eta_C': { 'max': 2 } } )
	];
	var msgs = [];
	msgs = msgs.concat( gates.violations( rec( { 'alg': 'A0', 'L': 0 }, { 'eta_N': 1e9, 'eta_C': { 'max': 1e9 }, 'n_nonfinite': 2 } ) ) );
	msgs = msgs.concat( gates.violations( rec( { 'family': 'F11' }, { 'rho_N': 3 } ) ) );
	msgs = msgs.concat( gates.recordWarnings( rec( { 'alg': 'V1', 'L': 2 }, { 'eta_N': 1e12 } ) ) );
	msgs = msgs.concat( gates.recordWarnings( rec( { 'alg': 'V2' }, { 'scale_inexact': 1, 'unscale_inexact': 0 } ) ) );
	gates.shardWarnings( shard );
	msgs = msgs.concat( shard[ 1 ].warnings );
	t.deepEqual( rules( msgs ), [ 'non-finite output entries', 'classic eta_N >= K^2', 'classic eta_C > K', 'SW rho_N >= 1', 'F11 inexact', 'V1 eta_N >= Strassen bound f_S', 'V2 scaling not exact', 'F1 k0>=32, L<=4' ], 'rule names' );
	t.ok( rules( msgs ).every( function known( n ) {
		return names.indexOf( n.replace( /^(SW|V1) (rho_N)/, '$2' ) ) >= 0;
	}), 'each is listed in RULES (rho_N with its arm prefix)' );
	t.strictEqual( gates.growthWarnings( [ rec( { 'alg': 'A0', 'L': 0 }, {} ), rec( {}, { 'eta_F': 4 } ) ] )[ 0 ].rule, gates.RULES.growth, 'growth warnings (accuracy_warning.rule) carry RULES.growth' );
	t.end();
});

tape( 'recordWarnings: V1 at or above its Strassen bound f_S also when eta_N was stored as null', function test( t ) {
	var r = rec( { 'alg': 'V1', 'L': 2 }, { 'eta_N': Infinity } );
	t.deepEqual( rules( gates.recordWarnings( r ) ), [ 'V1 eta_N >= Strassen bound f_S' ], 'in memory' );
	t.deepEqual( rules( gates.recordWarnings( roundTrip( r ) ) ), [ 'V1 eta_N >= Strassen bound f_S' ], 'after JSON' );
	t.deepEqual( gates.recordWarnings( rec( { 'alg': 'V1', 'L': 2 }, { 'eta_N': 10 } ) ), [], 'below f_S' );
	t.end();
});
