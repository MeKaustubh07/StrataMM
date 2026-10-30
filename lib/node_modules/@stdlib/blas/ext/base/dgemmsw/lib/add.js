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
* Adds two matrices element-wise and assigns the results to an output matrix (i.e., `Z = X + Y`).
*
* ## Notes
*
* -   The output matrix may alias either input matrix, provided the aliased matrices share the same strides and offset (i.e., the operation may be performed in-place).
*
* @private
* @param {NonNegativeInteger} M - number of rows
* @param {NonNegativeInteger} N - number of columns
* @param {Float64Array} X - first input matrix
* @param {integer} strideX1 - stride of the first dimension of `X`
* @param {integer} strideX2 - stride of the second dimension of `X`
* @param {NonNegativeInteger} offsetX - starting index for `X`
* @param {Float64Array} Y - second input matrix
* @param {integer} strideY1 - stride of the first dimension of `Y`
* @param {integer} strideY2 - stride of the second dimension of `Y`
* @param {NonNegativeInteger} offsetY - starting index for `Y`
* @param {Float64Array} Z - output matrix
* @param {integer} strideZ1 - stride of the first dimension of `Z`
* @param {integer} strideZ2 - stride of the second dimension of `Z`
* @param {NonNegativeInteger} offsetZ - starting index for `Z`
* @returns {Float64Array} output matrix
*
* @example
* var Float64Array = require( '@stdlib/array/float64' );
*
* var X = new Float64Array( [ 1.0, 2.0, 3.0, 4.0 ] );
* var Y = new Float64Array( [ 1.0, 1.0, 1.0, 1.0 ] );
* var Z = new Float64Array( 4 );
*
* add( 2, 2, X, 2, 1, 0, Y, 2, 1, 0, Z, 2, 1, 0 );
* // Z => <Float64Array>[ 2.0, 3.0, 4.0, 5.0 ]
*/
function add( M, N, X, strideX1, strideX2, offsetX, Y, strideY1, strideY2, offsetY, Z, strideZ1, strideZ2, offsetZ ) { // eslint-disable-line max-params, max-len
	var dx0;
	var dx1;
	var dy0;
	var dy1;
	var dz0;
	var dz1;
	var S0;
	var S1;
	var i0;
	var i1;
	var ix;
	var iy;
	var iz;

	// Note on variable naming convention: S#, dx#, dy#, dz#, i# where # corresponds to the loop number, with `0` being the innermost loop...

	if ( isRowMajor( [ strideZ1, strideZ2 ] ) ) {
		// For row-major matrices, the last dimension has the fastest changing index...
		S0 = N;
		S1 = M;
		dx0 = strideX2;
		dx1 = strideX1 - ( S0*strideX2 );
		dy0 = strideY2;
		dy1 = strideY1 - ( S0*strideY2 );
		dz0 = strideZ2;
		dz1 = strideZ1 - ( S0*strideZ2 );
	} else { // column-major
		// For column-major matrices, the first dimension has the fastest changing index...
		S0 = M;
		S1 = N;
		dx0 = strideX1;
		dx1 = strideX2 - ( S0*strideX1 );
		dy0 = strideY1;
		dy1 = strideY2 - ( S0*strideY1 );
		dz0 = strideZ1;
		dz1 = strideZ2 - ( S0*strideZ1 );
	}
	ix = offsetX;
	iy = offsetY;
	iz = offsetZ;
	for ( i1 = 0; i1 < S1; i1++ ) {
		for ( i0 = 0; i0 < S0; i0++ ) {
			Z[ iz ] = X[ ix ] + Y[ iy ];
			ix += dx0;
			iy += dy0;
			iz += dz0;
		}
		ix += dx1;
		iy += dy1;
		iz += dz1;
	}
	return Z;
}


// EXPORTS //

module.exports = add;
