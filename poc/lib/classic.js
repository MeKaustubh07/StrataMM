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

// MODULES //

var dgemm = require( '@stdlib/blas/base/dgemm' ).ndarray;
var floor = require( '@stdlib/math/base/special/floor' );


// VARIABLES //

var NT = 'no-transpose';


// MAIN //

/**
* Computes `C = α*A*B + β*C` using a recursive 2×2 block decomposition performing eight half-size multiplications per level (i.e., the conventional algorithm).
*
* ## Notes
*
* -   This is a research control, not a library feature. It shares the Strassen–Winograd recursion's splitting rule, cutoff criterion, dynamic peeling, and base-case kernel, but performs eight rather than seven half-size multiplications and no matrix additions.
* -   It is NOT leaf-equivalent to the Strassen–Winograd recursion: every leaf here reads the caller's arrays (leading dimension `n`), whereas most Strassen–Winograd leaves read compact workspace temporaries (leading dimension ≈ leaf size). stdlib's blocked `dgemm` path is measurably slower at power-of-two leading dimensions, so the ratio between the two recursions mixes the multiplication saving with a leaf-locality effect. Attribution therefore requires a padded-leading-dimension arm and/or a compact-copy control (see `docs/research-protocol.md`).
*
* @private
* @param {NonNegativeInteger} M - number of rows in `A` and `C`
* @param {NonNegativeInteger} N - number of columns in `B` and `C`
* @param {NonNegativeInteger} K - number of columns in `A` and rows in `B`
* @param {number} alpha - scalar constant
* @param {Float64Array} A - first input matrix
* @param {integer} strideA1 - stride of the first dimension of `A`
* @param {integer} strideA2 - stride of the second dimension of `A`
* @param {NonNegativeInteger} offsetA - starting index for `A`
* @param {Float64Array} B - second input matrix
* @param {integer} strideB1 - stride of the first dimension of `B`
* @param {integer} strideB2 - stride of the second dimension of `B`
* @param {NonNegativeInteger} offsetB - starting index for `B`
* @param {number} beta - scalar constant
* @param {Float64Array} C - input/output matrix
* @param {integer} strideC1 - stride of the first dimension of `C`
* @param {integer} strideC2 - stride of the second dimension of `C`
* @param {NonNegativeInteger} offsetC - starting index for `C`
* @param {PositiveInteger} cutoff - recursion cutoff
* @returns {Float64Array} `C`
*
* @example
* var Float64Array = require( '@stdlib/array/float64' );
*
* var A = new Float64Array( [ 1.0, 2.0, 3.0, 4.0 ] );
* var B = new Float64Array( [ 5.0, 6.0, 7.0, 8.0 ] );
* var C = new Float64Array( 4 );
*
* classic( 2, 2, 2, 1.0, A, 2, 1, 0, B, 2, 1, 0, 0.0, C, 2, 1, 0, 1 );
* // C => <Float64Array>[ 19.0, 22.0, 43.0, 50.0 ]
*/
function classic( M, N, K, alpha, A, strideA1, strideA2, offsetA, B, strideB1, strideB2, offsetB, beta, C, strideC1, strideC2, offsetC, cutoff ) {
	var a12;
	var a21;
	var a22;
	var b12;
	var b21;
	var b22;
	var c12;
	var c21;
	var c22;
	var m;
	var n;
	var k;

	if ( M <= cutoff || N <= cutoff || K <= cutoff ) {
		return dgemm( NT, NT, M, N, K, alpha, A, strideA1, strideA2, offsetA, B, strideB1, strideB2, offsetB, beta, C, strideC1, strideC2, offsetC );
	}
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
	classic( m, n, k, alpha, A, strideA1, strideA2, offsetA, B, strideB1, strideB2, offsetB, beta, C, strideC1, strideC2, offsetC, cutoff );
	classic( m, n, k, alpha, A, strideA1, strideA2, a12, B, strideB1, strideB2, b21, 1.0, C, strideC1, strideC2, offsetC, cutoff );

	// C12 = α*A11*B12 + β*C12 + α*A12*B22
	classic( m, n, k, alpha, A, strideA1, strideA2, offsetA, B, strideB1, strideB2, b12, beta, C, strideC1, strideC2, c12, cutoff );
	classic( m, n, k, alpha, A, strideA1, strideA2, a12, B, strideB1, strideB2, b22, 1.0, C, strideC1, strideC2, c12, cutoff );

	// C21 = α*A21*B11 + β*C21 + α*A22*B21
	classic( m, n, k, alpha, A, strideA1, strideA2, a21, B, strideB1, strideB2, offsetB, beta, C, strideC1, strideC2, c21, cutoff );
	classic( m, n, k, alpha, A, strideA1, strideA2, a22, B, strideB1, strideB2, b21, 1.0, C, strideC1, strideC2, c21, cutoff );

	// C22 = α*A21*B12 + β*C22 + α*A22*B22
	classic( m, n, k, alpha, A, strideA1, strideA2, a21, B, strideB1, strideB2, b12, beta, C, strideC1, strideC2, c22, cutoff );
	classic( m, n, k, alpha, A, strideA1, strideA2, a22, B, strideB1, strideB2, b22, 1.0, C, strideC1, strideC2, c22, cutoff );

	// Dynamic peeling (identical to the Strassen–Winograd recursion)...
	if ( 2*k < K ) {
		dgemm( NT, NT, 2*m, 2*n, 1, alpha, A, strideA1, strideA2, offsetA+( (K-1)*strideA2 ), B, strideB1, strideB2, offsetB+( (K-1)*strideB1 ), 1.0, C, strideC1, strideC2, offsetC );
	}
	if ( 2*n < N ) {
		dgemm( NT, NT, 2*m, 1, K, alpha, A, strideA1, strideA2, offsetA, B, strideB1, strideB2, offsetB+( (N-1)*strideB2 ), beta, C, strideC1, strideC2, offsetC+( (N-1)*strideC2 ) );
	}
	if ( 2*m < M ) {
		dgemm( NT, NT, 1, N, K, alpha, A, strideA1, strideA2, offsetA+( (M-1)*strideA1 ), B, strideB1, strideB2, offsetB, beta, C, strideC1, strideC2, offsetC+( (M-1)*strideC1 ) );
	}
	return C;
}


// EXPORTS //

module.exports = classic;
