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

/* eslint-disable no-console */

'use strict';

// Side check E8 (see docs/research-protocol.md): does ml-matrix's `mmulStrassen` agree with its own classical `mmul`?
//
// Static reading of ml-matrix 6.15.1 (`matrix.js`, `mmulStrassen` → `blockMult`) suggests the recursive path, taken
// when both padded dimensions exceed 512, writes C12 = m3 + m5 to the bottom-left quadrant and C21 = m2 + m4 to the
// top-right (`setSubMatrix(matrix, startRow, startColumn)`). This script checks that claim by execution.
//
// Usage (deliberately manual; this runs third-party code):
//
//   mkdir -p /tmp/mlm && cd /tmp/mlm && npm init -y && npm install --ignore-scripts ml-matrix@6.15.1
//   node <repo>/poc/side-checks/mlmatrix-strassen-check.js /tmp/mlm/node_modules/ml-matrix
//
// Inputs are small integers, so both algorithms compute exactly: any nonzero difference is a correctness bug, not
// rounding. If confirmed, report upstream (https://github.com/mljs/matrix/issues) before any public mention.

// MODULES //

var resolve = require( 'path' ).resolve;


// VARIABLES //

var Matrix = require( resolve( process.argv[ 2 ], 'matrix.js' ) ).Matrix;
var SHAPES = [ [ 4, 4, 4 ], [ 513, 513, 513 ], [ 600, 600, 600 ], [ 1024, 1024, 1024 ], [ 700, 600, 650 ] ];


// FUNCTIONS //

/**
* Returns a deterministic matrix of small integers.
*
* @private
* @param {PositiveInteger} rows - number of rows
* @param {PositiveInteger} cols - number of columns
* @param {integer} seed - seed offset
* @returns {Matrix} matrix
*/
function make( rows, cols, seed ) {
	var m = Matrix.zeros( rows, cols );
	var i;
	var j;
	for ( i = 0; i < rows; i++ ) {
		for ( j = 0; j < cols; j++ ) {
			m.set( i, j, ( ( ( i*31 ) + ( j*17 ) + seed ) % 7 ) - 3 );
		}
	}
	return m;
}


// MAIN //

SHAPES.forEach( function run( d ) {
	var shapeOK;
	var diff;
	var ref;
	var out;
	var A;
	var B;
	var i;
	var j;

	A = make( d[ 0 ], d[ 1 ], 1 );
	B = make( d[ 1 ], d[ 2 ], 2 );
	ref = A.mmul( B );
	out = A.mmulStrassen( B );
	shapeOK = ( out.rows === ref.rows && out.columns === ref.columns );
	diff = 0;
	if ( shapeOK ) {
		for ( i = 0; i < ref.rows; i++ ) {
			for ( j = 0; j < ref.columns; j++ ) {
				diff = Math.max( diff, Math.abs( out.get( i, j ) - ref.get( i, j ) ) );
			}
		}
	}
	console.log( d.join( 'x' ) + ': result ' + out.rows + 'x' + out.columns + ' (expected ' + ref.rows + 'x' + ref.columns + '), max |mmulStrassen - mmul| = ' + ( ( shapeOK ) ? diff : 'n/a (shape mismatch)' ) );
});
