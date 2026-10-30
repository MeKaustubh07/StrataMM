'use strict';

// E6 reporting helpers: dry-run budget, growth-factor warning records, and a compact console summary.

// MODULES //

var records = require( './records.js' );
var design = require( './design.js' );


// VARIABLES //

var NS_PER_FMA_EVAL = 1.6e-9;  // dgemm-class multiply-add cost (Node 22, M2), per arm
var NS_PER_FMA_REF = 2.6e-9;   // Dot2 reference (single thread)


// FUNCTIONS //

/**
* Returns the E6 budget estimate for a set of shards.
*
* @param {Array<Object>} shards - shards
* @param {Object} o - options (`procs`, `workers`)
* @returns {Object} budget
*/
function budget( shards, o ) {
	var evalS = 0.0;
	var refS = 0.0;
	var arms = 0;
	var i;
	for ( i = 0; i < shards.length; i++ ) {
		evalS += design.cost( shards[ i ] ) * NS_PER_FMA_EVAL;
		refS += Math.pow( shards[ i ].n, 3 ) * NS_PER_FMA_REF;
		arms += shards[ i ].arms.length;
	}
	return {
		'shards': shards.length,
		'arm_evaluations': arms,
		'reference_s': Math.round( refS / o.workers ),
		'evaluation_s': Math.round( evalS / o.procs ),
		'total_s': Math.round( ( refS / o.workers ) + ( evalS / o.procs ) )
	};
}

/**
* Appends out-of-range growth-factor warnings as `accuracy_warning` records (skipping ones already recorded). Each
* record carries the shape both as `n` and, like `accuracy` records, as `M`, `N`, `K`.
*
* @param {string} file - accuracy.jsonl
* @param {string} campaign - campaign identifier
* @param {Array<Object>} gw - results of `gates.growthWarnings`
* @param {Array<Object>} existing - records already in the file
* @param {Function} log - logger
* @returns {NonNegativeInteger} number of out-of-range groups
*/
function writeGrowthWarnings( file, campaign, gw, existing, log ) {
	var seen = new Set();
	var count = 0;
	var key;
	var w;
	var i;
	existing.forEach( function add( r ) {
		if ( r.type === 'accuracy_warning' ) {
			seen.add( r.rule + '|' + r.family + '|' + JSON.stringify( r.params ) + '|' + r.n + '|' + r.L + '|' + r.seeds );
		}
	});
	for ( i = 0; i < gw.length; i++ ) {
		w = gw[ i ];
		if ( w.ok ) {
			continue;
		}
		count += 1;
		key = w.rule + '|' + w.family + '|' + JSON.stringify( w.params ) + '|' + w.n + '|' + w.L + '|' + w.seeds;
		log( 'WARNING growth factor ' + w.family + ' n=' + w.n + ' L=' + w.L + ': g = ' + w.g.toFixed( 3 ) + ' (outside [1.7, 3]; ' + w.seeds + ' seeds)' );
		if ( !seen.has( key ) ) {
			records.appendLine( file, records.record( 'accuracy_warning', campaign, {
				'rule': w.rule,
				'family': w.family,
				'params': w.params,
				'n': w.n,
				'M': w.n,
				'N': w.n,
				'K': w.n,
				'L': w.L,
				'g': w.g,
				'seeds': w.seeds
			}) );
		}
	}
	return count;
}

/**
* Returns the median of an array of numbers.
*
* @private
* @param {Array<number>} v - values
* @returns {number} median
*/
function median( v ) {
	var s = v.slice().sort( function cmp( a, b ) {
		return a - b;
	});
	var m = s.length >>> 1;
	return ( s.length % 2 ) ? s[ m ] : 0.5 * ( s[ m-1 ] + s[ m ] );
}

function fmt( x ) {
	if ( x === null || x === void 0 ) {
		return '-';
	}
	return ( x === 0 ) ? '0' : x.toExponential( 2 );
}

/**
* Prints, per (family, params, n, alg), the medians over seeds of η_N, η_C(max) and the fraction of entries with no
* correct digit, for each L.
*
* @param {Array<Object>} recs - accuracy records
*/
function print( recs ) {
	var groups = {};
	var keys;
	var g;
	var k;
	var i;
	var L;
	var cells;
	for ( i = 0; i < recs.length; i++ ) {
		k = recs[ i ].family + ' ' + JSON.stringify( recs[ i ].params ) + ' n=' + recs[ i ].N + ' ' + recs[ i ].alg;
		groups[ k ] = groups[ k ] || {};
		L = recs[ i ].L;
		groups[ k ][ L ] = groups[ k ][ L ] || [];
		groups[ k ][ L ].push( recs[ i ].metrics );
	}
	keys = Object.keys( groups ).sort();
	console.log( 'E6 summary: medians over seeds per L -> eta_N / eta_C(max) / frac(E >= |C|)' );
	for ( i = 0; i < keys.length; i++ ) {
		g = groups[ keys[ i ] ];
		cells = Object.keys( g ).sort( function cmp( a, b ) {
			return a - b;
		}).map( function cell( l ) {
			var m = g[ l ];
			return 'L' + l + ' ' + fmt( median( m.map( function f( x ) {
				return x.eta_N;
			}) ) ) + '/' + fmt( median( m.map( function f( x ) {
				return x.eta_C.max;
			}) ) ) + '/' + fmt( median( m.map( function f( x ) {
				return x.rel.frac_ge1;
			}) ) );
		});
		console.log( '  ' + keys[ i ].padEnd( 34 ) + cells.join( '  ' ) );
	}
}


// EXPORTS //

module.exports = {
	'budget': budget,
	'writeGrowthWarnings': writeGrowthWarnings,
	'print': print
};
