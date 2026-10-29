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
var Float64Array = require( '@stdlib/array/float64' );
var dgemm = require( '@stdlib/blas/base/dgemm' ).ndarray;
var workspaceLength = require( './workspace_length.js' );
var winograd = require( './winograd.js' );
var axpby = require( './axpby.js' );


// FUNCTIONS //

/**
* Tests whether a provided string indicates to transpose a matrix.
*
* @private
* @param {string} str - input string
* @returns {boolean} boolean indicating whether to transpose a matrix
*/
function isTransposed( str ) {
	return ( str !== 'no-transpose' );
}


// MAIN //

/**
* Performs the matrix-matrix operation `C = α*op(A)*op(B) + β*C`, where `op(X)` is either `op(X) = X` or `op(X) = X^T`, using the Strassen–Winograd algorithm.
*
* ## Notes
*
* -   Problems in which any dimension is less than or equal to the cutoff, as well as all degenerate cases (e.g., `M = 0`, `K = 0`, or `α = 0`), are delegated to `dgemm`, thus ensuring identical quick-return semantics.
* -   `α` is folded into the base-case calls of the recursion. When `β = 0`, the product `α*op(A)*op(B)` is formed directly in `C`, requiring only the recursion workspace. Otherwise, the product is formed in a temporary matrix having the same memory layout as `C`, which is then combined with `β*C`.
* -   POC limitations (addressed by the implementation plan): non-finite inputs and near-overflow magnitudes are not yet delegated to `dgemm`, and the workspace is allocated on every call.
*
* @private
* @param {string} transA - specifies whether `A` should be transposed, conjugate-transposed, or not transposed
* @param {string} transB - specifies whether `B` should be transposed, conjugate-transposed, or not transposed
* @param {NonNegativeInteger} M - number of rows in the matrix `op(A)` and in the matrix `C`
* @param {NonNegativeInteger} N - number of columns in the matrix `op(B)` and in the matrix `C`
* @param {NonNegativeInteger} K - number of columns in the matrix `op(A)` and number of rows in the matrix `op(B)`
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
* @param {Float64Array} C - third matrix
* @param {integer} strideC1 - stride of the first dimension of `C`
* @param {integer} strideC2 - stride of the second dimension of `C`
* @param {NonNegativeInteger} offsetC - starting index for `C`
* @param {PositiveInteger} cutoff - recursion cutoff
* @returns {Float64Array} `C`
*/
function strassen( transA, transB, M, N, K, alpha, A, strideA1, strideA2, offsetA, B, strideB1, strideB2, offsetB, beta, C, strideC1, strideC2, offsetC, cutoff ) {
	var sa1;
	var sa2;
	var sb1;
	var sb2;
	var sp1;
	var sp2;
	var op;
	var W;

	if ( M <= cutoff || N <= cutoff || K <= cutoff || alpha === 0.0 ) {
		return dgemm( transA, transB, M, N, K, alpha, A, strideA1, strideA2, offsetA, B, strideB1, strideB2, offsetB, beta, C, strideC1, strideC2, offsetC );
	}
	// Resolve transpose operations by swapping strides...
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
	if ( beta === 0.0 ) {
		// Form: C = α*op(A)*op(B)
		W = new Float64Array( workspaceLength( M, N, K, cutoff ) );
		return winograd( M, N, K, alpha, A, sa1, sa2, offsetA, B, sb1, sb2, offsetB, C, strideC1, strideC2, offsetC, W, 0, cutoff );
	}
	// Form: P = α*op(A)*op(B), followed by C = P + β*C
	op = M * N;
	W = new Float64Array( op + workspaceLength( M, N, K, cutoff ) );
	if ( isRowMajor( [ strideC1, strideC2 ] ) ) {
		sp1 = N;
		sp2 = 1;
	} else {
		sp1 = 1;
		sp2 = M;
	}
	winograd( M, N, K, alpha, A, sa1, sa2, offsetA, B, sb1, sb2, offsetB, W, sp1, sp2, 0, W, op, cutoff );
	return axpby( M, N, 1.0, W, sp1, sp2, 0, beta, C, strideC1, strideC2, offsetC );
}


// EXPORTS //

module.exports = strassen;
