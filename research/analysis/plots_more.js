'use strict';

/**
* Figures for memory (E7), the sentinel/thermal series, accuracy (E6, η vs L with the f_W bound and A0) and the
* speed–accuracy Pareto view. Used by `plots.js`.
*/

var svg = require( './lib/svg.js' );
var layout = require( './lib/svg_layout.js' );

var ARM_SLOT = { 'A0': 1, 'SW': 2, 'V1': 3, 'V2': 4 };
var SOURCE_SLOT = { 'E2 A1': 2, 'E2 A2': 3, 'E4': 5 };


/**
* Formats a number for tooltips.
*
* @private
*/
function f3( v ) {
	return ( Number.isFinite( v ) ) ? Number( v.toPrecision( 4 ) ).toString() : 'n/a';
}

/**
* Memory (E7): analytic vs ΔarrayBuffers (read on return, single-allocation arms; §12 amendment 2026-10-30b item 2) vs
* ΔmaxRSS, in multiples of 8MN, per (algorithm, β).
*
* @param {Object} d - derived results
* @returns {(string|null)} SVG
*/
function memoryFigure( d ) {
	var groups = new Map();
	var panels = [];
	d.memory.forEach( function each( m ) {
		var k = m.alg + ', β = ' + m.beta;
		if ( !( m.analytic_bytes > 0 || m.d_ab_median > 0 || m.d_rss_median > 0 ) ) {
			return;
		}
		if ( !groups.has( k ) ) {
			groups.set( k, [] );
		}
		groups.get( k ).push( m );
	});
	if ( groups.size === 0 ) {
		return null;
	}
	groups.forEach( function each( list, k ) {
		var series;
		var vals = [ 0 ];
		var ns = list.map( function f( m ) {
			return m.n;
		});
		var pt = function pt( key, label ) {
			return list.map( function f( m ) {
				var gc = m.gc_events || {};
				vals.push( m[ key ] );
				return { 'x': m.n, 'y': m[ key ], 'tip': label + ', n = ' + m.n + ': ' + f3( m[ key ] ) + ' × 8MN (' + m.reps + ' reps' + ( ( m.excluded ) ? ', ' + m.excluded + ' excluded' : '' ) + ( ( gc.min === null || gc.min === void 0 ) ? '' : ', ' + gc.min + '–' + gc.max + ' GCs during the call' ) + ')' };
			});
		};
		series = [
			{ 'name': 'analytic', 'slot': 1, 'line': true, 'points': pt( 'analytic_x8mn', 'analytic 8·E1(+8MN)' ) },
			{ 'name': 'ΔarrayBuffers', 'slot': 2, 'points': pt( 'd_ab_x8mn', 'ΔarrayBuffers read on return (GCs recorded)' ) },
			{ 'name': 'ΔmaxRSS', 'slot': 3, 'points': pt( 'd_rss_x8mn', 'ΔmaxRSS' ).map( function f( p ) {
				p.open = true;
				return p;
			}) }
		];
		panels.push( svg.panel( {
			'title': k,
			'x': { 'type': 'log2', 'domain': [ Math.min.apply( null, ns ) / 1.4, Math.max.apply( null, ns ) * 1.4 ], 'label': 'n (log scale)' },
			'y': { 'type': 'linear', 'domain': svg.domainOf( vals, 'linear' ), 'label': 'extra bytes / 8MN' },
			'series': series
		}) );
	});
	return layout.figure( {
		'title': 'Peak extra memory per call (E7)',
		'subtitle': 'Analytic 8·E1 (+8MN when β ≠ 0) vs ΔarrayBuffers read on return (single-allocation arms, all non-excluded reps; GC events recorded; §12 amendment 2026-10-30b item 2) vs ΔmaxRSS (fresh process), in multiples of 8MN.',
		'legend': [ { 'name': 'analytic', 'slot': 1, 'kind': 'line' }, { 'name': 'ΔarrayBuffers', 'slot': 2 }, { 'name': 'ΔmaxRSS', 'slot': 3, 'open': true } ],
		'panels': panels,
		'cols': Math.min( 2, panels.length ),
		'notes': [ 'Table view: derived/tables.md (memory).' ]
	});
}

/**
* Sentinel (dgemm n = 256) and thermal state over campaign time; two panels sharing the time axis.
*
* @param {Object} d - derived results
* @returns {(string|null)} SVG
*/
function sentinelFigure( d ) {
	var s = d.sentinel.series;
	var t0;
	var pts;
	var thermal = [];
	var base = d.sentinel.summary.baseline_ns / 1e6;
	var tmax;
	var vals;
	if ( !s.length ) {
		return null;
	}
	t0 = Date.parse( s[ 0 ].t_wall );
	pts = s.map( function each( e ) {
		var x = ( Date.parse( e.t_wall ) - t0 ) / 60000;
		return { 'x': ( Number.isFinite( x ) ) ? x : e.i, 'y': e.median_ns / 1e6, 'tip': '#' + e.i + ' ' + e.t_wall + ' block ' + e.block_id + ': ' + f3( e.median_ns / 1e6 ) + ' ms, drift ' + f3( 100 * e.drift ) + '%, thermal ' + e.thermal_state };
	});
	pts.forEach( function each( p, i ) {
		var th = Number( s[ i ].thermal_state );
		if ( i > 0 ) {
			thermal.push( { 'x': p.x, 'y': Number( s[ i-1 ].thermal_state ), 'tip': '' } );
		}
		thermal.push( { 'x': p.x, 'y': th, 'tip': '#' + s[ i ].i + ': thermalState ' + th } );
	});
	tmax = Math.max.apply( null, pts.map( function f( p ) {
		return p.x;
	}) );
	vals = pts.map( function f( p ) {
		return p.y;
	}).concat( [ base*0.97, base*1.03 ] );
	return layout.figure( {
		'title': 'Sentinel and thermal state over the campaign',
		'subtitle': 'Sentinel = dgemm n = 256 before each block; dashed lines: ±3% around the median of the first 5 sentinels.',
		'panels': [
			svg.panel( { 'width': 720, 'height': 240, 'title': 'sentinel median per call', 'x': { 'type': 'linear', 'domain': [ 0, tmax || 1 ], 'label': 'minutes since first sentinel' }, 'y': { 'type': 'linear', 'domain': svg.domainOf( vals, 'linear' ), 'label': 'ms' }, 'series': [ { 'name': 'sentinel', 'slot': 1, 'line': true, 'points': pts } ], 'refs': [ { 'axis': 'y', 'value': base, 'label': 'baseline' }, { 'axis': 'y', 'value': base*1.03, 'label': '+3%', 'dashed': true }, { 'axis': 'y', 'value': base*0.97, 'label': '−3%', 'dashed': true } ] } ),
			svg.panel( { 'width': 720, 'height': 170, 'title': 'thermalState (0 nominal … 3 critical)', 'x': { 'type': 'linear', 'domain': [ 0, tmax || 1 ], 'label': 'minutes since first sentinel' }, 'y': { 'type': 'linear', 'domain': [ -0.2, 3.2 ], 'label': 'state' }, 'series': [ { 'name': 'thermal', 'slot': 1, 'line': true, 'markers': false, 'points': thermal } ] } )
		],
		'cols': 1,
		'notes': [ 'Table view: derived/tables.md (sentinel and environment).' ]
	});
}

/**
* Accuracy (E6): η_N vs L per family (one panel per parameter setting and n), SW median and maximum over seeds, V1 and
* V2 medians, A0 on the same inputs, and the f_W bound (dashed).
*
* @param {Object} d - derived results
* @param {Object} accLib - accuracy library (for f_W)
* @returns {Array<Object>} `{ name, svg }` per family
*/
function accuracyFigures( d, accLib ) {
	var fams = new Map();
	d.accuracy.groups.forEach( function each( g ) {
		var key = g.family;
		var sub = ( g.pkey ? g.pkey + ', ' : '' ) + 'n = ' + g.M + ( ( g.M === g.N && g.N === g.K ) ? '' : '×' + g.N + '×' + g.K );
		if ( !fams.has( key ) ) {
			fams.set( key, new Map() );
		}
		if ( !fams.get( key ).has( sub ) ) {
			fams.get( key ).set( sub, [] );
		}
		fams.get( key ).get( sub ).push( g );
	});
	return Array.from( fams.keys() ).sort( function c( a, b ) {
		return a.localeCompare( b, 'en', { 'numeric': true } );
	}).map( function each( fam ) {
		var panels = [];
		fams.get( fam ).forEach( function f( list, sub ) {
			panels.push( accuracyPanel( sub, list, accLib ) );
		});
		return {
			'name': 'accuracy_' + fam + '.svg',
			'svg': layout.figure( {
				'title': 'Accuracy, family ' + fam + ': η_N vs recursion levels L',
				'subtitle': 'η_N = max E / (u‖A‖_M‖B‖_M); lines: median over seeds; open markers: SW maximum; dashed: f_W bound.',
				'legend': [ { 'name': 'A0 (same inputs)', 'slot': ARM_SLOT.A0, 'kind': 'line' }, { 'name': 'SW median', 'slot': ARM_SLOT.SW, 'kind': 'line' }, { 'name': 'SW max', 'slot': ARM_SLOT.SW, 'open': true }, { 'name': 'V1 (Strassen-18)', 'slot': ARM_SLOT.V1, 'kind': 'line' }, { 'name': 'V2 (scaled SW)', 'slot': ARM_SLOT.V2, 'kind': 'line' }, { 'name': 'f_W bound', 'kind': 'dashed' } ],
				'panels': panels,
				'cols': Math.min( 3, panels.length ),
				'notes': [ 'Table view: derived/tables.md (accuracy, family ' + fam + ').' ]
			})
		};
	});
}

/**
* One accuracy panel.
*
* @private
*/
function accuracyPanel( sub, list, accLib ) {
	var vals = [];
	var maxL = 0;
	var series = [];
	var a0 = list.filter( function f( g ) {
		return g.alg === 'A0';
	})[ 0 ];
	var K = list[ 0 ].K;
	list.forEach( function each( g ) {
		maxL = Math.max( maxL, g.L );
	});
	[ 'SW', 'V1', 'V2' ].forEach( function each( arm ) {
		var gs = list.filter( function f( g ) {
			return g.alg === arm;
		}).sort( function c( a, b ) {
			return a.L - b.L;
		});
		if ( !gs.length ) {
			return;
		}
		series.push( { 'name': arm, 'slot': ARM_SLOT[ arm ], 'line': true, 'points': gs.map( function f( g ) {
			vals.push( g.metrics.eta_N.median );
			return { 'x': g.L, 'y': g.metrics.eta_N.median, 'tip': arm + ' L = ' + g.L + ' (k₀ = ' + g.k0 + '): η_N median ' + f3( g.metrics.eta_N.median ) + ', max ' + f3( g.metrics.eta_N.max ) + ', ρ_N max ' + f3( g.metrics.rho_N.max ) + ', R_N ' + f3( g.R_N.median ) + ', ' + g.seeds + ' seeds' };
		}) } );
		if ( arm === 'SW' ) {
			series.push( { 'name': 'SW max', 'slot': ARM_SLOT.SW, 'points': gs.map( function f( g ) {
				vals.push( g.metrics.eta_N.max );
				return { 'x': g.L, 'y': g.metrics.eta_N.max, 'open': true, 'tip': 'SW L = ' + g.L + ': η_N max over seeds ' + f3( g.metrics.eta_N.max ) };
			}) } );
		}
	});
	series.push( { 'name': 'f_W', 'slot': 0, 'line': true, 'dashed': true, 'markers': false, 'points': range( maxL ).map( function f( L ) {
		var v = accLib.fW( L, K / Math.pow( 2, L ), K );
		vals.push( v );
		return { 'x': L, 'y': v };
	}) } );
	if ( a0 ) {
		vals.push( a0.metrics.eta_N.median );
		series.push( { 'name': 'A0', 'slot': ARM_SLOT.A0, 'line': true, 'markers': false, 'points': [ { 'x': 0, 'y': a0.metrics.eta_N.median }, { 'x': Math.max( maxL, 1 ), 'y': a0.metrics.eta_N.median } ] } );
		series.push( { 'name': 'A0 point', 'slot': ARM_SLOT.A0, 'points': [ { 'x': 0, 'y': a0.metrics.eta_N.median, 'tip': 'A0: η_N median ' + f3( a0.metrics.eta_N.median ) + ', η_C max ' + f3( a0.metrics.eta_C_max.median ) } ] } );
	}
	return svg.panel( {
		'title': sub,
		'width': 330,
		'x': { 'type': 'linear', 'domain': [ -0.3, Math.max( maxL, 1 ) + 0.3 ], 'label': 'L', 'ticks': range( Math.max( maxL, 1 ) ) },
		'y': { 'type': 'log10', 'domain': svg.domainOf( vals, 'log10' ), 'label': 'η_N (units of u)' },
		'series': series
	});
}

/**
* Returns [0, 1, ..., n].
*
* @private
*/
function range( n ) {
	var out = [];
	var i;
	for ( i = 0; i <= n; i++ ) {
		out.push( i );
	}
	return out;
}

/**
* Speed–accuracy Pareto view per family: speedup (timing) vs R_N = η_N(SW, L)/η_N(A0) at the same (n, L).
*
* @param {Object} d - derived results
* @returns {Array<Object>} `{ name, svg }` per family with paired points
*/
function paretoFigures( d ) {
	return [ 'F1', 'F2', 'F3' ].map( function each( fam ) {
		var pts = [];
		var front;
		var best = -Infinity;
		var xv = [];
		var yv = [ 1 ];
		var bySrc = {};
		d.pairing.forEach( function f( r ) {
			var a = r.acc[ fam ];
			var e4 = String( r.experiment ).split( '.' )[ 0 ] === 'E4';
			var src = ( e4 ) ? 'E4' : r.experiment + ' ' + r.alg;
			if ( !a || !Number.isFinite( a.R_N ) || !Number.isFinite( r.S ) ) {
				return;
			}
			pts.push( { 'x': a.R_N, 'y': r.S, 'n': r.n, 'L': r.L, 'src': src, 'tip': src + ', n = ' + r.n + ', L = ' + r.L + ( ( e4 ) ? ', cutoff ' + r.cutoff : '' ) + ': S = ' + f3( r.S ) + ' [' + f3( r.lo ) + ', ' + f3( r.hi ) + '], R_N = ' + f3( a.R_N ) + ', ' + r.cell } );
			xv.push( a.R_N );
			yv.push( r.S, r.lo, r.hi );
		});
		if ( !pts.length ) {
			return null;
		}
		front = pts.slice().sort( function c( a, b ) {
			return ( a.x - b.x ) || ( b.y - a.y );
		}).filter( function f( p ) {
			if ( p.y > best ) {
				best = p.y;
				return true;
			}
			return false;
		});
		pts.forEach( function f( p ) {
			( bySrc[ p.src ] = bySrc[ p.src ] || [] ).push( p );
		});
		return {
			'name': 'pareto_' + fam + '.svg',
			'svg': layout.figure( {
				'title': 'Speed–accuracy trade-off, family ' + fam,
				'subtitle': 'Each point is one (n, L): speedup over A0 (timing) vs R_N = η_N(SW)/η_N(A0) at the same n and L (median over seeds).',
				'legend': Object.keys( bySrc ).map( function f( k ) {
					return { 'name': k, 'slot': SOURCE_SLOT[ k ] || 6 };
				}).concat( [ { 'name': 'Pareto front (max S, min R_N)', 'kind': 'line' } ] ),
				'panels': [ svg.panel( {
					'width': 600,
					'height': 320,
					'x': { 'type': 'log10', 'domain': svg.domainOf( xv, 'log10' ), 'label': 'R_N (log scale; lower is more accurate)' },
					'y': { 'type': 'linear', 'domain': svg.domainOf( yv, 'linear' ), 'label': 'speedup S' },
					'series': [ { 'name': 'front', 'slot': 0, 'line': true, 'markers': false, 'points': front } ].concat( Object.keys( bySrc ).map( function f( k ) {
						return { 'name': k, 'slot': SOURCE_SLOT[ k ] || 6, 'points': bySrc[ k ] };
					}) ),
					'refs': [ { 'axis': 'y', 'value': 1, 'label': 'S = 1' } ],
					'labels': front.map( function f( p ) {
						return { 'x': p.x, 'y': p.y, 'text': p.n + '/L' + p.L };
					})
				}) ],
				'cols': 1,
				'notes': [ 'Table view: derived/tables.md (speed–accuracy pairing).' ]
			})
		};
	}).filter( Boolean );
}


// EXPORTS //

module.exports = {
	'memoryFigure': memoryFigure,
	'sentinelFigure': sentinelFigure,
	'accuracyFigures': accuracyFigures,
	'paretoFigures': paretoFigures
};
