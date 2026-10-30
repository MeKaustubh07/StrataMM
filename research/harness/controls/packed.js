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

// Research control C1 (protocol §3): "packed dgemm". On every call, op(B) is copied into a freshly
// allocated, contiguous column-major K×N buffer (allocation and copy are part of the timed call, as SW's workspace
// is), then the public `dgemm.ndarray` is called with that buffer. For row-major, non-transposed A this selects
// dgemm's unit-stride `naive` path (the layout effect, H3).

// MODULES //

var dgemm = require( '@stdlib/blas/base/dgemm' ).ndarray;


// VARIABLES //

var NT = 'no-transpose';


// MAIN //

/**
* Computes `C = α*op(A)*op(B) + β*C` by packing `op(B)` into a per-call column-major buffer and calling `dgemm`.
*
* ## Notes
*
* -   Degenerate problems (`M`, `N` or `K` equal to zero, or `α = 0`) are delegated to `dgemm` without packing, because the result does not depend on `B`.
* -   The packed buffer holds `K*N` doubles (`8*K*N` bytes), allocated on every call.
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
* @returns {Float64Array} `C`
*
* @example
* var A = new Float64Array( [ 1.0, 2.0, 3.0, 4.0 ] );
* var B = new Float64Array( [ 5.0, 6.0, 7.0, 8.0 ] );
* var C = new Float64Array( 4 );
*
* packed( 'no-transpose', 'no-transpose', 2, 2, 2, 1.0, A, 2, 1, 0, B, 2, 1, 0, 0.0, C, 2, 1, 0 );
* // C => <Float64Array>[ 19.0, 22.0, 43.0, 50.0 ]
*/
function packed( transA, transB, M, N, K, alpha, A, strideA1, strideA2, offsetA, B, strideB1, strideB2, offsetB, beta, C, strideC1, strideC2, offsetC ) {
	var Bp;
	var s1;
	var s2;
	var ib;
	var ip;
	var i;
	var j;

	if ( M === 0 || N === 0 || K === 0 || alpha === 0.0 ) {
		return dgemm( transA, transB, M, N, K, alpha, A, strideA1, strideA2, offsetA, B, strideB1, strideB2, offsetB, beta, C, strideC1, strideC2, offsetC );
	}
	// Strides of op(B) (K×N) within `B`:
	if ( transB === NT ) {
		s1 = strideB1;
		s2 = strideB2;
	} else {
		s1 = strideB2;
		s2 = strideB1;
	}
	// Pack op(B) column by column (contiguous writes):
	Bp = new Float64Array( K*N );
	ip = 0;
	for ( j = 0; j < N; j++ ) {
		ib = offsetB + ( j*s2 );
		for ( i = 0; i < K; i++ ) {
			Bp[ ip ] = B[ ib ];
			ib += s1;
			ip += 1;
		}
	}
	return dgemm( transA, NT, M, N, K, alpha, A, strideA1, strideA2, offsetA, Bp, 1, K, 0, beta, C, strideC1, strideC2, offsetC );
}


// EXPORTS //

module.exports = packed;
