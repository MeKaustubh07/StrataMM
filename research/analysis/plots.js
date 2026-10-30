#!/usr/bin/env node
'use strict';

/**
* Dependency-free SVG figures from the derived analysis (`derived/*.json`), written to `<campaign>/figures/`.
*
* Usage:
*   node research/analysis/plots.js <campaign_id>
*   node research/analysis/plots.js --dir <campaign directory> [--derived <dir>] [--out <figures dir>]
*
* Table view of every figure: `derived/tables.md`.
*/

var path = require( 'path' );
var io = require( './lib/io.js' );
var svg = require( './lib/svg.js' );
var layout = require( './lib/svg_layout.js' );
var accLib = require( './lib/accuracy.js' );
var summarize = require( './summarize.js' );
var more = require( './plots_more.js' );

var SLOT = { 'A0': 1, 'A1': 2, 'A2': 3, 'C1': 4, 'C2': 5 };
var MANIFEST = 'figures.json';
var ARM_SLOT = { 'A0': 1, 'SW': 2, 'V1': 3, 'V2': 4 };
var VERDICT_MARK = {
	'faster': { 'shape': 'circle', 'open': false },
	'faster (<2% margin)': { 'shape': 'diamond', 'open': false },
	'equivalent': { 'shape': 'circle', 'open': true },
	'slower': { 'shape': 'down', 'open': false },
	'inconclusive': { 'shape': 'diamond', 'open': true }
};


/**
* Returns the E2 cell of an algorithm at square size n (row-major NN, LD n, α = 1, β = 0).
*
* @private
*/
function e2( d, alg, n ) {
	return d.cells.filter( function f( c ) {
		var x = c.desc;
		return c.inference && x.experiment === 'E2' && x.alg === alg && x.M === n && x.N === n && x.K === n && x.ld_pad === 0 && x.order === 'row-major' && x.transA === 'no-transpose' && x.transB === 'no-transpose' && x.alpha === 1 && x.beta === 0;
	})[ 0 ] || null;
}

/**
* Formats a number for tooltips.
*
* @private
*/
function f3( v ) {
	return ( Number.isFinite( v ) ) ? v.toFixed( 3 ) : 'n/a';
}

/**
* Speedup vs n per family, with CI bands (P, connected) or whiskers (O, R, unconnected), verdict markers and the
* 1.0 / 1.02 lines; the P panel marks the pre-registered interpolated crossovers.
*
* @param {Object} d - derived results
* @returns {string} SVG
*/
function speedupFigure( d ) {
	var fams = Object.keys( d.crossover.families );
	var panels = fams.map( function each( fam ) {
		var sizes = d.crossover.families[ fam ];
		var vals = [ 1.0, 1.02 ];
		var refs = [ { 'axis': 'y', 'value': 1.0, 'label': 'S = 1', 'below': true }, { 'axis': 'y', 'value': 1.02, 'label': '1.02', 'dashed': true } ];
		var series = [ 'A1', 'A2' ].map( function f( alg ) {
			return {
				'name': alg, 'slot': SLOT[ alg ], 'line': fam === 'P', 'band': fam === 'P', 'whisker': fam !== 'P', 'endLabel': fam === 'P',
				'points': sizes.map( function g( n ) {
					var c = e2( d, alg, n );
					var s = c && c.speedup;
					var mk;
					if ( !s ) {
						return null;
					}
					vals.push( s.est, s.lo, s.hi );
					mk = VERDICT_MARK[ s.verdict ] || VERDICT_MARK.inconclusive;
					return { 'x': n, 'y': s.est, 'lo': s.lo, 'hi': s.hi, 'shape': mk.shape, 'open': mk.open, 'tip': alg + ', n = ' + n + ': S = ' + f3( s.est ) + ' [' + f3( s.lo ) + ', ' + f3( s.hi ) + '], ' + s.verdict + ( ( s.low_replication ) ? ' (low replication)' : '' ) + ', ' + c.id };
				}).filter( Boolean )
			};
		});
		d.crossover.results.forEach( function g( r ) {
			if ( r.family === fam && r.pre_registered && Number.isFinite( r.interpolation.median ) ) {
				refs.push( { 'axis': 'x', 'value': r.interpolation.median, 'label': r.alg + ' n* (θ=' + r.theta + ')', 'dashed': true } );
			}
		});
		return svg.panel( {
			'title': 'Family ' + fam + ( ( fam === 'P' ) ? ' (primary)' : '' ),
			'x': { 'type': 'log2', 'domain': [ sizes[ 0 ] / 1.25, sizes[ sizes.length-1 ] * 1.25 ], 'label': 'n (log scale)' },
			'y': { 'type': 'linear', 'domain': svg.domainOf( vals, 'linear' ), 'label': 'S = A0 / alg' },
			'series': series,
			'refs': refs
		});
	});
	return layout.figure( {
		'title': 'Speedup over dgemm vs n (E2)',
		'subtitle': 'Paired 95% CIs (block bootstrap; t-interval when r ≤ 4). Row-major NN, LD = n, α = 1, β = 0.',
		'legend': [ { 'name': 'A1 (one level)', 'slot': SLOT.A1, 'kind': 'line' }, { 'name': 'A2 (τ*, L_max)', 'slot': SLOT.A2, 'kind': 'line' } ].concat( Object.keys( VERDICT_MARK ).map( function f( v ) {
			return { 'name': v, 'shape': VERDICT_MARK[ v ].shape, 'open': VERDICT_MARK[ v ].open };
		}) ),
		'panels': panels,
		'cols': 3,
		'notes': [ 'Specific to ' + d.crossover.specific_to + '.', 'Table view: derived/tables.md (E2 speedups, crossovers).' ]
	});
}

/**
* Effective GFLOP/s (2n³/t) per algorithm vs n (E2), whiskers = min–max of process medians.
*
* @param {Object} d - derived results
* @returns {string} SVG
*/
function gflopsFigure( d ) {
	var vals = [];
	var series = [];
	[ 'A0', 'A1', 'A2' ].forEach( function each( alg ) {
		Object.keys( d.crossover.families ).forEach( function f( fam ) {
			series.push( {
				'name': alg, 'slot': SLOT[ alg ], 'line': fam === 'P', 'whisker': true, 'endLabel': fam === 'P',
				'points': d.crossover.families[ fam ].map( function g( n ) {
					var c = e2( d, alg, n );
					var fl;
					if ( !c ) {
						return null;
					}
					fl = 2.0 * n * n * n;
					vals.push( c.gflops, fl / c.pm_max_ns, fl / c.pm_min_ns );
					return { 'x': n, 'y': c.gflops, 'lo': fl / c.pm_max_ns, 'hi': fl / c.pm_min_ns, 'tip': alg + ', n = ' + n + ': ' + f3( c.gflops ) + ' GFLOP/s (cell median ' + ( c.median_ns / 1e6 ).toPrecision( 4 ) + ' ms), ' + c.id };
				}).filter( Boolean )
			});
		});
	});
	return layout.figure( {
		'title': 'Effective GFLOP/s per algorithm (E2)',
		'subtitle': 'Effective rate 2n³ / (cell median time); whiskers span the process medians; P sizes connected, O/R sizes unconnected.',
		'legend': [ 'A0', 'A1', 'A2' ].map( function f( a ) {
			return { 'name': a, 'slot': SLOT[ a ], 'kind': 'line' };
		}),
		'panels': [ svg.panel( { 'width': 640, 'height': 300, 'x': { 'type': 'log2', 'domain': [ 26, 2600 ], 'label': 'n (log scale)' }, 'y': { 'type': 'linear', 'domain': svg.domainOf( vals, 'linear', [ 0 ] ), 'label': 'GFLOP/s' }, 'series': series } ) ],
		'cols': 1,
		'notes': [ 'Table view: derived/tables.md (all cells).' ]
	});
}

/**
* Attribution ladder (E3): ratio terms at LD n vs LD n+8 with CIs, the (8/7)^L ceiling and confounded flags; and the
* LD penalty per algorithm.
*
* @param {Object} d - derived results
* @returns {(string|null)} SVG
*/
function ladderFigure( d ) {
	var panels = [];
	if ( !d.ladder.length ) {
		return null;
	}
	d.ladder.forEach( function each( l ) {
		var t = {};
		var vals = [ 1, l.ceiling ];
		l.terms.forEach( function f( x ) {
			t[ x.name ] = { 'est': x.est, 'lo': x.lo, 'hi': x.hi, 'note': ( x.confounded ) ? 'confounded' : '', 'tip': x.label + ': ' + f3( x.est ) + ' [' + f3( x.lo ) + ', ' + f3( x.hi ) + ']' + ( ( x.ceiling ) ? ', ' + f3( 100 * x.ceiling_ratio ) + '% of (8/7)^L' : '' ) };
			vals.push( x.est, x.lo, x.hi );
		});
		panels.push( svg.barPanel( {
			'title': 'n = ' + l.n + ' (L = ' + l.L + ')',
			'categories': [ 'recursion A0/C2', 'arithmetic C2/A2', 'total A0/A2', 'layout A0/C1' ],
			'groups': [ { 'name': 'LD n', 'slot': 1 }, { 'name': 'LD n+8', 'slot': 2 } ],
			'values': [ [ t.recursion_n, t.recursion_pad ], [ t.arith_n, t.arith_pad ], [ t.total_n, t.total_pad ], [ t.layout, null ] ],
			'y': { 'type': 'log2', 'domain': svg.domainOf( vals, 'log2' ), 'label': 'ratio of cell medians' },
			'base': 1,
			'width': 420,
			'refs': [ { 'axis': 'y', 'value': l.ceiling, 'label': '(8/7)^L', 'dashed': true } ]
		}) );
		panels.push( svg.barPanel( {
			'title': 'n = ' + l.n + ': LD penalty',
			'categories': [ 'A0', 'C2', 'A2' ],
			'groups': [ { 'name': 'LD n / LD n+8', 'slot': 4 } ],
			'values': [ [ t.ld_A0 ], [ t.ld_C2 ], [ t.ld_A2 ] ],
			'y': { 'type': 'log2', 'domain': svg.domainOf( [ 1 ].concat( [ t.ld_A0, t.ld_C2, t.ld_A2 ].filter( Boolean ).map( function f( x ) {
				return x.hi;
			}), [ t.ld_A0, t.ld_C2, t.ld_A2 ].filter( Boolean ).map( function f( x ) {
				return x.lo;
			}) ), 'log2' ), 'label': 'time(LD n) / time(LD n+8)' },
			'base': 1,
			'width': 260
		}) );
	});
	return layout.figure( {
		'title': 'Attribution ladder (E3)',
		'subtitle': 'Ratios of cell medians paired by block with 95% CIs; an arithmetic term time(C2)/time(A2) (the speedup of A2 over C2, §6 "A2/C2") at or above (8/7)^L is flagged confounded.',
		'legend': [ { 'name': 'LD = n', 'slot': 1, 'kind': 'bar' }, { 'name': 'LD = n + 8', 'slot': 2, 'kind': 'bar' }, { 'name': 'LD n / LD n+8 (same algorithm)', 'slot': 4, 'kind': 'bar' } ],
		'panels': panels,
		'cols': 2,
		'notes': [ 'Table view: derived/tables.md (attribution ladder).' ]
	});
}

/**
* Depth sweep (E4): speedup vs leaf cutoff per n.
*
* @param {Object} d - derived results
* @returns {(string|null)} SVG
*/
function depthFigure( d ) {
	var byN = new Map();
	var vals = [ 1 ];
	var series;
	var keys;
	var cut;
	if ( !d.depth.length ) {
		return null;
	}
	d.depth.forEach( function each( r ) {
		if ( !r.speedup ) {
			return;
		}
		if ( !byN.has( r.desc.M ) ) {
			byN.set( r.desc.M, [] );
		}
		byN.get( r.desc.M ).push( { 'x': r.desc.cutoff, 'y': r.speedup.est, 'lo': r.speedup.lo, 'hi': r.speedup.hi, 'tip': 'n = ' + r.desc.M + ', cutoff ' + r.desc.cutoff + ' (L = ' + r.L + '): S = ' + f3( r.speedup.est ) + ' [' + f3( r.speedup.lo ) + ', ' + f3( r.speedup.hi ) + '], ' + r.speedup.verdict + ', ' + r.cell } );
		vals.push( r.speedup.est, r.speedup.lo, r.speedup.hi );
	});
	keys = Array.from( byN.keys() ).sort( function c( a, b ) {
		return a - b;
	});
	series = keys.map( function f( n, i ) {
		return { 'name': 'n = ' + n, 'slot': i+1, 'line': true, 'whisker': true, 'endLabel': true, 'points': byN.get( n ) };
	});
	cut = d.depth.map( function f( r ) {
		return r.desc.cutoff;
	});
	return layout.figure( {
		'title': 'Depth sweep (E4, exploratory)',
		'subtitle': 'Speedup over A0 vs leaf cutoff (levels uncapped); 95% CIs.',
		'legend': series.map( function f( s ) {
			return { 'name': s.name, 'slot': s.slot, 'kind': 'line' };
		}),
		'panels': [ svg.panel( { 'width': 560, 'height': 280, 'x': { 'type': 'log2', 'domain': [ Math.min.apply( null, cut ) / 1.4, Math.max.apply( null, cut ) * 1.4 ], 'label': 'leaf cutoff (log scale)' }, 'y': { 'type': 'linear', 'domain': svg.domainOf( vals, 'linear' ), 'label': 'S = A0 / SW' }, 'series': series, 'refs': [ { 'axis': 'y', 'value': 1, 'label': 'S = 1' } ] } ) ],
		'cols': 1,
		'notes': [ 'Table view: derived/tables.md (depth sweep).' ]
	});
}

/**
* Writes every figure of a campaign.
*
* @param {Array<string>} argv - arguments
* @returns {Array<string>} written files
*/
function main( argv ) {
	var opts = io.parseArgs( argv );
	var dir = io.campaignDir( opts );
	var d = summarize.loadDerived( ( opts.derived ) ? path.resolve( opts.derived ) : path.join( dir, 'derived' ) );
	var out = ( opts.out ) ? path.resolve( opts.out ) : path.join( dir, 'figures' );
	var written;
	var names;
	var figs = {
		'speedup.svg': speedupFigure( d ),
		'gflops.svg': gflopsFigure( d ),
		'ladder.svg': ladderFigure( d ),
		'depth.svg': depthFigure( d ),
		'memory.svg': more.memoryFigure( d ),
		'sentinel.svg': more.sentinelFigure( d )
	};
	more.accuracyFigures( d, accLib ).forEach( function each( f ) {
		figs[ f.name ] = f.svg;
	});
	more.paretoFigures( d ).forEach( function each( f ) {
		figs[ f.name ] = f.svg;
	});
	names = Object.keys( figs ).filter( function f( k ) {
		return figs[ k ];
	});
	written = names.map( function each( k ) {
		io.writeText( path.join( out, k ), figs[ k ] );
		return path.join( out, k );
	});
	// The report embeds exactly the figures of this run (a figure without data is not generated; stale files from an
	// earlier run in the same directory are not listed):
	io.writeJson( path.join( out, MANIFEST ), { 'campaign': d.summary.campaign, 'generated_at': new Date().toISOString(), 'figures': names, 'not_generated': Object.keys( figs ).filter( function f( k ) {
		return !figs[ k ];
	}) } );
	return written;
}


// EXPORTS //

module.exports = {
	'SLOT': SLOT,
	'MANIFEST': MANIFEST,
	'ARM_SLOT': ARM_SLOT,
	'speedupFigure': speedupFigure,
	'gflopsFigure': gflopsFigure,
	'ladderFigure': ladderFigure,
	'depthFigure': depthFigure,
	'main': main
};

if ( require.main === module ) {
	try {
		console.log( 'plots: wrote ' + main( process.argv.slice( 2 ) ).length + ' figures' );
	} catch ( err ) {
		console.error( 'plots: ' + err.message );
		process.exitCode = 1;
	}
}
