'use strict';

// GenDot (Ogita, Rump, Oishi 2005, Algorithm 6.1): vectors x, y whose dot product has condition number about `c`.
// The running exact dot product is accumulated incrementally in BigInt (O(n) exact operations per pair).

// MODULES //

var exact = require( './exact.js' );


// FUNCTIONS //

/**
* Generates an ill-conditioned dot-product pair of length `n` with condition number about `c`.
*
* @param {PositiveInteger} n - length (>= 2)
* @param {number} c - target condition number (> 1)
* @param {Function} rand - uniform PRNG on [0,1)
* @returns {Object} `{ x, y }` (Float64Arrays)
*/
function genDot( n, c, rand ) {
	var acc;
	var n2;
	var tx;
	var ty;
	var b;
	var e;
	var i;
	var j;
	var t;
	var x;
	var y;
	var p;
	var d;

	n2 = Math.round( n/2 );
	b = Math.log2( c );
	x = new Float64Array( n );
	y = new Float64Array( n );
	acc = {
		'm': 0n,
		'e': 0
	};

	// First half: random exponents in [0, b/2], with the largest and the smallest exponent pinned...
	for ( i = 0; i < n2; i++ ) {
		e = Math.round( rand() * b / 2.0 );
		if ( i === 0 ) {
			e = Math.round( b/2.0 ) + 1;
		} else if ( i === n2-1 ) {
			e = 0;
		}
		x[ i ] = ( ( 2.0*rand() ) - 1.0 ) * Math.pow( 2.0, e );
		y[ i ] = ( ( 2.0*rand() ) - 1.0 ) * Math.pow( 2.0, e );
		add( x[ i ], y[ i ] );
	}
	// Second half: exponents decreasing linearly from b/2 to 0, each y chosen to cancel the running exact sum...
	for ( i = n2; i < n; i++ ) {
		t = ( n-n2 === 1 ) ? b/2.0 : ( b/2.0 ) * ( 1.0 - ( ( i-n2 ) / ( n-n2-1 ) ) );
		t = Math.round( t );
		x[ i ] = ( ( 2.0*rand() ) - 1.0 ) * Math.pow( 2.0, t );
		if ( x[ i ] === 0.0 ) {
			x[ i ] = Math.pow( 2.0, t );
		}
		y[ i ] = ( ( ( ( 2.0*rand() ) - 1.0 ) * Math.pow( 2.0, t ) ) - exact.toDouble( acc ) ) / x[ i ];
		add( x[ i ], y[ i ] );
	}
	// Random permutation (Fisher–Yates), applied to both vectors...
	p = new Int32Array( n );
	for ( i = 0; i < n; i++ ) {
		p[ i ] = i;
	}
	for ( i = n-1; i > 0; i-- ) {
		j = Math.floor( rand() * ( i+1 ) );
		t = p[ i ];
		p[ i ] = p[ j ];
		p[ j ] = t;
	}
	tx = new Float64Array( n );
	ty = new Float64Array( n );
	for ( i = 0; i < n; i++ ) {
		tx[ i ] = x[ p[ i ] ];
		ty[ i ] = y[ p[ i ] ];
	}
	return {
		'x': tx,
		'y': ty
	};

	function add( a, v ) {
		var da = exact.decompose( a );
		var dv = exact.decompose( v );
		d = exact.sum( [ acc, {
			'm': da.m * dv.m,
			'e': da.e + dv.e
		} ] );
		acc = d;
	}
}


// EXPORTS //

module.exports = genDot;
