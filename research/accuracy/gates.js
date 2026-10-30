'use strict';

// E6 hard gates (violation = bug ⇒ stop) and warnings (investigate, not bugs), research protocol §8:
//   hard:     classic (A0) η_N >= K^2 or η_C > K; SW or V1 with ρ_N = η_N/f_W >= 1; any F11 inexactness;
//             additionally (sanity) any non-finite output entry.
//   warnings: F1 with k0 >= 32 and L <= 4 more than 2× worse than A0 (η_N or η_C max, per seed);
//             g outside [1.7, 3], g = median over seeds of (η_F(L)/η_F(0))^(1/L), F2/F3 only.
// ρ_N is reported, never range-checked. ρ against V1's own Strassen bound f_S is a warning only.
//
// Every gate and warning message starts with its rule name (`RULES`; `ruleOf` recovers it). The checks also work on
// records read back from JSON, where NaN/±Infinity metrics are stored as null: a gated metric that is not a number
// fails its gate. Records persist their violations in `gate_violations` (present iff non-empty) and their warnings in
// `warnings` (always present); `recordViolations` is the union of both sources (sticky gates on resume).

// MODULES //

var fS = require( './metrics.js' ).fS;


// VARIABLES //

var G_LO = 1.7;
var G_HI = 3.0;
var RULES = {
	'nonfinite': 'non-finite output entries',
	'classic_eta_N': 'classic eta_N >= K^2',
	'classic_eta_C': 'classic eta_C > K',
	'rho_N': 'rho_N >= 1', // prefixed by the arm: 'SW rho_N >= 1', 'V1 rho_N >= 1'
	'f11': 'F11 inexact',
	'v1_fS': 'V1 eta_N >= Strassen bound f_S',
	'v2_scaling': 'V2 scaling not exact',
	'f1': 'F1 k0>=32, L<=4',
	'growth': 'g = median over seeds of (eta_F(L)/eta_F(0))^(1/L) in [1.7, 3] (F2/F3)'
};


// FUNCTIONS //

/**
* Returns a value if it is a number, else NaN (JSON stores NaN/±Infinity as null; every comparison with NaN fails).
*
* @private
* @param {*} x - value
* @returns {number} number or NaN
*/
function num( x ) {
	return ( typeof x === 'number' ) ? x : NaN;
}

/**
* Returns the rule name of a gate or warning message: the text before the first ' (' or ':'.
*
* @param {string} msg - message
* @returns {string} rule name
*/
function ruleOf( msg ) {
	var s = String( msg );
	var i = s.indexOf( ' (' );
	var j = s.indexOf( ':' );
	if ( i < 0 || ( j >= 0 && j < i ) ) {
		i = j;
	}
	return ( i < 0 ) ? s : s.slice( 0, i );
}

/**
* Returns the hard-gate violations of one accuracy record (empty array if none), recomputed from its metrics.
*
* @param {Object} rec - accuracy record (in memory, or read back from JSON)
* @returns {Array<string>} violations
*/
function violations( rec ) {
	var m = rec.metrics || {};
	var out = [];
	var K = rec.K;
	if ( m.n_nonfinite > 0 ) {
		out.push( RULES.nonfinite + ': ' + m.n_nonfinite );
	}
	if ( rec.alg === 'A0' ) {
		if ( !( num( m.eta_N ) < K*K ) ) {
			out.push( RULES.classic_eta_N + ' (' + m.eta_N + ' >= ' + ( K*K ) + ')' );
		}
		if ( !( num( ( m.eta_C ) ? m.eta_C.max : null ) <= K ) ) {
			out.push( RULES.classic_eta_C + ' (' + ( ( m.eta_C ) ? m.eta_C.max : m.eta_C ) + ' > ' + K + ')' );
		}
	}
	if ( ( rec.alg === 'SW' || rec.alg === 'V1' ) && !( num( m.rho_N ) < 1.0 ) ) {
		out.push( rec.alg + ' ' + RULES.rho_N + ' (eta_N ' + m.eta_N + ' vs f_W ' + m.f_W + ')' );
	}
	if ( rec.family === 'F11' && m.exact !== true ) {
		out.push( RULES.f11 + ' (' + rec.alg + ' L=' + rec.L + ': max E = ' + m.max_E + ')' );
	}
	return out;
}

/**
* Returns the hard-gate violations of a record as persisted (`gate_violations`) united with those recomputed from its
* metrics, one message per rule (the persisted message wins). Use this on records read back from accuracy.jsonl.
*
* @param {Object} rec - accuracy record
* @returns {Array<string>} violations (empty if none)
*/
function recordViolations( rec ) {
	var seen = {};
	var out = [];
	var all = ( Array.isArray( rec.gate_violations ) ) ? rec.gate_violations.map( String ) : [];
	var i;
	all = all.concat( violations( rec ) );
	for ( i = 0; i < all.length; i++ ) {
		if ( !seen[ ruleOf( all[ i ] ) ] ) {
			seen[ ruleOf( all[ i ] ) ] = true;
			out.push( all[ i ] );
		}
	}
	return out;
}

/**
* Returns per-record warnings that need only the record itself.
*
* @param {Object} rec - accuracy record
* @returns {Array<string>} warnings
*/
function recordWarnings( rec ) {
	var m = rec.metrics || {};
	var out = [];
	var f;
	if ( rec.alg === 'V1' && rec.L > 0 ) {
		f = fS( rec.K, rec.L );
		if ( !( num( m.eta_N ) < f ) ) {
			out.push( RULES.v1_fS + ' (' + m.eta_N + ' >= ' + f + ')' );
		}
	}
	if ( m.scale_inexact || m.unscale_inexact ) {
		out.push( RULES.v2_scaling + ' (' + m.scale_inexact + ' inputs, ' + m.unscale_inexact + ' outputs)' );
	}
	return out;
}

/**
* Adds the F1 warnings to the SW records of one (family, params, seed, n) shard: k0 >= 32, L <= 4 and more than
* 2× worse than A0 on η_N or η_C(max).
*
* @param {Array<Object>} recs - accuracy records of one shard (mutated: `warnings` extended)
*/
function shardWarnings( recs ) {
	var a0 = null;
	var r;
	var i;
	var x;
	var y;
	for ( i = 0; i < recs.length; i++ ) {
		if ( recs[ i ].alg === 'A0' ) {
			a0 = recs[ i ];
		}
	}
	if ( !a0 || a0.family !== 'F1' ) {
		return;
	}
	for ( i = 0; i < recs.length; i++ ) {
		r = recs[ i ];
		if ( r.alg !== 'SW' || r.k0 < 32 || r.L > 4 || r.L < 1 ) {
			continue;
		}
		x = r.metrics.eta_N / a0.metrics.eta_N;
		y = r.metrics.eta_C.max / a0.metrics.eta_C.max;
		if ( x > 2.0 || y > 2.0 ) {
			r.warnings.push( RULES.f1 + ': SW more than 2x worse than A0 (eta_N ratio ' + x.toFixed( 3 ) + ', eta_C ratio ' + y.toFixed( 3 ) + ')' );
		}
	}
}

/**
* Computes the per-level growth factors g (F2/F3) over all records and returns the out-of-range ones.
*
* @param {Array<Object>} recs - all accuracy records of the campaign
* @returns {Array<Object>} warnings `{ rule, family, params, n, L, g, seeds }` (also listed when in range: `ok`)
*/
function growthWarnings( recs ) {
	var groups = {};
	var a0 = {};
	var out = [];
	var keys;
	var key;
	var vals;
	var r;
	var g;
	var i;
	var s;
	for ( i = 0; i < recs.length; i++ ) {
		r = recs[ i ];
		if ( r.type !== 'accuracy' || ( r.family !== 'F2' && r.family !== 'F3' ) ) {
			continue;
		}
		s = r.family + '|' + JSON.stringify( r.params ) + '|' + r.N + '|' + r.seed;
		if ( r.alg === 'A0' ) {
			a0[ s ] = r.metrics.eta_F;
		}
	}
	for ( i = 0; i < recs.length; i++ ) {
		r = recs[ i ];
		if ( r.type !== 'accuracy' || r.alg !== 'SW' || r.L < 1 || ( r.family !== 'F2' && r.family !== 'F3' ) ) {
			continue;
		}
		s = r.family + '|' + JSON.stringify( r.params ) + '|' + r.N + '|' + r.seed;
		if ( !a0[ s ] ) {
			continue;
		}
		key = r.family + '|' + JSON.stringify( r.params ) + '|' + r.N + '|' + r.L;
		if ( !groups[ key ] ) {
			groups[ key ] = {
				'family': r.family,
				'params': r.params,
				'n': r.N,
				'L': r.L,
				'v': []
			};
		}
		groups[ key ].v.push( Math.pow( r.metrics.eta_F / a0[ s ], 1.0 / r.L ) );
	}
	keys = Object.keys( groups );
	for ( i = 0; i < keys.length; i++ ) {
		vals = groups[ keys[ i ] ].v.slice().sort( function cmp( a, b ) {
			return a - b;
		});
		g = ( vals.length % 2 ) ? vals[ ( vals.length-1 ) / 2 ] : 0.5 * ( vals[ ( vals.length/2 ) - 1 ] + vals[ vals.length/2 ] );
		out.push({
			'rule': RULES.growth,
			'family': groups[ keys[ i ] ].family,
			'params': groups[ keys[ i ] ].params,
			'n': groups[ keys[ i ] ].n,
			'L': groups[ keys[ i ] ].L,
			'g': g,
			'seeds': vals.length,
			'ok': ( g >= G_LO && g <= G_HI )
		});
	}
	return out;
}


// EXPORTS //

module.exports = {
	'RULES': RULES,
	'ruleOf': ruleOf,
	'violations': violations,
	'recordViolations': recordViolations,
	'recordWarnings': recordWarnings,
	'shardWarnings': shardWarnings,
	'growthWarnings': growthWarnings
};
