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

/* eslint-disable max-len */

'use strict';

// MODULES //

var tape = require( 'tape' );
var uniform = require( '@stdlib/random/base/uniform' );
var Float64Array = require( '@stdlib/array/float64' );
var referenceProduct = require( './../benchmark/reference.js' );


// VARIABLES //

var SEED = 20261030;
var EPS = Math.pow( 2.0, -53 ); // unit roundoff
var SCALE = 1100n; // each double x is represented exactly as the integer x*2^1100 (covers subnormals down to 2^-1074)


// FUNCTIONS //

/**
* Returns `x*2^SCALE` as an exact BigInt.
*
* @private
* @param {number} x - finite double
* @returns {BigInt} scaled integer
*/
function toScaledBigInt( x ) {
	var view;
	var bits;
	var mant;
	var sign;
	var exp;

	if ( x === 0.0 ) {
		return 0n;
	}
	view = new DataView( new ArrayBuffer( 8 ) );
	view.setFloat64( 0, x );
	bits = view.getBigUint64( 0 );
	sign = ( bits >> 63n ) ? -1n : 1n;
	exp = Number( ( bits >> 52n ) & 0x7ffn );
	mant = bits & 0xfffffffffffffn;
	if ( exp === 0 ) {
		exp = -1074; // subnormal
	} else {
		mant |= 0x10000000000000n;
		exp -= 1075;
	}
	return sign * ( mant << BigInt( exp + Number( SCALE ) ) );
}

/**
* Returns the relative error `|approx - exact| / |exact|` as a double, where both arguments are scaled BigInts.
*
* @private
* @param {BigInt} approx - approximation
* @param {BigInt} exact - exact value
* @returns {number} relative error
*/
function relerr( approx, exact ) {
	var num = approx - exact;
	if ( num < 0n ) {
		num = -num;
	}
	if ( exact < 0n ) {
		exact = -exact;
	}
	if ( exact === 0n ) {
		return ( num === 0n ) ? 0.0 : Infinity;
	}
	return Number( ( num * ( 1n << 200n ) ) / exact ) / Math.pow( 2.0, 200 );
}

/**
* Checks the reference product against exact rational arithmetic.
*
* ## Notes
*
* -   Dot2 satisfies `|res - x^T y| <= u|x^T y| + γ_n² |x|^T|y|` (Ogita et al., 2005, Proposition 4.10), where the first term stems from the final rounding. Because the result is retained as an unevaluated double-double, only the second term applies, and we report the ratio of the observed error to `γ_n² |x|^T|y|` (which must not exceed one).
*
* @private
* @param {PositiveInteger} n - order
* @param {Float64Array} A - first matrix
* @param {Float64Array} B - second matrix
* @returns {Object} maximum relative error and maximum ratio of the observed error to the a priori bound
*/
function check( n, A, B ) {
	var gamma2;
	var approx;
	var exact;
	var absum;
	var ratio;
	var maxe;
	var ref;
	var err;
	var a;
	var b;
	var i;
	var j;
	var k;

	gamma2 = Math.pow( ( n*EPS ) / ( 1.0 - ( n*EPS ) ), 2 );
	ref = referenceProduct( n, A, B );
	maxe = 0.0;
	ratio = 0.0;
	for ( i = 0; i < n; i++ ) {
		for ( j = 0; j < n; j++ ) {
			exact = 0n;
			absum = 0n;
			for ( k = 0; k < n; k++ ) {
				a = toScaledBigInt( A[ (i*n)+k ] );
				b = toScaledBigInt( B[ (k*n)+j ] );
				exact += a * b;
				absum += ( ( a < 0n ) ? -a : a ) * ( ( b < 0n ) ? -b : b );
			}
			// hi + lo, scaled by 2^(2*SCALE) to match the scale of the exact products:
			approx = ( toScaledBigInt( ref.hi[ (i*n)+j ] ) + toScaledBigInt( ref.lo[ (i*n)+j ] ) ) << SCALE;
			maxe = Math.max( maxe, relerr( approx, exact ) );
			err = approx - exact;
			err = ( err < 0n ) ? -err : err;
			if ( absum > 0n ) {
				ratio = Math.max( ratio, ( Number( ( err * ( 1n << 200n ) ) / absum ) / Math.pow( 2.0, 200 ) ) / gamma2 );
			}
		}
	}
	return {
		'relerr': maxe,
		'ratio': ratio
	};
}


// TESTS //

tape( 'the double-double reference product agrees with exact rational arithmetic (random and cancellation-heavy inputs)', function test( t ) {
	var rand;
	var res;
	var n;
	var A;
	var B;
	var d;
	var i;
	var j;

	rand = uniform.factory( -1.0, 1.0, {
		'seed': SEED
	});
	n = 24;
	A = new Float64Array( n*n );
	B = new Float64Array( n*n );
	for ( i = 0; i < n*n; i++ ) {
		A[ i ] = rand();
		B[ i ] = rand();
	}
	res = check( n, A, B );
	t.ok( res.ratio <= 1.0, 'uniform[-1,1]: max relative error ' + res.relerr.toExponential( 2 ) + '; error/bound = ' + res.ratio.toExponential( 2 ) );

	// Inside scaling: column j of A scaled by 2^s_j and row j of B by 2^-s_j (wide dynamic range within each inner product)...
	for ( i = 0; i < n; i++ ) {
		d = Math.pow( 2.0, Math.round( 64.0*rand() ) );
		for ( j = 0; j < n; j++ ) {
			A[ (j*n)+i ] *= d;
			B[ (i*n)+j ] /= d;
		}
	}
	res = check( n, A, B );
	t.ok( res.ratio <= 1.0, 'inside-scaled: max relative error ' + res.relerr.toExponential( 2 ) + '; error/bound = ' + res.ratio.toExponential( 2 ) );

	// Severe cancellation: B's last column makes each inner product nearly cancel...
	for ( i = 0; i < n; i++ ) {
		A[ (i*n)+(n-1) ] = 0.0;
		for ( j = 0; j < n-1; j++ ) {
			A[ (i*n)+(n-1) ] -= A[ (i*n)+j ] * B[ (j*n)+(n-1) ];
		}
	}
	for ( i = 0; i < n-1; i++ ) {
		B[ ((n-1)*n)+i ] = rand();
	}
	B[ ((n-1)*n)+(n-1) ] = 1.0;
	res = check( n, A, B );
	t.ok( res.ratio <= 1.0, 'cancellation-heavy: max relative error ' + res.relerr.toExponential( 2 ) + ' (relative to tiny exact values); error/bound = ' + res.ratio.toExponential( 2 ) );
	t.end();
});
