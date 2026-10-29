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

'use strict';

// MODULES //

var floor = require( '@stdlib/math/base/special/floor' );
var max = require( '@stdlib/math/base/special/max' );


// MAIN //

/**
* Returns the number of workspace elements required by the Strassen–Winograd recursion.
*
* ## Notes
*
* -   Each recursion level requires two temporaries: `X`, which holds an `m×k` operand sum and, later, the `m×n` product `P1`, and `Y`, which holds a `k×n` operand sum, where `m = floor(M/2)`, `n = floor(N/2)`, and `k = floor(K/2)`.
* -   Recursive calls execute sequentially, and each child call only requires workspace for the duration of its execution. Hence, the total workspace is the sum over recursion levels (a stack), which, for square matrices, is bounded by `(2/3)N²`.
*
* @private
* @param {NonNegativeInteger} M - number of rows in `op(A)` and `C`
* @param {NonNegativeInteger} N - number of columns in `op(B)` and `C`
* @param {NonNegativeInteger} K - number of columns in `op(A)` and rows in `op(B)`
* @param {PositiveInteger} cutoff - recursion cutoff
* @returns {NonNegativeInteger} number of elements
*
* @example
* var len = workspaceLength( 128, 128, 128, 32 );
* // returns 10240
*/
function workspaceLength( M, N, K, cutoff ) {
	var len;
	var m;
	var n;
	var k;

	len = 0;
	while ( M > cutoff && N > cutoff && K > cutoff ) {
		m = floor( M/2 );
		n = floor( N/2 );
		k = floor( K/2 );
		len += ( m*max( k, n ) ) + ( k*n );
		M = m;
		N = n;
		K = k;
	}
	return len;
}


// EXPORTS //

module.exports = workspaceLength;
