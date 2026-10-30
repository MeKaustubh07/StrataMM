'use strict';

/**
* Position-in-block effect test (protocol §4: `pos_in_block` is randomized within each block and recorded; the review
* asked for its effect to be tested in the analysis).
*/

var prng = require( './prng.js' );
var desc = require( './descriptive.js' );

var B_DEFAULT = 10000;
var mean = desc.mean;
var median = desc.median;


/**
* Tests for an effect of the position within a block on process medians.
*
* Residuals are log(process median / cell median), centred within each block (removing block-level drift). The
* statistic is the between-position sum of squares Σ_p n_p·mean_p²; its null distribution is obtained by permuting
* positions within blocks (the randomization actually performed by the orchestrator). Blocks with one process are
* uninformative and dropped.
*
* @param {Array<Object>} procs - `{ cell, block_id, pos_in_block, median_ns }` for valid replicated processes
* @param {Object} [opts] - `{ B, seed }`
* @returns {Object} per-position mean effects (%), OLS slope (% per position), statistic and permutation p-value
*/
function positionEffect( procs, opts ) {
	var cellVals = new Map();
	var blocks = new Map();
	var labels = [];
	var groups = [];
	var res = [];
	var posOf;
	var cells;
	var lab;
	var ge = 0;
	var out;
	var obs;
	var g;
	var B;
	var i;
	var b;

	opts = opts || {};
	B = opts.B || B_DEFAULT;
	procs = procs.filter( function f( p ) {
		return Number.isFinite( p.median_ns ) && p.median_ns > 0 && p.pos_in_block !== void 0 && p.pos_in_block !== null;
	});
	procs.forEach( function each( p ) {
		if ( !cellVals.has( p.cell ) ) {
			cellVals.set( p.cell, [] );
		}
		cellVals.get( p.cell ).push( p.median_ns );
	});
	cells = new Map();
	cellVals.forEach( function each( v, k ) {
		cells.set( k, median( v ) );
	});
	procs.forEach( function each( p ) {
		if ( !blocks.has( p.block_id ) ) {
			blocks.set( p.block_id, [] );
		}
		blocks.get( p.block_id ).push( p );
	});
	posOf = [];
	blocks.forEach( function each( list ) {
		var m = 0.0;
		var idx = [];
		var j;
		if ( list.length < 2 ) {
			return;
		}
		for ( j = 0; j < list.length; j++ ) {
			m += Math.log( list[ j ].median_ns / cells.get( list[ j ].cell ) );
		}
		m /= list.length;
		for ( j = 0; j < list.length; j++ ) {
			idx.push( res.length );
			res.push( Math.log( list[ j ].median_ns / cells.get( list[ j ].cell ) ) - m );
			labels.push( list[ j ].pos_in_block );
			posOf.push( Number( list[ j ].pos_in_block ) );
		}
		groups.push( idx );
	});
	out = { 'n_procs': res.length, 'n_blocks': groups.length, 'positions': [], 'slope_pct': NaN, 'stat': NaN, 'p': NaN, 'B': B, 'seed': opts.seed || prng.DEFAULT_SEED };
	if ( groups.length === 0 ) {
		return out;
	}
	lab = labels.slice();
	obs = statistic( lab );
	out.stat = obs;
	g = prng.createRng( out.seed );
	for ( b = 0; b < B; b++ ) {
		for ( i = 0; i < groups.length; i++ ) {
			shuffleWithin( lab, groups[ i ], g );
		}
		if ( statistic( lab ) >= obs - ( 1e-12 * Math.abs( obs ) ) ) {
			ge += 1;
		}
	}
	out.p = ( 1 + ge ) / ( B + 1 );
	out.positions = positionSummary( labels );
	out.slope_pct = 100.0 * olsSlope( posOf, res );
	return out;

	function statistic( lbl ) {
		var sums = new Map();
		var t = 0.0;
		var j;
		for ( j = 0; j < res.length; j++ ) {
			if ( !sums.has( lbl[ j ] ) ) {
				sums.set( lbl[ j ], [ 0.0, 0 ] );
			}
			sums.get( lbl[ j ] )[ 0 ] += res[ j ];
			sums.get( lbl[ j ] )[ 1 ] += 1;
		}
		sums.forEach( function each( v ) {
			t += v[ 0 ] * v[ 0 ] / v[ 1 ];
		});
		return t;
	}

	function positionSummary( lbl ) {
		var by = new Map();
		var rows = [];
		var j;
		for ( j = 0; j < res.length; j++ ) {
			if ( !by.has( lbl[ j ] ) ) {
				by.set( lbl[ j ], [] );
			}
			by.get( lbl[ j ] ).push( res[ j ] );
		}
		by.forEach( function each( v, k ) {
			rows.push( { 'pos': k, 'n': v.length, 'mean_pct': 100.0 * ( Math.exp( mean( v ) ) - 1.0 ), 'median_pct': 100.0 * ( Math.exp( median( v ) ) - 1.0 ) } );
		});
		return rows.sort( function cmp( a, c ) {
			return cmpId( a.pos, c.pos );
		});
	}
}

/**
* Shuffles the labels at the given indices in place (Fisher–Yates).
*
* @private
*/
function shuffleWithin( lab, idx, g ) {
	var tmp;
	var i;
	var j;
	for ( i = idx.length-1; i > 0; i-- ) {
		j = g.randint( i+1 );
		tmp = lab[ idx[ i ] ];
		lab[ idx[ i ] ] = lab[ idx[ j ] ];
		lab[ idx[ j ] ] = tmp;
	}
}

/**
* Returns the least-squares slope of y on x.
*
* @private
*/
function olsSlope( x, y ) {
	var mx = mean( x );
	var my = mean( y );
	var sxy = 0.0;
	var sxx = 0.0;
	var i;
	for ( i = 0; i < x.length; i++ ) {
		sxy += ( x[ i ]-mx ) * ( y[ i ]-my );
		sxx += ( x[ i ]-mx ) * ( x[ i ]-mx );
	}
	return ( sxx > 0 ) ? sxy / sxx : NaN;
}



/**
* Compares ids (numeric when both are numbers).
*
* @private
*/
function cmpId( a, b ) {
	if ( typeof a === 'number' && typeof b === 'number' ) {
		return a - b;
	}
	a = String( a );
	b = String( b );
	return ( a < b ) ? -1 : ( ( a > b ) ? 1 : 0 );
}


// EXPORTS //

module.exports = positionEffect;
