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

var isRowMajor = require( '@stdlib/ndarray/base/assert/is-row-major' );


// MAIN //

/**
* Performs the matrix operation `Y = α*X + β*Y`.
*
* ## Notes
*
* -   When `β` equals zero, `Y` is not read (i.e., `NaN` and infinite values in `Y` do not propagate), matching the conventions of `dgemm`.
*
* @private
* @param {NonNegativeInteger} M - number of rows
* @param {NonNegativeInteger} N - number of columns
* @param {number} alpha - scalar constant
* @param {Float64Array} X - input matrix
* @param {integer} strideX1 - stride of the first dimension of `X`
* @param {integer} strideX2 - stride of the second dimension of `X`
* @param {NonNegativeInteger} offsetX - starting index for `X`
* @param {number} beta - scalar constant
* @param {Float64Array} Y - input/output matrix
* @param {integer} strideY1 - stride of the first dimension of `Y`
* @param {integer} strideY2 - stride of the second dimension of `Y`
* @param {NonNegativeInteger} offsetY - starting index for `Y`
* @returns {Float64Array} `Y`
*
* @example
* var Float64Array = require( '@stdlib/array/float64' );
*
* var X = new Float64Array( [ 1.0, 2.0, 3.0, 4.0 ] );
* var Y = new Float64Array( [ 1.0, 1.0, 1.0, 1.0 ] );
*
* axpby( 2, 2, 2.0, X, 2, 1, 0, 3.0, Y, 2, 1, 0 );
* // Y => <Float64Array>[ 5.0, 7.0, 9.0, 11.0 ]
*/
function axpby( M, N, alpha, X, strideX1, strideX2, offsetX, beta, Y, strideY1, strideY2, offsetY ) { // eslint-disable-line max-params, max-len
	var dx0;
	var dx1;
	var dy0;
	var dy1;
	var S0;
	var S1;
	var i0;
	var i1;
	var ix;
	var iy;

	if ( isRowMajor( [ strideY1, strideY2 ] ) ) {
		S0 = N;
		S1 = M;
		dx0 = strideX2;
		dx1 = strideX1 - ( S0*strideX2 );
		dy0 = strideY2;
		dy1 = strideY1 - ( S0*strideY2 );
	} else { // column-major
		S0 = M;
		S1 = N;
		dx0 = strideX1;
		dx1 = strideX2 - ( S0*strideX1 );
		dy0 = strideY1;
		dy1 = strideY2 - ( S0*strideY1 );
	}
	ix = offsetX;
	iy = offsetY;
	if ( beta === 0.0 ) {
		for ( i1 = 0; i1 < S1; i1++ ) {
			for ( i0 = 0; i0 < S0; i0++ ) {
				Y[ iy ] = alpha * X[ ix ];
				ix += dx0;
				iy += dy0;
			}
			ix += dx1;
			iy += dy1;
		}
		return Y;
	}
	for ( i1 = 0; i1 < S1; i1++ ) {
		for ( i0 = 0; i0 < S0; i0++ ) {
			Y[ iy ] = ( beta*Y[ iy ] ) + ( alpha*X[ ix ] );
			ix += dx0;
			iy += dy0;
		}
		ix += dx1;
		iy += dy1;
	}
	return Y;
}


// EXPORTS //

module.exports = axpby;
