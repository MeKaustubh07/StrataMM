'use strict';

// Element-wise kernels on strided matrices (research arms only). Traversal follows the output's layout; in-place
// use (output aliasing an input with identical strides and offset) is safe because each element is read then written.

// MODULES //

var isRowMajor = require( '@stdlib/ndarray/base/assert/is-row-major' );


// FUNCTIONS //

/**
* Applies `f( x, y )` element-wise: Z = f(X, Y).
*
* @private
* @param {Function} f - binary function
* @param {NonNegativeInteger} M - rows
* @param {NonNegativeInteger} N - columns
* @param {Float64Array} X - first input
* @param {integer} sx1 - row stride of X
* @param {integer} sx2 - column stride of X
* @param {NonNegativeInteger} ox - offset of X
* @param {Float64Array} Y - second input
* @param {integer} sy1 - row stride of Y
* @param {integer} sy2 - column stride of Y
* @param {NonNegativeInteger} oy - offset of Y
* @param {Float64Array} Z - output
* @param {integer} sz1 - row stride of Z
* @param {integer} sz2 - column stride of Z
* @param {NonNegativeInteger} oz - offset of Z
* @returns {Float64Array} Z
*/
function map2( f, M, N, X, sx1, sx2, ox, Y, sy1, sy2, oy, Z, sz1, sz2, oz ) { // eslint-disable-line max-params
	var dx0;
	var dx1;
	var dy0;
	var dy1;
	var dz0;
	var dz1;
	var S0;
	var S1;
	var i0;
	var i1;
	if ( isRowMajor( [ sz1, sz2 ] ) ) {
		S0 = N;
		S1 = M;
		dx0 = sx2;
		dy0 = sy2;
		dz0 = sz2;
		dx1 = sx1 - ( S0*sx2 );
		dy1 = sy1 - ( S0*sy2 );
		dz1 = sz1 - ( S0*sz2 );
	} else {
		S0 = M;
		S1 = N;
		dx0 = sx1;
		dy0 = sy1;
		dz0 = sz1;
		dx1 = sx2 - ( S0*sx1 );
		dy1 = sy2 - ( S0*sy1 );
		dz1 = sz2 - ( S0*sz1 );
	}
	for ( i1 = 0; i1 < S1; i1++ ) {
		for ( i0 = 0; i0 < S0; i0++ ) {
			Z[ oz ] = f( X[ ox ], Y[ oy ] );
			ox += dx0;
			oy += dy0;
			oz += dz0;
		}
		ox += dx1;
		oy += dy1;
		oz += dz1;
	}
	return Z;
}

function plus( x, y ) {
	return x + y;
}

function minus( x, y ) {
	return x - y;
}

function second( x, y ) {
	return y;
}

/**
* Z = X + Y.
*
* @param {...*} args - `M, N, X, sx1, sx2, ox, Y, sy1, sy2, oy, Z, sz1, sz2, oz`
* @returns {Float64Array} Z
*/
function add( M, N, X, sx1, sx2, ox, Y, sy1, sy2, oy, Z, sz1, sz2, oz ) { // eslint-disable-line max-params
	return map2( plus, M, N, X, sx1, sx2, ox, Y, sy1, sy2, oy, Z, sz1, sz2, oz );
}

/**
* Z = X - Y.
*
* @param {...*} args - `M, N, X, sx1, sx2, ox, Y, sy1, sy2, oy, Z, sz1, sz2, oz`
* @returns {Float64Array} Z
*/
function sub( M, N, X, sx1, sx2, ox, Y, sy1, sy2, oy, Z, sz1, sz2, oz ) { // eslint-disable-line max-params
	return map2( minus, M, N, X, sx1, sx2, ox, Y, sy1, sy2, oy, Z, sz1, sz2, oz );
}

/**
* Z = X (copy).
*
* @param {...*} args - `M, N, X, sx1, sx2, ox, Z, sz1, sz2, oz`
* @returns {Float64Array} Z
*/
function copy( M, N, X, sx1, sx2, ox, Z, sz1, sz2, oz ) { // eslint-disable-line max-params
	return map2( second, M, N, Z, sz1, sz2, oz, X, sx1, sx2, ox, Z, sz1, sz2, oz );
}

/**
* Z = X + beta*Z (the `C = P + βC` combination used for β ≠ 0).
*
* @param {...*} args - `M, N, X, sx1, sx2, ox, beta, Z, sz1, sz2, oz`
* @returns {Float64Array} Z
*/
function xpbz( M, N, X, sx1, sx2, ox, beta, Z, sz1, sz2, oz ) { // eslint-disable-line max-params
	return map2( f, M, N, X, sx1, sx2, ox, Z, sz1, sz2, oz, Z, sz1, sz2, oz );

	function f( x, z ) {
		return x + ( beta*z );
	}
}


// EXPORTS //

module.exports = {
	'add': add,
	'sub': sub,
	'copy': copy,
	'xpbz': xpbz
};
