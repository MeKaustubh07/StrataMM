'use strict';

// E6 design grid (research protocol §8): families × parameters × sizes × seeds, one shard per (family, params,
// seed, n), each evaluated for every arm. `--tiny`: n ∈ {32, 64}, F1, F2, F4, F5, F11, 2 seeds, L <= 3.

// MODULES //

var families = require( './families.js' );
var arms = require( './arms.js' );
var rng = require( './rng.js' );


// VARIABLES //

var FULL = {
	'sizes': [ 64, 128, 256, 512, 1024, 2048 ],
	'families': families.FAMILIES.slice(),
	'Lmax': 6
};
var TINY = {
	'sizes': [ 32, 64 ],
	'families': [ 'F1', 'F2', 'F4', 'F5', 'F11' ],
	'Lmax': 3,
	'seeds': 2
};
var LARGE_N_FAMILIES = [ 'F1', 'F2', 'F4', 'F5' ]; // n = 2048 only for these


// FUNCTIONS //

/**
* Returns the number of seeds at order n (10 for n <= 512, 5 at 1024, 3 above).
*
* @param {PositiveInteger} n - order
* @param {Object} opts - options (`seeds` override, `tiny`)
* @returns {PositiveInteger} number of seeds
*/
function seedsFor( n, opts ) {
	if ( opts.seeds ) {
		return opts.seeds;
	}
	if ( opts.tiny ) {
		return TINY.seeds;
	}
	if ( n <= 512 ) {
		return 10;
	}
	return ( n <= 1024 ) ? 5 : 3;
}

/**
* Enumerates the E6 shards.
*
* @param {Object} opts - options
* @param {PositiveInteger} opts.masterSeed - master seed
* @param {boolean} [opts.tiny] - tiny grid
* @param {Array<number>} [opts.sizes] - size override
* @param {Array<string>} [opts.families] - family override
* @param {PositiveInteger} [opts.seeds] - seeds-per-size override
* @param {PositiveInteger} [opts.Lmax] - maximum levels override
* @returns {Array<Object>} shards
*/
function shards( opts ) {
	var sizes = opts.sizes || ( ( opts.tiny ) ? TINY.sizes : FULL.sizes );
	var fams = opts.families || ( ( opts.tiny ) ? TINY.families : FULL.families );
	var Lmax = opts.Lmax || ( ( opts.tiny ) ? TINY.Lmax : FULL.Lmax );
	var out = [];
	var pkey;
	var ps;
	var n;
	var f;
	var p;
	var s;
	var i;
	var seed;
	for ( i = 0; i < sizes.length; i++ ) {
		n = sizes[ i ];
		for ( f = 0; f < fams.length; f++ ) {
			if ( n > families.maxN( fams[ f ] ) || ( n >= 2048 && LARGE_N_FAMILIES.indexOf( fams[ f ] ) < 0 ) ) {
				continue;
			}
			ps = families.paramSets( fams[ f ] );
			for ( p = 0; p < ps.length; p++ ) {
				pkey = families.paramsKey( ps[ p ] );
				for ( s = 0; s < seedsFor( n, opts ); s++ ) {
					seed = rng.seed32( opts.masterSeed, 'E6', fams[ f ], pkey, n, s );
					out.push({
						'family': fams[ f ],
						'params': ps[ p ],
						'pkey': pkey,
						'n': n,
						'seed_index': s,
						'seed': seed,
						'name': fams[ f ] + '-' + pkey + '-' + seed + '-' + n,
						'key': fams[ f ] + '|' + pkey + '|' + seed + '|' + n,
						'arms': arms.armsFor( fams[ f ], Lmax )
					});
				}
			}
		}
	}
	return out;
}

/**
* Returns the record key of one arm of a shard (used for resuming).
*
* @param {string} shardKey - shard key
* @param {string} alg - algorithm
* @param {NonNegativeInteger} levels - requested levels
* @returns {string} key
*/
function armKey( shardKey, alg, levels ) {
	return shardKey + '|' + alg + '|' + levels;
}

/**
* Returns a relative cost estimate of a shard (in units of n^3 multiply-adds; ~1.5 ns each on the target machine).
*
* @param {Object} shard - shard
* @returns {number} cost
*/
function cost( shard ) {
	return Math.pow( shard.n, 3 ) * ( shard.arms.length + 1 );
}


// EXPORTS //

module.exports = {
	'FULL': FULL,
	'TINY': TINY,
	'seedsFor': seedsFor,
	'shards': shards,
	'armKey': armKey,
	'cost': cost
};
