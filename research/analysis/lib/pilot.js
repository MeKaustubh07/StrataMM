'use strict';

/**
* Pilot table and τ* re-derivation (protocol §5.1; §12 amendment 2026-10-30b item 3), mirroring the orchestrator's
* selection (`research/harness/resume.js`, `selectTau`):
*
* -   t_best(n) = min over τ of the A2 pilot cell median at each select size n (τ cells at L_max);
* -   §5.1: τ* = the largest τ whose median is ≤ band · t_best(n) at every select size (relative slack 1e-12);
* -   fallback (amendment 3), only if no τ qualifies: among the τ with a cell at every select size, the τ with the
*     smallest worst-case ratio max_n median(τ, n)/t_best(n), ties to the larger τ; the choice is flagged.
*
* Pilot cells are never quoted as speedups. The campaign-wide SENTINEL cell (one sentinel before every block of every
* stage) is not a pilot cell and is not listed.
*/

var PILOT_SIZES = [ 512, 1024 ];
var BAND = 1.02;
var SLACK = 1.0e-12;


/**
* Returns a copy of an array of numbers, or null.
*
* @private
*/
function nums( v ) {
	return ( Array.isArray( v ) && v.length ) ? v.map( Number ) : null;
}

/**
* Returns whether a cell is a pilot cell (sentinel cells are not).
*
* @private
*/
function isPilotCell( c ) {
	return c.pilot === true && c.desc.alg !== 'SENTINEL' && c.desc.experiment !== 'sentinel';
}

/**
* Re-derives τ* from the pilot cells.
*
* @param {Array<Object>} cells - cells (`cells.buildCells`)
* @param {Object} o - `{ frozen, tauStar, levels, design }` (`design`: the campaign record's design, for the band and
*   select sizes when `frozen.json` does not carry them)
* @returns {Object} pilot rows, candidate medians, t_best, worst-case ratios, eligible τ, the re-derived τ* and whether
*   the fallback chose it, compared with the frozen τ* and the frozen fallback flag
*/
function pilot( cells, o ) {
	var frozen = o.frozen || {};
	var ps = frozen.pilot_summary || {};
	var proto = ( o.design && o.design.protocol && o.design.protocol.pilot ) || {};
	var sizes = nums( ps.select_sizes ) || nums( proto.select_sizes ) || PILOT_SIZES;
	var band = ( Number( proto.band ) > 1 ) ? Number( proto.band ) : BAND;
	var cand = {};
	var best = {};
	var worst = {};
	var used = [];
	var eligible;
	var bestW = Infinity;
	var taus;
	var tau = null;
	var rows;
	var tauExp;

	rows = cells.filter( function f( c ) {
		return isPilotCell( c ) && c.r > 0;
	}).map( function each( c ) {
		return { 'cell': c.id, 'desc': c.desc, 'r': c.r, 'median_ns': c.median_ns, 'src': [ c.src ] };
	});
	tauExp = rows.some( function f( r ) {
		return r.desc.experiment === 'pilot.tau';
	});
	rows.forEach( function each( r ) {
		var n = r.desc.M;
		if ( r.desc.alg !== 'A2' || sizes.indexOf( n ) < 0 || r.desc.N !== n || r.desc.K !== n || r.desc.levels !== o.levels || ( tauExp && r.desc.experiment !== 'pilot.tau' ) ) {
			return;
		}
		cand[ r.desc.cutoff ] = cand[ r.desc.cutoff ] || {};
		cand[ r.desc.cutoff ][ n ] = r.median_ns;
		best[ n ] = Math.min( ( best[ n ] === void 0 ) ? Infinity : best[ n ], r.median_ns );
		used.push( r.src[ 0 ] );
	});
	taus = Object.keys( cand ).map( Number ).sort( function cmp( a, b ) {
		return a - b;
	});
	taus.forEach( function each( t ) {
		worst[ t ] = sizes.every( function g( n ) {
			return cand[ t ][ n ] !== void 0;
		}) ? Math.max.apply( null, sizes.map( function g( n ) {
			return cand[ t ][ n ] / best[ n ];
		}) ) : null;
	});
	eligible = taus.filter( function f( t ) {
		return sizes.every( function g( n ) {
			return cand[ t ][ n ] !== void 0 && cand[ t ][ n ] <= band * best[ n ] * ( 1.0 + SLACK );
		});
	});
	if ( eligible.length ) {
		tau = eligible[ eligible.length-1 ];
	} else {
		taus.forEach( function each( t ) { // ascending τ with `<=`: ties go to the larger τ
			if ( worst[ t ] !== null && worst[ t ] <= bestW ) {
				bestW = worst[ t ];
				tau = t;
			}
		});
	}
	return {
		'rows': rows,
		'select_sizes': sizes,
		'band': band,
		'levels': o.levels,
		'tau_candidates': cand,
		't_best': best,
		'worst_ratio': worst,
		'eligible': eligible,
		'tau_star_recomputed': tau,
		'fallback': tau !== null && eligible.length === 0,
		'rule': ( eligible.length || tau === null ) ? '§5.1: largest τ with median ≤ ' + band + '·t_best(n) at every select size' : 'fallback (§12 amendment 2026-10-30b item 3): no τ within ' + band + '× of t_best at every select size; τ with the smallest worst-case ratio max_n median/t_best (ties to the larger τ)',
		'tau_star_frozen': o.tauStar,
		'fallback_frozen': ( typeof ps.fallback === 'boolean' ) ? ps.fallback : null,
		'match': ( tau !== null && o.tauStar !== null && o.tauStar !== void 0 ) ? tau === o.tauStar : null,
		'src': used
	};
}

/**
* Returns a one-sentence account of the re-derivation (tables and report).
*
* @param {Object} p - result of `pilot`
* @returns {string} sentence (Markdown)
*/
function sentence( p ) {
	var how;
	if ( p.tau_star_recomputed === null ) {
		how = 'τ* cannot be re-derived from the pilot cells (no A2 τ cell at every select size ' + p.select_sizes.join( ', ' ) + ')';
	} else if ( p.fallback ) {
		how = 'τ* re-derived from the pilot cells by the **fallback** rule (§12 amendment 2026-10-30b item 3: no τ within ' + p.band + '× of t_best at every select size ' + p.select_sizes.join( ', ' ) + '; worst-case ratios ' + Object.keys( p.worst_ratio ).map( function f( t ) {
			return 'τ = ' + t + ': ' + ( ( p.worst_ratio[ t ] === null ) ? 'n/a' : p.worst_ratio[ t ].toFixed( 4 ) );
		}).join( ', ' ) + '): **' + p.tau_star_recomputed + '**';
	} else {
		how = 'τ* re-derived from the pilot cells by the §5.1 rule (largest τ within ' + p.band + '× of t_best at every select size ' + p.select_sizes.join( ', ' ) + '; eligible ' + p.eligible.join( ', ' ) + '): **' + p.tau_star_recomputed + '**';
	}
	return how + '; frozen: **' + p.tau_star_frozen + '**' + ( ( p.fallback_frozen === null ) ? '' : ' (frozen.json fallback flag: ' + p.fallback_frozen + ')' ) + ' — ' + ( ( p.match === null ) ? 'not checkable' : ( ( p.match && ( p.fallback_frozen === null || p.fallback_frozen === p.fallback ) ) ? 'match' : '**MISMATCH**' ) ) + '.';
}


// EXPORTS //

module.exports = {
	'PILOT_SIZES': PILOT_SIZES,
	'isPilotCell': isPilotCell,
	'pilot': pilot,
	'sentence': sentence
};
