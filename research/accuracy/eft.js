'use strict';

// Error-free transformations and accurate dot products (Ogita, Rump, Oishi 2005, doi:10.1137/030601818).
//
// ECMAScript rounds every operation separately (no fused multiply-add contraction), so these transformations are
// valid in JavaScript. u = 2^-53. Valid without underflow/overflow: |a| < 2^996 (split) and nonzero |a*b| >= 2^-969.

// VARIABLES //

var SPLITTER = 134217729.0; // 2^27 + 1 (Veltkamp)
var U = Math.pow( 2.0, -53 );


// FUNCTIONS //

/**
* Returns `gamma_n = n*u / (1 - n*u)`.
*
* @param {NonNegativeInteger} n - count
* @returns {number} gamma_n
*/
function gamma( n ) {
	return ( n*U ) / ( 1.0 - ( n*U ) );
}

/**
* Knuth TwoSum: `a + b = s + e` exactly with `s = fl(a+b)`.
*
* @param {number} a - first summand
* @param {number} b - second summand
* @param {Array<number>} out - output array (`[s, e]`)
* @returns {Array<number>} `out`
*/
function twoSum( a, b, out ) {
	var s = a + b;
	var z = s - a;
	out[ 0 ] = s;
	out[ 1 ] = ( a - ( s - z ) ) + ( b - z );
	return out;
}

/**
* Dekker TwoProduct: `a*b = p + e` exactly with `p = fl(a*b)` (no underflow/overflow).
*
* @param {number} a - first factor
* @param {number} b - second factor
* @param {Array<number>} out - output array (`[p, e]`)
* @returns {Array<number>} `out`
*/
function twoProduct( a, b, out ) {
	var p = a * b;
	var c = SPLITTER * a;
	var ah = c - ( c - a );
	var al = a - ah;
	var bh;
	var bl;
	c = SPLITTER * b;
	bh = c - ( c - b );
	bl = b - bh;
	out[ 0 ] = p;
	out[ 1 ] = ( al*bl ) - ( ( ( p - ( ah*bh ) ) - ( al*bh ) ) - ( ah*bl ) );
	return out;
}

/**
* Splits every element of `x` into `hi + lo` (Veltkamp), each with at most 26 significant bits.
*
* @param {Float64Array} x - input array
* @param {Float64Array} hi - output array (high parts)
* @param {Float64Array} lo - output array (low parts)
*/
function splitInto( x, hi, lo ) {
	var c;
	var h;
	var i;
	for ( i = 0; i < x.length; i++ ) {
		c = SPLITTER * x[ i ];
		h = c - ( c - x[ i ] );
		hi[ i ] = h;
		lo[ i ] = x[ i ] - h;
	}
}

/**
* VecSum (ORO Algorithm 4.3): in-place error-free distillation; the sum is unchanged and the last entry is fl(sum).
*
* @param {NonNegativeInteger} N - number of elements
* @param {Float64Array} p - input/output array
* @returns {Float64Array} `p`
*/
function vecSum( N, p ) {
	var a;
	var b;
	var s;
	var z;
	var i;
	for ( i = 1; i < N; i++ ) {
		a = p[ i ];
		b = p[ i-1 ];
		s = a + b;
		z = s - a;
		p[ i-1 ] = ( a - ( s - z ) ) + ( b - z );
		p[ i ] = s;
	}
	return p;
}

/**
* DotK (ORO Algorithm 5.10) returning an unevaluated double-double `[hi, lo]` (no final rounding).
*
* ## Notes
*
* -   The 2N error-free terms are distilled with `K-2` VecSum passes (i.e., `SumK(r, K-1)`), after which `hi` is the
*     last term and `lo` the plainly summed remainder. Error <= ~gamma_{4N-2}^2 |x'y| + gamma_{4N-2}^K |x|'|y|.
*
* @param {PositiveInteger} N - number of elements
* @param {Float64Array} x - first vector
* @param {integer} sx - stride of `x`
* @param {NonNegativeInteger} ox - offset of `x`
* @param {Float64Array} y - second vector
* @param {integer} sy - stride of `y`
* @param {NonNegativeInteger} oy - offset of `y`
* @param {PositiveInteger} K - fold (>= 3)
* @param {Float64Array} work - workspace of length >= 2N
* @param {Array<number>} out - output array (`[hi, lo]`)
* @returns {Array<number>} `out`
*/
function dotKdd( N, x, sx, ox, y, sy, oy, K, work, out ) {
	var tp = [ 0.0, 0.0 ];
	var ts = [ 0.0, 0.0 ];
	var lo;
	var p;
	var i;
	var k;
	twoProduct( x[ ox ], y[ oy ], tp );
	p = tp[ 0 ];
	work[ 0 ] = tp[ 1 ];
	for ( i = 1; i < N; i++ ) {
		ox += sx;
		oy += sy;
		twoProduct( x[ ox ], y[ oy ], tp );
		work[ i ] = tp[ 1 ];
		twoSum( p, tp[ 0 ], ts );
		p = ts[ 0 ];
		work[ N+i-1 ] = ts[ 1 ];
	}
	work[ ( 2*N )-1 ] = p;
	for ( k = 1; k < K-1; k++ ) {
		vecSum( 2*N, work );
	}
	lo = 0.0;
	for ( i = 0; i < ( 2*N )-1; i++ ) {
		lo += work[ i ];
	}
	return twoSum( work[ ( 2*N )-1 ], lo, out );
}

/**
* Returns `(h1 + l1) - (h2 + l2)` for two double-doubles, accurate to about one rounding of the difference.
*
* @param {number} h1 - first high part
* @param {number} l1 - first low part
* @param {number} h2 - second high part
* @param {number} l2 - second low part
* @returns {number} difference
*/
function ddDiff( h1, l1, h2, l2 ) {
	var t = twoSum( h1, -h2, [ 0.0, 0.0 ] );
	return t[ 0 ] + ( t[ 1 ] + ( l1 - l2 ) );
}


// EXPORTS //

module.exports = {
	'SPLITTER': SPLITTER,
	'U': U,
	'gamma': gamma,
	'twoSum': twoSum,
	'twoProduct': twoProduct,
	'splitInto': splitInto,
	'vecSum': vecSum,
	'dotKdd': dotKdd,
	'ddDiff': ddDiff
};
