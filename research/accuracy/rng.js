'use strict';

// Deterministic seeding: every random stream is a seeded `@stdlib/random/base/*` factory whose seed is derived
// from a master seed and a descriptive key via SHA-256, so streams are independent of execution order/sharding.

// MODULES //

var crypto = require( 'crypto' );
var uniform = require( '@stdlib/random/base/uniform' );
var normal = require( '@stdlib/random/base/normal' );
var discreteUniform = require( '@stdlib/random/base/discrete-uniform' );


// FUNCTIONS //

/**
* Derives a 32-bit PRNG seed in [1, 2^32-1] from a list of key parts.
*
* @param {...*} parts - key parts (joined with `|`)
* @returns {PositiveInteger} seed
*/
function seed32() {
	var parts = Array.prototype.slice.call( arguments ).map( String );
	var buf = crypto.createHash( 'sha256' ).update( parts.join( '|' ) ).digest();
	var s = buf.readUInt32LE( 0 );
	return ( s === 0 ) ? 1 : s;
}

/**
* Returns a seeded PRNG for uniform variates on `[a, b)`.
*
* @param {PositiveInteger} seed - seed
* @param {number} [a=0.0] - lower bound
* @param {number} [b=1.0] - upper bound
* @returns {Function} PRNG
*/
function uniformRng( seed, a, b ) {
	return uniform.factory( ( a === void 0 ) ? 0.0 : a, ( b === void 0 ) ? 1.0 : b, {
		'seed': seed
	});
}

/**
* Returns a seeded PRNG for standard normal variates.
*
* @param {PositiveInteger} seed - seed
* @returns {Function} PRNG
*/
function normalRng( seed ) {
	return normal.factory( 0.0, 1.0, {
		'seed': seed
	});
}

/**
* Returns a seeded PRNG `randi( a, b )` for integers uniformly distributed on `[a, b]`.
*
* @param {PositiveInteger} seed - seed
* @returns {Function} PRNG
*/
function intRng( seed ) {
	return discreteUniform.factory({
		'seed': seed
	});
}


// EXPORTS //

module.exports = {
	'seed32': seed32,
	'uniform': uniformRng,
	'normal': normalRng,
	'int': intRng
};
