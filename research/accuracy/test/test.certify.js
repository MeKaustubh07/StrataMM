'use strict';

// Certification (DotK(3) + BigInt) passes on a correct reference and fails (hard error) on a corrupted one, and the
// gates flag every pre-registered violation.

// MODULES //

var tape = require( 'tape' );
var certify = require( './../certify.js' );
var reference = require( './../reference.js' );
var families = require( './../families.js' );
var gates = require( './../gates.js' );


// FUNCTIONS //

function setup( n ) {
	var g = families.generate( 'F9a', families.paramSets( 'F9a' )[ 0 ], n, 5 );
	var ref = reference.computeSerial( n, n, n, g.A, g.B );
	return {
		'M': n,
		'N': n,
		'K': n,
		'A': g.A,
		'B': g.B,
		'hi': ref.hi,
		'lo': ref.lo,
		'entries': [ 0, ( n*n )-1, n+1 ],
		'seed': 9
	};
}

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


// TESTS //

tape( 'certification passes on a correct reference (ill-conditioned F9a inputs, kappa up to 1e16)', function test( t ) {
	var o = setup( 48 );
	var r = certify.certify( o );
	t.strictEqual( r.dotk.failures.length, 0, 'DotK(3): ' + r.dotk.n + ' entries, max ratio ' + r.dotk.max_ratio.toExponential( 2 ) );
	t.strictEqual( r.bigint.failures.length, 0, 'BigInt: ' + r.bigint.n + ' entries, max ratio ' + r.bigint.max_ratio.toExponential( 2 ) );
	t.ok( r.dotk.n >= 1000 && r.dotk.n <= 1003 && r.bigint.n === 32, 'entry counts (priority entries + 1000 distinct random entries; 32 exact)' );
	t.doesNotThrow( function ok() {
		certify.assertCertified( r, 'F9a' );
	}, 'assertCertified passes' );
	t.end();
});

tape( 'certification fails on a reference corrupted by one ulp at a priority entry', function test( t ) {
	var o = setup( 48 );
	var k = o.N + 1;
	var r;
	o.hi[ k ] += Math.abs( o.hi[ k ] ) * Math.pow( 2, -52 );
	r = certify.certify( o );
	t.ok( r.dotk.failures.length >= 1, 'DotK(3) detects it (ratio ' + r.dotk.max_ratio.toExponential( 2 ) + ')' );
	t.ok( r.bigint.failures.length >= 1, 'BigInt detects it' );
	t.throws( function bad() {
		certify.assertCertified( r, 'F9a test' );
	}, /CERTIFICATION FAILED/, 'assertCertified throws' );
	t.end();
});

tape( 'hard gates: classic eta_N >= K^2 or eta_C > K, SW/V1 rho_N >= 1, F11 inexact, non-finite outputs', function test( t ) {
	t.deepEqual( gates.violations( rec( {}, {} ) ), [], 'healthy SW record passes' );
	t.strictEqual( gates.violations( rec( { 'alg': 'A0', 'L': 0 }, { 'eta_N': 64*64 } ) ).length, 1, 'classic eta_N >= K^2' );
	t.strictEqual( gates.violations( rec( { 'alg': 'A0', 'L': 0 }, { 'eta_C': { 'max': 65 } } ) ).length, 1, 'classic eta_C > K' );
	t.strictEqual( gates.violations( rec( {}, { 'rho_N': 1 } ) ).length, 1, 'SW rho_N >= 1' );
	t.strictEqual( gates.violations( rec( { 'alg': 'V1' }, { 'rho_N': 2 } ) ).length, 1, 'V1 rho_N >= 1' );
	t.strictEqual( gates.violations( rec( { 'alg': 'V2' }, { 'rho_N': 2 } ) ).length, 0, 'V2 is not gated on rho_N' );
	t.strictEqual( gates.violations( rec( { 'family': 'F11' }, { 'exact': false } ) ).length, 1, 'F11 inexact' );
	t.strictEqual( gates.violations( rec( { 'family': 'F11' }, { 'exact': true } ) ).length, 0, 'F11 exact passes' );
	t.strictEqual( gates.violations( rec( {}, { 'n_nonfinite': 3 } ) ).length, 1, 'non-finite output' );
	t.end();
});

tape( 'warnings: F1 rule (k0 >= 32, L <= 4, more than 2x worse than A0) and growth factor g on F2/F3', function test( t ) {
	var shard = [
		rec( { 'family': 'F1', 'alg': 'A0', 'L': 0, 'k0': 64 }, { 'eta_N': 10, 'eta_C': { 'max': 2 } } ),
		rec( { 'family': 'F1', 'alg': 'SW', 'L': 1, 'k0': 32 }, { 'eta_N': 25, 'eta_C': { 'max': 2 } } ),
		rec( { 'family': 'F1', 'alg': 'SW', 'L': 2, 'k0': 16 }, { 'eta_N': 99, 'eta_C': { 'max': 9 } } )
	];
	var all = [];
	var w;
	var s;
	gates.shardWarnings( shard );
	t.strictEqual( shard[ 1 ].warnings.length, 1, 'k0 = 32, 2.5x worse => warning' );
	t.strictEqual( shard[ 2 ].warnings.length, 0, 'k0 = 16 is out of scope' );
	for ( s = 0; s < 3; s++ ) {
		all.push( rec( { 'alg': 'A0', 'L': 0, 'seed': s }, { 'eta_F': 1 } ) );
		all.push( rec( { 'alg': 'SW', 'L': 2, 'seed': s }, { 'eta_F': [ 4, 16, 25 ][ s ] } ) ); // g = 2, 4, 5 => median 4
		all.push( rec( { 'alg': 'SW', 'L': 1, 'seed': s }, { 'eta_F': 2 } ) ); // g = 2
	}
	w = gates.growthWarnings( all );
	t.strictEqual( w.length, 2, 'two (n, L) groups' );
	w.sort( function cmp( a, b ) {
		return a.L - b.L;
	});
	t.ok( w[ 0 ].ok && w[ 0 ].g === 2, 'L=1: g = 2 in range' );
	t.ok( !w[ 1 ].ok && w[ 1 ].g === 4, 'L=2: median g = 4 out of range' );
	t.end();
});
