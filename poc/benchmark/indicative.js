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

// Indicative (POC) benchmark. NOT the rigorous protocol described in the implementation plan:
// single process, short warmup, few interleaved repetitions. Numbers are for orientation only.

// MODULES //

var path = require( 'path' );
var fs = require( 'fs' );
var discreteUniform = require( '@stdlib/random/base/discrete-uniform' );
var uniform = require( '@stdlib/random/base/uniform' );
var Float64Array = require( '@stdlib/array/float64' );
var dgemm = require( '@stdlib/blas/base/dgemm' ).ndarray;
var strassen = require( './../lib' );
var classic = require( './../lib/classic.js' );
var workspaceLength = require( './../lib/workspace_length.js' );
var env = require( './env.js' );


// VARIABLES //

var SEED = 20261030;
var SIZES = ( process.env.SIZES ) ? process.env.SIZES.split( ',' ).map( Number ) : [ 128, 256, 512, 1000, 1024 ];
var CUTOFFS = ( process.env.CUTOFFS ) ? process.env.CUTOFFS.split( ',' ).map( Number ) : [ 32, 64, 128 ];
var BUDGET = Number( process.env.BUDGET_SECONDS || 12 ); // target measured seconds per (size, algorithm)
var MIN_REPS = 3;
var MAX_REPS = 15;
var NT = 'no-transpose';


// FUNCTIONS //

/**
* Returns the median of an array of numbers.
*
* @private
* @param {NumericArray} x - input array
* @returns {number} median
*/
function median( x ) {
	var s = x.slice().sort( function cmp( a, b ) {
		return a - b;
	});
	var n = s.length;
	return ( n%2 ) ? s[ (n-1)/2 ] : ( s[ (n/2)-1 ] + s[ n/2 ] ) / 2.0;
}

/**
* Returns the sum of all elements (used as an anti-dead-code-elimination checksum).
*
* @private
* @param {Float64Array} x - input array
* @returns {number} sum
*/
function checksum( x ) {
	var s = 0.0;
	var i;
	for ( i = 0; i < x.length; i++ ) {
		s += x[ i ];
	}
	return s;
}

/**
* Shuffles an array in-place (Fisher–Yates) using a seeded PRNG.
*
* @private
* @param {Array} arr - input array
* @param {Function} randi - PRNG
* @returns {Array} input array
*/
function shuffle( arr, randi ) {
	var tmp;
	var i;
	var j;
	for ( i = arr.length-1; i > 0; i-- ) {
		j = randi( 0, i );
		tmp = arr[ i ];
		arr[ i ] = arr[ j ];
		arr[ j ] = tmp;
	}
	return arr;
}

/**
* Times a single invocation (in seconds), optionally triggering garbage collection beforehand.
*
* @private
* @param {Function} fcn - function to time
* @returns {number} elapsed time (seconds)
*/
function time( fcn ) {
	var t0;
	if ( typeof global.gc === 'function' ) {
		global.gc();
	}
	t0 = process.hrtime.bigint();
	fcn();
	return Number( process.hrtime.bigint() - t0 ) / 1.0e9;
}


// MAIN //

/**
* Main execution sequence.
*
* @private
*/
function main() {
	var outfile;
	var results;
	var randi;
	var rand;
	var algs;
	var meta;
	var reps;
	var line;
	var ref;
	var A;
	var B;
	var C;
	var n;
	var r;
	var i;
	var j;
	var t;

	meta = env();
	meta.kind = 'indicative-poc';
	meta.sizes = SIZES;
	meta.cutoffs = CUTOFFS;
	meta.budgetSeconds = BUDGET;
	console.log( '# Environment' );
	console.log( JSON.stringify( meta, null, 2 ) );
	if ( typeof global.gc !== 'function' ) {
		console.log( '# WARNING: run with --expose-gc for GC between measurements' );
	}
	outfile = path.join( __dirname, 'results', 'indicative-' + meta.timestamp.replace( /[:.]/g, '-' ) + '.jsonl' );
	fs.mkdirSync( path.dirname( outfile ), {
		'recursive': true
	});
	fs.writeFileSync( outfile, JSON.stringify( { 'type': 'env', 'env': meta } ) + '\n' );

	randi = discreteUniform.factory({
		'seed': SEED
	});
	rand = uniform.factory( -1.0, 1.0, {
		'seed': SEED
	});
	for ( i = 0; i < SIZES.length; i++ ) {
		n = SIZES[ i ];
		A = new Float64Array( n*n );
		B = new Float64Array( n*n );
		C = new Float64Array( n*n );
		for ( j = 0; j < n*n; j++ ) {
			A[ j ] = rand();
			B[ j ] = rand();
		}
		algs = [
			{
				'name': 'dgemm',
				'cutoff': null,
				'fcn': function dg() {
					dgemm( NT, NT, n, n, n, 1.0, A, n, 1, 0, B, n, 1, 0, 0.0, C, n, 1, 0 );
				}
			}
		];
		CUTOFFS.forEach( function each( c ) {
			var f = strassen.factory( c );
			algs.push({
				'name': 'winograd',
				'cutoff': c,
				'workspaceBytes': 8 * workspaceLength( n, n, n, c ),
				'fcn': function sw() {
					f( NT, NT, n, n, n, 1.0, A, n, 1, 0, B, n, 1, 0, 0.0, C, n, 1, 0 );
				}
			});
			algs.push({
				'name': 'classic-recursive',
				'cutoff': c,
				'workspaceBytes': 0,
				'fcn': function cr() {
					classic( n, n, n, 1.0, A, n, 1, 0, B, n, 1, 0, 0.0, C, n, 1, 0, c );
				}
			});
		});

		// Warmup (also establishes the reference checksum and per-algorithm run time)...
		algs[ 0 ].fcn();
		ref = checksum( C );
		for ( j = 0; j < algs.length; j++ ) {
			algs[ j ].fcn();
			algs[ j ].times = [];
			algs[ j ].warm = time( algs[ j ].fcn );
			if ( Math.abs( checksum( C ) - ref ) > 1.0e-6 * Math.abs( ref ) + 1.0e-6 ) {
				throw new Error( 'checksum mismatch for ' + algs[ j ].name + ' (cutoff ' + algs[ j ].cutoff + ') at n=' + n );
			}
		}
		reps = Math.max( MIN_REPS, Math.min( MAX_REPS, Math.floor( BUDGET / algs[ 0 ].warm ) ) );

		// Interleaved rounds: every algorithm runs once per round in a freshly shuffled order (cancels slow drift, e.g., thermal)...
		for ( r = 0; r < reps; r++ ) {
			shuffle( algs.slice(), randi ).forEach( function each( alg ) {
				t = time( alg.fcn );
				alg.times.push( t );
				fs.appendFileSync( outfile, JSON.stringify({
					'type': 'run',
					'n': n,
					'alg': alg.name,
					'cutoff': alg.cutoff,
					'round': r,
					'seconds': t,
					'checksum': checksum( C )
				}) + '\n' );
			});
		}
		results = algs.map( function each( alg ) {
			var ratios = [];
			var k;
			for ( k = 0; k < reps; k++ ) {
				ratios.push( algs[ 0 ].times[ k ] / alg.times[ k ] ); // paired by round
			}
			ratios.sort( function cmp( a, b ) {
				return a - b;
			});
			return {
				'alg': alg.name,
				'cutoff': alg.cutoff,
				'median': median( alg.times ),
				'gflops': ( 2.0*n*n*n ) / median( alg.times ) / 1.0e9,
				'speedup': median( ratios ),
				'speedupMin': ratios[ 0 ],
				'speedupMax': ratios[ ratios.length-1 ],
				'workspaceMB': ( alg.workspaceBytes || 0 ) / 1048576
			};
		});
		console.log( '\n# n = ' + n + ' (' + reps + ' interleaved rounds)' );
		console.log( 'algorithm            cutoff   median(s)   GFLOP/s   speedup vs dgemm [min, max]   workspace(MB)' );
		results.forEach( function each( res ) {
			line = res.alg.padEnd( 20 ) + String( res.cutoff === null ? '-' : res.cutoff ).padStart( 6 ) + res.median.toFixed( 4 ).padStart( 12 ) + res.gflops.toFixed( 3 ).padStart( 10 ) + ( res.speedup.toFixed( 3 ) + 'x [' + res.speedupMin.toFixed( 2 ) + ', ' + res.speedupMax.toFixed( 2 ) + ']' ).padStart( 30 ) + res.workspaceMB.toFixed( 2 ).padStart( 16 );
			console.log( line );
			fs.appendFileSync( outfile, JSON.stringify( { 'type': 'summary', 'n': n, 'result': res } ) + '\n' );
		});
	}
	console.log( '\n# Raw data: ' + outfile );
}

main();
