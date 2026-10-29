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

/* eslint-disable no-console, max-len, max-statements */

'use strict';

// Indicative (POC) accuracy probe: forward error of dgemm and Strassen–Winograd (at increasing recursion depth)
// against a double-double reference computed with Ogita–Rump–Oishi's Dot2 (error-free transformations).

// MODULES //

var path = require( 'path' );
var fs = require( 'fs' );
var uniform = require( '@stdlib/random/base/uniform' );
var Float64Array = require( '@stdlib/array/float64' );
var dgemm = require( '@stdlib/blas/base/dgemm' ).ndarray;
var strassen = require( './../lib' );
var referenceProduct = require( './reference.js' );
var env = require( './env.js' );


// VARIABLES //

var SEED = 20261030;
var EPS = Math.pow( 2.0, -53 ); // unit roundoff
var SIZES = ( process.env.SIZES ) ? process.env.SIZES.split( ',' ).map( Number ) : [ 64, 128, 256, 512 ];
var NT = 'no-transpose';


// FUNCTIONS //

/**
* Generates a pair of test matrices for a given input family.
*
* @private
* @param {string} family - input family
* @param {PositiveInteger} n - matrix order
* @param {Function} rand - PRNG returning numbers on [0,1)
* @returns {Array<Float64Array>} matrices
*/
function generate( family, n, rand ) {
	var A = new Float64Array( n*n );
	var B = new Float64Array( n*n );
	var d;
	var i;
	var j;
	for ( i = 0; i < n*n; i++ ) {
		if ( family === 'uniform[0,1]' ) {
			A[ i ] = rand();
			B[ i ] = rand();
		} else {
			A[ i ] = ( 2.0*rand() ) - 1.0;
			B[ i ] = ( 2.0*rand() ) - 1.0;
		}
	}
	if ( family === 'outside-scaled' ) {
		// Rows of A and columns of B scaled by 2^U(-16,16): small output entries next to large ones (Higham, 2002; Ballard et al., 2016)...
		for ( i = 0; i < n; i++ ) {
			d = Math.pow( 2.0, Math.round( ( 32.0*rand() ) - 16.0 ) );
			for ( j = 0; j < n; j++ ) {
				A[ ( i*n )+j ] *= d;
			}
			d = Math.pow( 2.0, Math.round( ( 32.0*rand() ) - 16.0 ) );
			for ( j = 0; j < n; j++ ) {
				B[ ( j*n )+i ] *= d;
			}
		}
	} else if ( family === 'inside-scaled' ) {
		// Columns of A scaled by 2^s and rows of B by 2^-s: the exact product is unchanged in distribution, but operand magnitudes vary widely within each inner product...
		for ( i = 0; i < n; i++ ) {
			d = Math.pow( 2.0, Math.round( ( 32.0*rand() ) - 16.0 ) );
			for ( j = 0; j < n; j++ ) {
				A[ ( j*n )+i ] *= d;
				B[ ( i*n )+j ] /= d;
			}
		}
	}
	return [ A, B ];
}

/**
* Computes forward error metrics (in units of the unit roundoff).
*
* @private
* @param {PositiveInteger} n - matrix order
* @param {Float64Array} X - computed product
* @param {Object} ref - reference product (`hi`, `lo`)
* @param {Float64Array} AB - product of absolute values `|A||B|`
* @returns {Object} metrics
*/
function errors( n, X, ref, AB ) {
	var maxabsAB;
	var normwise;
	var cw;
	var e;
	var i;

	maxabsAB = 0.0;
	for ( i = 0; i < n*n; i++ ) {
		maxabsAB = Math.max( maxabsAB, AB[ i ] );
	}
	normwise = 0.0;
	cw = 0.0;
	for ( i = 0; i < n*n; i++ ) {
		e = Math.abs( ( X[ i ] - ref.hi[ i ] ) - ref.lo[ i ] );
		normwise = Math.max( normwise, e );
		if ( AB[ i ] > 0.0 ) {
			cw = Math.max( cw, e / AB[ i ] );
		}
	}
	return {
		'normwise': normwise / maxabsAB / EPS, // max|C - Ĉ| / max(|A||B|), in units of u
		'componentwise': cw / EPS // max_ij |C - Ĉ|_ij / (|A||B|)_ij, in units of u
	};
}


// MAIN //

/**
* Main execution sequence.
*
* @private
*/
function main() {
	var families;
	var outfile;
	var cutoff;
	var depth;
	var meta;
	var rand;
	var absA;
	var absB;
	var ref;
	var AB;
	var ex;
	var A;
	var B;
	var X;
	var n;
	var e;
	var f;
	var i;
	var j;

	families = [ 'uniform[0,1]', 'uniform[-1,1]', 'outside-scaled', 'inside-scaled' ];
	meta = env();
	meta.kind = 'accuracy-poc';
	outfile = path.join( __dirname, 'results', 'accuracy-' + meta.timestamp.replace( /[:.]/g, '-' ) + '.jsonl' );
	fs.mkdirSync( path.dirname( outfile ), {
		'recursive': true
	});
	fs.writeFileSync( outfile, JSON.stringify( { 'type': 'env', 'env': meta } ) + '\n' );
	rand = uniform.factory( 0.0, 1.0, {
		'seed': SEED
	});
	console.log( 'family            n     algorithm         depth   normwise(u)   componentwise(u)' );
	for ( f = 0; f < families.length; f++ ) {
		for ( i = 0; i < SIZES.length; i++ ) {
			n = SIZES[ i ];
			ex = generate( families[ f ], n, rand );
			A = ex[ 0 ];
			B = ex[ 1 ];
			ref = referenceProduct( n, A, B );
			absA = A.map( Math.abs );
			absB = B.map( Math.abs );
			AB = new Float64Array( n*n );
			dgemm( NT, NT, n, n, n, 1.0, absA, n, 1, 0, absB, n, 1, 0, 0.0, AB, n, 1, 0 );

			X = new Float64Array( n*n );
			dgemm( NT, NT, n, n, n, 1.0, A, n, 1, 0, B, n, 1, 0, 0.0, X, n, 1, 0 );
			e = errors( n, X, ref, AB );
			report( families[ f ], n, 'dgemm', 0, e );

			// Strassen–Winograd at increasing recursion depth (cutoff n/2^d => d levels for powers of two)...
			for ( depth = 1, cutoff = n/2; cutoff >= 8; depth++, cutoff /= 2 ) {
				for ( j = 0; j < n*n; j++ ) {
					X[ j ] = 0.0;
				}
				strassen.factory( cutoff )( NT, NT, n, n, n, 1.0, A, n, 1, 0, B, n, 1, 0, 0.0, X, n, 1, 0 );
				e = errors( n, X, ref, AB );
				report( families[ f ], n, 'winograd', depth, e );
			}
		}
	}
	console.log( '\n# Raw data: ' + outfile );

	function report( family, order, alg, d, err ) {
		console.log( family.padEnd( 16 ) + String( order ).padStart( 5 ) + '     ' + alg.padEnd( 16 ) + String( d ).padStart( 6 ) + err.normwise.toFixed( 2 ).padStart( 14 ) + err.componentwise.toExponential( 2 ).padStart( 19 ) );
		fs.appendFileSync( outfile, JSON.stringify({
			'type': 'error',
			'family': family,
			'n': order,
			'alg': alg,
			'depth': d,
			'normwise_u': err.normwise,
			'componentwise_u': err.componentwise
		}) + '\n' );
	}
}

main();
