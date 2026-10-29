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

/* eslint-disable max-len, max-params */

'use strict';

// MODULES //

var tape = require( 'tape' );
var discreteUniform = require( '@stdlib/random/base/discrete-uniform' );
var uniform = require( '@stdlib/random/base/uniform' );
var Float64Array = require( '@stdlib/array/float64' );
var dgemm = require( '@stdlib/blas/base/dgemm' ).ndarray;
var abs = require( '@stdlib/math/base/special/abs' );
var max = require( '@stdlib/math/base/special/max' );
var strassen = require( './../lib' );
var workspaceLength = require( './../lib/workspace_length.js' );
var winograd = require( './../lib/winograd.js' );
var classic = require( './../lib/classic.js' );


// VARIABLES //

var SEED = 20261030;
var TRIALS = 4000;
var ALPHAS = [ 0.0, 1.0, -1.0, 2.0, 0.5, -3.0 ];
var BETAS = [ 0.0, 1.0, -1.0, 2.0, 0.5 ];
var CUTOFFS = [ 1, 2, 3, 5, 8 ];
var TRANS = [ 'no-transpose', 'transpose' ];


// FUNCTIONS //

/**
* Returns a strided matrix description, with randomized layout, padding, offset, and stride signs, backed by a buffer whose every element (including padding) is filled with small integers.
*
* @private
* @param {Function} randi - PRNG for integers
* @param {NonNegativeInteger} rows - number of rows
* @param {NonNegativeInteger} cols - number of columns
* @param {number} fill - fill value (`null` for random integers in [-6,6])
* @returns {Object} matrix description
*/
function createMatrix( randi, rows, cols, fill ) {
	var pad;
	var len;
	var buf;
	var s1;
	var s2;
	var o;
	var i;

	pad = randi( 0, 3 );
	if ( randi( 0, 1 ) === 0 ) { // row-major
		s1 = max( cols, 1 ) + pad;
		s2 = 1;
	} else { // column-major
		s1 = 1;
		s2 = max( rows, 1 ) + pad;
	}
	o = randi( 0, 5 );
	len = o + ( max( rows-1, 0 )*s1 ) + ( max( cols-1, 0 )*s2 ) + 1 + randi( 0, 3 );

	// Randomly flip stride signs (the offset must then point to the logical first element)...
	if ( randi( 0, 3 ) === 0 ) {
		o += max( rows-1, 0 ) * s1;
		s1 *= -1;
	}
	if ( randi( 0, 3 ) === 0 ) {
		o += max( cols-1, 0 ) * s2;
		s2 *= -1;
	}
	buf = new Float64Array( len );
	for ( i = 0; i < len; i++ ) {
		buf[ i ] = ( fill === null ) ? randi( -6, 6 ) : fill;
	}
	return {
		'buf': buf,
		's1': s1,
		's2': s2,
		'o': o
	};
}

/**
* Copies a typed array.
*
* @private
* @param {Float64Array} x - input array
* @returns {Float64Array} copy
*/
function copy( x ) {
	return new Float64Array( x );
}

/**
* Returns the index of the first element at which two arrays differ (treating `NaN` as equal to `NaN`), or `-1`.
*
* @private
* @param {Float64Array} x - first array
* @param {Float64Array} y - second array
* @returns {integer} index or `-1`
*/
function firstDifference( x, y ) {
	var i;
	if ( x.length !== y.length ) {
		return 0;
	}
	for ( i = 0; i < x.length; i++ ) {
		if ( x[ i ] !== y[ i ] && !( x[ i ] !== x[ i ] && y[ i ] !== y[ i ] ) ) { // eslint-disable-line no-self-compare
			return i;
		}
	}
	return -1;
}

/**
* Runs randomized exact-arithmetic differential trials against `dgemm`.
*
* @private
* @param {Object} t - test object
* @param {string} name - implementation name
* @param {Function} impl - function `( cutoff, args )` which performs the operation
*/
function differential( t, name, impl ) {
	var failures;
	var randi;
	var cfg;
	var ref;
	var out;
	var ta;
	var tb;
	var A;
	var B;
	var C;
	var M;
	var N;
	var K;
	var a;
	var b;
	var c;
	var d;
	var i;

	randi = discreteUniform.factory({
		'seed': SEED
	});
	failures = 0;
	for ( i = 0; i < TRIALS; i++ ) {
		M = randi( 0, 40 );
		N = randi( 0, 40 );
		K = randi( 0, 40 );
		ta = TRANS[ randi( 0, 1 ) ];
		tb = TRANS[ randi( 0, 1 ) ];
		a = ALPHAS[ randi( 0, ALPHAS.length-1 ) ];
		b = BETAS[ randi( 0, BETAS.length-1 ) ];
		c = CUTOFFS[ randi( 0, CUTOFFS.length-1 ) ];

		// Stored shapes depend on the transpose operations...
		A = ( ta === 'no-transpose' ) ? createMatrix( randi, M, K, null ) : createMatrix( randi, K, M, null );
		B = ( tb === 'no-transpose' ) ? createMatrix( randi, K, N, null ) : createMatrix( randi, N, K, null );

		// When `β = 0`, `C` must be ignored on input, so fill it with `NaN` to verify that `NaN` does not propagate...
		C = createMatrix( randi, M, N, ( b === 0.0 ) ? NaN : null );

		cfg = [ ta, tb, M, N, K, a, b, c ].join( ',' );
		ref = copy( C.buf );
		out = copy( C.buf );
		dgemm( ta, tb, M, N, K, a, A.buf, A.s1, A.s2, A.o, B.buf, B.s1, B.s2, B.o, b, ref, C.s1, C.s2, C.o );

		A.copy = copy( A.buf );
		B.copy = copy( B.buf );
		impl( c, [ ta, tb, M, N, K, a, A.buf, A.s1, A.s2, A.o, B.buf, B.s1, B.s2, B.o, b, out, C.s1, C.s2, C.o ] );

		d = firstDifference( ref, out );
		if ( d >= 0 ) {
			failures += 1;
			if ( failures <= 5 ) {
				t.fail( name + ': mismatch at buffer index ' + d + ' (' + cfg + '): expected ' + ref[ d ] + ', actual ' + out[ d ] );
			}
		}
		if ( firstDifference( A.copy, A.buf ) >= 0 || firstDifference( B.copy, B.buf ) >= 0 ) {
			failures += 1;
			t.fail( name + ': input matrices were mutated (' + cfg + ')' );
		}
	}
	t.strictEqual( failures, 0, name + ': ' + TRIALS + ' randomized trials match dgemm exactly (entire buffers, including padding)' );
}


// TESTS //

tape( 'main export is a function with a factory method', function test( t ) {
	t.strictEqual( typeof strassen, 'function', 'main export is a function' );
	t.strictEqual( typeof strassen.factory, 'function', 'has factory method' );
	t.end();
});

tape( 'the factory throws if not provided a positive integer', function test( t ) {
	var values;
	var i;

	values = [ 0, -1, 1.5, NaN, '5', null, void 0 ];
	for ( i = 0; i < values.length; i++ ) {
		t.throws( badValue( values[ i ] ), TypeError, 'throws for ' + values[ i ] );
	}
	t.end();

	function badValue( value ) {
		return function badValue() {
			strassen.factory( value );
		};
	}
});

tape( 'the function validates arguments using the same messages as dgemm', function test( t ) {
	var fcn = strassen.factory( 1 );
	var x = new Float64Array( 4 );
	t.throws( function badValue() {
		fcn( 'foo', 'no-transpose', 2, 2, 2, 1.0, x, 2, 1, 0, x, 2, 1, 0, 0.0, x, 2, 1, 0 );
	}, /First argument must be a valid transpose operation/, 'throws for invalid transA' );
	t.throws( function badValue() {
		fcn( 'no-transpose', 'no-transpose', -1, 2, 2, 1.0, x, 2, 1, 0, x, 2, 1, 0, 0.0, x, 2, 1, 0 );
	}, /Third argument must be a nonnegative integer/, 'throws for negative M' );
	t.throws( function badValue() {
		fcn( 'no-transpose', 'no-transpose', 2, 2, 2, 1.0, x, 2, 1, 0, x, 2, 1, 0, 0.0, x, 0, 1, 0 );
	}, /Seventeenth argument must be non-zero/, 'throws for zero strideC1' );
	t.end();
});

tape( 'Strassen–Winograd matches dgemm exactly on integer-valued matrices (randomized dimensions, cutoffs, transposes, layouts, strides, offsets, α, β)', function test( t ) {
	differential( t, 'winograd', function impl( cutoff, args ) {
		var f = strassen.factory( cutoff );
		f.apply( null, args );
	});
	t.end();
});

tape( 'the recursive conventional control matches dgemm exactly on integer-valued matrices', function test( t ) {
	differential( t, 'classic', function impl( cutoff, args ) {
		var sa1 = ( args[ 0 ] === 'no-transpose' ) ? args[ 7 ] : args[ 8 ];
		var sa2 = ( args[ 0 ] === 'no-transpose' ) ? args[ 8 ] : args[ 7 ];
		var sb1 = ( args[ 1 ] === 'no-transpose' ) ? args[ 11 ] : args[ 12 ];
		var sb2 = ( args[ 1 ] === 'no-transpose' ) ? args[ 12 ] : args[ 11 ];
		classic( args[ 2 ], args[ 3 ], args[ 4 ], args[ 5 ], args[ 6 ], sa1, sa2, args[ 9 ], args[ 10 ], sb1, sb2, args[ 13 ], args[ 14 ], args[ 15 ], args[ 16 ], args[ 17 ], args[ 18 ], cutoff );
	});
	t.end();
});

tape( 'the recursion never touches workspace beyond the computed length', function test( t ) {
	var shapes;
	var guard;
	var ok;
	var len;
	var A;
	var B;
	var C;
	var W;
	var s;
	var i;
	var j;

	shapes = [ [ 17, 9, 33, 2 ], [ 64, 64, 64, 4 ], [ 31, 47, 29, 3 ], [ 100, 7, 50, 3 ], [ 9, 100, 13, 1 ] ];
	guard = 64;
	ok = true;
	for ( i = 0; i < shapes.length; i++ ) {
		s = shapes[ i ];
		len = workspaceLength( s[ 0 ], s[ 1 ], s[ 2 ], s[ 3 ] );
		W = new Float64Array( len + guard );
		for ( j = len; j < W.length; j++ ) {
			W[ j ] = 12345.0;
		}
		A = new Float64Array( s[ 0 ]*s[ 2 ] ).fill( 1.0 );
		B = new Float64Array( s[ 2 ]*s[ 1 ] ).fill( 1.0 );
		C = new Float64Array( s[ 0 ]*s[ 1 ] );
		winograd( s[ 0 ], s[ 1 ], s[ 2 ], 1.0, A, s[ 2 ], 1, 0, B, s[ 1 ], 1, 0, C, s[ 1 ], 1, 0, W, 0, s[ 3 ] );
		for ( j = len; j < W.length; j++ ) {
			if ( W[ j ] !== 12345.0 ) {
				ok = false;
			}
		}
		for ( j = 0; j < C.length; j++ ) {
			if ( C[ j ] !== s[ 2 ] ) { // all-ones inputs => every element equals K
				ok = false;
			}
		}
	}
	t.strictEqual( ok, true, 'guard elements are untouched and results are correct' );
	t.end();
});

tape( 'Strassen–Winograd agrees with dgemm to within a normwise tolerance on random real-valued matrices', function test( t ) {
	var maxerr;
	var rand;
	var ref;
	var out;
	var tol;
	var A;
	var B;
	var n;
	var i;

	rand = uniform.factory( -1.0, 1.0, {
		'seed': SEED
	});
	n = 257; // odd => peeling at the top level
	A = new Float64Array( n*n );
	B = new Float64Array( n*n );
	for ( i = 0; i < n*n; i++ ) {
		A[ i ] = rand();
		B[ i ] = rand();
	}
	ref = new Float64Array( n*n );
	out = new Float64Array( n*n );
	dgemm( 'no-transpose', 'no-transpose', n, n, n, 1.0, A, n, 1, 0, B, n, 1, 0, 0.0, ref, n, 1, 0 );
	strassen.factory( 8 )( 'no-transpose', 'no-transpose', n, n, n, 1.0, A, n, 1, 0, B, n, 1, 0, 0.0, out, n, 1, 0 );
	maxerr = 0.0;
	for ( i = 0; i < n*n; i++ ) {
		maxerr = max( maxerr, abs( out[ i ] - ref[ i ] ) );
	}
	// Loose sanity bound: ||A||_max ||B||_max <= 1, n = 257, five levels of recursion...
	tol = 1.0e-10;
	t.ok( maxerr < tol, 'max abs difference (' + maxerr + ') is less than ' + tol );
	t.end();
});
