'use strict';

// Per-run certification of a cached Dot2 reference (protocol §8): DotK(3) on 1,000 random entries plus the worst
// entries of every arm, and exact BigInt arithmetic on 32 entries. Any failure is a hard error.

// MODULES //

var eft = require( './eft.js' );
var exact = require( './exact.js' );
var rng = require( './rng.js' );


// VARIABLES //

var TINY = 10.0 * Math.pow( 2.0, -1074 );


// FUNCTIONS //

/**
* Certifies a reference product.
*
* ## Notes
*
* -   DotK(3): accept iff |ref - dotK| <= (gamma_K^2·|x|'|y| (Dot2 bound) + 2·gamma_{4K-2}^2·|x'y| + gamma_{4K-2}^3·|x|'|y|
*     (DotK bound)) · (1 + 1e-6) + 10K·2^-1074, with |x|'|y| computed in double and inflated by (1 + 2·gamma_K).
* -   BigInt: accept iff |hi + lo - x'y| <= gamma_K^2·|x|'|y| + 5K·2^-1074 with every quantity exact.
*
* @param {Object} o - inputs
* @param {NonNegativeInteger} o.M - rows
* @param {NonNegativeInteger} o.N - columns
* @param {NonNegativeInteger} o.K - inner dimension
* @param {Float64Array} o.A - row-major M×K
* @param {Float64Array} o.B - row-major K×N
* @param {Float64Array} o.hi - reference high parts
* @param {Float64Array} o.lo - reference low parts
* @param {Array<integer>} o.entries - priority entries (flat indices, most important first)
* @param {PositiveInteger} o.seed - seed for the random entries
* @param {NonNegativeInteger} [o.nRandom=1000] - number of random entries for DotK(3)
* @param {NonNegativeInteger} [o.nBigInt=32] - number of entries checked exactly
* @returns {Object} `{ dotk: { n, max_ratio, failures }, bigint: { n, max_ratio, failures } }`
*/
function certify( o ) {
	var nRandom = ( o.nRandom === void 0 ) ? 1000 : o.nRandom;
	var nBig = ( o.nBigInt === void 0 ) ? 32 : o.nBigInt;
	var len = o.M * o.N;
	var g = eft.gamma( o.K );
	var g4 = eft.gamma( ( 4*o.K ) - 2 );
	var work = new Float64Array( 2 * Math.max( o.K, 1 ) );
	var dk = [ 0.0, 0.0 ];
	var res = {
		'dotk': { 'n': 0, 'max_ratio': 0.0, 'failures': [] },
		'bigint': { 'n': 0, 'max_ratio': 0.0, 'failures': [] }
	};
	var randi = rng.int( rng.seed32( o.seed, 'certify' ) );
	var prio = unique( o.entries.filter( function valid( v ) {
		return v >= 0 && v < len;
	}) );
	var set;
	var big;
	var idx;
	var i;

	if ( len === 0 || o.K === 0 ) {
		return res;
	}
	// Priority entries plus `nRandom` distinct random entries (all entries when there are fewer)...
	set = new Set( prio );
	if ( nRandom >= len ) {
		for ( i = 0; i < len; i++ ) {
			set.add( i );
		}
	} else {
		idx = new Set();
		while ( idx.size < nRandom ) {
			idx.add( randi( 0, len-1 ) );
		}
		idx.forEach( function add( v ) {
			set.add( v );
		});
	}
	set = Array.from( set );
	for ( i = 0; i < set.length; i++ ) {
		checkDotK( set[ i ] );
	}
	// BigInt: the most important priority entries (up to half), the rest random and distinct...
	big = prio.slice( 0, Math.min( prio.length, Math.ceil( nBig/2 ) ) );
	for ( i = 0; big.length < Math.min( nBig, len ) && i < 100*nBig; i++ ) {
		idx = randi( 0, len-1 );
		if ( big.indexOf( idx ) < 0 ) {
			big.push( idx );
		}
	}
	for ( i = 0; i < big.length; i++ ) {
		checkBigInt( big[ i ] );
	}
	return res;

	function checkDotK( k ) {
		var r = Math.floor( k / o.N );
		var c = k % o.N;
		var absdot = 0.0;
		var bound;
		var diff;
		var q;
		var t;
		eft.dotKdd( o.K, o.A, 1, r*o.K, o.B, o.N, c, 3, work, dk );
		for ( q = 0; q < o.K; q++ ) {
			absdot += Math.abs( o.A[ ( r*o.K )+q ] ) * Math.abs( o.B[ ( q*o.N )+c ] );
		}
		absdot *= 1.0 + ( 2.0*g );
		diff = Math.abs( eft.ddDiff( o.hi[ k ], o.lo[ k ], dk[ 0 ], dk[ 1 ] ) );
		bound = ( ( ( g*g ) * absdot ) + ( 2.0 * ( g4*g4 ) * Math.abs( dk[ 0 ] ) ) + ( g4*g4*g4*absdot ) ) * ( 1.0 + 1e-6 );
		bound += TINY * o.K;
		t = ( diff === 0.0 ) ? 0.0 : diff / bound;
		res.dotk.n += 1;
		if ( t > res.dotk.max_ratio ) {
			res.dotk.max_ratio = t;
		}
		if ( !( t <= 1.0 ) ) {
			res.dotk.failures.push({
				'i': r,
				'j': c,
				'hi': o.hi[ k ],
				'lo': o.lo[ k ],
				'dotk_hi': dk[ 0 ],
				'dotk_lo': dk[ 1 ],
				'ratio': t
			});
		}
	}

	function checkBigInt( k ) {
		var r = Math.floor( k / o.N );
		var c = k % o.N;
		var ex = exact.dot( o.K, o.A, 1, r*o.K, o.B, o.N, c, false );
		var ab = exact.dot( o.K, o.A, 1, r*o.K, o.B, o.N, c, true );
		var err = exact.sum( [ o.hi[ k ], o.lo[ k ], exact.neg( ex ) ] );
		var bound = ( ( g*g ) * exact.toDouble( ab ) ) + ( 0.5 * TINY * o.K );
		var e = Math.abs( exact.toDouble( err ) );
		var t = ( e === 0.0 ) ? 0.0 : e / bound;
		res.bigint.n += 1;
		if ( t > res.bigint.max_ratio ) {
			res.bigint.max_ratio = t;
		}
		if ( !( t <= 1.0 ) ) {
			res.bigint.failures.push({
				'i': r,
				'j': c,
				'hi': o.hi[ k ],
				'lo': o.lo[ k ],
				'exact': exact.toDouble( ex ),
				'ratio': t
			});
		}
	}
}

/**
* Returns the distinct values of an array, preserving first occurrence order.
*
* @private
* @param {Array<integer>} arr - input
* @returns {Array<integer>} distinct values
*/
function unique( arr ) {
	var seen = new Set();
	var out = [];
	var i;
	for ( i = 0; i < arr.length; i++ ) {
		if ( !seen.has( arr[ i ] ) ) {
			seen.add( arr[ i ] );
			out.push( arr[ i ] );
		}
	}
	return out;
}

/**
* Throws a descriptive error if a certification result has any failure.
*
* @param {Object} res - result of `certify`
* @param {string} label - shard label for the message
* @throws {Error} certification failed
*/
function assertCertified( res, label ) {
	var f;
	if ( res.dotk.failures.length || res.bigint.failures.length ) {
		f = res.dotk.failures.concat( res.bigint.failures )[ 0 ];
		throw new Error( 'E6 CERTIFICATION FAILED for ' + label + ': ' + res.dotk.failures.length + ' DotK(3) and ' + res.bigint.failures.length + ' BigInt failure(s); first at (' + f.i + ',' + f.j + ') ratio ' + f.ratio );
	}
}


// EXPORTS //

module.exports = {
	'certify': certify,
	'assertCertified': assertCertified
};
