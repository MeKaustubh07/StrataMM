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

var isRowMajor = require( '@stdlib/ndarray/base/assert/is-row-major' );
var dgemm = require( '@stdlib/blas/base/dgemm' ).ndarray;
var floor = require( '@stdlib/math/base/special/floor' );
var max = require( '@stdlib/math/base/special/max' );
var add = require( './add.js' );
var sub = require( './sub.js' );


// VARIABLES //

var NT = 'no-transpose';


// MAIN //

/**
* Computes the matrix product `C = α*A*B` using the Strassen–Winograd algorithm.
*
* ## Notes
*
* -   `A` is an `M×K` matrix, `B` is a `K×N` matrix, and `C` is an `M×N` matrix. Transpose operations must be resolved by the caller (i.e., by swapping strides). `C` is overwritten and never read before being written, and, thus, `NaN` values in `C` do not propagate.
*
* -   The scalar `α` is applied only in the base-case and peeling calls to the conventional algorithm. Every output block is a linear combination (with coefficients ±1) of the seven products, so scaling each product by `α` scales the result by `α`, without an additional pass over `C`.
*
* -   Each recursion level performs seven half-size multiplications and fifteen half-size additions using the following variant due to Winograd:
*
*     ```text
*     S1 = A21 + A22    T1 = B12 - B11    P1 = A11*B11    U1 = P1 + P2  => C11
*     S2 = S1 - A11     T2 = B22 - T1     P2 = A12*B21    U2 = P1 + P6
*     S3 = A11 - A21    T3 = B22 - B12    P3 = S4*B22     U3 = U2 + P7
*     S4 = A12 - S2     T4 = T2 - B21     P4 = A22*T4     U4 = U2 + P5
*                                         P5 = S1*T1      U5 = U4 + P3  => C12
*                                         P6 = S2*T2      U6 = U3 - P4  => C21
*                                         P7 = S3*T3      U7 = U3 + P5  => C22
*     ```
*
* -   Operations are scheduled such that the quadrants of `C` serve as scratch space and only two temporaries are required per recursion level (Douglas et al., 1994; Boyer et al., 2009). `X` holds an `m×k` operand sum and, later, the `m×n` product `P1`; `Y` holds a `k×n` operand sum. Temporaries mirror the memory layouts of the matrices they stand in for, such that recursive calls encounter the same layout combinations as the original problem.
*
* -   Odd dimensions are handled via dynamic peeling (Huss-Lederman et al., 1996): the even-dimensioned leading block is computed recursively, and the remaining row, column, and rank-one contribution are computed using the conventional algorithm.
*
* -   Recursion terminates when any dimension is less than or equal to the cutoff, at which point the conventional algorithm is used.
*
* ## References
*
* -   Winograd, Shmuel. 1971. "On multiplication of 2×2 matrices." _Linear Algebra and Its Applications_ 4 (4): 381–88. doi:[10.1016/0024-3795(71)90009-7](https://doi.org/10.1016/0024-3795(71)90009-7).
* -   Douglas, Craig C., Michael Heroux, Gordon Slishman, and Roger M. Smith. 1994. "GEMMW: A Portable Level 3 BLAS Winograd Variant of Strassen's Matrix-Matrix Multiply Algorithm." _Journal of Computational Physics_ 110 (1): 1–10. doi:[10.1006/jcph.1994.1001](https://doi.org/10.1006/jcph.1994.1001).
* -   Huss-Lederman, Steven, Elaine M. Jacobson, Jeremy R. Johnson, Anna Tsao, and Thomas Turnbull. 1996. "Implementation of Strassen's Algorithm for Matrix Multiplication." In _Proceedings of the 1996 ACM/IEEE Conference on Supercomputing_. doi:[10.1145/369028.369096](https://doi.org/10.1145/369028.369096).
* -   Boyer, Brice, Jean-Guillaume Dumas, Clément Pernet, and Wei Zhou. 2009. "Memory Efficient Scheduling of Strassen-Winograd's Matrix Multiplication Algorithm." In _Proceedings of the 2009 International Symposium on Symbolic and Algebraic Computation_, 55–62. doi:[10.1145/1576702.1576713](https://doi.org/10.1145/1576702.1576713).
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
* @param {Float64Array} C - output matrix
* @param {integer} strideC1 - stride of the first dimension of `C`
* @param {integer} strideC2 - stride of the second dimension of `C`
* @param {NonNegativeInteger} offsetC - starting index for `C`
* @param {Float64Array} W - workspace
* @param {NonNegativeInteger} offsetW - starting index for `W`
* @param {PositiveInteger} cutoff - recursion cutoff
* @returns {Float64Array} `C`
*
* @example
* var Float64Array = require( '@stdlib/array/float64' );
*
* var A = new Float64Array( [ 1.0, 2.0, 3.0, 4.0 ] );
* var B = new Float64Array( [ 5.0, 6.0, 7.0, 8.0 ] );
* var C = new Float64Array( 4 );
* var W = new Float64Array( 2 );
*
* winograd( 2, 2, 2, 1.0, A, 2, 1, 0, B, 2, 1, 0, C, 2, 1, 0, W, 0, 1 );
* // C => <Float64Array>[ 19.0, 22.0, 43.0, 50.0 ]
*/
function winograd( M, N, K, alpha, A, strideA1, strideA2, offsetA, B, strideB1, strideB2, offsetB, C, strideC1, strideC2, offsetC, W, offsetW, cutoff ) {
	var sxa1;
	var sxa2;
	var sxc1;
	var sxc2;
	var sy1;
	var sy2;
	var a12;
	var a21;
	var a22;
	var b12;
	var b21;
	var b22;
	var c12;
	var c21;
	var c22;
	var ox;
	var oy;
	var ow;
	var m;
	var n;
	var k;

	// Base case: use the conventional algorithm...
	if ( M <= cutoff || N <= cutoff || K <= cutoff ) {
		return dgemm( NT, NT, M, N, K, alpha, A, strideA1, strideA2, offsetA, B, strideB1, strideB2, offsetB, 0.0, C, strideC1, strideC2, offsetC );
	}
	// Resolve the dimensions of the even-dimensioned leading block (dynamic peeling)...
	m = floor( M/2 );
	n = floor( N/2 );
	k = floor( K/2 );

	// Resolve quadrant offsets (the `11` quadrants begin at the respective matrix offsets)...
	a12 = offsetA + ( k*strideA2 );
	a21 = offsetA + ( m*strideA1 );
	a22 = a21 + ( k*strideA2 );
	b12 = offsetB + ( n*strideB2 );
	b21 = offsetB + ( k*strideB1 );
	b22 = b21 + ( n*strideB2 );
	c12 = offsetC + ( n*strideC2 );
	c21 = offsetC + ( m*strideC1 );
	c22 = c21 + ( n*strideC2 );

	// Partition the workspace: `X` (m×max(k,n)), `Y` (k×n), followed by the workspace for recursive calls...
	ox = offsetW;
	oy = ox + ( m*max( k, n ) );
	ow = oy + ( k*n );

	// Temporaries mirror the memory layouts of the matrices they stand in for...
	if ( isRowMajor( [ strideA1, strideA2 ] ) ) {
		sxa1 = k; // `X` as an m×k operand sum
		sxa2 = 1;
	} else {
		sxa1 = 1;
		sxa2 = m;
	}
	if ( isRowMajor( [ strideB1, strideB2 ] ) ) {
		sy1 = n; // `Y` as a k×n operand sum
		sy2 = 1;
	} else {
		sy1 = 1;
		sy2 = k;
	}
	if ( isRowMajor( [ strideC1, strideC2 ] ) ) {
		sxc1 = n; // `X` as the m×n product `P1`
		sxc2 = 1;
	} else {
		sxc1 = 1;
		sxc2 = m;
	}

	// 1. X = S3 = A11 - A21
	sub( m, k, A, strideA1, strideA2, offsetA, A, strideA1, strideA2, a21, W, sxa1, sxa2, ox );

	// 2. Y = T3 = B22 - B12
	sub( k, n, B, strideB1, strideB2, b22, B, strideB1, strideB2, b12, W, sy1, sy2, oy );

	// 3. C21 = P7 = S3*T3
	winograd( m, n, k, alpha, W, sxa1, sxa2, ox, W, sy1, sy2, oy, C, strideC1, strideC2, c21, W, ow, cutoff );

	// 4. X = S1 = A21 + A22
	add( m, k, A, strideA1, strideA2, a21, A, strideA1, strideA2, a22, W, sxa1, sxa2, ox );

	// 5. Y = T1 = B12 - B11
	sub( k, n, B, strideB1, strideB2, b12, B, strideB1, strideB2, offsetB, W, sy1, sy2, oy );

	// 6. C22 = P5 = S1*T1
	winograd( m, n, k, alpha, W, sxa1, sxa2, ox, W, sy1, sy2, oy, C, strideC1, strideC2, c22, W, ow, cutoff );

	// 7. X = S2 = S1 - A11
	sub( m, k, W, sxa1, sxa2, ox, A, strideA1, strideA2, offsetA, W, sxa1, sxa2, ox );

	// 8. Y = T2 = B22 - T1
	sub( k, n, B, strideB1, strideB2, b22, W, sy1, sy2, oy, W, sy1, sy2, oy );

	// 9. C12 = P6 = S2*T2
	winograd( m, n, k, alpha, W, sxa1, sxa2, ox, W, sy1, sy2, oy, C, strideC1, strideC2, c12, W, ow, cutoff );

	// 10. X = S4 = A12 - S2
	sub( m, k, A, strideA1, strideA2, a12, W, sxa1, sxa2, ox, W, sxa1, sxa2, ox );

	// 11. C11 = P3 = S4*B22
	winograd( m, n, k, alpha, W, sxa1, sxa2, ox, B, strideB1, strideB2, b22, C, strideC1, strideC2, offsetC, W, ow, cutoff );

	// 12. X = P1 = A11*B11
	winograd( m, n, k, alpha, A, strideA1, strideA2, offsetA, B, strideB1, strideB2, offsetB, W, sxc1, sxc2, ox, W, ow, cutoff );

	// 13. C12 = U2 = P1 + P6
	add( m, n, W, sxc1, sxc2, ox, C, strideC1, strideC2, c12, C, strideC1, strideC2, c12 );

	// 14. C21 = U3 = U2 + P7
	add( m, n, C, strideC1, strideC2, c12, C, strideC1, strideC2, c21, C, strideC1, strideC2, c21 );

	// 15. C12 = U4 = U2 + P5
	add( m, n, C, strideC1, strideC2, c12, C, strideC1, strideC2, c22, C, strideC1, strideC2, c12 );

	// 16. C22 = U7 = U3 + P5
	add( m, n, C, strideC1, strideC2, c21, C, strideC1, strideC2, c22, C, strideC1, strideC2, c22 );

	// 17. C12 = U5 = U4 + P3
	add( m, n, C, strideC1, strideC2, c12, C, strideC1, strideC2, offsetC, C, strideC1, strideC2, c12 );

	// 18. Y = T4 = T2 - B21
	sub( k, n, W, sy1, sy2, oy, B, strideB1, strideB2, b21, W, sy1, sy2, oy );

	// 19. C11 = P4 = A22*T4
	winograd( m, n, k, alpha, A, strideA1, strideA2, a22, W, sy1, sy2, oy, C, strideC1, strideC2, offsetC, W, ow, cutoff );

	// 20. C21 = U6 = U3 - P4
	sub( m, n, C, strideC1, strideC2, c21, C, strideC1, strideC2, offsetC, C, strideC1, strideC2, c21 );

	// 21. C11 = P2 = A12*B21
	winograd( m, n, k, alpha, A, strideA1, strideA2, a12, B, strideB1, strideB2, b21, C, strideC1, strideC2, offsetC, W, ow, cutoff );

	// 22. C11 = U1 = P1 + P2
	add( m, n, W, sxc1, sxc2, ox, C, strideC1, strideC2, offsetC, C, strideC1, strideC2, offsetC );

	// Dynamic peeling: account for odd dimensions using the conventional algorithm...
	if ( 2*k < K ) {
		// C[0:2m,0:2n] += α * A[0:2m,K-1] * B[K-1,0:2n]
		dgemm( NT, NT, 2*m, 2*n, 1, alpha, A, strideA1, strideA2, offsetA+( (K-1)*strideA2 ), B, strideB1, strideB2, offsetB+( (K-1)*strideB1 ), 1.0, C, strideC1, strideC2, offsetC );
	}
	if ( 2*n < N ) {
		// C[0:2m,N-1] = α * A[0:2m,0:K] * B[0:K,N-1]
		dgemm( NT, NT, 2*m, 1, K, alpha, A, strideA1, strideA2, offsetA, B, strideB1, strideB2, offsetB+( (N-1)*strideB2 ), 0.0, C, strideC1, strideC2, offsetC+( (N-1)*strideC2 ) );
	}
	if ( 2*m < M ) {
		// C[M-1,0:N] = α * A[M-1,0:K] * B[0:K,0:N]
		dgemm( NT, NT, 1, N, K, alpha, A, strideA1, strideA2, offsetA+( (M-1)*strideA1 ), B, strideB1, strideB2, offsetB, 0.0, C, strideC1, strideC2, offsetC+( (M-1)*strideC1 ) );
	}
	return C;
}


// EXPORTS //

module.exports = winograd;
