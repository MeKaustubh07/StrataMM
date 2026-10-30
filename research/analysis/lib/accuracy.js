'use strict';

/**
* Accuracy (E6) aggregation — research protocol rev. 2, §8: metrics per (family, parameters, shape, arm, L) over
* seeds, the ratio R_N = η_N(arm)/η_N(A0) on the same inputs, the κ-binned relative error of F9 (per κ decade: entries,
* median over seeds of the per-seed bin median, max over seeds of the bin max), hard gates (violation = bug) and
* warnings as the E6 harness evaluates them (`acc_checks.js`).
*/

var stats = require( '../stats.js' );
var checks = require( './acc_checks.js' );

var METRICS = {
	'eta_N': function f( m ) {
		return m.eta_N;
	},
	'rho_N': function f( m ) {
		return m.rho_N;
	},
	'eta_C_max': function f( m ) {
		return ( m.eta_C ) ? m.eta_C.max : NaN;
	},
	'eta_C_p999': function f( m ) {
		return ( m.eta_C ) ? m.eta_C.p999 : NaN;
	},
	'eta_C_median': function f( m ) {
		return ( m.eta_C ) ? m.eta_C.median : NaN;
	},
	'eta_R': function f( m ) {
		return m.eta_R;
	},
	'eta_F': function f( m ) {
		return m.eta_F;
	},
	'eta_M': function f( m ) {
		return m.eta_M;
	},
	'frac_ge1': function f( m ) {
		return ( m.rel ) ? m.rel.frac_ge1 : NaN;
	},
	'frac_ge1e8': function f( m ) {
		return ( m.rel ) ? m.rel.frac_ge1e8 : NaN;
	},
	'rel_max': function f( m ) {
		return ( m.rel ) ? m.rel.max : NaN;
	},
	'rel_p999': function f( m ) {
		return ( m.rel ) ? m.rel.p999 : NaN;
	}
};
var GROWTH_FAMILIES = { 'F2': true, 'F3': true };
var GROWTH_RANGE = [ 1.7, 3.0 ];


/**
* Returns the re-derived Winograd-variant normwise bound constant f_W = 18^L(k₀² + 5.5625k₀) − 5.5625K.
*
* @param {NonNegativeInteger} L - levels
* @param {number} k0 - leaf inner dimension
* @param {number} K - inner dimension
* @returns {number} bound constant (units of u‖A‖_M‖B‖_M)
*/
function fW( L, k0, K ) {
	return ( Math.pow( 18, L ) * ( ( k0*k0 ) + ( 5.5625*k0 ) ) ) - ( 5.5625*K );
}

/**
* Returns the classic Strassen bound constant [12^L(k₀² + 5k₀) − 5K].
*
* @param {NonNegativeInteger} L - levels
* @param {number} k0 - leaf inner dimension
* @param {number} K - inner dimension
* @returns {number} bound constant
*/
function fStrassen( L, k0, K ) {
	return ( Math.pow( 12, L ) * ( ( k0*k0 ) + ( 5*k0 ) ) ) - ( 5*K );
}

/**
* Returns a stable key for a parameters object.
*
* @private
*/
function pkey( params ) {
	if ( params === null || params === void 0 ) {
		return '';
	}
	if ( typeof params !== 'object' ) {
		return String( params );
	}
	return Object.keys( params ).sort().map( function f( k ) {
		return k + '=' + JSON.stringify( params[ k ] );
	}).join( ',' );
}

/**
* Normalizes an accuracy record.
*
* @private
*/
function normalize( r ) {
	var L = ( r.alg === 'A0' ) ? 0 : Number( r.L );
	return {
		'family': r.family,
		'params': r.params || null,
		'pkey': pkey( r.params ),
		'seed': r.seed,
		'M': r.M,
		'N': r.N,
		'K': r.K,
		'alg': r.alg,
		'L': L,
		'k0': ( r.k0 !== void 0 && r.k0 !== null ) ? r.k0 : Math.floor( r.K / Math.pow( 2, L ) ),
		'm': r.metrics || {},
		'line': r._line,
		'ref_sha256': r.ref_sha256 || null,
		'persisted_gates': ( Array.isArray( r.gate_violations ) ) ? r.gate_violations : [],
		'persisted_warnings': ( Array.isArray( r.warnings ) ) ? r.warnings : []
	};
}

/**
* Returns the shape key of a normalized record (family, parameters, M, N, K).
*
* @private
*/
function shapeKey( x ) {
	return [ x.family, x.pkey, x.M, x.N, x.K ].join( '|' );
}

/**
* Aggregates accuracy records over seeds and evaluates gates and warnings.
*
* @param {Array<Object>} records - `accuracy` records (with `_line`)
* @param {Object} [opts] - `{ warnings }`: the `accuracy_warning` records of the campaign
* @returns {Object} `{ groups, gates, warnings, growth, n_records, n_warning_records }`
*/
function aggregate( records, opts ) {
	var a0 = new Map();
	var groups = new Map();
	var growth = new Map();
	var warnings = [];
	var gates = [];
	var xs = records.map( normalize );
	var out;

	xs.forEach( function each( x ) {
		if ( x.alg === 'A0' ) {
			a0.set( shapeKey( x ) + '|' + x.seed, x );
		}
	});
	xs.forEach( function each( x ) {
		var key = shapeKey( x ) + '|' + x.alg + '|' + x.L;
		var ref = a0.get( shapeKey( x ) + '|' + x.seed );
		var g;
		x.R_N = ( ref && ref.m.eta_N > 0 ) ? x.m.eta_N / ref.m.eta_N : NaN;
		x.F_ratio = ( ref && ref.m.eta_F > 0 ) ? x.m.eta_F / ref.m.eta_F : NaN;
		if ( !groups.has( key ) ) {
			groups.set( key, { 'family': x.family, 'params': x.params, 'pkey': x.pkey, 'M': x.M, 'N': x.N, 'K': x.K, 'alg': x.alg, 'L': x.L, 'k0': x.k0, 'items': [] } );
		}
		groups.get( key ).items.push( x );
		x.gates = checks.union( checks.gates( x ), x.persisted_gates, checks.GATE_RULES ).map( locator( x ) );
		x.warnings = checks.union( checks.warnings( x, ( x.alg === 'A0' ) ? null : ref || null ), x.persisted_warnings, checks.WARNING_RULES ).map( locator( x ) );
		Array.prototype.push.apply( gates, x.gates );
		Array.prototype.push.apply( warnings, x.warnings );
		if ( x.alg === 'SW' && x.L >= 1 && GROWTH_FAMILIES[ x.family ] && Number.isFinite( x.F_ratio ) ) {
			g = shapeKey( x ) + '|' + x.L;
			if ( !growth.has( g ) ) {
				growth.set( g, { 'family': x.family, 'params': x.params, 'M': x.M, 'N': x.N, 'K': x.K, 'L': x.L, 'per_seed': [], 'lines': [] } );
			}
			growth.get( g ).per_seed.push( Math.pow( x.F_ratio, 1.0/x.L ) );
			growth.get( g ).lines.push( x.line );
		}
	});
	out = {
		'n_records': xs.length,
		'n_warning_records': ( opts && opts.warnings ) ? opts.warnings.length : 0,
		'groups': Array.from( groups.values() ).map( summarizeGroup ).sort( cmpGroups ),
		'gates': gates,
		'warnings': warnings,
		'growth': []
	};
	growth.forEach( function each( g ) {
		g.pkey = pkey( g.params );
		g.g = stats.median( g.per_seed );
		g.in_range = g.g >= GROWTH_RANGE[ 0 ] && g.g <= GROWTH_RANGE[ 1 ];
		g.src = { 'file': 'accuracy.jsonl', 'lines': g.lines };
		delete g.lines;
		out.growth.push( g );
	});
	Array.prototype.push.apply( warnings, checks.growthWarnings( out.growth, ( opts && opts.warnings ) || [], pkey ) );
	return out;
}

/**
* Returns a function that tags a gate or warning entry with its record's identity and source line.
*
* @private
*/
function locator( x ) {
	return function locate( v ) {
		return Object.assign( v, { 'family': x.family, 'params': x.params, 'M': x.M, 'N': x.N, 'K': x.K, 'alg': x.alg, 'L': x.L, 'seed': x.seed, 'src': { 'file': 'accuracy.jsonl', 'lines': [ x.line ] } } );
	};
}

/**
* Summarizes one group of records (one arm at one shape, over seeds).
*
* @private
*/
function summarizeGroup( g ) {
	var out = {
		'family': g.family, 'params': g.params, 'pkey': g.pkey, 'M': g.M, 'N': g.N, 'K': g.K, 'alg': g.alg,
		'L': g.L, 'k0': g.k0, 'seeds': g.items.length, 'metrics': {}, 'R_N': null, 'f_W': NaN, 'f_S': NaN,
		'gate_violations': 0,
		'src': { 'file': 'accuracy.jsonl', 'lines': g.items.map( function f( x ) {
			return x.line;
		}) }
	};
	Object.keys( METRICS ).forEach( function each( name ) {
		var v = g.items.map( function f( x ) {
			return METRICS[ name ]( x.m );
		});
		out.metrics[ name ] = spread( v );
	});
	out.R_N = spread( g.items.map( function f( x ) {
		return x.R_N;
	}) );
	out.gate_violations = g.items.reduce( function f( acc, x ) {
		return acc + x.gates.length;
	}, 0 );
	out.warnings = g.items.reduce( function f( acc, x ) {
		return acc + x.warnings.length;
	}, 0 );
	out.kappa = kappaOf( g.items );
	if ( g.alg !== 'A0' ) {
		out.f_W = fW( g.L, g.k0, g.K );
		out.f_S = fStrassen( g.L, g.k0, g.K );
	} else {
		out.f_W = g.K * g.K;
	}
	return out;
}

/**
* Aggregates the F9 κ bins (`metrics.kappa`, one bin per decade of κ = (|A||B|)_ij/|C_ij|) over seeds: per decade,
* entries summed over seeds, the median over seeds of the per-seed bin median relative error, and the max over seeds
* of the per-seed bin max; entries with C_ij = 0 are counted separately (with the number having a nonzero error).
*
* @private
* @param {Array<Object>} items - normalized records of one group
* @returns {(Object|null)} `{ seeds, bins: [{ log10_kappa, n, seeds, rel_median, rel_max }], czero }`, or null
*/
function kappaOf( items ) {
	var bins = new Map();
	var czero = null;
	var seeds = 0;
	items.forEach( function each( x ) {
		var k = x.m.kappa;
		if ( !k || !Array.isArray( k.bins ) ) {
			return;
		}
		seeds += 1;
		k.bins.forEach( function f( b ) {
			var e = bins.get( b.log10_kappa );
			if ( !e ) {
				e = { 'log10_kappa': b.log10_kappa, 'n': 0, 'seeds': 0, 'medians': [], 'maxes': [] };
				bins.set( b.log10_kappa, e );
			}
			e.n += b.n || 0;
			e.seeds += 1;
			e.medians.push( b.rel_median );
			e.maxes.push( b.rel_max );
		});
		if ( k.czero ) {
			czero = czero || { 'n': 0, 'n_err': 0 };
			czero.n += k.czero.n || 0;
			czero.n_err += k.czero.n_err || 0;
		}
	});
	if ( !seeds ) {
		return null;
	}
	return {
		'seeds': seeds,
		'bins': Array.from( bins.values() ).sort( function cmp( a, b ) {
			return a.log10_kappa - b.log10_kappa;
		}).map( function each( e ) {
			return { 'log10_kappa': e.log10_kappa, 'n': e.n, 'seeds': e.seeds, 'rel_median': stats.median( e.medians ), 'rel_max': stats.describe( e.maxes ).max };
		}),
		'czero': czero
	};
}

/**
* Returns `{ median, min, max }` of the finite values.
*
* @private
*/
function spread( v ) {
	var d = stats.describe( v );
	return { 'median': d.median, 'min': d.min, 'max': d.max, 'n': d.n };
}

/**
* Orders groups by family, parameters, size, arm and L.
*
* @private
*/
function cmpGroups( a, b ) {
	var arms = [ 'A0', 'SW', 'V1', 'V2' ];
	var c = String( a.family ).localeCompare( String( b.family ), 'en', { 'numeric': true } );
	if ( c ) {
		return c;
	}
	c = a.pkey.localeCompare( b.pkey, 'en', { 'numeric': true } );
	if ( c ) {
		return c;
	}
	c = ( a.M*a.N*a.K ) - ( b.M*b.N*b.K );
	if ( c ) {
		return c;
	}
	c = arms.indexOf( a.alg ) - arms.indexOf( b.alg );
	if ( c ) {
		return c;
	}
	return a.L - b.L;
}

/**
* Looks up the group of an arm for a square size, returning the worst (largest median of `metric`) over parameter
* settings of the family.
*
* @param {Object} acc - aggregate result
* @param {string} family - family id
* @param {number} n - square size
* @param {string} alg - arm
* @param {NonNegativeInteger} L - levels
* @param {string} metric - metric name used to pick the worst parameter setting (`'R_N'` or a METRICS key)
* @returns {(Object|null)} group
*/
function lookupWorst( acc, family, n, alg, L, metric ) {
	var best = null;
	var bv = -Infinity;
	acc.groups.forEach( function each( g ) {
		var v;
		if ( g.family !== family || g.M !== n || g.N !== n || g.K !== n || g.alg !== alg || g.L !== L ) {
			return;
		}
		v = ( metric === 'R_N' ) ? g.R_N.median : g.metrics[ metric ].median;
		if ( best === null || v > bv ) {
			best = g;
			bv = v;
		}
	});
	return best;
}


// EXPORTS //

module.exports = {
	'METRICS': METRICS,
	'GROWTH_RANGE': GROWTH_RANGE,
	'fW': fW,
	'fStrassen': fStrassen,
	'aggregate': aggregate,
	'lookupWorst': lookupWorst
};
