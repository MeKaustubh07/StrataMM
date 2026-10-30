'use strict';

// V2: Strassen–Winograd (`base()`) with outside + inside diagonal scaling by powers of two (Ballard et al. 2016,
// doi:10.1137/15M1032168, Alg. 1): A' = Da·A, B' = B·Db (rows of A / columns of B scaled to max ≈ 1), then
// A'' = A'·D, B'' = inv(D)·B' with d_k = 2^round(log2(max_j|b'_kj| / max_i|a'_ik|) / 2); C = inv(Da)·(A''B'')·inv(Db).
// Every scale factor is a power of two, so scaling and rescaling are exact (barring underflow/overflow, counted).
// ACCURACY ARM ONLY.

// MODULES //

var dgemm = require( '@stdlib/blas/base/dgemm' ).ndarray;
var ldexp = require( '@stdlib/math/base/special/ldexp' );
var exponent = require( '@stdlib/number/float64/base/exponent' );
var paths = require( './paths.js' );
var base = require( paths.BASE );


// VARIABLES //

var NT = 'no-transpose';
var TWO64 = Math.pow( 2.0, 64 );
var SMALLEST_NORMAL = Math.pow( 2.0, -1022 );


// FUNCTIONS //

/**
* Returns floor(log2(x)) for finite x > 0 (subnormals included).
*
* @private
* @param {number} x - positive finite number
* @returns {integer} exponent
*/
function ilogb( x ) {
	if ( x < SMALLEST_NORMAL ) {
		return exponent( x * TWO64 ) - 64;
	}
	return exponent( x );
}

/**
* Computes `C = α·op(A)·op(B) + β·C` with scaled Strassen–Winograd (dgemm-like signature).
*
* @param {string} transA - `op(A)`
* @param {string} transB - `op(B)`
* @param {NonNegativeInteger} M - rows of op(A) and C
* @param {NonNegativeInteger} N - columns of op(B) and C
* @param {NonNegativeInteger} K - columns of op(A), rows of op(B)
* @param {number} alpha - scalar
* @param {Float64Array} A - first matrix
* @param {integer} sa1 - first stride of A
* @param {integer} sa2 - second stride of A
* @param {NonNegativeInteger} oa - offset of A
* @param {Float64Array} B - second matrix
* @param {integer} sb1 - first stride of B
* @param {integer} sb2 - second stride of B
* @param {NonNegativeInteger} ob - offset of B
* @param {number} beta - scalar
* @param {Float64Array} C - output matrix
* @param {integer} sc1 - first stride of C
* @param {integer} sc2 - second stride of C
* @param {NonNegativeInteger} oc - offset of C
* @param {PositiveInteger} cutoff - recursion cutoff passed to `base()`
* @param {NonNegativeInteger} levels - maximum levels passed to `base()`
* @param {Object} [stats] - if provided, receives `{ scale_inexact, unscale_inexact }` counts (expected 0)
* @returns {Float64Array} C
*/
function scaledSW( transA, transB, M, N, K, alpha, A, sa1, sa2, oa, B, sb1, sb2, ob, beta, C, sc1, sc2, oc, cutoff, levels, stats ) { // eslint-disable-line max-params, max-statements
	var inexactIn = 0;
	var inexactOut = 0;
	var ea;
	var eb;
	var ek;
	var As;
	var Bs;
	var P;
	var v;
	var w;
	var t;
	var i;
	var j;
	var q;

	if ( M === 0 || N === 0 || ( beta === 1.0 && ( alpha === 0.0 || K === 0 ) ) ) {
		return C;
	}
	if ( alpha === 0.0 || K === 0 || !isFinite( alpha ) || !isFinite( beta ) ) {
		return dgemm( transA, transB, M, N, K, alpha, A, sa1, sa2, oa, B, sb1, sb2, ob, beta, C, sc1, sc2, oc );
	}
	if ( transA !== NT ) {
		t = sa1;
		sa1 = sa2;
		sa2 = t;
	}
	if ( transB !== NT ) {
		t = sb1;
		sb1 = sb2;
		sb2 = t;
	}
	// Pack op(A) (M×K) and op(B) (K×N) row-major...
	As = new Float64Array( M*K );
	Bs = new Float64Array( K*N );
	for ( i = 0; i < M; i++ ) {
		for ( q = 0; q < K; q++ ) {
			As[ ( i*K )+q ] = A[ oa + ( i*sa1 ) + ( q*sa2 ) ];
		}
	}
	for ( q = 0; q < K; q++ ) {
		for ( j = 0; j < N; j++ ) {
			Bs[ ( q*N )+j ] = B[ ob + ( q*sb1 ) + ( j*sb2 ) ];
		}
	}
	// Outside scaling: rows of A and columns of B to a maximum magnitude in [1, 2)...
	ea = new Int32Array( M );
	eb = new Int32Array( N );
	for ( i = 0; i < M; i++ ) {
		v = 0.0;
		for ( q = 0; q < K; q++ ) {
			v = Math.max( v, Math.abs( As[ ( i*K )+q ] ) );
		}
		ea[ i ] = ( v > 0.0 && isFinite( v ) ) ? ilogb( v ) : 0;
	}
	for ( j = 0; j < N; j++ ) {
		v = 0.0;
		for ( q = 0; q < K; q++ ) {
			v = Math.max( v, Math.abs( Bs[ ( q*N )+j ] ) );
		}
		eb[ j ] = ( v > 0.0 && isFinite( v ) ) ? ilogb( v ) : 0;
	}
	for ( i = 0; i < M; i++ ) {
		for ( q = 0; q < K; q++ ) {
			As[ ( i*K )+q ] = ldexp( As[ ( i*K )+q ], -ea[ i ] );
		}
	}
	for ( q = 0; q < K; q++ ) {
		for ( j = 0; j < N; j++ ) {
			Bs[ ( q*N )+j ] = ldexp( Bs[ ( q*N )+j ], -eb[ j ] );
		}
	}
	// Inside scaling: balance column k of A' against row k of B'...
	ek = new Int32Array( K );
	for ( q = 0; q < K; q++ ) {
		v = 0.0;
		w = 0.0;
		for ( i = 0; i < M; i++ ) {
			v = Math.max( v, Math.abs( As[ ( i*K )+q ] ) );
		}
		for ( j = 0; j < N; j++ ) {
			w = Math.max( w, Math.abs( Bs[ ( q*N )+j ] ) );
		}
		ek[ q ] = ( v > 0.0 && w > 0.0 && isFinite( v ) && isFinite( w ) ) ? Math.round( ( ilogb( w ) - ilogb( v ) ) / 2 ) : 0;
	}
	for ( i = 0; i < M; i++ ) {
		for ( q = 0; q < K; q++ ) {
			v = ldexp( As[ ( i*K )+q ], ek[ q ] );
			As[ ( i*K )+q ] = v;
			if ( !Object.is( ldexp( v, ea[ i ] - ek[ q ] ), A[ oa + ( i*sa1 ) + ( q*sa2 ) ] ) ) {
				inexactIn += 1;
			}
		}
	}
	for ( q = 0; q < K; q++ ) {
		for ( j = 0; j < N; j++ ) {
			v = ldexp( Bs[ ( q*N )+j ], -ek[ q ] );
			Bs[ ( q*N )+j ] = v;
			if ( !Object.is( ldexp( v, eb[ j ] + ek[ q ] ), B[ ob + ( q*sb1 ) + ( j*sb2 ) ] ) ) {
				inexactIn += 1;
			}
		}
	}
	// Multiply the scaled operands with the library, then rescale exactly...
	P = new Float64Array( M*N );
	base( NT, NT, M, N, K, alpha, As, K, 1, 0, Bs, N, 1, 0, 0.0, P, N, 1, 0, cutoff, levels );
	for ( i = 0; i < M; i++ ) {
		for ( j = 0; j < N; j++ ) {
			v = P[ ( i*N )+j ];
			w = ldexp( v, ea[ i ] + eb[ j ] );
			if ( isFinite( v ) && !Object.is( ldexp( w, -( ea[ i ] + eb[ j ] ) ), v ) ) {
				inexactOut += 1;
			}
			t = oc + ( i*sc1 ) + ( j*sc2 );
			C[ t ] = ( beta === 0.0 ) ? w : w + ( beta*C[ t ] );
		}
	}
	if ( stats ) {
		stats.scale_inexact = inexactIn;
		stats.unscale_inexact = inexactOut;
	}
	return C;
}


// EXPORTS //

module.exports = scaledSW;
