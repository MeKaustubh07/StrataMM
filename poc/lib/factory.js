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

var isPositiveInteger = require( '@stdlib/assert/is-positive-integer' ).isPrimitive;
var resolveStr = require( '@stdlib/blas/base/transpose-operation-resolve-str' );
var format = require( '@stdlib/string/format' );
var base = require( './base.js' );


// MAIN //

/**
* Returns a function for performing the matrix-matrix operation `C = α*op(A)*op(B) + β*C` using the Strassen–Winograd algorithm with a specified recursion cutoff.
*
* @param {PositiveInteger} cutoff - recursion cutoff (i.e., the conventional algorithm is used once any dimension is less than or equal to this value)
* @throws {TypeError} must provide a positive integer
* @returns {Function} function having the same signature as `dgemm.ndarray`
*
* @example
* var Float64Array = require( '@stdlib/array/float64' );
*
* var dgemm = factory( 1 );
*
* var A = new Float64Array( [ 1.0, 2.0, 3.0, 4.0 ] );
* var B = new Float64Array( [ 5.0, 6.0, 7.0, 8.0 ] );
* var C = new Float64Array( 4 );
*
* dgemm( 'no-transpose', 'no-transpose', 2, 2, 2, 1.0, A, 2, 1, 0, B, 2, 1, 0, 0.0, C, 2, 1, 0 );
* // C => <Float64Array>[ 19.0, 22.0, 43.0, 50.0 ]
*/
function factory( cutoff ) {
	if ( !isPositiveInteger( cutoff ) ) {
		throw new TypeError( format( 'invalid argument. Must provide a positive integer. Value: `%s`.', cutoff ) );
	}
	return dgemm;

	/**
	* Performs the matrix-matrix operation `C = α*op(A)*op(B) + β*C` using the Strassen–Winograd algorithm.
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
	* @throws {TypeError} first argument must be a valid transpose operation
	* @throws {TypeError} second argument must be a valid transpose operation
	* @throws {RangeError} third argument must be a nonnegative integer
	* @throws {RangeError} fourth argument must be a nonnegative integer
	* @throws {RangeError} fifth argument must be a nonnegative integer
	* @throws {RangeError} seventeenth argument must be non-zero
	* @throws {RangeError} eighteenth argument must be non-zero
	* @returns {Float64Array} `C`
	*/
	function dgemm( transA, transB, M, N, K, alpha, A, strideA1, strideA2, offsetA, B, strideB1, strideB2, offsetB, beta, C, strideC1, strideC2, offsetC ) { // eslint-disable-line max-params, max-len
		var ta;
		var tb;

		ta = resolveStr( transA );
		if ( ta === null ) {
			throw new TypeError( format( 'invalid argument. First argument must be a valid transpose operation. Value: `%s`.', transA ) );
		}
		tb = resolveStr( transB );
		if ( tb === null ) {
			throw new TypeError( format( 'invalid argument. Second argument must be a valid transpose operation. Value: `%s`.', transB ) );
		}
		if ( M < 0 ) {
			throw new RangeError( format( 'invalid argument. Third argument must be a nonnegative integer. Value: `%d`.', M ) );
		}
		if ( N < 0 ) {
			throw new RangeError( format( 'invalid argument. Fourth argument must be a nonnegative integer. Value: `%d`.', N ) );
		}
		if ( K < 0 ) {
			throw new RangeError( format( 'invalid argument. Fifth argument must be a nonnegative integer. Value: `%d`.', K ) );
		}
		if ( strideC1 === 0 ) {
			throw new RangeError( format( 'invalid argument. Seventeenth argument must be non-zero. Value: `%d`.', strideC1 ) );
		}
		if ( strideC2 === 0 ) {
			throw new RangeError( format( 'invalid argument. Eighteenth argument must be non-zero. Value: `%d`.', strideC2 ) );
		}
		return base( ta, tb, M, N, K, alpha, A, strideA1, strideA2, offsetA, B, strideB1, strideB2, offsetB, beta, C, strideC1, strideC2, offsetC, cutoff ); // eslint-disable-line max-len
	}
}


// EXPORTS //

module.exports = factory;
