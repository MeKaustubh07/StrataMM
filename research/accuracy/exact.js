'use strict';

// Exact (BigInt) arithmetic on binary64 values. Every finite double is m*2^e with an integer |m| < 2^53, so sums and
// products are represented exactly as { m: BigInt, e: number } (value = m * 2^e).

// VARIABLES //

var F64 = new Float64Array( 1 );
var U64 = new BigUint64Array( F64.buffer ); // same platform byte order as `F64`, so the bit pattern is exact
var MANT_MASK = ( 1n << 52n ) - 1n;
var ZERO = {
	'm': 0n,
	'e': 0
};


// FUNCTIONS //

/**
* Decomposes a finite double into `{ m, e }` with value `m * 2^e`.
*
* @param {number} x - finite double
* @throws {Error} must be finite
* @returns {Object} exact representation
*/
function decompose( x ) {
	var bits;
	var be;
	var m;
	if ( x === 0.0 ) {
		return ZERO;
	}
	F64[ 0 ] = x;
	bits = U64[ 0 ];
	be = Number( ( bits >> 52n ) & 0x7ffn );
	if ( be === 0x7ff ) {
		throw new Error( 'exact: non-finite value' );
	}
	m = bits & MANT_MASK;
	if ( be === 0 ) {
		be = 1; // subnormal: value = m * 2^-1074
	} else {
		m |= ( 1n << 52n );
	}
	if ( bits >> 63n ) {
		m = -m;
	}
	return {
		'm': m,
		'e': be - 1075
	};
}

/**
* Adds `t` to the accumulator `acc` exactly (in place) and returns `acc`.
*
* @private
* @param {Object} acc - accumulator `{ m, e }`
* @param {BigInt} m - term mantissa
* @param {number} e - term exponent
* @returns {Object} accumulator
*/
function accumulate( acc, m, e ) {
	if ( m === 0n ) {
		return acc;
	}
	if ( acc.m === 0n ) {
		acc.m = m;
		acc.e = e;
	} else if ( e >= acc.e ) {
		acc.m += m << BigInt( e - acc.e );
	} else {
		acc.m = ( acc.m << BigInt( acc.e - e ) ) + m;
		acc.e = e;
	}
	return acc;
}

/**
* Returns the exact dot product `x'y` (or `|x|'|y|` when `abs` is true).
*
* @param {NonNegativeInteger} N - number of elements
* @param {Float64Array} x - first vector
* @param {integer} sx - stride of `x`
* @param {NonNegativeInteger} ox - offset of `x`
* @param {Float64Array} y - second vector
* @param {integer} sy - stride of `y`
* @param {NonNegativeInteger} oy - offset of `y`
* @param {boolean} [abs=false] - whether to use absolute values
* @returns {Object} exact value `{ m, e }`
*/
function dot( N, x, sx, ox, y, sy, oy, abs ) {
	var acc = {
		'm': 0n,
		'e': 0
	};
	var a;
	var b;
	var i;
	for ( i = 0; i < N; i++ ) {
		a = decompose( ( abs ) ? Math.abs( x[ ox ] ) : x[ ox ] );
		b = decompose( ( abs ) ? Math.abs( y[ oy ] ) : y[ oy ] );
		accumulate( acc, a.m * b.m, a.e + b.e );
		ox += sx;
		oy += sy;
	}
	return acc;
}

/**
* Returns the exact sum of a list of exact values and/or doubles.
*
* @param {Array<(Object|number)>} terms - terms
* @returns {Object} exact value `{ m, e }`
*/
function sum( terms ) {
	var acc = {
		'm': 0n,
		'e': 0
	};
	var t;
	var i;
	for ( i = 0; i < terms.length; i++ ) {
		t = ( typeof terms[ i ] === 'number' ) ? decompose( terms[ i ] ) : terms[ i ];
		accumulate( acc, t.m, t.e );
	}
	return acc;
}

/**
* Returns the negation of an exact value.
*
* @param {Object} v - exact value
* @returns {Object} negated value
*/
function neg( v ) {
	return {
		'm': -v.m,
		'e': v.e
	};
}

/**
* Returns the number of bits of `|m|`.
*
* @private
* @param {BigInt} m - integer
* @returns {NonNegativeInteger} bit length
*/
function bitLength( m ) {
	return ( ( m < 0n ) ? -m : m ).toString( 2 ).length;
}

/**
* Rounds an exact value to the nearest double (ties to even).
*
* @param {Object} v - exact value
* @returns {number} double
*/
function toDouble( v ) {
	var sticky;
	var negative;
	var bl;
	var m;
	var e;
	var k;
	var r;
	if ( v.m === 0n ) {
		return 0.0;
	}
	m = v.m;
	e = v.e;
	negative = ( m < 0n );
	if ( negative ) {
		m = -m;
	}
	bl = bitLength( m );
	if ( bl > 64 ) {
		k = bl - 64;
		sticky = ( m & ( ( 1n << BigInt( k ) ) - 1n ) ) !== 0n;
		m >>= BigInt( k );
		if ( sticky ) {
			m |= 1n; // >= 55 kept bits + sticky => Number() rounds correctly
		}
		e += k;
	}
	r = Number( m );
	while ( e > 1000 ) {
		r *= Math.pow( 2.0, 1000 );
		e -= 1000;
	}
	while ( e < -1000 ) {
		r *= Math.pow( 2.0, -1000 );
		e += 1000;
	}
	r *= ( e >= -1022 ) ? Math.pow( 2.0, e ) : Math.pow( 2.0, e+600 ) * Math.pow( 2.0, -600 );
	return ( negative ) ? -r : r;
}

/**
* Returns `|a| / |b|` as a double for exact values (`Infinity` if `b = 0 != a`, `0` if `a = 0`).
*
* @param {Object} a - numerator
* @param {Object} b - denominator
* @returns {number} ratio
*/
function ratio( a, b ) {
	var ma = ( a.m < 0n ) ? -a.m : a.m;
	var mb = ( b.m < 0n ) ? -b.m : b.m;
	var sa;
	var sb;
	var d;
	var h;
	if ( ma === 0n ) {
		return 0.0;
	}
	if ( mb === 0n ) {
		return Infinity;
	}
	sa = Math.max( 0, bitLength( ma ) - 60 );
	sb = Math.max( 0, bitLength( mb ) - 60 );
	d = ( a.e+sa ) - ( b.e+sb );
	h = Math.trunc( d/2 ); // apply 2^d in two steps to avoid spurious overflow/underflow of the scale factor
	return ( ( Number( ma >> BigInt( sa ) ) / Number( mb >> BigInt( sb ) ) ) * Math.pow( 2.0, h ) ) * Math.pow( 2.0, d-h );
}


// EXPORTS //

module.exports = {
	'decompose': decompose,
	'dot': dot,
	'sum': sum,
	'neg': neg,
	'toDouble': toDouble,
	'ratio': ratio
};
