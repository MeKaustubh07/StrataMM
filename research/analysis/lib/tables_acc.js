'use strict';

/**
* Accuracy (E6, protocol §8) Markdown tables: hard gates and warnings as the E6 harness evaluates them (with their
* origin: recomputed by the analysis, recorded by the harness, or both), growth factors, per-family tables over seeds
* (incl. the per-entry relative metrics) and the κ-binned relative error of F9.
*/

var fmt = require( './format.js' );

var ACC_ARMS = [ 'A0', 'SW', 'V1', 'V2' ];
var ORIGIN = { 'recomputed+recorded': 'both', 'recomputed': 'analysis only', 'recorded': 'E6 record only' };


/**
* Returns the family/parameter-setting label of a group.
*
* @param {Object} g - group (or entry with `family` and `pkey`)
* @returns {string} label
*/
function famKey( g ) {
	return g.family + ( ( g.pkey ) ? ' (' + g.pkey + ')' : '' );
}

/**
* Renders gate or warning entries.
*
* @private
*/
function entries( list, ctx ) {
	return fmt.table( [ 'rule', 'family', 'params', 'shape', 'arm', 'L', 'seed', 'value', 'limit', 'origin', 'recorded message', 'src' ], list.map( function each( e ) {
		return [ e.rule, e.family, JSON.stringify( e.params ), fmt.shape( e.M, e.N, e.K ), e.alg, e.L, ( e.seed === null || e.seed === void 0 ) ? '—' : e.seed, fmt.sig( e.value, 4 ), fmt.sig( e.limit, 4 ), ORIGIN[ e.origin ] || e.origin, e.recorded || '—', ctx.src( [ e.src ] ) ];
	}), 'lllllrrrrlll' );
}

/**
* Accuracy gates, warnings and growth factors (§8).
*
* @param {Object} derived - derived results
* @param {Object} [ctx] - context
* @returns {string} Markdown
*/
function accuracyChecks( derived, ctx ) {
	var a = derived.accuracy;
	var recs;
	var out = '';
	ctx = fmt.srcContext( ctx );
	if ( !a.n_records ) {
		out += '**Hard gates** (violation = bug, stop): not evaluated — E6 not run (no `accuracy` records).\n\n';
		out += '**Warnings** (investigate, not bugs): ' + ( ( a.warnings.length ) ? a.warnings.length + ' recorded by the harness (`accuracy_warning` records), listed below' : 'none can be evaluated (no `accuracy` records)' ) + '.\n\n';
		return out + ( ( a.warnings.length ) ? entries( a.warnings, ctx ) : '' );
	}
	recs = new Set( a.gates.map( function f( g ) {
		return g.src.lines[ 0 ];
	}) ).size;
	out += '**Hard gates** (violation = bug, stop; evaluated as the E6 harness does — any non-finite output; classic η_N ≥ K² or η_C > K; SW or V1 with ρ_N ≥ 1; any F11 inexactness — and unioned with the `gate_violations` the harness recorded): ' + ( ( a.gates.length ) ? '**' + a.gates.length + ' violation(s) in ' + recs + ' record(s)**' : 'none violated' ) + ' over ' + a.n_records + ' records.\n\n';
	if ( a.gates.length ) {
		out += entries( a.gates, ctx ) + '\n';
	}
	out += '**Warnings** (investigate, not bugs; per record as the harness evaluates them — F1 with k₀ ≥ 32, L ≤ 4 more than 2× worse than A0 on η_N or η_C(max) per seed, V1 at or above f_S, V2 scaling inexact — plus growth g outside [1.7, 3], unioned with the records\' `warnings` and the `accuracy_warning` records): ' + ( ( a.warnings.length ) ? a.warnings.length : 'none' ) + '.\n\n';
	if ( a.warnings.length ) {
		out += entries( a.warnings, ctx ) + '\n';
	}
	if ( !a.growth.length ) {
		return out + 'Per-level growth g: not computed (no SW records on F2/F3 with an A0 on the same inputs).\n';
	}
	out += 'Per-level growth g = median over seeds of (η_F(L)/η_F(A0))^(1/L), SW on F2/F3:\n\n';
	out += fmt.table( [ 'family', 'params', 'shape', 'L', 'g', 'in [1.7, 3]', 'src' ], a.growth.map( function each( g ) {
		return [ g.family, JSON.stringify( g.params ), fmt.shape( g.M, g.N, g.K ), g.L, fmt.fixed( g.g, 3 ), ( g.in_range ) ? 'yes' : '**no**', ctx.src( [ g.src ] ) ];
	}), 'lllrrll' );
	return out;
}

/**
* Accuracy tables per family (and parameter setting), aggregated over seeds.
*
* @param {Object} derived - derived results
* @param {Object} [ctx] - context
* @param {Object} [opts] - `{ arms }` restricts the arms shown
* @returns {string} Markdown with one table per family/parameter setting
*/
function accuracyTables( derived, ctx, opts ) {
	var fams = new Map();
	var arms = ( opts && opts.arms ) || ACC_ARMS;
	var out = '';
	ctx = fmt.srcContext( ctx );
	derived.accuracy.groups.forEach( function each( g ) {
		var k = famKey( g );
		if ( arms.indexOf( g.alg ) < 0 ) {
			return;
		}
		if ( !fams.has( k ) ) {
			fams.set( k, [] );
		}
		fams.get( k ).push( g );
	});
	fams.forEach( function each( list, k ) {
		out += '\n#### ' + k + '\n\n' + fmt.table( [ 'shape', 'arm', 'L', 'k₀', 'seeds', 'η_N med [max]', 'ρ_N max', 'η_C max (med)', 'η_C p99.9 (med)', 'η_R med', 'R_N med', 'no correct digit (E ≥ |C|): med [max]', 'E ≥ 1e−8·|C|: med [max]', 'E/|C| max (max)', 'E/|C| p99.9 (med)', 'gates', 'warnings', 'src' ], list.map( function f( g ) {
			var m = g.metrics;
			return [ fmt.shape( g.M, g.N, g.K ), g.alg, g.L, g.k0, g.seeds, fmt.sig( m.eta_N.median ) + ' [' + fmt.sig( m.eta_N.max ) + ']', fmt.sig( m.rho_N.max ), fmt.sig( m.eta_C_max.median ), fmt.sig( m.eta_C_p999.median ), fmt.sig( m.eta_R.median ), fmt.sig( g.R_N.median ), fmt.pct( m.frac_ge1.median, 3 ) + ' [' + fmt.pct( m.frac_ge1.max, 3 ) + ']', fmt.pct( m.frac_ge1e8.median, 3 ) + ' [' + fmt.pct( m.frac_ge1e8.max, 3 ) + ']', fmt.sig( m.rel_max.max ), fmt.sig( m.rel_p999.median ), ( g.gate_violations ) ? '**' + g.gate_violations + ' violation(s)**' : 'ok', g.warnings || 0, ctx.src( [ g.src ] ) ];
		}), 'llrrrrrrrrrrrrrlrl' );
	});
	return out;
}

/**
* κ-binned relative error tables (F9, §8): one table per (family, parameters, n); rows arm × L; one column per decade
* of κ = (|A||B|)_ij/|C_ij| with the median over seeds of the per-seed bin median of E_ij/|C_ij| [max over seeds].
*
* @param {Object} derived - derived results
* @param {Object} [ctx] - context
* @param {Object} [opts] - `{ family }` restricts to one family/parameter label (`famKey`)
* @returns {string} Markdown ('' when no record carries κ bins)
*/
function kappaTables( derived, ctx, opts ) {
	var by = new Map();
	var out = '';
	ctx = fmt.srcContext( ctx );
	derived.accuracy.groups.forEach( function each( g ) {
		var k;
		if ( !g.kappa || ( opts && opts.family && famKey( g ) !== opts.family ) ) {
			return;
		}
		k = famKey( g ) + ', n = ' + fmt.shape( g.M, g.N, g.K );
		if ( !by.has( k ) ) {
			by.set( k, [] );
		}
		by.get( k ).push( g );
	});
	by.forEach( function each( list, k ) {
		var decades = [];
		var count = {};
		list.forEach( function f( g ) {
			g.kappa.bins.forEach( function h( b ) {
				if ( decades.indexOf( b.log10_kappa ) < 0 ) {
					decades.push( b.log10_kappa );
				}
				count[ b.log10_kappa ] = Math.max( count[ b.log10_kappa ] || 0, b.n );
			});
		});
		decades.sort( function cmp( a, b ) {
			return a - b;
		});
		out += '\n#### κ-binned relative error, ' + k + '\n\n' + fmt.table( [ 'arm', 'L', 'seeds' ].concat( decades.map( function f( d ) {
			return 'κ in [1e' + d + ', 1e' + ( d+1 ) + ') (' + count[ d ] + ' entries)';
		}) ).concat( [ 'C_ij = 0: entries (with error)', 'src' ] ), list.map( function f( g ) {
			var bins = {};
			g.kappa.bins.forEach( function h( b ) {
				bins[ b.log10_kappa ] = b;
			});
			return [ g.alg, g.L, g.kappa.seeds ].concat( decades.map( function h( d ) {
				return ( bins[ d ] ) ? fmt.sig( bins[ d ].rel_median ) + ' [' + fmt.sig( bins[ d ].rel_max ) + ']' : '—';
			}) ).concat( [ ( g.kappa.czero ) ? g.kappa.czero.n + ' (' + g.kappa.czero.n_err + ')' : '—', ctx.src( [ g.src ] ) ] );
		}), 'lrr' + decades.map( function f() {
			return 'r';
		}).join( '' ) + 'rl' );
	});
	return out;
}


// EXPORTS //

module.exports = {
	'ACC_ARMS': ACC_ARMS,
	'famKey': famKey,
	'accuracyChecks': accuracyChecks,
	'accuracyTables': accuracyTables,
	'kappaTables': kappaTables
};
