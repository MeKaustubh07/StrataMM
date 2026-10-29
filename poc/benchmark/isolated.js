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

// Process-isolated POC benchmark (a miniature of the protocol in docs/implementation-plan.md):
// - one fresh Node process per (algorithm, n, cutoff, block), so no JIT/type-feedback state is shared;
// - randomized complete blocks: every block runs each algorithm once, in a freshly shuffled order;
// - speedups are paired within blocks (dgemm time / algorithm time), summarized by the median with the min–max range.
// Still indicative: few blocks, no pre-flight checks, no sentinel, no bootstrap CIs.

// MODULES //

var spawnSync = require( 'child_process' ).spawnSync;
var path = require( 'path' );
var fs = require( 'fs' );
var discreteUniform = require( '@stdlib/random/base/discrete-uniform' );
var env = require( './env.js' );


// VARIABLES //

var SEED = 20261030;
var GRID = ( process.env.GRID ) ? JSON.parse( process.env.GRID ) : [
	{ 'n': 512, 'blocks': 6, 'samples': 5, 'warmup': 2 },
	{ 'n': 1024, 'blocks': 4, 'samples': 3, 'warmup': 1 }
];
var CUTOFF = Number( process.env.CUTOFF || 64 );
var ALGS = [
	{ 'alg': 'dgemm', 'cutoff': null },
	{ 'alg': 'classic-recursive', 'cutoff': CUTOFF },
	{ 'alg': 'winograd', 'cutoff': CUTOFF }
];


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


// MAIN //

/**
* Main execution sequence.
*
* @private
*/
function main() {
	var outfile;
	var results;
	var ratios;
	var randi;
	var order;
	var meta;
	var proc;
	var line;
	var res;
	var g;
	var b;
	var k;

	meta = env();
	meta.kind = 'isolated-poc';
	meta.grid = GRID;
	meta.cutoff = CUTOFF;
	outfile = path.join( __dirname, 'results', 'isolated-' + meta.timestamp.replace( /[:.]/g, '-' ) + '.jsonl' );
	fs.mkdirSync( path.dirname( outfile ), {
		'recursive': true
	});
	fs.writeFileSync( outfile, JSON.stringify( { 'type': 'env', 'env': meta } ) + '\n' );
	console.log( '# power: ' + meta.powerSource + ' | load: ' + meta.loadAverage.map( function f( x ) {
		return x.toFixed( 2 );
	}).join( ' ' ) );

	randi = discreteUniform.factory({
		'seed': SEED
	});
	for ( g = 0; g < GRID.length; g++ ) {
		results = {};
		ALGS.forEach( function each( a ) {
			results[ a.alg ] = [];
		});
		for ( b = 0; b < GRID[ g ].blocks; b++ ) {
			order = shuffle( ALGS.slice(), randi );
			for ( k = 0; k < order.length; k++ ) {
				proc = spawnSync( process.execPath, [ '--expose-gc', path.join( __dirname, 'child.js' ), JSON.stringify({
					'alg': order[ k ].alg,
					'cutoff': order[ k ].cutoff,
					'n': GRID[ g ].n,
					'seed': SEED + b,
					'block': b,
					'samples': GRID[ g ].samples,
					'warmup': GRID[ g ].warmup
				}) ], {
					'env': process.env,
					'encoding': 'utf8'
				});
				if ( proc.status !== 0 ) {
					throw new Error( 'child failed: ' + proc.stderr );
				}
				res = JSON.parse( proc.stdout.trim().split( '\n' ).pop() );
				results[ res.alg ][ b ] = res.median;
				fs.appendFileSync( outfile, JSON.stringify( { 'type': 'proc', 'result': res } ) + '\n' );
			}
		}
		console.log( '\n# n = ' + GRID[ g ].n + ' (' + GRID[ g ].blocks + ' blocks x 1 fresh process per algorithm; ' + GRID[ g ].samples + ' samples/process; cutoff ' + CUTOFF + ')' );
		console.log( 'algorithm             median(s)   GFLOP/s   paired speedup vs dgemm: median [min, max]' );
		ALGS.forEach( function each( a ) {
			var t = results[ a.alg ];
			var n = GRID[ g ].n;
			ratios = [];
			for ( b = 0; b < t.length; b++ ) {
				ratios.push( results.dgemm[ b ] / t[ b ] );
			}
			ratios.sort( function cmp( x, y ) {
				return x - y;
			});
			line = a.alg.padEnd( 20 ) + median( t ).toFixed( 4 ).padStart( 11 ) + ( ( 2.0*n*n*n ) / median( t ) / 1.0e9 ).toFixed( 3 ).padStart( 10 ) + ( median( ratios ).toFixed( 3 ) + 'x [' + ratios[ 0 ].toFixed( 3 ) + ', ' + ratios[ ratios.length-1 ].toFixed( 3 ) + ']' ).padStart( 34 );
			console.log( line );
			fs.appendFileSync( outfile, JSON.stringify( { 'type': 'summary', 'n': n, 'alg': a.alg, 'cutoff': a.cutoff, 'median': median( t ), 'speedup': median( ratios ), 'speedupMin': ratios[ 0 ], 'speedupMax': ratios[ ratios.length-1 ] } ) + '\n' );
		});
	}
	console.log( '\n# Raw data: ' + outfile );
}

main();
