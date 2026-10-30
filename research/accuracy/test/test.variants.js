'use strict';

// V1 (classic Strassen-18) and V2 (scaled SW) are exact on integer inputs, so they must equal dgemm bitwise over the
// whole C buffer (all layouts, transposes, LD padding, offsets, negative strides, α, β); plus behavioral checks on
// real inputs (V1 is a genuinely different algorithm within its bound; V2 repairs outside-scaled inputs).

// MODULES //

var tape = require( 'tape' );
var dgemm = require( '@stdlib/blas/base/dgemm' ).ndarray;
var strassen18 = require( './../strassen18.js' );
var scaledSW = require( './../scaling.js' );
var families = require( './../families.js' );
var reference = require( './../reference.js' );
var metrics = require( './../metrics.js' );
var arms = require( './../arms.js' );
var rng = require( './../rng.js' );
var e1 = require( './../../correctness/e1_trial.js' );


// VARIABLES //

var TRANS = [ 'no-transpose', 'transpose' ];
var ALPHAS = [ 1.0, -1.0, 0.5, 2.0, 0.0, -0.75 ];
var BETAS = [ 0.0, 0.0, 1.0, -1.0, 0.5 ];


// FUNCTIONS //

/**
* Runs randomized exact differential trials of an implementation against dgemm.
*
* @private
* @param {Function} impl - implementation (dgemm-like signature + cutoff, levels)
* @param {PositiveInteger} trials - number of trials
* @param {PositiveInteger} seed - seed
* @returns {Object} `{ mismatches, recursive, first }`
*/
function differential( impl, trials, seed ) {
	var out = {
		'mismatches': 0,
		'recursive': 0,
		'first': null
	};
	var ri = rng.int( seed );
	var alpha;
	var beta;
	var C1;
	var C2;
	var ta;
	var tb;
	var cut;
	var lev;
	var A;
	var B;
	var C;
	var M;
	var N;
	var K;
	var t;
	var i;
	var eq;
	for ( t = 0; t < trials; t++ ) {
		M = ri( 0, 40 );
		N = ri( 0, 40 );
		K = ri( 0, 40 );
		ta = TRANS[ ri( 0, 1 ) ];
		tb = TRANS[ ri( 0, 1 ) ];
		alpha = ALPHAS[ ri( 0, ALPHAS.length-1 ) ];
		beta = BETAS[ ri( 0, BETAS.length-1 ) ];
		cut = ri( 1, 3 );
		lev = ri( 1, 4 );
		A = ( ta === TRANS[ 0 ] ) ? e1.createMatrix( ri, M, K ) : e1.createMatrix( ri, K, M );
		B = ( tb === TRANS[ 0 ] ) ? e1.createMatrix( ri, K, N ) : e1.createMatrix( ri, N, K );
		C = e1.createMatrix( ri, M, N );
		e1.fillLogical( A, ta !== TRANS[ 0 ], M, K, small );
		e1.fillLogical( B, tb !== TRANS[ 0 ], K, N, small );
		if ( beta !== 0.0 ) {
			e1.fillLogical( C, false, M, N, small );
		}
		C1 = Float64Array.from( C.buf );
		C2 = Float64Array.from( C.buf );
		dgemm( ta, tb, M, N, K, alpha, A.buf, A.s1, A.s2, A.o, B.buf, B.s1, B.s2, B.o, beta, C1, C.s1, C.s2, C.o );
		impl( ta, tb, M, N, K, alpha, A.buf, A.s1, A.s2, A.o, B.buf, B.s1, B.s2, B.o, beta, C2, C.s1, C.s2, C.o, cut, lev );
		if ( M > cut && N > cut && K > cut && alpha !== 0.0 ) {
			out.recursive += 1;
		}
		eq = ( beta === 0.0 ) ? Object.is : e1.sameNaN;
		for ( i = 0; i < C1.length; i++ ) {
			if ( !eq( C1[ i ], C2[ i ] ) ) {
				out.mismatches += 1;
				if ( !out.first ) {
					out.first = [ ta, tb, M, N, K, alpha, beta, cut, lev, i, C1[ i ], C2[ i ] ].join( ',' );
				}
				break;
			}
		}
	}
	return out;

	function small() {
		return ri( -16, 16 );
	}
}

function errors( n, family, params, seed, alg, L ) {
	var g = families.generate( family, params, n, seed );
	var ref = reference.computeSerial( n, n, n, g.A, g.B );
	var C = new Float64Array( n*n ).fill( NaN );
	var maxA = 0.0;
	var maxB = 0.0;
	var i;
	for ( i = 0; i < n*n; i++ ) {
		maxA = Math.max( maxA, Math.abs( g.A[ i ] ) );
		maxB = Math.max( maxB, Math.abs( g.B[ i ] ) );
	}
	arms.run( { 'alg': alg, 'levels': L }, n, n, n, g.A, g.B, C, {} );
	return {
		'C': C,
		'm': metrics.compute( {
			'M': n,
			'N': n,
			'K': n,
			'L': arms.levelsPerformed( { 'alg': alg, 'levels': L }, n, n, n ),
			'C': C,
			'hi': ref.hi,
			'lo': ref.lo,
			'AB': arms.absProduct( n, n, n, g.A, g.B ),
			'maxA': maxA,
			'maxB': maxB
		}).metrics
	};
}


// TESTS //

tape( 'V1 (classic Strassen-18) equals dgemm bitwise on integer inputs (layouts, transposes, padding, offsets, negative strides, α, β)', function test( t ) {
	var r = differential( strassen18, 1500, 1801 );
	t.strictEqual( r.mismatches, 0, '1500 trials, ' + r.recursive + ' recursive; first mismatch: ' + r.first );
	t.ok( r.recursive > 900, 'most trials recurse' );
	t.end();
});

tape( 'V2 (outside+inside power-of-two scaled SW) equals dgemm bitwise on integer inputs', function test( t ) {
	var r = differential( scaledSW, 1500, 1802 );
	t.strictEqual( r.mismatches, 0, '1500 trials, ' + r.recursive + ' recursive; first mismatch: ' + r.first );
	t.end();
});

tape( 'V1 is a genuinely different algorithm on real inputs and stays within the Strassen bound f_S', function test( t ) {
	var a0 = errors( 64, 'F2', {}, 7, 'A0', 0 );
	var sw = errors( 64, 'F2', {}, 7, 'SW', 2 );
	var v1;
	var L;
	var d;
	var i;
	for ( L = 1; L <= 3; L++ ) {
		v1 = errors( 64, 'F2', {}, 7, 'V1', L );
		d = 0;
		for ( i = 0; i < v1.C.length; i++ ) {
			d += ( v1.C[ i ] !== a0.C[ i ] ) ? 1 : 0;
		}
		t.ok( d > 1000, 'L=' + L + ': ' + d + ' entries differ from dgemm' );
		t.ok( v1.m.eta_N < metrics.fS( 64, L ), 'L=' + L + ': eta_N ' + v1.m.eta_N.toFixed( 1 ) + ' < f_S ' + metrics.fS( 64, L ).toExponential( 2 ) );
	}
	v1 = errors( 64, 'F2', {}, 7, 'V1', 2 );
	d = 0;
	for ( i = 0; i < v1.C.length; i++ ) {
		d += ( v1.C[ i ] !== sw.C[ i ] ) ? 1 : 0;
	}
	t.ok( d > 1000, 'V1 differs from SW at L=2 (' + d + ' entries)' );
	t.end();
});

tape( 'V2 repairs the componentwise collapse of SW on outside-scaled inputs (F4, s = 20) and inside-scaled inputs (F5)', function test( t ) {
	var sw = errors( 64, 'F4', { 's': 20 }, 9, 'SW', 2 ).m;
	var v2 = errors( 64, 'F4', { 's': 20 }, 9, 'V2', 2 ).m;
	t.ok( sw.eta_C.max > 1e12, 'SW eta_C ' + sw.eta_C.max.toExponential( 2 ) );
	t.ok( v2.eta_C.max < 1e3, 'V2 eta_C ' + v2.eta_C.max.toExponential( 2 ) );
	t.strictEqual( v2.rel.frac_ge1, 0, 'V2 leaves no entry without a correct digit' );
	sw = errors( 64, 'F5', { 's': 20 }, 9, 'SW', 2 ).m;
	v2 = errors( 64, 'F5', { 's': 20 }, 9, 'V2', 2 ).m;
	t.ok( v2.eta_R < sw.eta_R / 1e6, 'F5: V2 eta_R ' + v2.eta_R.toExponential( 2 ) + ' vs SW ' + sw.eta_R.toExponential( 2 ) );
	t.end();
});

tape( 'V2 reports inexact scaling when a scaled entry underflows (exactness is checked, not assumed)', function test( t ) {
	var A = new Float64Array( [ Math.pow( 2, 1000 ), Math.pow( 2, -1070 ), 1.0, 1.0 ] );
	var B = new Float64Array( [ 1.0, 1.0, 1.0, 1.0 ] );
	var C = new Float64Array( 4 );
	var stats = {};
	scaledSW( 'no-transpose', 'no-transpose', 2, 2, 2, 1.0, A, 2, 1, 0, B, 2, 1, 0, 0.0, C, 2, 1, 0, 1, 1, stats );
	t.ok( stats.scale_inexact > 0, 'scale_inexact = ' + stats.scale_inexact );
	scaledSW( 'no-transpose', 'no-transpose', 2, 2, 2, 1.0, B, 2, 1, 0, B, 2, 1, 0, 0.0, C, 2, 1, 0, 1, 1, stats );
	t.strictEqual( stats.scale_inexact, 0, 'benign input scales exactly' );
	t.end();
});
