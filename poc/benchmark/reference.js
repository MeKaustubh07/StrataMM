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

var Float64Array = require( '@stdlib/array/float64' );


// VARIABLES //

var SPLITTER = 134217729.0; // 2^27 + 1 (Veltkamp splitting constant)


// MAIN //

/**
* Computes a double-double reference product `C = A*B` for row-major square matrices using Dot2.
*
* ## Notes
*
* -   Each element is computed as if in twice the working precision using error-free transformations (Dekker/Veltkamp TwoProduct and Knuth TwoSum), and the result is retained as an unevaluated sum `hi + lo`. Accordingly, the forward error of a computed value `x` may be accurately evaluated as `(x - hi) - lo`.
* -   Splitting may overflow for elements whose magnitude exceeds approximately `2^996`; inputs must be scaled accordingly.
*
* ## References
*
* -   Ogita, Takeshi, Siegfried M. Rump, and Shin'ichi Oishi. 2005. "Accurate Sum and Dot Product." _SIAM Journal on Scientific Computing_ 26 (6): 1955–88. doi:[10.1137/030601818](https://doi.org/10.1137/030601818).
*
* @param {PositiveInteger} n - matrix order
* @param {Float64Array} A - first matrix (row-major)
* @param {Float64Array} B - second matrix (row-major)
* @returns {Object} object containing `hi` and `lo` arrays (row-major)
*/
function referenceProduct( n, A, B ) {
	var BT;
	var hi;
	var lo;
	var ah;
	var al;
	var bh;
	var bl;
	var ia;
	var ib;
	var a;
	var b;
	var c;
	var h;
	var p;
	var q;
	var r;
	var s;
	var x;
	var z;
	var i;
	var j;
	var k;

	BT = new Float64Array( n*n );
	for ( i = 0; i < n; i++ ) {
		for ( j = 0; j < n; j++ ) {
			BT[ ( j*n )+i ] = B[ ( i*n )+j ];
		}
	}
	hi = new Float64Array( n*n );
	lo = new Float64Array( n*n );
	for ( i = 0; i < n; i++ ) {
		ia = i * n;
		for ( j = 0; j < n; j++ ) {
			ib = j * n;
			p = 0.0;
			s = 0.0;
			for ( k = 0; k < n; k++ ) {
				a = A[ ia+k ];
				b = BT[ ib+k ];

				// TwoProduct(a, b) => (h, r) such that h + r = a*b exactly:
				h = a * b;
				c = SPLITTER * a;
				ah = c - ( c - a );
				al = a - ah;
				c = SPLITTER * b;
				bh = c - ( c - b );
				bl = b - bh;
				r = ( al*bl ) - ( ( ( h - ( ah*bh ) ) - ( al*bh ) ) - ( ah*bl ) );

				// TwoSum(p, h) => (x, q) such that x + q = p + h exactly:
				x = p + h;
				z = x - p;
				q = ( p - ( x - z ) ) + ( h - z );
				p = x;

				// Accumulate the error terms in working precision:
				s += q + r;
			}
			// Normalize (p, s) into a double-double (hi, lo):
			x = p + s;
			z = x - p;
			hi[ ia+j ] = x;
			lo[ ia+j ] = ( p - ( x - z ) ) + ( s - z );
		}
	}
	return {
		'hi': hi,
		'lo': lo
	};
}


// EXPORTS //

module.exports = referenceProduct;
