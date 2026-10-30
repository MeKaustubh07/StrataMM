'use strict';

/**
* Memory (E7, protocol §9) and sentinel/environment summaries for `summarize.js`.
*/

var stats = require( '../stats.js' );
var cellsLib = require( './cells.js' );

// E7 arms that make at most one allocation per call (§12 amendment 2026-10-30b item 2): A1/A2 one workspace `W`
// (base.js), C1 one packed copy of B (controls/packed.js), A0/C2 none. ΔarrayBuffers read on return is valid for these.
var SINGLE_ALLOCATION = { 'A0': true, 'A1': true, 'A2': true, 'C1': true, 'C2': true };
var D_AB_RULE = 'ΔarrayBuffers = ab1 − ab0 read immediately on return; valid for single-allocation arms over all non-excluded replicates (§12 amendment 2026-10-30b item 2); GC events during the call are recorded alongside';


/**
* Returns `{ min, median, max }` of the finite values (nulls when there are none).
*
* @private
*/
function range( v ) {
	var d = stats.describe( v );
	return ( d.n ) ? { 'min': d.min, 'median': d.median, 'max': d.max } : { 'min': null, 'median': null, 'max': null };
}

/**
* Summarizes the memory records (E7, §9 as amended by §12 2026-10-30b item 2): analytic vs ΔarrayBuffers (read on
* return, over all non-excluded replicates of single-allocation arms; GC events during the call reported alongside) vs
* ΔmaxRSS (fresh process). Excluded records are not used but are counted per row.
*
* @param {Array<Object>} mems - `mem` records
* @param {(number|null)} tauStar - frozen cutoff τ*
* @param {PositiveInteger} levels - frozen L_max
* @returns {Array<Object>} rows per (alg, n, β)
*/
function memory( mems, tauStar, levels ) {
	var groups = new Map();
	mems.forEach( function each( m ) {
		var key = [ m.alg, m.n, m.beta ].join( '|' );
		if ( !groups.has( key ) ) {
			groups.set( key, { 'kept': [], 'excluded': [] } );
		}
		groups.get( key )[ ( m.excluded === true ) ? 'excluded' : 'kept' ].push( m );
	});
	return Array.from( groups.values() ).map( function each( g ) {
		var list = g.kept;
		var m0 = list[ 0 ] || g.excluded[ 0 ];
		var base = 8 * m0.n * m0.n;
		var single = SINGLE_ALLOCATION[ m0.alg ] === true;
		var dabs = ( single ) ? list : [];
		var dab = dabs.map( function f( m ) {
			return m.ab1 - m.ab0;
		});
		var eq = dabs.filter( function f( m ) {
			return ( m.ab1 - m.ab0 ) === m.analytic_bytes;
		}).length;
		var analytic = stats.median( list.map( function f( m ) {
			return m.analytic_bytes;
		}) );
		var expected = expectedBytes( m0, tauStar, levels );
		var drss = stats.median( list.map( function f( m ) {
			return ( m.maxrss1_kib - m.maxrss0_kib ) * 1024;
		}) );
		return {
			'alg': m0.alg, 'n': m0.n, 'beta': m0.beta, 'reps': list.length, 'excluded': g.excluded.length,
			'analytic_bytes': analytic, 'analytic_x8mn': analytic / base, 'expected_bytes': expected,
			'analytic_check': ( expected === null || !list.length ) ? null : expected === analytic,
			'd_ab_rule': ( single ) ? D_AB_RULE : 'not valid: the arm may allocate more than once per call',
			'd_ab_median': stats.median( dab ), 'd_ab_x8mn': stats.median( dab ) / base,
			'd_ab_n': dab.length, 'd_ab_eq_count': eq,
			'd_ab_equals_analytic': ( dab.length ) ? eq === dab.length : null,
			'gc_events': range( list.map( function f( m ) {
				return m.gc_during_call;
			}) ),
			'reps_with_gc': list.filter( function f( m ) {
				return m.gc_during_call > 0;
			}).length,
			'gc_us_median': stats.median( list.map( function f( m ) {
				return m.gc_us;
			}) ),
			'resid_after_gc_median': stats.median( list.map( function f( m ) {
				return m.ab2 - m.ab0;
			}) ),
			'd_rss_median': drss, 'd_rss_x8mn': drss / base,
			'src': { 'file': 'campaign.jsonl', 'lines': list.map( function f( m ) {
				return m._line;
			}), 'excluded_lines': g.excluded.map( function f( m ) {
				return m._line;
			}) }
		};
	}).sort( function cmp( a, b ) {
		return String( a.alg ).localeCompare( String( b.alg ) ) || ( a.n - b.n ) || ( a.beta - b.beta );
	});
}

/**
* Returns the analytic peak extra bytes of SW arms (H5): 8·E1, plus 8MN when β ≠ 0; null for other arms.
*
* @private
*/
function expectedBytes( m, tauStar, levels ) {
	var wl;
	if ( ( m.alg === 'A1' || m.alg === 'A2' ) && m.params && m.params.cutoff && m.params.levels !== void 0 && m.params.levels !== null ) {
		wl = cellsLib.workspaceLength( m.n, m.n, m.n, m.params.cutoff, m.params.levels );
	} else if ( m.alg === 'A2' && tauStar !== null ) {
		wl = cellsLib.workspaceLength( m.n, m.n, m.n, tauStar, levels );
	} else if ( m.alg === 'A1' ) {
		wl = cellsLib.workspaceLength( m.n, m.n, m.n, 1, 1 );
	} else {
		return null;
	}
	return 8 * ( wl + ( ( m.beta === 0 ) ? 0 : m.n*m.n ) );
}

/**
* Builds the sentinel/thermal series from env_check records.
*
* @param {Array<Object>} checks - `env_check` records
* @returns {Object} `{ series, summary }`
*/
function sentinel( checks ) {
	var series = checks.filter( function f( e ) {
		return e.sentinel && Number.isFinite( e.sentinel.median_ns );
	}).map( function each( e, i ) {
		return {
			'i': i, 't_wall': e.t_wall, 'block_id': e.block_id, 'stage': e.stage, 'median_ns': e.sentinel.median_ns,
			'iqr_ns': e.sentinel.iqr_ns, 'drift': e.sentinel.drift, 'thermal_state': e.thermal_state, 'power': ( e.power && typeof e.power === 'object' ) ? String( e.power.source || JSON.stringify( e.power ) ) : String( e.power ),
			'low_power_mode': e.low_power_mode, 'pressure_level': e.pressure_level, 'swapouts': e.swapouts,
			'swap_used_mb': e.swap_used_mb, 'load_avg': e.load_avg, 'line': e._line
		};
	});
	var base = stats.median( series.slice( 0, 5 ).map( function f( s ) {
		return s.median_ns;
	}) );
	var thermal = {};
	var power = {};
	series.forEach( function each( s ) {
		if ( !Number.isFinite( s.drift ) ) {
			s.drift = ( s.median_ns - base ) / base;
		}
		thermal[ s.thermal_state ] = ( thermal[ s.thermal_state ] || 0 ) + 1;
		power[ s.power ] = ( power[ s.power ] || 0 ) + 1;
	});
	return {
		'series': series,
		'summary': {
			'n': series.length,
			'baseline_ns': base,
			'median_ns': stats.describe( series.map( pick( 'median_ns' ) ) ),
			'max_abs_drift': Math.max.apply( null, [ 0 ].concat( series.map( function f( s ) {
				return Math.abs( s.drift );
			}) ) ),
			'n_drift_gt_3pct': series.filter( function f( s ) {
				return Math.abs( s.drift ) > 0.03;
			}).length,
			'thermal_states': thermal,
			'power': power,
			'max_pressure_level': Math.max.apply( null, [ -Infinity ].concat( series.map( pick( 'pressure_level' ) ).filter( Number.isFinite ) ) ),
			'src': { 'file': 'campaign.jsonl', 'lines': series.map( pick( 'line' ) ) }
		}
	};

	function pick( k ) {
		return function f( s ) {
			return s[ k ];
		};
	}
}


// EXPORTS //

module.exports = {
	'SINGLE_ALLOCATION': SINGLE_ALLOCATION,
	'D_AB_RULE': D_AB_RULE,
	'memory': memory,
	'expectedBytes': expectedBytes,
	'sentinel': sentinel
};
