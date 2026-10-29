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

/**
* Proof of concept: Strassen–Winograd matrix multiplication layered on `@stdlib/blas/base/dgemm`.
*
* @module strassen-poc
*
* @example
* var Float64Array = require( '@stdlib/array/float64' );
* var dgemm = require( './lib' );
*
* var A = new Float64Array( [ 1.0, 2.0, 3.0, 4.0 ] );
* var B = new Float64Array( [ 5.0, 6.0, 7.0, 8.0 ] );
* var C = new Float64Array( 4 );
*
* dgemm.factory( 1 )( 'no-transpose', 'no-transpose', 2, 2, 2, 1.0, A, 2, 1, 0, B, 2, 1, 0, 0.0, C, 2, 1, 0 );
* // C => <Float64Array>[ 19.0, 22.0, 43.0, 50.0 ]
*/

// MODULES //

var setReadOnly = require( '@stdlib/utils/define-nonenumerable-read-only-property' );
var factory = require( './factory.js' );


// VARIABLES //

var DEFAULT_CUTOFF = 64; // POC placeholder; the default is to be chosen from the cutoff-sweep experiment


// MAIN //

var main = factory( DEFAULT_CUTOFF );
setReadOnly( main, 'factory', factory );


// EXPORTS //

module.exports = main;
