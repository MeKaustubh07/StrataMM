'use strict';

/**
* Seeded pseudorandom numbers for the analysis (bootstrap and permutation tests).
*
* Each analysis unit (a cell, a ladder term, a family crossover, a permutation test) derives its own seed from the
* recorded master analysis seed and a stable key, so results do not depend on processing order and every seed can be
* printed next to the number it produced.
*/

var mt19937 = require( '@stdlib/random/base/mt19937' );

var DEFAULT_SEED = 20261030;


/**
* Returns the 32-bit FNV-1a hash of a string.
*
* @param {string} str - input
* @returns {NonNegativeInteger} hash
*/
function fnv1a( str ) {
	var h = 0x811c9dc5;
	var i;
	for ( i = 0; i < str.length; i++ ) {
		h ^= str.charCodeAt( i );
		h = Math.imul( h, 0x01000193 ) >>> 0;
	}
	return h >>> 0;
}

/**
* Derives a positive 32-bit seed from a master seed and a key.
*
* @param {NonNegativeInteger} master - master seed
* @param {string} key - stable key of the analysis unit
* @returns {PositiveInteger} seed in [1, 2^32-1]
*/
function deriveSeed( master, key ) {
	var s = ( fnv1a( String( key ) ) ^ ( master >>> 0 ) ) >>> 0;
	s = Math.imul( s ^ ( s >>> 16 ), 0x45d9f3b ) >>> 0;
	return ( s === 0 ) ? 1 : s;
}

/**
* Creates a seeded generator (MT19937).
*
* @param {PositiveInteger} seed - seed
* @returns {Object} generator with `uniform()` in [0,1), `randint(n)` in {0,...,n-1}, `normal()` and `seed`
*/
function createRng( seed ) {
	var g = mt19937.factory( { 'seed': seed } );
	var spare = null;
	return {
		'seed': seed,
		'uniform': uniform,
		'randint': randint,
		'normal': normal
	};

	function uniform() {
		return g.normalized();
	}

	function randint( n ) {
		return Math.floor( g.normalized() * n );
	}

	function normal() {
		var u;
		var v;
		var s;
		var t;
		if ( spare !== null ) {
			t = spare;
			spare = null;
			return t;
		}
		do {
			u = ( 2.0*g.normalized() ) - 1.0;
			v = ( 2.0*g.normalized() ) - 1.0;
			s = ( u*u ) + ( v*v );
		} while ( s >= 1.0 || s === 0.0 );
		t = Math.sqrt( -2.0 * Math.log( s ) / s );
		spare = v * t;
		return u * t;
	}
}


// EXPORTS //

module.exports = {
	'DEFAULT_SEED': DEFAULT_SEED,
	'fnv1a': fnv1a,
	'deriveSeed': deriveSeed,
	'createRng': createRng
};
