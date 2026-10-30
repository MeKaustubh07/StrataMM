#!/usr/bin/env node
'use strict';

/**
* Generates the `research/REPORT.md` draft from the derived analysis (protocol §11): every number links to an entry of
* the source-record appendix (file + record ids or line numbers, and the campaign commit); interpretation is left in
* clearly marked `TODO(interpretation)` slots; the §11 limitations are quoted verbatim from the protocol.
*
* Usage:
*   node research/analysis/report.js <campaign_id> [--out research/REPORT.md]
*   node research/analysis/report.js --dir <campaign directory> [--derived <dir>] [--figures <dir>] [--out <file>]
*/

var path = require( 'path' );
var fs = require( 'fs' );
var io = require( './lib/io.js' );
var fmt = require( './lib/format.js' );
var xo = require( './crossover.js' );
var tables = require( './lib/tables.js' );
var pilotLib = require( './lib/pilot.js' );
var summarize = require( './summarize.js' );
var plots = require( './plots.js' );

var LIMITATIONS = 'Limitations: single fanless laptop; no core pinning or frequency locking on macOS; ±2% band near the noise floor; XL low replication; RSS resolution; Node 22.14 / V8 12.4 without Maglev only.';
var TODO = '> **TODO(interpretation):** ';
var FIGURES = [ 'speedup', 'gflops', 'ladder', 'depth', 'memory', 'sentinel' ];
var MEMORY_NOTE = 'ΔarrayBuffers is read immediately on return and is valid for these single-allocation arms (§12, amendment 2026-10-30b item 2); GC events during the call are listed; ΔmaxRSS only in a fresh process (§9).';
var CONFOUNDED_NOTE = 'Confounded rule as pre-registered (§6: "if A2/C2 ≥ (8/7)^L the cell is flagged confounded"), where A2/C2 is the speedup of A2 over C2: flagged iff time(C2)/time(A2) ≥ (8/7)^L, i.e. SW beats the 8-product recursion by at least the most its 7-vs-8 arithmetic saving can explain (non-arithmetic leaf effects).';
var HYPOTHESES = [
	[ 'H1', 'A2 beats A0 above a crossover n*; break-even (A1) at n ≤ 256', '§2, §3' ],
	[ 'H2', 'C2 ≈ 1.00 at LD n+8; SW avoids the ≈7% power-of-two LD penalty', '§5' ],
	[ 'H3', 'Packing B (C1) gives ≈2× over A0 at n ≤ 1024, more than A2', '§5' ],
	[ 'H4a–d', 'Accuracy: growth g, outside/inside scaling, diagonal scaling', '§10' ],
	[ 'H5', 'Peak extra memory = 8·E1 (β = 0), 8·(MN + E1) (β ≠ 0)', '§9' ],
	[ 'H6', 'Peeling sawtooth on O-family sizes', '§3 (family O)' ],
	[ 'H7', 'F1: SW more accurate than A0 iff k₀ ≥ 64 and n ≥ 256', '§10' ]
];


/**
* Extracts the §11 limitations sentence verbatim from the protocol (falls back to the rev. 2 text).
*
* @param {string} file - protocol path
* @returns {Object} `{ text, source }`
*/
function limitations( file ) {
	var m;
	if ( fs.existsSync( file ) ) {
		m = fs.readFileSync( file, 'utf8' ).match( /7\.\s+(Limitations:[\s\S]*?only\.)/ );
		if ( m ) {
			return { 'text': m[ 1 ].replace( /\s*\n\s*/g, ' ' ), 'source': 'docs/research-protocol.md §11' };
		}
	}
	return { 'text': LIMITATIONS, 'source': 'rev. 2 text (protocol file not found)' };
}

/**
* Creates the source registry: each distinct list of source records gets a key `sN` rendered as a link to the appendix.
*
* @param {Object} d - derived results
* @returns {Object} `{ src(list), entries }`
*/
function registry( d ) {
	var cells = new Map();
	var keys = new Map();
	var entries = [];
	d.cells.forEach( function each( c ) {
		cells.set( c.id, c.src );
	});
	return {
		'entries': entries,
		'src': function src( list ) {
			var items = [];
			var key;
			( list || [] ).filter( Boolean ).forEach( function f( s ) {
				var r = ( s.cell && !s.ids && cells.has( s.cell ) ) ? cells.get( s.cell ) : s;
				items.push( { 'cell': r.cell || null, 'file': r.file, 'ids': r.ids || null, 'lines': r.lines || null, 'excluded_ids': r.excluded_ids || null, 'excluded_lines': r.excluded_lines || null } );
			});
			if ( !items.length ) {
				return '—';
			}
			key = JSON.stringify( items );
			if ( !keys.has( key ) ) {
				keys.set( key, 's' + ( entries.length + 1 ) );
				entries.push( { 'key': keys.get( key ), 'items': items } );
			}
			return '[' + keys.get( key ) + '](#' + keys.get( key ) + ')';
		}
	};
}

/**
* Renders the source-record appendix.
*
* @private
*/
function appendix( reg, d ) {
	var commits = ( d.summary.commits && d.summary.commits.length ) ? d.summary.commits : [ d.summary.commit ];
	var sha = commits.map( function f( c ) {
		return String( c || 'unknown' ).slice( 0, 12 );
	}).join( '+' );
	var out = '\n## Appendix A — source records\n\nAll records are in `research/data/' + d.summary.campaign + '/`, recorded at ' + tables.provenance( d.summary ) + '. Timing cells cite `proc_id`s (their `sample` records share the id); accuracy, memory and environment numbers cite line numbers of the append-only files.\n\n';
	reg.entries.forEach( function each( e ) {
		out += '- <a id="' + e.key + '"></a>**' + e.key + '** @`' + sha + '`: ' + e.items.map( function f( it ) {
			var s = '`' + it.file + '`';
			if ( it.cell ) {
				s += ' cell ' + it.cell;
			}
			if ( it.ids && it.ids.length ) {
				s += ' ids ' + it.ids.join( ', ' );
			}
			if ( it.lines && it.lines.length ) {
				s += ' lines ' + it.lines.join( ', ' );
			}
			if ( it.excluded_ids && it.excluded_ids.length ) {
				s += ' (excluded, kept: ' + it.excluded_ids.join( ', ' ) + ')';
			}
			if ( it.excluded_lines && it.excluded_lines.length ) {
				s += ' (excluded, kept: lines ' + it.excluded_lines.join( ', ' ) + ')';
			}
			return s;
		}).join( '; ' ) + '\n';
	});
	return out;
}

/**
* Pivot table of one accuracy metric: rows = arm × L, columns = n.
*
* @private
*/
function pivot( groups, metric, label, reg ) {
	var ns = [];
	var rows = new Map();
	groups.forEach( function each( g ) {
		var k = g.alg + '|' + g.L;
		if ( ns.indexOf( g.M ) < 0 ) {
			ns.push( g.M );
		}
		if ( !rows.has( k ) ) {
			rows.set( k, { 'alg': g.alg, 'L': g.L, 'by': {}, 'src': [] } );
		}
		rows.get( k ).by[ g.M ] = metric( g );
		rows.get( k ).src.push( g.src );
	});
	ns.sort( function c( a, b ) {
		return a - b;
	});
	return fmt.table( [ 'arm', 'L' ].concat( ns.map( function f( n ) {
		return label + ' n=' + n;
	}) ).concat( [ 'src' ] ), Array.from( rows.values() ).map( function each( r ) {
		return [ r.alg, r.L ].concat( ns.map( function f( n ) {
			return ( r.by[ n ] === void 0 ) ? '—' : r.by[ n ];
		}) ).concat( [ reg.src( r.src ) ] );
	}), 'lr' + ns.map( function f() {
		return 'r';
	}).join( '' ) + 'l' );
}

/**
* Renders the accuracy section (gates, warnings, growth, condensed per-family pivots).
*
* @private
*/
function accuracySection( d, reg ) {
	var fams = new Map();
	var out = tables.accuracyChecks( d, reg ) + '\n';
	d.accuracy.groups.forEach( function each( g ) {
		var k = g.family + ( ( g.pkey ) ? ' (' + g.pkey + ')' : '' );
		if ( !fams.has( k ) ) {
			fams.set( k, [] );
		}
		fams.get( k ).push( g );
	});
	fams.forEach( function each( list, k ) {
		out += '\n### ' + k + '\n\nη_N = max E/(u‖A‖_M‖B‖_M), median over seeds [ρ_N = η_N/f_W, max over seeds]:\n\n';
		out += pivot( list, function f( g ) {
			return fmt.sig( g.metrics.eta_N.median ) + ( ( g.alg !== 'A0' ) ? ' [' + fmt.sig( g.metrics.rho_N.max, 2 ) + ']' : '' );
		}, 'η_N', reg );
		if ( /^F(4|5)/.test( k ) ) {
			out += '\nPer-entry "no correct digit" fraction (E_ij ≥ |C_ij|), median over seeds; η_C max and η_R medians:\n\n';
			out += pivot( list, function f( g ) {
				return fmt.pct( g.metrics.frac_ge1.median, 3 ) + '; η_C ' + fmt.sig( g.metrics.eta_C_max.median ) + '; η_R ' + fmt.sig( g.metrics.eta_R.median );
			}, 'no digit; η_C; η_R', reg );
		}
		if ( list.some( function f( g ) {
			return g.kappa;
		}) ) {
			out += '\nκ-binned relative error E_ij/|C_ij| (§8, F9): per decade of κ = (|A||B|)_ij/|C_ij|, median over seeds of the per-seed bin median [max over seeds of the bin max]:\n' + tables.kappaTables( d, reg, { 'family': k } );
		}
	});
	if ( !d.accuracy.n_records ) {
		return out;
	}
	return out + '\nFull per-family tables (η_C p99.9, η_R, R_N, per-entry fractions E ≥ |C| and E ≥ 1e−8·|C|, max and p99.9 of E/|C|, gate and warning counts) and the κ tables: `derived/tables.md`.\n';
}

/**
* Builds the report Markdown.
*
* @param {Object} d - derived results
* @param {Object} opts - `{ figuresRel, protocolFile }`
* @returns {string} Markdown
*/
function build( d, opts ) {
	var reg = registry( d );
	var s = d.summary;
	var lim = limitations( opts.protocolFile );
	var env = s.env_summary || {};
	var excl = d.exclusions.length;
	var out = '';
	var res;

	out += '# StrataMM — research report (DRAFT)\n\n';
	out += '> **Draft generated by `research/analysis/report.js`** on ' + new Date().toISOString() + ' from campaign `' + s.campaign + '` (`research/data/' + s.campaign + '/`), ' + tables.provenance( s ) + '. Every number links to its source records ([Appendix A](#appendix-a--source-records)). Interpretation is left in `TODO(interpretation)` slots; do not publish until every slot is filled and reviewed.\n\n';
	out += '## 0. Status and provenance\n\n';
	out += '- Campaign status: **' + s.status.status + '**' + ( ( s.status.reason ) ? ' (' + s.status.reason + ')' : '' ) + ( ( s.status.warnings && s.status.warnings.length ) ? '; orchestrator warnings: ' + s.status.warnings.join( '; ' ) : '' ) + ( ( s.status.src ) ? ' ' + reg.src( [ s.status.src ] ) : '' ) + '.\n';
	out += '- Runs: ' + ( s.runs || [] ).length + ( ( ( s.runs || [] ).length > 1 ) ? ' (stopped and resumed; the numbers below pool all runs — see "Runs" below); ' + ( ( s.provenance_changed ) ? '**provenance differs between runs: ' + s.provenance_changes.join( '; ' ) + '**' : 'commit, dirty flag, protocol hash, machine, OS, Node and V8 identical across runs' ) : '; ' + tables.provenance( s ) ) + ( ( s.blocks_across_runs && s.blocks_across_runs.length ) ? '; **' + s.blocks_across_runs.length + ' block(s) span two runs**' : '' ) + '.\n';
	out += '- Machine ' + ( env.machine || '(unrecorded)' ) + ', ' + ( env.os || 'OS unrecorded' ) + ', Node ' + ( env.node || '(unrecorded)' ) + ( ( env.v8 ) ? ', V8 ' + env.v8 : '' ) + ' ' + reg.src( [ s.campaign_src ] ) + '.\n';
	out += '- Frozen design: sha256 recorded by the campaign `' + s.protocol_sha256 + '`; current `' + ( s.protocol_file || 'research/protocol.json' ) + '` `' + s.protocol_file_sha256 + '` (' + ( ( s.protocol_match === null ) ? 'not comparable' : ( ( s.protocol_match ) ? 'match' : '**differs — check amendments (§12)**' ) ) + '); `docs/research-protocol.md` sha256 `' + s.protocol_doc_sha256 + '`.\n';
	out += '- Frozen: ' + ( ( s.frozen.tau_star === null ) ? '**no frozen τ* recorded**' : 'τ* = ' + s.frozen.tau_star ) + ', L_max = ' + s.frozen.levels + ' (`frozen.json`' + ( ( s.frozen.fallback === true ) ? '; **τ* chosen by the fallback rule** of §12 amendment 2026-10-30b item 3, flagged in frozen.json' : '' ) + '). ' + pilotLib.sentence( d.pilot ) + ( ( d.pilot.src && d.pilot.src.length ) ? ' ' + reg.src( d.pilot.src ) : '' ) + '\n';
	out += '- Processes: ' + s.counts.procs + ' (' + s.counts.excluded + ' excluded and kept, §4), ' + s.counts.samples + ' samples, ' + s.counts.env_checks + ' environment checks, ' + s.counts.mem + ' memory records (' + ( s.counts.mem_excluded || 0 ) + ' excluded), ' + s.counts.accuracy + ' accuracy records, ' + ( s.counts.accuracy_warning || 0 ) + ' accuracy_warning records; ' + s.counts.parse_errors + ' unparsable lines; ' + s.anomalies.length + ' anomalies (`derived/summary.json`).\n';
	s.e1.forEach( function each( e ) {
		var shp = ( e.shapes_max && typeof e.shapes_max === 'object' ) ? e.shapes_max.M + '×' + e.shapes_max.N + '×' + e.shapes_max.K : e.shapes_max;
		out += '- E1 exact differential trials: ' + e.trials + ', mismatches **' + e.mismatches + '**, recursive fraction ' + fmt.fixed( e.recursive_fraction, 3 ) + ', shapes up to ' + shp + ( ( e.max_depth !== null && e.max_depth !== void 0 ) ? ', max depth ' + e.max_depth : '' ) + ( ( e.input_mutations !== null && e.input_mutations !== void 0 ) ? ', input mutations ' + e.input_mutations : '' ) + ' ' + reg.src( [ e.src ] ) + '.\n';
	});
	out += '- Statistics: block bootstrap B = ' + s.B + ' (percentile, type-7 quantiles), analysis seed ' + s.analysis_seed + ' (per-cell seeds in `derived/cells.json`); t-interval on log ratios when r ≤ ' + s.low_rep_max + ' ("low replication").\n';
	out += '\n### Runs\n\n' + tables.runsTable( d, reg ) + '\n';

	out += '## 1. Summary\n\n' + TODO + 'headline result (crossover n* with interval, speedup at the largest n with CI and baseline time), the layout result (H3) even if it overshadows Strassen, and the accuracy cost at the same (n, L). Every speed claim must name layout, LD, cutoff, levels, n, machine and Node (§11 rule 3).\n\n';

	out += '## 2. Crossover (E2, primary endpoint, §7)\n\n';
	res = d.crossover.results.slice().sort( function c( a, b ) {
		return ( b.primary - a.primary ) || ( b.pre_registered - a.pre_registered );
	});
	out += tables.crossoverTable( { 'crossover': { 'results': res }, 'cells': d.cells }, reg );
	out += '\nRoles: *primary* = family P with the pre-registered pairing (θ = 1 on A1, θ = 1.02 on A2); *pre-registered* = the same pairing on families O and R; *secondary* = the other pairings (not pre-registered). Fixed-sequence n*: ' + xo.N_STAR_DEFINITION + '. A size that was not measured stops the test without counting as a failure (a missing n_max: no test; a missing smaller size: n* is an upper bound). Specific to: ' + d.crossover.specific_to + '.\n\n' + TODO + 'n*₁ (A1) and n*₁.₀₂ (A2) for family P; agreement of the O and R families; censoring.\n\n';

	out += '## 3. Speedups by family (E2)\n\nS = cell(A0)/cell(alg) paired within E2 blocks (never against another experiment\'s A0; a cell without a paired A0 is shown as missing); absolute A0 times reported (Hoefler rule 1); losses and inconclusive cells shown.\n';
	Object.keys( d.crossover.families ).forEach( function each( f ) {
		out += '\n### Family ' + f + '\n\n' + tables.e2Table( d, f, reg );
	});
	out += '\n' + TODO + 'speedup shape vs n, the O-family sawtooth (H6), low-replication XL cells.\n\n';

	out += '## 4. Speed and accuracy at the same (n, L) (§11 rule 4)\n\n' + tables.pairingTable( d, reg ) + '\nR_N = η_N(SW, L)/η_N(A0) on the same inputs (median over seeds; worst parameter setting of the family). "n/a": no E6 run at that n.\n\n' + TODO + 'which speedups are worth their accuracy cost; scaled-family per-entry losses.\n\n';

	out += '## 5. Attribution ladder (E3)\n\n' + ( ( d.ladder.length ) ? tables.ladderTable( d, reg ) + '\nC2 and ladder terms are estimates with CIs, not verdicts (§6). ' + CONFOUNDED_NOTE + '\n\n' : 'E3 not run (no E3 cell with A2).\n\n' ) + TODO + 'layout vs LD/locality vs arithmetic (H2, H3).\n\n';
	out += '## 6. Shapes, layouts and α/β (E5)\n\n' + tables.e5Table( d, reg ) + '\n' + TODO + 'transposes, column-major, β ≠ 0 and rectangular panels.\n\n';
	out += '## 7. Depth sweep (E4, exploratory)\n\n' + tables.depthTable( d, reg ) + '\n' + TODO + 'speed vs leaf size; compare with τ*.\n\n';
	out += '## 8. Baseline characterization (E0, unreplicated)\n\n' + tables.e0Table( d, reg ) + '\n' + TODO + 'the dgemm code-path effect by layout and LD.\n\n';
	out += '## 9. Memory (E7)\n\n' + ( ( d.memory.length ) ? tables.memoryTable( d, reg ) + '\n' + MEMORY_NOTE + '\n\n' : 'E7 not run (no `mem` records).\n\n' ) + TODO + 'H5 (exact 8·E1 / 8·(MN + E1)).\n\n';
	out += '## 10. Accuracy (E6)\n\n' + accuracySection( d, reg ) + '\n' + TODO + 'H4a–d and H7 against the tables; ρ_N is reported, never range-checked.\n\n';

	out += '## 11. Run quality\n\n### Sentinel and environment\n\n' + tables.sentinelTable( d, reg, false );
	out += '\n### Position-in-block effect\n\n' + tables.positionTable( d, reg ) + '\nWithin-block permutation test on log(process median / cell median), centred per block.\n';
	out += '\n### Excluded processes (' + excl + ')\n\n' + tables.exclusionsTable( d, reg ) + '\n' + TODO + 'drift, thermal events, exclusions and any position effect.\n\n';

	out += '## 12. Figures\n\n' + figuresSection( opts ) + '\n\nTable view of every figure: `research/data/' + s.campaign + '/derived/tables.md`.\n\n';

	out += '## 13. Hypotheses\n\n' + fmt.table( [ 'id', 'statement (protocol §1)', 'evidence', 'verdict' ], HYPOTHESES.map( function f( h ) {
		return [ h[ 0 ], h[ 1 ], h[ 2 ], 'TODO(interpretation)' ];
	}), 'llll' ) + '\n';
	out += '## 14. Limitations\n\nQuoted verbatim from ' + lim.source + ':\n\n> ' + lim.text + '\n\n' + TODO + 'discuss each limitation; every crossover is specific to cutoff × layout × LD × machine × Node version (§7).\n';
	out += appendix( reg, d );
	return out;
}

/**
* Lists the figures to embed: those `plots.js` generated in its last run (its manifest), else the SVG files present;
* a figure that was not generated (no data) is never linked.
*
* @private
* @param {string} dir - figures directory
* @returns {(Object|null)} `{ present: Array<string>, missing: Array<string> }` (basenames), or null without a directory
*/
function figureList( dir ) {
	var manifest = path.join( dir || '', plots.MANIFEST );
	var present;
	var missing;
	var m;
	if ( !dir || !fs.existsSync( dir ) ) {
		return null;
	}
	if ( fs.existsSync( manifest ) ) {
		m = io.readJson( manifest );
		present = ( m.figures || [] ).filter( exists );
		missing = ( m.not_generated || [] ).concat( ( m.figures || [] ).filter( function f( n ) {
			return !exists( n );
		}) );
	} else {
		present = FIGURES.map( svg ).filter( exists ).concat( fs.readdirSync( dir ).filter( function f( n ) {
			return /^(accuracy|pareto)_.*\.svg$/.test( n );
		}).sort() );
		missing = FIGURES.map( svg ).filter( function f( n ) {
			return !exists( n );
		});
	}
	return { 'present': present.map( base ), 'missing': missing.map( base ) };

	function svg( n ) {
		return n + '.svg';
	}

	function base( n ) {
		return n.replace( /\.svg$/, '' );
	}

	function exists( n ) {
		return fs.existsSync( path.join( dir, n ) );
	}
}

/**
* Renders the figures section (only figures that exist).
*
* @private
*/
function figuresSection( opts ) {
	var list = figureList( opts.figuresDir );
	if ( list === null ) {
		return 'No figures directory (`plots.js` has not been run for this campaign).';
	}
	return ( ( list.present.length ) ? list.present.map( function f( name ) {
		return '### ' + name + '\n\n![' + name + '](' + path.posix.join( opts.figuresRel, name + '.svg' ) + ')';
	}).join( '\n\n' ) : 'No figure was generated.' ) + ( ( list.missing.length ) ? '\n\nNot generated (no data for them): ' + list.missing.join( ', ' ) + '.' : '' );
}

/**
* Command-line entry point.
*
* @param {Array<string>} argv - arguments
* @returns {string} output path
*/
function main( argv ) {
	var opts = io.parseArgs( argv );
	var dir = io.campaignDir( opts );
	var derived = ( opts.derived ) ? path.resolve( opts.derived ) : path.join( dir, 'derived' );
	var figures = ( opts.figures ) ? path.resolve( opts.figures ) : path.join( dir, 'figures' );
	var out = ( opts.out ) ? path.resolve( opts.out ) : path.join( io.REPO_ROOT, 'research', 'REPORT.md' );
	var md = build( summarize.loadDerived( derived ), {
		'figuresDir': figures,
		'figuresRel': path.relative( path.dirname( out ), figures ).split( path.sep ).join( '/' ),
		'protocolFile': path.join( io.REPO_ROOT, 'docs', 'research-protocol.md' )
	});
	io.writeText( out, md );
	return out;
}


// EXPORTS //

module.exports = {
	'LIMITATIONS': LIMITATIONS,
	'limitations': limitations,
	'registry': registry,
	'build': build,
	'main': main
};

if ( require.main === module ) {
	try {
		console.log( 'report: wrote ' + main( process.argv.slice( 2 ) ) );
	} catch ( err ) {
		console.error( 'report: ' + err.message );
		process.exitCode = 1;
	}
}
