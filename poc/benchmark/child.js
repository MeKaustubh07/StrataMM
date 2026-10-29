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

/* eslint-disable no-console, max-len */

'use strict';

// Child process for the process-isolated POC benchmark: runs exactly one (algorithm, n, cutoff) configuration
// in a fresh V8 instance (no shared JIT/type-feedback state with other algorithms), then prints one JSON line.

// MODULES //

var uniform = require( '@stdlib/random/base/uniform' );
var Float64Array = require( '@stdlib/array/float64' );
var dgemm = require( '@stdlib/blas/base/dgemm' ).ndarray;
var strassen = require( './../lib' );
var classic = require( './../lib/classic.js' );


// VARIABLES //

var NT = 'no-transpose';
var cfg = JSON.parse( process.argv[ 2 ] );


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
* Freivalds-style check: compares C*x with A*(B*x) for a random vector x (O(n^2)), returning the relative discrepancy.
*
* @private
* @param {PositiveInteger} n - order
* @param {Float64Array} A - first matrix (row-major)
* @param {Float64Array} B - second matrix (row-major)
* @param {Float64Array} C - computed product (row-major)
* @returns {number} relative discrepancy
*/
function freivalds( n, A, B, C ) {
	var num;
	var den;
	var Bx;
	var x;
	var s;
	var t;
	var i;
	var j;

	x = new Float64Array( n );
	for ( i = 0; i < n; i++ ) {
		x[ i ] = ( i%3 ) - 1.0;
	}
	Bx = new Float64Array( n );
	for ( i = 0; i < n; i++ ) {
		s = 0.0;
		for ( j = 0; j < n; j++ ) {
			s += B[ (i*n)+j ] * x[ j ];
		}
		Bx[ i ] = s;
	}
	num = 0.0;
	den = 0.0;
	for ( i = 0; i < n; i++ ) {
		s = 0.0;
		t = 0.0;
		for ( j = 0; j < n; j++ ) {
			s += C[ (i*n)+j ] * x[ j ];
			t += A[ (i*n)+j ] * Bx[ j ];
		}
		num = Math.max( num, Math.abs( s - t ) );
		den = Math.max( den, Math.abs( t ) );
	}
	return num / ( den || 1.0 );
}


// MAIN //

/**
* Main execution sequence.
*
* @private
*/
function main() {
	var samples;
	var first;
	var rand;
	var gate;
	var sink;
	var fcn;
	var A;
	var B;
	var C;
	var n;
	var t;
	var i;

	n = cfg.n;
	rand = uniform.factory( -1.0, 1.0, {
		'seed': cfg.seed
	});
	A = new Float64Array( n*n );
	B = new Float64Array( n*n );
	C = new Float64Array( n*n );
	for ( i = 0; i < n*n; i++ ) {
		A[ i ] = rand();
		B[ i ] = rand();
	}
	C.fill( NaN ); // β = 0 must ignore C

	if ( cfg.alg === 'dgemm' ) {
		fcn = function dg() {
			dgemm( NT, NT, n, n, n, 1.0, A, n, 1, 0, B, n, 1, 0, 0.0, C, n, 1, 0 );
		};
	} else if ( cfg.alg === 'winograd' ) {
		fcn = ( function create( f ) {
			return function sw() {
				f( NT, NT, n, n, n, 1.0, A, n, 1, 0, B, n, 1, 0, 0.0, C, n, 1, 0 );
			};
		})( strassen.factory( cfg.cutoff ) );
	} else if ( cfg.alg === 'classic-recursive' ) {
		fcn = function cr() {
			classic( n, n, n, 1.0, A, n, 1, 0, B, n, 1, 0, 0.0, C, n, 1, 0, cfg.cutoff );
		};
	} else {
		throw new Error( 'unknown algorithm: ' + cfg.alg );
	}
	// First (cold) call doubles as the correctness gate...
	t = process.hrtime.bigint();
	fcn();
	first = Number( process.hrtime.bigint() - t ) / 1.0e9;
	gate = freivalds( n, A, B, C );
	if ( !( gate < 1.0e-10 ) ) {
		throw new Error( 'correctness gate failed: ' + gate );
	}
	// Warmup...
	for ( i = 0; i < cfg.warmup; i++ ) {
		fcn();
	}
	if ( typeof global.gc === 'function' ) {
		global.gc(); // once, at the warmup/measurement boundary
	}
	samples = [];
	sink = 0.0;
	for ( i = 0; i < cfg.samples; i++ ) {
		t = process.hrtime.bigint();
		fcn();
		samples.push( Number( process.hrtime.bigint() - t ) / 1.0e9 );
		sink += C[ ( i*7919 ) % C.length ];
	}
	console.log( JSON.stringify({
		'alg': cfg.alg,
		'cutoff': cfg.cutoff,
		'n': n,
		'block': cfg.block,
		'first': first,
		'gate': gate,
		'samples': samples,
		'median': median( samples ),
		'sink': sink
	}) );
}

main();
