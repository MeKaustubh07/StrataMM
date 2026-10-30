'use strict';

/**
* E6 hard gates and warnings (protocol §8; §12 amendment 2026-10-30b item 7), recomputed on the stored records exactly as
* the E6 harness evaluates them (`research/accuracy/gates.js`) and unioned with what the harness persisted:
*
* -   hard gates (violation = bug): any non-finite output entry (`n_nonfinite > 0`); classic (A0) η_N ≥ K² or
*     η_C > K; SW or V1 with ρ_N ≥ 1; any F11 inexactness (`exact` not true). Comparisons are NaN-safe
*     (`!(x < limit)`, `!(x <= limit)`) and a gated metric stored as `null` or missing counts as NaN (JSON has no NaN,
*     so a NaN metric is written as `null`). A record's persisted `gate_violations` are always reported, also when the
*     stored metrics no longer show them.
* -   per-record warnings: F1 with k₀ ≥ 32 and 1 ≤ L ≤ 4 more than 2× worse than A0 on η_N or η_C(max), per seed (A0 of
*     the same family, parameters, seed and n); V1 with η_N ≥ its Strassen bound f_S; V2 scaling inexact; unioned
*     with the record's persisted `warnings`.
* -   growth warnings: g outside [1.7, 3] (recomputed in `accuracy.js`), unioned with the `accuracy_warning` records.
*
* Every entry carries `origin`: 'recomputed+recorded', 'recomputed' (not recorded by the harness) or 'recorded' (by
* the harness only).
*/

var GATE_RULES = [ 'non-finite output entries', 'classic eta_N >= K^2', 'classic eta_C > K', 'SW rho_N >= 1', 'V1 rho_N >= 1', 'F11 inexact' ];
var WARNING_RULES = [ 'F1 k0>=32, L<=4: SW more than 2x worse than A0', 'V1 eta_N >= Strassen bound f_S', 'V2 scaling not exact' ];
var GROWTH_RULE = 'g outside [1.7, 3] (F2/F3, eta_F)';
var F1_RATIO = 2.0;


/**
* Returns a number, mapping anything else (null, undefined) to NaN.
*
* @private
*/
function num( v ) {
	return ( typeof v === 'number' ) ? v : NaN;
}

/**
* Returns the classic Strassen bound constant with k₀ = K/2^L (as `research/accuracy/metrics.js` fS).
*
* @private
*/
function fS( K, L ) {
	var k0 = K / Math.pow( 2.0, L );
	return ( Math.pow( 12.0, L ) * ( ( k0*k0 ) + ( 5.0*k0 ) ) ) - ( 5.0*K );
}

/**
* Returns the hard-gate violations of a normalized record, recomputed from its stored metrics.
*
* @param {Object} x - normalized record (`family`, `alg`, `L`, `K`, metrics `m`)
* @returns {Array<Object>} `{ rule, value, limit }`
*/
function gates( x ) {
	var m = x.m;
	var out = [];
	var K = x.K;
	var etaC = ( m.eta_C ) ? num( m.eta_C.max ) : NaN;
	if ( m.n_nonfinite > 0 ) {
		out.push( { 'rule': GATE_RULES[ 0 ], 'value': m.n_nonfinite, 'limit': 0 } );
	}
	if ( x.alg === 'A0' ) {
		if ( !( num( m.eta_N ) < K*K ) ) {
			out.push( { 'rule': GATE_RULES[ 1 ], 'value': num( m.eta_N ), 'limit': K*K } );
		}
		if ( !( etaC <= K ) ) {
			out.push( { 'rule': GATE_RULES[ 2 ], 'value': etaC, 'limit': K } );
		}
	}
	if ( ( x.alg === 'SW' || x.alg === 'V1' ) && !( num( m.rho_N ) < 1.0 ) ) {
		out.push( { 'rule': x.alg + ' rho_N >= 1', 'value': num( m.rho_N ), 'limit': 1 } );
	}
	// The harness records `exact` (all entries exact and finite) on every record; anything but `true` fails:
	if ( x.family === 'F11' && m.exact !== true ) {
		out.push( { 'rule': GATE_RULES[ 5 ], 'value': Math.max( num( m.max_E ) || 0, num( m.eta_N ) || 0, etaC || 0 ), 'limit': 0 } );
	}
	return out;
}

/**
* Returns the per-record warnings of a normalized record, recomputed (`a0`: the A0 record of the same shard, or null).
*
* @param {Object} x - normalized record
* @param {(Object|null)} a0 - normalized A0 record of the same (family, parameters, seed, n)
* @returns {Array<Object>} `{ rule, value, limit }`
*/
function warnings( x, a0 ) {
	var out = [];
	var r1;
	var r2;
	var f;
	if ( x.alg === 'V1' && x.L > 0 ) {
		f = fS( x.K, x.L );
		if ( !( num( x.m.eta_N ) < f ) ) {
			out.push( { 'rule': WARNING_RULES[ 1 ], 'value': num( x.m.eta_N ), 'limit': f } );
		}
	}
	if ( x.m.scale_inexact || x.m.unscale_inexact ) {
		out.push( { 'rule': WARNING_RULES[ 2 ], 'value': ( x.m.scale_inexact || 0 ) + ( x.m.unscale_inexact || 0 ), 'limit': 0 } );
	}
	if ( a0 && a0.family === 'F1' && x.alg === 'SW' && x.k0 >= 32 && x.L >= 1 && x.L <= 4 ) {
		r1 = num( x.m.eta_N ) / num( a0.m.eta_N );
		r2 = ( x.m.eta_C && a0.m.eta_C ) ? num( x.m.eta_C.max ) / num( a0.m.eta_C.max ) : NaN;
		if ( r1 > F1_RATIO || r2 > F1_RATIO ) {
			out.push( { 'rule': WARNING_RULES[ 0 ], 'value': ( r1 > F1_RATIO ) ? r1 : r2, 'limit': F1_RATIO, 'eta_N_ratio': r1, 'eta_C_ratio': r2 } );
		}
	}
	return out;
}

/**
* Returns the known rule a persisted message belongs to (the rule name prefixes the message), or null.
*
* @private
*/
function ruleOf( text, rules ) {
	var i;
	for ( i = 0; i < rules.length; i++ ) {
		if ( String( text ).indexOf( rules[ i ] ) === 0 ) {
			return rules[ i ];
		}
	}
	return null;
}

/**
* Unions recomputed entries with persisted messages (one entry per rule; unknown messages are kept verbatim).
*
* @param {Array<Object>} recomputed - `{ rule, value, limit }`
* @param {Array<string>} persisted - messages recorded by the harness
* @param {Array<string>} rules - known rule names
* @returns {Array<Object>} entries with `origin` and `recorded` (the persisted message, or null)
*/
function union( recomputed, persisted, rules ) {
	var out = recomputed.map( function each( e ) {
		return Object.assign( {}, e, { 'origin': 'recomputed', 'recorded': null } );
	});
	( persisted || [] ).forEach( function each( text ) {
		var k = ruleOf( text, rules );
		var hit = out.filter( function f( e ) {
			return k !== null && e.rule === k && e.recorded === null;
		})[ 0 ];
		if ( hit ) {
			hit.origin = 'recomputed+recorded';
			hit.recorded = String( text );
		} else {
			out.push( { 'rule': k || String( text ), 'value': NaN, 'limit': NaN, 'origin': 'recorded', 'recorded': String( text ) } );
		}
	});
	return out;
}

/**
* Unions the recomputed growth groups out of range with the harness's `accuracy_warning` records.
*
* @param {Array<Object>} growth - recomputed growth groups (`{ family, params, pkey, M, N, K, L, g, in_range, src }`)
* @param {Array<Object>} records - `accuracy_warning` records (`{ rule, family, params, n, L, g, seeds }`)
* @param {Function} pkey - parameter-key function
* @returns {Array<Object>} warnings
*/
function growthWarnings( growth, records, pkey ) {
	var out = [];
	growth.forEach( function each( g ) {
		g.recorded = false;
		if ( !g.in_range ) {
			out.push( { 'rule': GROWTH_RULE, 'family': g.family, 'params': g.params, 'M': g.M, 'N': g.N, 'K': g.K, 'alg': 'SW', 'L': g.L, 'seed': null, 'value': g.g, 'limit': null, 'origin': 'recomputed', 'recorded': null, 'src': g.src } );
		}
	});
	( records || [] ).forEach( function each( r ) {
		var key = r.family + '|' + pkey( r.params ) + '|' + r.n + '|' + r.L;
		var hit = out.filter( function f( w ) {
			return w.rule === GROWTH_RULE && ( w.family + '|' + pkey( w.params ) + '|' + w.M + '|' + w.L ) === key && w.origin === 'recomputed';
		})[ 0 ];
		growth.forEach( function f( g ) {
			if ( ( g.family + '|' + pkey( g.params ) + '|' + g.M + '|' + g.L ) === key ) {
				g.recorded = true;
			}
		});
		if ( hit ) {
			hit.origin = 'recomputed+recorded';
			hit.recorded = 'g = ' + r.g + ' (' + r.seeds + ' seeds)';
			hit.src = { 'file': 'accuracy.jsonl', 'lines': ( hit.src.lines || [] ).concat( [ r._line ] ) };
		} else {
			out.push( { 'rule': GROWTH_RULE, 'family': r.family, 'params': r.params, 'M': r.n, 'N': r.n, 'K': r.n, 'alg': 'SW', 'L': r.L, 'seed': null, 'value': num( r.g ), 'limit': null, 'origin': 'recorded', 'recorded': String( r.rule ) + ': g = ' + r.g, 'src': { 'file': 'accuracy.jsonl', 'lines': [ r._line ] } } );
		}
	});
	return out;
}


// EXPORTS //

module.exports = {
	'GATE_RULES': GATE_RULES,
	'WARNING_RULES': WARNING_RULES,
	'GROWTH_RULE': GROWTH_RULE,
	'F1_RATIO': F1_RATIO,
	'gates': gates,
	'warnings': warnings,
	'union': union,
	'growthWarnings': growthWarnings
};
