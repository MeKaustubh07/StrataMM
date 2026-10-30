/**
* @license Apache-2.0
*
* Copyright (c) 2026 The Stdlib Authors.
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*    http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

/* eslint-disable max-len, max-params */

'use strict';

// Research control C2 (protocol §3): an eight-product 2×2 block recursion that shares the Strassen–Winograd
// recursion's split rule (floor halves), cutoff criterion, level cap, dynamic peeling and leaf kernel (the public
// `dgemm.ndarray`, called with 'no-transpose' and the caller's strides), but performs eight half-size products and no
// matrix additions. Ported from `poc/lib/classic.js`, plus a `levels` cap and transpose resolution identical to
// `dgemmsw/lib/base.js`. Not leaf-equivalent to SW: its leaves read the caller's arrays (leading dimension LD), whereas
// most SW leaves read compact workspace temporaries; the padded-LD arm of E3 separates the two effects.

// MODULES //

var dgemm = require( '@stdlib/blas/base/dgemm' ).ndarray;
var isfinite = require( '@stdlib/math/base/assert/is-finite' );
var floor = require( '@stdlib/math/base/special/floor' );


// VARIABLES //

var NT = 'no-transpose';


// FUNCTIONS //

/**
* Tests whether a provided string indicates to transpose a matrix (same rule as `dgemmsw/lib/base.js`).
*
* @private
* @param {string} str - transpose operation
* @returns {boolean} boolean indicating whether to transpose
*/
function isTransposed( str ) {
	return ( str !== 'no-transpose' );
}

/**
* Returns the number of recursion levels performed for a given problem size (same rule as `dgemmsw/lib/depth.js`).
*
* @param {NonNegativeInteger} M - rows of `op(A)` and `C`
* @param {NonNegativeInteger} N - columns of `op(B)` and `C`
* @param {NonNegativeInteger} K - columns of `op(A)` and rows of `op(B)`
* @param {PositiveInteger} cutoff - recursion cutoff
* @param {NonNegativeInteger} levels - maximum number of recursion levels
* @returns {NonNegativeInteger} number of levels
*
* @example
* var d = depth( 1024, 1024, 1024, 64, 4 );
* // returns 4
*/
function depth( M, N, K, cutoff, levels ) {
	var d = 0;
	while ( d < levels && M > cutoff && N > cutoff && K > cutoff ) {
		M = floor( M/2 );
		N = floor( N/2 );
		K = floor( K/2 );
		d += 1;
	}
	return d;
}

/**
* Recursive eight-product kernel computing `C = α*A*B + β*C` for non-transposed (stride-resolved) operands.
*
* @param {NonNegativeInteger} M - rows of `A` and `C`
* @param {NonNegativeInteger} N - columns of `B` and `C`
* @param {NonNegativeInteger} K - columns of `A` and rows of `B`
* @param {number} alpha - scalar constant
* @param {Float64Array} A - first matrix
* @param {integer} strideA1 - stride of the first dimension of `A`
* @param {integer} strideA2 - stride of the second dimension of `A`
* @param {NonNegativeInteger} offsetA - starting index for `A`
* @param {Float64Array} B - second matrix
* @param {integer} strideB1 - stride of the first dimension of `B`
* @param {integer} strideB2 - stride of the second dimension of `B`
* @param {NonNegativeInteger} offsetB - starting index for `B`
* @param {number} beta - scalar constant
* @param {Float64Array} C - output matrix
* @param {integer} strideC1 - stride of the first dimension of `C`
* @param {integer} strideC2 - stride of the second dimension of `C`
* @param {NonNegativeInteger} offsetC - starting index for `C`
* @param {PositiveInteger} cutoff - recursion cutoff
* @param {NonNegativeInteger} levels - remaining recursion levels
* @returns {Float64Array} `C`
*/
function recurse( M, N, K, alpha, A, strideA1, strideA2, offsetA, B, strideB1, strideB2, offsetB, beta, C, strideC1, strideC2, offsetC, cutoff, levels ) {
	var a12;
	var a21;
	var a22;
	var b12;
	var b21;
	var b22;
	var c12;
	var c21;
	var c22;
	var lvl;
	var m;
	var n;
	var k;

	// Base case (identical criterion to `winograd.js`):
	if ( levels <= 0 || M <= cutoff || N <= cutoff || K <= cutoff ) {
		return dgemm( NT, NT, M, N, K, alpha, A, strideA1, strideA2, offsetA, B, strideB1, strideB2, offsetB, beta, C, strideC1, strideC2, offsetC );
	}
	lvl = levels - 1;

	// Even-dimensioned leading block (dynamic peeling, identical to `winograd.js`):
	m = floor( M/2 );
	n = floor( N/2 );
	k = floor( K/2 );

	a12 = offsetA + ( k*strideA2 );
	a21 = offsetA + ( m*strideA1 );
	a22 = a21 + ( k*strideA2 );
	b12 = offsetB + ( n*strideB2 );
	b21 = offsetB + ( k*strideB1 );
	b22 = b21 + ( n*strideB2 );
	c12 = offsetC + ( n*strideC2 );
	c21 = offsetC + ( m*strideC1 );
	c22 = c21 + ( n*strideC2 );

	// C11 = α*A11*B11 + β*C11 + α*A12*B21
	recurse( m, n, k, alpha, A, strideA1, strideA2, offsetA, B, strideB1, strideB2, offsetB, beta, C, strideC1, strideC2, offsetC, cutoff, lvl );
	recurse( m, n, k, alpha, A, strideA1, strideA2, a12, B, strideB1, strideB2, b21, 1.0, C, strideC1, strideC2, offsetC, cutoff, lvl );

	// C12 = α*A11*B12 + β*C12 + α*A12*B22
	recurse( m, n, k, alpha, A, strideA1, strideA2, offsetA, B, strideB1, strideB2, b12, beta, C, strideC1, strideC2, c12, cutoff, lvl );
	recurse( m, n, k, alpha, A, strideA1, strideA2, a12, B, strideB1, strideB2, b22, 1.0, C, strideC1, strideC2, c12, cutoff, lvl );

	// C21 = α*A21*B11 + β*C21 + α*A22*B21
	recurse( m, n, k, alpha, A, strideA1, strideA2, a21, B, strideB1, strideB2, offsetB, beta, C, strideC1, strideC2, c21, cutoff, lvl );
	recurse( m, n, k, alpha, A, strideA1, strideA2, a22, B, strideB1, strideB2, b21, 1.0, C, strideC1, strideC2, c21, cutoff, lvl );

	// C22 = α*A21*B12 + β*C22 + α*A22*B22
	recurse( m, n, k, alpha, A, strideA1, strideA2, a21, B, strideB1, strideB2, b12, beta, C, strideC1, strideC2, c22, cutoff, lvl );
	recurse( m, n, k, alpha, A, strideA1, strideA2, a22, B, strideB1, strideB2, b22, 1.0, C, strideC1, strideC2, c22, cutoff, lvl );

	// Dynamic peeling (same three updates and order as `winograd.js`; β applied here because there is no separate P temporary):
	if ( 2*k < K ) {
		// C[0:2m,0:2n] += α * A[0:2m,K-1] * B[K-1,0:2n]
		dgemm( NT, NT, 2*m, 2*n, 1, alpha, A, strideA1, strideA2, offsetA+( (K-1)*strideA2 ), B, strideB1, strideB2, offsetB+( (K-1)*strideB1 ), 1.0, C, strideC1, strideC2, offsetC );
	}
	if ( 2*n < N ) {
		// C[0:2m,N-1] = α * A[0:2m,0:K] * B[0:K,N-1] + β * C[0:2m,N-1]
		dgemm( NT, NT, 2*m, 1, K, alpha, A, strideA1, strideA2, offsetA, B, strideB1, strideB2, offsetB+( (N-1)*strideB2 ), beta, C, strideC1, strideC2, offsetC+( (N-1)*strideC2 ) );
	}
	if ( 2*m < M ) {
		// C[M-1,0:N] = α * A[M-1,0:K] * B[0:K,0:N] + β * C[M-1,0:N]
		dgemm( NT, NT, 1, N, K, alpha, A, strideA1, strideA2, offsetA+( (M-1)*strideA1 ), B, strideB1, strideB2, offsetB, beta, C, strideC1, strideC2, offsetC+( (M-1)*strideC1 ) );
	}
	return C;
}


// MAIN //

/**
* Computes `C = α*op(A)*op(B) + β*C` with the eight-product recursion control (C2).
*
* ## Notes
*
* -   Argument order and the trailing `cutoff, levels` parameters match `dgemmsw/lib/base.js`.
* -   Quick returns are dgemm's. Problems which would not recurse (depth 0), `α = 0`, `K = 0` and non-finite `α`/`β` are delegated to `dgemm` with the original arguments, as in `base.js`. Unlike `base.js`, no `maxAbs` scans are performed (the eight-product recursion cannot overflow where `dgemm` does not).
* -   Transposes are resolved by swapping strides; leaves call `dgemm.ndarray` with 'no-transpose'.
*
* @param {string} transA - transpose operation for `A`
* @param {string} transB - transpose operation for `B`
* @param {NonNegativeInteger} M - rows of `op(A)` and `C`
* @param {NonNegativeInteger} N - columns of `op(B)` and `C`
* @param {NonNegativeInteger} K - columns of `op(A)` and rows of `op(B)`
* @param {number} alpha - scalar constant
* @param {Float64Array} A - first matrix
* @param {integer} strideA1 - stride of the first dimension of `A`
* @param {integer} strideA2 - stride of the second dimension of `A`
* @param {NonNegativeInteger} offsetA - starting index for `A`
* @param {Float64Array} B - second matrix
* @param {integer} strideB1 - stride of the first dimension of `B`
* @param {integer} strideB2 - stride of the second dimension of `B`
* @param {NonNegativeInteger} offsetB - starting index for `B`
* @param {number} beta - scalar constant
* @param {Float64Array} C - output matrix
* @param {integer} strideC1 - stride of the first dimension of `C`
* @param {integer} strideC2 - stride of the second dimension of `C`
* @param {NonNegativeInteger} offsetC - starting index for `C`
* @param {PositiveInteger} cutoff - recursion cutoff
* @param {NonNegativeInteger} levels - maximum number of recursion levels
* @returns {Float64Array} `C`
*
* @example
* var A = new Float64Array( [ 1.0, 2.0, 3.0, 4.0 ] );
* var B = new Float64Array( [ 5.0, 6.0, 7.0, 8.0 ] );
* var C = new Float64Array( 4 );
*
* classic( 'no-transpose', 'no-transpose', 2, 2, 2, 1.0, A, 2, 1, 0, B, 2, 1, 0, 0.0, C, 2, 1, 0, 1, 4 );
* // C => <Float64Array>[ 19.0, 22.0, 43.0, 50.0 ]
*/
function classic( transA, transB, M, N, K, alpha, A, strideA1, strideA2, offsetA, B, strideB1, strideB2, offsetB, beta, C, strideC1, strideC2, offsetC, cutoff, levels ) {
	var sa1;
	var sa2;
	var sb1;
	var sb2;

	if ( M === 0 || N === 0 || ( ( beta === 1.0 ) && ( ( alpha === 0.0 ) || ( K === 0 ) ) ) ) {
		return C;
	}
	if ( depth( M, N, K, cutoff, levels ) === 0 || alpha === 0.0 || K === 0 || !isfinite( alpha ) || !isfinite( beta ) ) {
		return dgemm( transA, transB, M, N, K, alpha, A, strideA1, strideA2, offsetA, B, strideB1, strideB2, offsetB, beta, C, strideC1, strideC2, offsetC );
	}
	if ( isTransposed( transA ) ) {
		sa1 = strideA2;
		sa2 = strideA1;
	} else {
		sa1 = strideA1;
		sa2 = strideA2;
	}
	if ( isTransposed( transB ) ) {
		sb1 = strideB2;
		sb2 = strideB1;
	} else {
		sb1 = strideB1;
		sb2 = strideB2;
	}
	return recurse( M, N, K, alpha, A, sa1, sa2, offsetA, B, sb1, sb2, offsetB, beta, C, strideC1, strideC2, offsetC, cutoff, levels );
}


// EXPORTS //

module.exports = classic;
module.exports.depth = depth;
module.exports.recurse = recurse;
