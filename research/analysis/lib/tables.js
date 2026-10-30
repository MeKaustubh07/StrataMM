'use strict';

/**
* Markdown tables over the derived analysis results. Every table has a source column; `ctx.src(list)` renders it
* (derived `tables.md`: compact cell ids / line references; `REPORT.md`: links to the source-record appendix).
*/

var fmt = require( './format.js' );
var acc = require( './tables_acc.js' );
var pilotLib = require( './pilot.js' );

var context = fmt.srcContext;


/**
* Formats a speedup object as `S [lo, hi]` plus a low-replication marker.
*
* @param {Object} s - speedup
* @returns {string} formatted speedup
*/
function speedup( s ) {
	if ( !s || !Number.isFinite( s.est ) ) {
		return '—';
	}
	return fmt.fixed( s.est, 3 ) + ' ' + fmt.ci( s.lo, s.hi, 3 ) + ( ( s.low_replication ) ? ' (low replication)' : '' ) + ( ( s.pairing === 'unpaired' ) ? ' (unpaired)' : '' );
}

/**
* Returns the verdict label of a speedup (C2: estimate only).
*
* @param {Object} s - speedup
* @returns {string} verdict
*/
function verdict( s ) {
	if ( !s ) {
		return '—';
	}
	return ( s.estimate_only ) ? 'estimate (no verdict)' : s.verdict;
}

/**
* Formats the speedup of a cell or row, or why it is missing (no paired A0 reference, §6).
*
* @private
*/
function speedupOf( c ) {
	if ( c && c.speedup ) {
		return speedup( c.speedup );
	}
	return ( c && c.speedup_missing ) ? 'missing: ' + c.speedup_missing.reason : '—';
}

/**
* Returns the verdict label of a cell or row (`missing` when it has no paired reference).
*
* @private
*/
function verdictOf( c ) {
	if ( c && c.speedup ) {
		return verdict( c.speedup );
	}
	return ( c && c.speedup_missing ) ? 'missing' : '—';
}

/**
* Returns the sources of a cell's speedup: the cell and its A0 reference cell.
*
* @private
*/
function speedupSrc( c ) {
	return [ c.src ].concat( ( c.speedup && c.speedup.ref && c.speedup.ref !== c.id ) ? [ { 'cell': c.speedup.ref } ] : [] );
}

/**
* Per-cell table (§6): r, k, batch, median, IQR, min, mean, p90, first call, flags, exclusions, steady classes, S.
*
* @param {Array<Object>} cells - derived cells
* @param {Object} [ctx] - context
* @returns {string} Markdown
*/
function cellTable( cells, ctx ) {
	ctx = context( ctx );
	return fmt.table( [ 'cell', 'exp', 'alg', 'cutoff/levels (L)', 'shape', 'layout', 'LD', 'α, β', 'r', 'k', 'b', 'median', 'process medians min–max', 'IQR (pooled)', 'min', 'mean', 'p90', 'first call', 'flags', 'excl.', 'steady', 'S [95% CI]', 'verdict', 'src' ], cells.map( function each( c ) {
		var d = c.desc;
		return [ c.id, d.experiment, d.alg, ( d.cutoff === null ) ? '—' : d.cutoff + '/' + d.levels + ' (' + c.L + ')', fmt.shape( d.M, d.N, d.K ), fmt.layout( d ), fmt.ld( d ), d.alpha + ', ' + d.beta, c.r, c.k, ( c.batch || [] ).join( '/' ), fmt.time( c.median_ns ), fmt.time( c.pm_min_ns ) + ' – ' + fmt.time( c.pm_max_ns ), fmt.time( c.iqr_ns ), fmt.time( c.min_ns ), fmt.time( c.mean_ns ), fmt.time( c.p90_ns ), fmt.time( c.first_call_ns ), fmt.counts( c.flags ), c.excluded_count, fmt.counts( c.steady ), speedupOf( c ), verdictOf( c ), ctx.src( speedupSrc( c ) ) ];
	}), 'lllllllrrrrrrrrrrrlrllll' );
}

/**
* E2 speedup table for one family: absolute baseline times, A1 and A2 speedups with CIs and verdicts.
*
* @param {Object} derived - derived results
* @param {string} family - family id
* @param {Object} [ctx] - context
* @returns {string} Markdown
*/
function e2Table( derived, family, ctx ) {
	var sizes = derived.crossover.families[ family ];
	var rows = [];
	ctx = context( ctx );
	sizes.forEach( function each( n ) {
		var a0 = find( 'A0' );
		var a1 = find( 'A1' );
		var a2 = find( 'A2' );
		if ( !a0 && !a1 && !a2 ) {
			return;
		}
		rows.push( [ n, ( a0 ) ? fmt.time( a0.median_ns ) : '—', ( a0 ) ? fmt.fixed( a0.gflops, 3 ) : '—', speedupOf( a1 ), verdictOf( a1 ), ( a2 ) ? a2.L : '—', speedupOf( a2 ), verdictOf( a2 ), ctx.src( sources( [ a0, a1, a2 ] ) ) ] );

		function find( alg ) {
			return derived.cells.filter( function f( c ) {
				var d = c.desc;
				return c.inference && d.experiment === 'E2' && d.alg === alg && d.M === n && d.N === n && d.K === n && d.ld_pad === 0 && d.order === 'row-major' && d.transA === 'no-transpose' && d.transB === 'no-transpose' && d.alpha === 1 && d.beta === 0;
			})[ 0 ] || null;
		}
	});
	return fmt.table( [ 'n', 'A0 median', 'A0 GFLOP/s', 'A1 S [95% CI]', 'A1 verdict', 'A2 L', 'A2 S [95% CI]', 'A2 verdict', 'src' ], rows, 'rrrlllll' );

	// The cells shown plus the A0 reference cell actually behind each S (paired within E2 blocks only):
	function sources( list ) {
		var ids = [];
		var out = [];
		list.forEach( function each( c ) {
			if ( !c ) {
				return;
			}
			speedupSrc( c ).forEach( function f( s ) {
				if ( ids.indexOf( s.cell ) < 0 ) {
					ids.push( s.cell );
					out.push( s );
				}
			});
		});
		return out;
	}
}

/**
* Crossover table (§7).
*
* @param {Object} derived - derived results
* @param {Object} [ctx] - context
* @returns {string} Markdown
*/
function crossoverTable( derived, ctx ) {
	ctx = context( ctx );
	return fmt.table( [ 'family', 'alg', 'θ', 'role', 'sizes used', 'fixed-sequence n* (§7)', 'stopped at', 'interpolated n* (median)', '95% interval', 'censored < / >', 'resampling, B, seed', 'src' ], derived.crossover.results.map( function each( r ) {
		var ip = r.interpolation;
		var role = ( r.pre_registered ) ? ( ( r.primary ) ? 'primary' : 'pre-registered' ) : 'secondary';
		return [ r.family, r.alg, r.theta, role, r.sizes.join( ',' ) + ( ( r.missing.length ) ? ' (missing ' + r.missing.join( ',' ) + ')' : '' ), r.fixed_sequence.label, ( r.fixed_sequence.stopped_at === null ) ? '—' : r.fixed_sequence.stopped_at + ' (' + r.fixed_sequence.reason + ')', ( ip.labels ) ? ip.labels.median : '—', ( ip.labels ) ? ip.labels.interval : '—', ( ip.labels ) ? fmt.pct( ip.frac_left, 1 ) + ' / ' + fmt.pct( ip.frac_right, 1 ) : '—', ( ip.resampling || '—' ) + ', ' + ip.B + ', ' + ip.seed, ctx.src( pointSources( derived, r ) ) ];
	}), 'llrllllllll' );
}

/**
* Returns the cell sources used by a crossover result.
*
* @private
*/
function pointSources( derived, r ) {
	return derived.cells.filter( function f( c ) {
		var d = c.desc;
		return c.inference && d.experiment === 'E2' && ( d.alg === r.alg || d.alg === 'A0' ) && d.M === d.N && d.N === d.K && r.sizes.indexOf( d.M ) >= 0 && d.ld_pad === 0 && d.alpha === 1 && d.beta === 0 && d.order === 'row-major' && d.transA === 'no-transpose' && d.transB === 'no-transpose';
	}).map( function f( c ) {
		return c.src;
	});
}

/**
* Attribution ladder table (E3).
*
* @param {Object} derived - derived results
* @param {Object} [ctx] - context
* @returns {string} Markdown
*/
function ladderTable( derived, ctx ) {
	var rows = [];
	ctx = context( ctx );
	derived.ladder.forEach( function each( l ) {
		l.terms.forEach( function f( t ) {
			rows.push( [ l.n, l.L, fmt.fixed( l.ceiling, 4 ), t.label, fmt.fixed( t.est, 3 ), fmt.ci( t.lo, t.hi, 3 ), t.method + ( ( t.low_replication ) ? ', low replication' : '' ), t.r, ( t.ceiling ) ? fmt.pct( t.ceiling_ratio, 1 ) + ' of (8/7)^L' + ( ( t.confounded ) ? ' — **confounded**' : '' ) : '', ctx.src( [ { 'cell': t.num }, { 'cell': t.den } ] ) ] );
		});
	});
	return fmt.table( [ 'n', 'L', '(8/7)^L', 'term (ratio of cell medians = time num / time den)', 'estimate', '95% CI', 'method', 'r', 'confounded check: time(C2)/time(A2) vs (8/7)^L', 'src' ], rows, 'rrrlrrlrll' ) + ( ( derived.ladder.length ) ? '\nConfounded rule: ' + ( derived.ladder[ 0 ].rule || 'confounded iff cell(C2)/cell(A2) ≥ (8/7)^L' ) + '.\n' : '' );
}

/**
* Rows of E4/E5 (cells other than A0 with their speedups).
*
* @private
*/
function speedRows( rows, ctx, extra ) {
	return rows.map( function each( r ) {
		return extra( r ).concat( [ fmt.time( r.ref_median_ns ), fmt.time( r.median_ns ), fmt.fixed( r.gflops, 3 ), speedupOf( r ), verdictOf( r ), ctx.src( r.src ) ] );
	});
}

/**
* Depth sweep table (E4).
*
* @param {Object} derived - derived results
* @param {Object} [ctx] - context
* @returns {string} Markdown
*/
function depthTable( derived, ctx ) {
	ctx = context( ctx );
	return fmt.table( [ 'shape', 'alg', 'cutoff', 'levels', 'L', 'A0 median', 'median', 'GFLOP/s', 'S [95% CI]', 'verdict', 'src' ], speedRows( derived.depth, ctx, function f( r ) {
		return [ fmt.shape( r.desc.M, r.desc.N, r.desc.K ), r.desc.alg, r.desc.cutoff, r.desc.levels, r.L ];
	}), 'llrrrrrrlll' );
}

/**
* Shapes/layouts/α-β table (E5).
*
* @param {Object} derived - derived results
* @param {Object} [ctx] - context
* @returns {string} Markdown
*/
function e5Table( derived, ctx ) {
	ctx = context( ctx );
	return fmt.table( [ 'kind', 'shape', 'alg', 'layout', 'LD', 'α', 'β', 'A0 median', 'median', 'GFLOP/s', 'S [95% CI]', 'verdict', 'src' ], speedRows( derived.e5, ctx, function f( r ) {
		return [ r.kind, fmt.shape( r.desc.M, r.desc.N, r.desc.K ), r.desc.alg, fmt.layout( r.desc ), fmt.ld( r.desc ), r.desc.alpha, r.desc.beta ];
	}), 'llllllrrrrlll' );
}

/**
* Baseline characterization table (E0, unreplicated).
*
* @param {Object} derived - derived results
* @param {Object} [ctx] - context
* @returns {string} Markdown
*/
function e0Table( derived, ctx ) {
	ctx = context( ctx );
	return fmt.table( [ 'shape', 'layout', 'LD pad', 'lda', 'r', 'median', 'GFLOP/s', 'time / (RM NN, LD n)', 'src' ], derived.e0.map( function each( r ) {
		return [ fmt.shape( r.desc.M, r.desc.N, r.desc.K ), fmt.layout( r.desc ), r.desc.ld_pad, ( r.lda === null ) ? '—' : r.lda, r.r, fmt.time( r.median_ns ), fmt.fixed( r.gflops, 3 ), fmt.fixed( r.rel_to_rm_nn, 3 ), ctx.src( r.src ) ];
	}), 'llrrrrrrl' );
}

/**
* Pilot table and τ* re-derivation (§5.1; never quoted as speedups).
*
* @param {Object} derived - derived results
* @param {Object} [ctx] - context
* @returns {string} Markdown
*/
function pilotTable( derived, ctx ) {
	var p = derived.pilot;
	ctx = context( ctx );
	return fmt.table( [ 'alg', 'shape', 'cutoff', 'levels', 'r', 'median', 'src' ], p.rows.map( function each( r ) {
		return [ r.desc.alg, fmt.shape( r.desc.M, r.desc.N, r.desc.K ), ( r.desc.cutoff === null ) ? '—' : r.desc.cutoff, ( r.desc.levels === null ) ? '—' : r.desc.levels, r.r, fmt.time( r.median_ns ), ctx.src( r.src ) ];
	}), 'llrrrrl' ) + '\n' + pilotLib.sentence( p ) + ( ( p.src && p.src.length ) ? ' Sources: ' + ctx.src( p.src ) + '.' : '' ) + '\n';
}

/**
* Memory table (E7, §9 as amended by §12 2026-10-30b item 2): ΔarrayBuffers read on return over all non-excluded
* replicates of the single-allocation arms, with the GC events during the call and the excluded records listed.
*
* @param {Object} derived - derived results
* @param {Object} [ctx] - context
* @returns {string} Markdown
*/
function memoryTable( derived, ctx ) {
	ctx = context( ctx );
	return fmt.table( [ 'alg', 'n', 'β', 'reps', 'excluded', 'analytic bytes', '× 8MN', 'analytic = 8·E1(+8MN)', 'ΔarrayBuffers (median, read on return)', '× 8MN', 'Δ = analytic (k/r)', 'GCs during call (min–max)', 'ΔmaxRSS (median)', '× 8MN', 'after gc()', 'src' ], derived.memory.map( function each( m ) {
		var gc = m.gc_events || {};
		var eq = ( m.d_ab_equals_analytic === null || m.d_ab_equals_analytic === void 0 ) ? '—' : ( ( m.d_ab_equals_analytic ) ? 'yes' : '**no**' ) + ' (' + m.d_ab_eq_count + '/' + m.d_ab_n + ')';
		return [ m.alg, m.n, m.beta, m.reps, m.excluded || 0, fmt.bytes( m.analytic_bytes ), fmt.fixed( m.analytic_x8mn, 4 ), ( m.analytic_check === null ) ? '—' : ( ( m.analytic_check ) ? 'yes' : '**no**' ), fmt.bytes( m.d_ab_median ), fmt.fixed( m.d_ab_x8mn, 4 ), eq, ( gc.min === null || gc.min === void 0 ) ? '—' : gc.min + '–' + gc.max, fmt.bytes( m.d_rss_median ), fmt.fixed( m.d_rss_x8mn, 3 ), fmt.bytes( m.resid_after_gc_median ), ctx.src( [ m.src ] ) ];
	}), 'lrrrrrrlrrlrrrrl' );
}

/**
* Campaign runs (one `campaign` record per run; a resume appends one) and blocks whose processes span runs.
*
* @param {Object} derived - derived results
* @param {Object} [ctx] - context
* @returns {string} Markdown
*/
function runsTable( derived, ctx ) {
	var s = derived.summary;
	var out;
	ctx = context( ctx );
	out = fmt.table( [ 'run', 'started', 'commit', 'dirty', 'resumed', 'preceded by', 'own end', 'src' ], ( s.runs || [] ).map( function each( r ) {
		var p = r.preceded_by;
		return [ r.run, r.t_wall, '`' + r.commit + '`', r.dirty, r.resumed, ( p ) ? p.status + ( ( p.reason ) ? ': ' + p.reason : '' ) : '—', ( r.end ) ? r.end.status + ( ( r.end.reason ) ? ': ' + r.end.reason : '' ) : 'none recorded', ctx.src( [ r.src ].concat( ( p && p.src ) ? [ p.src ] : [] ) ) ];
	}), 'rlllllll' );
	out += '\n' + ( ( s.provenance_changed ) ? '**Provenance differs between runs:** ' + s.provenance_changes.join( '; ' ) + '.' : 'Commit, dirty flag, protocol hash, machine, OS, Node and V8 identical across runs.' ) + '\n';
	if ( ( s.blocks_across_runs || [] ).length ) {
		out += '\nBlocks whose processes were recorded by different runs (their within-block pairing spans the interruption):\n\n' + fmt.table( [ 'block', 'runs', 'src' ], s.blocks_across_runs.map( function each( b ) {
			return [ b.block_id, b.runs.join( ', ' ), ctx.src( [ b.src ] ) ];
		}), 'lll' );
	} else if ( ( s.runs || [] ).length > 1 ) {
		out += '\nNo block has processes from more than one run.\n';
	}
	return out;
}

/**
* Returns the provenance phrase of the derived outputs (all runs' commits and dirty flags).
*
* @param {Object} s - summary
* @returns {string} Markdown
*/
function provenance( s ) {
	var runs = s.runs || [];
	if ( runs.length <= 1 ) {
		return 'commit `' + s.commit + '` (dirty: ' + s.dirty + ')';
	}
	return runs.length + ' runs (resumed): ' + runs.map( function f( r ) {
		return 'run ' + r.run + ' commit `' + r.commit + '` (dirty: ' + r.dirty + ')';
	}).join( '; ' ) + ( ( s.provenance_changed ) ? ' — **provenance differs between runs**' : '' );
}

/**
* Speed–accuracy pairing (§11 rule 4): each speed claim at (n, L) next to the accuracy cost at the same (n, L).
*
* @param {Object} derived - derived results
* @param {Object} [ctx] - context
* @returns {string} Markdown
*/
function pairingTable( derived, ctx ) {
	ctx = context( ctx );
	return fmt.table( [ 'exp', 'alg', 'cutoff/levels', 'n', 'L', 'S [95% CI]', 'verdict', 'R_N F1', 'R_N F2', 'R_N F3', 'no correct digit F4 (worst s)', 'no correct digit F5', 'src' ], derived.pairing.map( function each( r ) {
		var a = r.acc;
		return [ r.experiment, r.alg, r.cutoff + '/' + r.levels, r.n, r.L, fmt.fixed( r.S, 3 ) + ' ' + fmt.ci( r.lo, r.hi, 3 ) + ( ( r.pairing === 'unpaired' ) ? ' (unpaired)' : '' ), r.verdict || '—', rn( a.F1 ), rn( a.F2 ), rn( a.F3 ), dig( a.F4 ), dig( a.F5 ), ctx.src( r.src ) ];
	}), 'lllrrllrrrrrl' );

	function rn( x ) {
		return ( x ) ? fmt.sig( x.R_N ) : 'n/a';
	}

	function dig( x ) {
		return ( x ) ? fmt.pct( x.frac_ge1, 3 ) + ( ( x.params ) ? ' ' + JSON.stringify( x.params ) : '' ) : 'n/a';
	}
}

/**
* Sentinel and environment series (or its summary).
*
* @param {Object} derived - derived results
* @param {Object} [ctx] - context
* @param {boolean} [full=false] - list every sentinel
* @returns {string} Markdown
*/
function sentinelTable( derived, ctx, full ) {
	var s = derived.sentinel;
	var sum = s.summary;
	var out;
	ctx = context( ctx );
	out = fmt.table( [ 'sentinels', 'baseline (median of first 5)', 'median', 'min', 'max', 'max |drift|', '|drift| > 3%', 'thermal states', 'power', 'max pressure', 'src' ], [ [ sum.n, fmt.time( sum.baseline_ns ), fmt.time( sum.median_ns.median ), fmt.time( sum.median_ns.min ), fmt.time( sum.median_ns.max ), fmt.pct( sum.max_abs_drift, 2 ), sum.n_drift_gt_3pct, fmt.counts( sum.thermal_states ), fmt.counts( sum.power ), sum.max_pressure_level, ctx.src( [ sum.src ] ) ] ], 'rrrrrrrlllr' );
	if ( full ) {
		out += '\n' + fmt.table( [ '#', 't_wall', 'block', 'stage', 'median', 'drift', 'thermal', 'power', 'pressure', 'line' ], s.series.map( function each( e ) {
			return [ e.i, e.t_wall, e.block_id, e.stage, fmt.time( e.median_ns ), fmt.pct( e.drift, 2 ), e.thermal_state, e.power, e.pressure_level, e.line ];
		}), 'rlllrrrrrr' );
	}
	return out;
}

/**
* Position-in-block effect table.
*
* @param {Object} derived - derived results
* @returns {string} Markdown
*/
function positionTable( derived, ctx ) {
	ctx = context( ctx );
	return fmt.table( [ 'experiment', 'processes', 'blocks', 'mean effect by position (%)', 'slope (% per position)', 'p (within-block permutation)', 'B, seed', 'src' ], derived.position.map( function each( p ) {
		var cells = derived.cells.filter( function f( c ) {
			return c.inference && c.r >= 2 && ( p.experiment === 'all' || c.desc.group === p.experiment );
		}).map( function f( c ) {
			return { 'cell': c.id };
		});
		return [ p.experiment, p.n_procs, p.n_blocks, p.positions.map( function f( q ) {
			return q.pos + ': ' + fmt.fixed( q.mean_pct, 2 );
		}).join( '; ' ), fmt.fixed( p.slope_pct, 3 ), fmt.fixed( p.p, 4 ), p.B + ', ' + p.seed, ctx.src( cells ) ];
	}), 'lrrlrrll' );
}

/**
* Excluded processes (kept with `excluded: true`).
*
* @param {Object} derived - derived results
* @param {Object} [ctx] - context
* @returns {string} Markdown
*/
function exclusionsTable( derived, ctx ) {
	ctx = context( ctx );
	return fmt.table( [ 'proc', 'cell', 'exp', 'alg', 'shape', 'block', 'reason', 'src' ], derived.exclusions.map( function each( e ) {
		return [ e.proc_id, e.cell, e.desc.experiment, e.desc.alg, fmt.shape( e.desc.M, e.desc.N, e.desc.K ), e.block_id, e.reason, ctx.src( [ e.src ] ) ];
	}), 'llllllll' );
}

/**
* Renders every table into one Markdown document (`derived/tables.md`).
*
* @param {Object} derived - derived results
* @returns {string} Markdown
*/
function renderAll( derived ) {
	var s = derived.summary;
	var out = '# Derived tables — campaign `' + s.campaign + '`\n\n';
	out += 'Generated ' + s.generated_at + ' by `research/analysis/summarize.js` from ' + provenance( s ) + '. Bootstrap B = ' + s.B + ', analysis seed ' + s.analysis_seed + '. Sources: cell ids (`cells.json` lists their proc ids) or `file#Lline`.\n';
	out += '\n## Campaign runs\n\n' + runsTable( derived );
	out += '\n## E2 speedups\n';
	Object.keys( derived.crossover.families ).forEach( function each( f ) {
		out += '\n### Family ' + f + '\n\n' + e2Table( derived, f );
	});
	out += '\n## Crossovers (§7)\n\n' + crossoverTable( derived ) + '\nFixed-sequence n*: ' + ( ( derived.crossover.results[ 0 ] ) ? derived.crossover.results[ 0 ].fixed_sequence.definition : '—' ) + '. Specific to: ' + derived.crossover.specific_to + '.\n';
	out += '\n## Attribution ladder (E3)\n\n' + ladderTable( derived );
	out += '\n## Shapes, layouts, α/β (E5)\n\n' + e5Table( derived );
	out += '\n## Depth sweep (E4)\n\n' + depthTable( derived );
	out += '\n## Baseline characterization (E0)\n\n' + e0Table( derived );
	out += '\n## Speed–accuracy pairing\n\n' + pairingTable( derived );
	out += '\n## Memory (E7)\n\n' + memoryTable( derived );
	out += '\n## Accuracy (E6)\n\n' + acc.accuracyChecks( derived ) + acc.accuracyTables( derived );
	out += '\n### κ-binned relative error (F9)\n' + ( acc.kappaTables( derived ) || '\n_No κ-binned records (F9 not run)._\n' );
	out += '\n## Sentinel and environment\n\n' + sentinelTable( derived, null, true );
	out += '\n## Position-in-block effect\n\n' + positionTable( derived );
	out += '\n## Excluded processes\n\n' + exclusionsTable( derived );
	out += '\n## Pilot (excluded from inference)\n\n' + pilotTable( derived );
	out += '\n## All cells\n\n' + cellTable( derived.cells );
	return out;
}


// EXPORTS //

module.exports = {
	'defaultSrc': fmt.defaultSrc,
	'speedup': speedup,
	'verdict': verdict,
	'cellTable': cellTable,
	'e2Table': e2Table,
	'crossoverTable': crossoverTable,
	'ladderTable': ladderTable,
	'depthTable': depthTable,
	'e5Table': e5Table,
	'e0Table': e0Table,
	'pilotTable': pilotTable,
	'memoryTable': memoryTable,
	'runsTable': runsTable,
	'provenance': provenance,
	'accuracyChecks': acc.accuracyChecks,
	'accuracyTables': acc.accuracyTables,
	'kappaTables': acc.kappaTables,
	'pairingTable': pairingTable,
	'sentinelTable': sentinelTable,
	'positionTable': positionTable,
	'exclusionsTable': exclusionsTable,
	'renderAll': renderAll
};
