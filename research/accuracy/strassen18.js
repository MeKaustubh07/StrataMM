'use strict';

// V1: classic Strassen (7 products, 18 additions) with the library's split rule, cutoff criterion, level cap, dynamic
// peeling and `dgemm` leaves. ACCURACY ARM ONLY (not optimized; never timed).

// MODULES //

var isRowMajor = require( '@stdlib/ndarray/base/assert/is-row-major' );
var dgemm = require( '@stdlib/blas/base/dgemm' ).ndarray;
var paths = require( './paths.js' );
var depth = require( paths.DEPTH );
var k = require( './kernels.js' );


// VARIABLES //

var NT = 'no-transpose';


// FUNCTIONS //

/**
* Returns the workspace length: per level, S (m×k), T (k×n) and X (m×n).
*
* @param {NonNegativeInteger} M - rows of op(A)
* @param {NonNegativeInteger} N - columns of op(B)
* @param {NonNegativeInteger} K - inner dimension
* @param {PositiveInteger} cutoff - recursion cutoff
* @param {NonNegativeInteger} levels - maximum levels
* @returns {NonNegativeInteger} number of elements
*/
function workspaceLength( M, N, K, cutoff, levels ) {
	var len = 0;
	var d = 0;
	var m;
	var n;
	var q;
	while ( d < levels && M > cutoff && N > cutoff && K > cutoff ) {
		m = Math.floor( M/2 );
		n = Math.floor( N/2 );
		q = Math.floor( K/2 );
		len += ( m*q ) + ( q*n ) + ( m*n );
		M = m;
		N = n;
		K = q;
		d += 1;
	}
	return len;
}

/**
* Recursively computes C = α·A·B (C overwritten) with classic Strassen.
*
* ## Notes
*
* -   M1 = (A11+A22)(B11+B22), M2 = (A21+A22)B11, M3 = A11(B12−B22), M4 = A22(B21−B11), M5 = (A11+A12)B22,
*     M6 = (A21−A11)(B11+B12), M7 = (A12−A22)(B21+B22); C11 = ((M1+M4)−M5)+M7, C12 = M3+M5, C21 = M2+M4,
*     C22 = ((M1−M2)+M3)+M6 (left to right; copies are exact and not counted).
*
* @private
* @returns {Float64Array} C
*/
function rec( M, N, K, alpha, A, sa1, sa2, oa, B, sb1, sb2, ob, C, sc1, sc2, oc, W, ow, cutoff, levels ) { // eslint-disable-line max-params, max-statements
	var a12;
	var a21;
	var a22;
	var b12;
	var b21;
	var b22;
	var c12;
	var c21;
	var c22;
	var ss1;
	var ss2;
	var st1;
	var st2;
	var sx1;
	var sx2;
	var os;
	var ot;
	var ox;
	var nw;
	var m;
	var n;
	var q;
	var l;

	if ( levels <= 0 || M <= cutoff || N <= cutoff || K <= cutoff ) {
		return dgemm( NT, NT, M, N, K, alpha, A, sa1, sa2, oa, B, sb1, sb2, ob, 0.0, C, sc1, sc2, oc );
	}
	l = levels - 1;
	m = Math.floor( M/2 );
	n = Math.floor( N/2 );
	q = Math.floor( K/2 );
	a12 = oa + ( q*sa2 );
	a21 = oa + ( m*sa1 );
	a22 = a21 + ( q*sa2 );
	b12 = ob + ( n*sb2 );
	b21 = ob + ( q*sb1 );
	b22 = b21 + ( n*sb2 );
	c12 = oc + ( n*sc2 );
	c21 = oc + ( m*sc1 );
	c22 = c21 + ( n*sc2 );

	// Temporaries mirror the layouts of the matrices they stand in for...
	os = ow;
	ot = os + ( m*q );
	ox = ot + ( q*n );
	nw = ox + ( m*n );
	if ( isRowMajor( [ sa1, sa2 ] ) ) {
		ss1 = q;
		ss2 = 1;
	} else {
		ss1 = 1;
		ss2 = m;
	}
	if ( isRowMajor( [ sb1, sb2 ] ) ) {
		st1 = n;
		st2 = 1;
	} else {
		st1 = 1;
		st2 = q;
	}
	if ( isRowMajor( [ sc1, sc2 ] ) ) {
		sx1 = n;
		sx2 = 1;
	} else {
		sx1 = 1;
		sx2 = m;
	}

	// C11 = M1 = (A11 + A22)(B11 + B22); C22 = M1
	k.add( m, q, A, sa1, sa2, oa, A, sa1, sa2, a22, W, ss1, ss2, os );
	k.add( q, n, B, sb1, sb2, ob, B, sb1, sb2, b22, W, st1, st2, ot );
	rec( m, n, q, alpha, W, ss1, ss2, os, W, st1, st2, ot, C, sc1, sc2, oc, W, nw, cutoff, l );
	k.copy( m, n, C, sc1, sc2, oc, C, sc1, sc2, c22 );

	// X = M4 = A22(B21 − B11); C11 += X; C21 = X
	k.sub( q, n, B, sb1, sb2, b21, B, sb1, sb2, ob, W, st1, st2, ot );
	rec( m, n, q, alpha, A, sa1, sa2, a22, W, st1, st2, ot, W, sx1, sx2, ox, W, nw, cutoff, l );
	k.add( m, n, C, sc1, sc2, oc, W, sx1, sx2, ox, C, sc1, sc2, oc );
	k.copy( m, n, W, sx1, sx2, ox, C, sc1, sc2, c21 );

	// X = M5 = (A11 + A12)B22; C11 −= X; C12 = X
	k.add( m, q, A, sa1, sa2, oa, A, sa1, sa2, a12, W, ss1, ss2, os );
	rec( m, n, q, alpha, W, ss1, ss2, os, B, sb1, sb2, b22, W, sx1, sx2, ox, W, nw, cutoff, l );
	k.sub( m, n, C, sc1, sc2, oc, W, sx1, sx2, ox, C, sc1, sc2, oc );
	k.copy( m, n, W, sx1, sx2, ox, C, sc1, sc2, c12 );

	// X = M7 = (A12 − A22)(B21 + B22); C11 += X
	k.sub( m, q, A, sa1, sa2, a12, A, sa1, sa2, a22, W, ss1, ss2, os );
	k.add( q, n, B, sb1, sb2, b21, B, sb1, sb2, b22, W, st1, st2, ot );
	rec( m, n, q, alpha, W, ss1, ss2, os, W, st1, st2, ot, W, sx1, sx2, ox, W, nw, cutoff, l );
	k.add( m, n, C, sc1, sc2, oc, W, sx1, sx2, ox, C, sc1, sc2, oc );

	// X = M2 = (A21 + A22)B11; C21 += X; C22 −= X
	k.add( m, q, A, sa1, sa2, a21, A, sa1, sa2, a22, W, ss1, ss2, os );
	rec( m, n, q, alpha, W, ss1, ss2, os, B, sb1, sb2, ob, W, sx1, sx2, ox, W, nw, cutoff, l );
	k.add( m, n, C, sc1, sc2, c21, W, sx1, sx2, ox, C, sc1, sc2, c21 );
	k.sub( m, n, C, sc1, sc2, c22, W, sx1, sx2, ox, C, sc1, sc2, c22 );

	// X = M3 = A11(B12 − B22); C12 += X; C22 += X
	k.sub( q, n, B, sb1, sb2, b12, B, sb1, sb2, b22, W, st1, st2, ot );
	rec( m, n, q, alpha, A, sa1, sa2, oa, W, st1, st2, ot, W, sx1, sx2, ox, W, nw, cutoff, l );
	k.add( m, n, C, sc1, sc2, c12, W, sx1, sx2, ox, C, sc1, sc2, c12 );
	k.add( m, n, C, sc1, sc2, c22, W, sx1, sx2, ox, C, sc1, sc2, c22 );

	// X = M6 = (A21 − A11)(B11 + B12); C22 += X
	k.sub( m, q, A, sa1, sa2, a21, A, sa1, sa2, oa, W, ss1, ss2, os );
	k.add( q, n, B, sb1, sb2, ob, B, sb1, sb2, b12, W, st1, st2, ot );
	rec( m, n, q, alpha, W, ss1, ss2, os, W, st1, st2, ot, W, sx1, sx2, ox, W, nw, cutoff, l );
	k.add( m, n, C, sc1, sc2, c22, W, sx1, sx2, ox, C, sc1, sc2, c22 );

	// Dynamic peeling (identical to the library's Strassen–Winograd recursion)...
	if ( 2*q < K ) {
		dgemm( NT, NT, 2*m, 2*n, 1, alpha, A, sa1, sa2, oa+( ( K-1 )*sa2 ), B, sb1, sb2, ob+( ( K-1 )*sb1 ), 1.0, C, sc1, sc2, oc );
	}
	if ( 2*n < N ) {
		dgemm( NT, NT, 2*m, 1, K, alpha, A, sa1, sa2, oa, B, sb1, sb2, ob+( ( N-1 )*sb2 ), 0.0, C, sc1, sc2, oc+( ( N-1 )*sc2 ) );
	}
	if ( 2*m < M ) {
		dgemm( NT, NT, 1, N, K, alpha, A, sa1, sa2, oa+( ( M-1 )*sa1 ), B, sb1, sb2, ob, 0.0, C, sc1, sc2, oc+( ( M-1 )*sc1 ) );
	}
	return C;
}

/**
* Computes `C = α·op(A)·op(B) + β·C` with classic Strassen (dgemm-like signature; same quick returns and delegation
* of non-recursive/degenerate cases to `dgemm` as the library, but no overflow guard).
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
* @param {PositiveInteger} cutoff - recursion cutoff
* @param {NonNegativeInteger} levels - maximum levels
* @returns {Float64Array} C
*/
function strassen18( transA, transB, M, N, K, alpha, A, sa1, sa2, oa, B, sb1, sb2, ob, beta, C, sc1, sc2, oc, cutoff, levels ) { // eslint-disable-line max-params
	var len;
	var t1;
	var t2;
	var W;
	var L;
	if ( M === 0 || N === 0 || ( beta === 1.0 && ( alpha === 0.0 || K === 0 ) ) ) {
		return C;
	}
	L = depth( M, N, K, cutoff, levels );
	if ( L === 0 || alpha === 0.0 || K === 0 || !isFinite( alpha ) || !isFinite( beta ) ) {
		return dgemm( transA, transB, M, N, K, alpha, A, sa1, sa2, oa, B, sb1, sb2, ob, beta, C, sc1, sc2, oc );
	}
	if ( transA !== NT ) {
		t1 = sa1;
		sa1 = sa2;
		sa2 = t1;
	}
	if ( transB !== NT ) {
		t2 = sb1;
		sb1 = sb2;
		sb2 = t2;
	}
	len = workspaceLength( M, N, K, cutoff, levels );
	if ( beta === 0.0 ) {
		W = new Float64Array( len );
		return rec( M, N, K, alpha, A, sa1, sa2, oa, B, sb1, sb2, ob, C, sc1, sc2, oc, W, 0, cutoff, levels );
	}
	// Form P = α·op(A)·op(B) in a temporary with C's layout, then C = P + β·C...
	W = new Float64Array( ( M*N ) + len );
	if ( isRowMajor( [ sc1, sc2 ] ) ) {
		t1 = N;
		t2 = 1;
	} else {
		t1 = 1;
		t2 = M;
	}
	rec( M, N, K, alpha, A, sa1, sa2, oa, B, sb1, sb2, ob, W, t1, t2, 0, W, M*N, cutoff, levels );
	return k.xpbz( M, N, W, t1, t2, 0, beta, C, sc1, sc2, oc );
}


// EXPORTS //

module.exports = strassen18;
module.exports.workspaceLength = workspaceLength;
