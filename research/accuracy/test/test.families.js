'use strict';

// Families: determinism, preconditions, F7 size limit, F10 sign pattern, F11 exactness, GenDot conditioning.

// MODULES //

var tape = require( 'tape' );
var families = require( './../families.js' );
var genDot = require( './../gendot.js' );
var exact = require( './../exact.js' );
var records = require( './../records.js' );
var arms = require( './../arms.js' );
var rng = require( './../rng.js' );


// TESTS //

tape( 'every family/parameter set is deterministic in its seed and satisfies the reference preconditions', function test( t ) {
	var n = 32;
	var h1;
	var h2;
	var g;
	var f;
	var p;
	var ps;
	for ( f = 0; f < families.FAMILIES.length; f++ ) {
		ps = families.paramSets( families.FAMILIES[ f ] );
		for ( p = 0; p < ps.length; p++ ) {
			g = families.generate( families.FAMILIES[ f ], ps[ p ], n, 4242 );
			h1 = records.sha256Arrays( [ g.A, g.B ] );
			h2 = records.sha256Arrays( [ families.generate( families.FAMILIES[ f ], ps[ p ], n, 4242 ).A, families.generate( families.FAMILIES[ f ], ps[ p ], n, 4242 ).B ] );
			t.strictEqual( h1, h2, families.FAMILIES[ f ] + ' ' + families.paramsKey( ps[ p ] ) + ' deterministic' );
			t.notEqual( h1, records.sha256Arrays( [ families.generate( families.FAMILIES[ f ], ps[ p ], n, 4243 ).B ] ), 'seed changes the inputs' );
			families.checkPreconditions( n, g.A, g.B, arms.absProduct( n, n, n, g.A, g.B ) );
		}
	}
	t.end();
});

tape( 'precondition violations are rejected with a descriptive error', function test( t ) {
	var n = 2;
	var A = new Float64Array( [ 1, 2, 3, 4 ] );
	var B = new Float64Array( [ 1, 2, 3, 4 ] );
	var big = Float64Array.from( A );
	var tiny = Float64Array.from( A );
	big[ 1 ] = Math.pow( 2, 996 );
	tiny[ 0 ] = Math.pow( 2, -500 );
	t.throws( function f() {
		families.checkPreconditions( n, big, B, null );
	}, /2\^996/, '|a| >= 2^996' );
	t.throws( function f() {
		families.checkPreconditions( n, tiny, tiny, null );
	}, /2\^-969/, 'nonzero product below 2^-969' );
	t.throws( function f() {
		families.checkPreconditions( n, A, B, new Float64Array( [ 1, Infinity, 1, 1 ] ) );
	}, /finite/, '|A||B| not finite' );
	t.doesNotThrow( function f() {
		families.checkPreconditions( n, A, B, null );
	}, 'benign inputs pass' );
	t.end();
});

tape( 'F7 (Pascal) is only defined for n <= 128', function test( t ) {
	t.throws( function f() {
		families.generate( 'F7', {}, 129, 1 );
	}, /n <= 128/, 'n = 129 rejected' );
	t.ok( families.generate( 'F7', {}, 128, 1 ).A[ ( 128*128 )-1 ] > Math.pow( 2, 249 ), 'max Pascal entry ~2^249.6 at n = 128' );
	t.end();
});

tape( 'F10 signs equal the Kronecker product s⊗s⊗s (n = 8) and the exact product of the pure sign matrices is zero', function test( t ) {
	var s = [ [ -1, -1 ], [ 1, 1 ] ];
	var tt = [ [ 1, -1 ], [ -1, 1 ] ];
	var ok = true;
	var A = new Float64Array( 64 );
	var B = new Float64Array( 64 );
	var C = new Float64Array( 64 );
	var i;
	var j;
	var v;
	for ( i = 0; i < 8; i++ ) {
		for ( j = 0; j < 8; j++ ) {
			v = s[ ( i>>2 )&1 ][ ( j>>2 )&1 ] * s[ ( i>>1 )&1 ][ ( j>>1 )&1 ] * s[ i&1 ][ j&1 ];
			ok = ok && ( families.kronSign( i, j, 8, 8, 64, s ) === v );
			A[ ( i*8 )+j ] = families.kronSign( i, j, 8, 8, 64, s );
			B[ ( i*8 )+j ] = families.kronSign( i, j, 8, 8, 64, tt );
		}
	}
	t.ok( ok, 'pattern matches' );
	arms.run( { 'alg': 'A0', 'levels': 0 }, 8, 8, 8, A, B, C );
	t.ok( C.every( function zero( x ) {
		return x === 0;
	}), 'A·B = 0' );
	t.end();
});

tape( 'F11 inputs are exact under every arm: SW, V1 at the deepest level and A0 all equal dgemm bitwise', function test( t ) {
	var n = 64;
	var kinds = [ 'int', 'dyadic' ];
	var C0 = new Float64Array( n*n );
	var C = new Float64Array( n*n );
	var algs = [ 'SW', 'V1' ];
	var g;
	var k;
	var a;
	t.strictEqual( families.exactBits( 64, 6 ), 16, 'safe bits at K = 64, L = 6' );
	for ( k = 0; k < kinds.length; k++ ) {
		g = families.generate( 'F11', { 'kind': kinds[ k ] }, n, 77 );
		arms.run( { 'alg': 'A0', 'levels': 0 }, n, n, n, g.A, g.B, C0 );
		for ( a = 0; a < algs.length; a++ ) {
			arms.run( { 'alg': algs[ a ], 'levels': 6 }, n, n, n, g.A, g.B, C );
			t.ok( C.every( function same( x, i ) {
				return Object.is( x, C0[ i ] );
			}), kinds[ k ] + ': ' + algs[ a ] + ' L=6 equals dgemm' );
		}
		t.strictEqual( exact.toDouble( exact.dot( n, g.A, 1, 0, g.B, n, 0, false ) ), C0[ 0 ], kinds[ k ] + ': dgemm entry (0,0) equals the exact dot product' );
	}
	t.end();
});

tape( 'GenDot achieves the requested condition number to within the expected spread', function test( t ) {
	var u = rng.uniform( 2024 );
	var cs = [ 1e4, 1e8, 1e12, 1e16 ];
	var k;
	var c;
	var v;
	var d;
	var a;
	var i;
	for ( i = 0; i < cs.length; i++ ) {
		for ( k = 0; k < 5; k++ ) {
			v = genDot( 64, cs[ i ], u );
			d = exact.dot( 64, v.x, 1, 0, v.y, 1, 0, false );
			a = exact.dot( 64, v.x, 1, 0, v.y, 1, 0, true );
			c = Math.log10( 2.0 * exact.ratio( a, d ) );
			t.ok( c > Math.log10( cs[ i ] ) - 1.5 && c < Math.log10( cs[ i ] ) + 3.5, 'c = ' + cs[ i ].toExponential( 0 ) + ': log10 cond = ' + c.toFixed( 2 ) );
		}
	}
	t.end();
});
