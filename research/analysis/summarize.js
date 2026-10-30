#!/usr/bin/env node
'use strict';

/**
* Summarizes one campaign: reads `research/data/<campaign>/*.jsonl` and writes `derived/*.json` plus
* `derived/tables.md` (protocol §6, §7, §8 aggregates, §9, §11).
*
* Usage:
*   node research/analysis/summarize.js <campaign_id> [--B 10000] [--seed <uint32>]
*   node research/analysis/summarize.js --dir <campaign directory> [--out <derived directory>]
*/

var path = require( 'path' );
var fs = require( 'fs' );
var io = require( './lib/io.js' );
var prng = require( './lib/prng.js' );
var stats = require( './stats.js' );
var cellsLib = require( './lib/cells.js' );
var xo = require( './crossover.js' );
var accLib = require( './lib/accuracy.js' );
var tables = require( './lib/tables.js' );
var derive = require( './lib/derive.js' );
var runsLib = require( './lib/runs.js' );
var pilotLib = require( './lib/pilot.js' );

var DERIVED = [ 'summary', 'cells', 'crossover', 'ladder', 'depth', 'e5', 'e0', 'pilot', 'memory', 'accuracy', 'pairing', 'sentinel', 'position', 'exclusions' ];
var PAIRING_RN = [ 'F1', 'F2', 'F3' ];
var PAIRING_DIGITS = [ 'F4', 'F5' ];


/**
* Returns whether a descriptor is the E2/E3 default layout (row-major NN, α = 1, β = 0) at square size n.
*
* @private
*/
function isDefaultSquare( d, n ) {
	return d.M === n && d.N === n && d.K === n && d.order === 'row-major' && d.transA === 'no-transpose' && d.transB === 'no-transpose' && d.alpha === 1 && d.beta === 0;
}

/**
* Runs the full analysis on a loaded campaign.
*
* @param {Object} data - loaded campaign (`io.loadCampaign`)
* @param {Object} [opts] - `{ B, seed }`
* @returns {Object} derived results keyed by output name
*/
function analyze( data, opts ) {
	var protoFile = path.join( io.REPO_ROOT, 'research', 'protocol.json' );
	var protoDoc = path.join( io.REPO_ROOT, 'docs', 'research-protocol.md' );
	var campaign = data.campaign || {};
	var frozen = data.frozen || {};
	var commit = runsLib.findCommit( campaign.provenance );
	var envs = runsLib.envSummary( campaign.env );
	var runs = runsLib.runs( data );
	var ps = frozen.pilot_summary || null;
	var tauStar = ( frozen.tau_star === void 0 ) ? null : frozen.tau_star;
	var levels = ( frozen.levels === void 0 ) ? 4 : frozen.levels;
	var built;
	var seed;
	var B;
	var out = {};

	opts = opts || {};
	B = Number( opts.B ) || stats.B_DEFAULT;
	seed = ( opts.seed ) ? Number( opts.seed ) >>> 0 : prng.deriveSeed( Number( campaign.master_seed ) || prng.DEFAULT_SEED, 'analysis' );
	built = cellsLib.buildCells( data );
	cellsLib.attachSpeedups( built, { 'B': B, 'seed': seed } );

	out.summary = {
		'schema': 'sw-analysis/1',
		'campaign': campaign.campaign || data.id,
		'generated_at': new Date().toISOString(),
		'commit': commit.commit,
		'dirty': commit.dirty,
		'commits': runs.commits,
		'dirty_any': runs.dirty_any,
		'provenance_changed': runs.provenance_changed,
		'provenance_changes': runs.changes,
		'runs': runs.runs,
		'blocks_across_runs': runs.blocks_across_runs,
		'protocol_sha256': campaign.protocol_sha256 || null,
		'protocol_file': 'research/protocol.json',
		'protocol_file_sha256': io.sha256File( protoFile ),
		'protocol_doc_sha256': io.sha256File( protoDoc ),
		'design': campaign.design || null,
		'master_seed': ( campaign.master_seed === void 0 ) ? null : campaign.master_seed,
		'analysis_seed': seed,
		'B': B,
		'level': stats.LEVEL,
		'low_rep_max': stats.LOW_REP_MAX,
		'frozen': {
			'tau_star': tauStar, 'levels': levels, 'batch_by_n': frozen.batch_by_n || null,
			'fallback': ( ps && typeof ps.fallback === 'boolean' ) ? ps.fallback : null,
			'pilot_summary': ( ps ) ? { 'rule': ps.rule || null, 'select_sizes': ps.select_sizes || null, 'taus': ps.taus || null, 'eligible': ps.eligible || null, 'worst_ratio': ps.worst_ratio || null, 'fallback': ( typeof ps.fallback === 'boolean' ) ? ps.fallback : null } : null
		},
		'env': campaign.env || null,
		'env_summary': envs,
		'provenance': campaign.provenance || null,
		'campaign_src': ( data.campaign ) ? { 'file': 'campaign.jsonl', 'lines': [ data.campaign._line ] } : null,
		'status': ( runs.final_end ) ? runs.final_end : { 'status': ( data.logTail && /CAMPAIGN COMPLETE/.test( data.logTail.line ) ) ? 'complete (log only; no campaign_end record)' : 'missing campaign_end record' + ( ( data.end ) ? ' for the last run (an earlier run ended: ' + data.end.status + ')' : '' ), 'reason': ( data.logTail ) ? data.logTail.file + ': ' + data.logTail.line : null, 'warnings': [], 'src': null },
		'ends': runs.ends,
		'counts': {
			'procs': data.procs.length,
			'excluded': data.procs.filter( function f( p ) {
				return p.excluded === true;
			}).length,
			'samples': Array.from( data.samples.values() ).reduce( function f( a, s ) {
				return a + s.length;
			}, 0 ),
			'env_checks': data.envChecks.length,
			'mem': data.mems.length,
			'mem_excluded': data.mems.filter( function f( m ) {
				return m.excluded === true;
			}).length,
			'accuracy': data.accuracy.length,
			'accuracy_warning': data.accuracyWarnings.length,
			'parse_errors': data.parseErrors.length,
			'schema_warnings': data.schemaWarnings
		},
		'parse_errors': data.parseErrors,
		'anomalies': built.anomalies,
		'e1': data.e1.map( function f( r ) {
			return { 'trials': r.trials, 'mismatches': r.mismatches, 'recursive_fraction': r.recursive_fraction, 'shapes_max': r.shapes_max, 'max_depth': ( r.max_depth === void 0 ) ? null : r.max_depth, 'input_mutations': ( r.input_mutations === void 0 ) ? null : r.input_mutations, 'src': { 'file': 'e1.jsonl', 'lines': [ r._line ] } };
		})
	};
	out.summary.protocol_match = ( out.summary.protocol_sha256 && out.summary.protocol_file_sha256 ) ? out.summary.protocol_sha256 === out.summary.protocol_file_sha256 : null;
	out.cells = built.cells.map( cellsLib.toJSON );
	out.crossover = {
		'families': xo.FAMILIES,
		'tau_star': tauStar,
		'specific_to': 'A1: cutoff 1, levels 1; A2: cutoff τ* = ' + tauStar + ', L_max = ' + levels + '; row-major NN, LD = n, α = 1, β = 0; machine ' + ( envs.machine || '(unrecorded)' ) + ', Node ' + ( envs.node || '(unrecorded)' ) + ( ( envs.v8 ) ? ' / V8 ' + envs.v8 : '' ),
		'results': xo.crossovers( getPoint, { 'B': B, 'seed': seed, 'tauStar': tauStar } )
	};
	out.ladder = ladders();
	out.depth = rowsFor( 'E4' );
	out.e5 = rowsFor( 'E5' ).map( function f( r ) {
		var d = r.desc;
		r.kind = ( d.M !== d.N || d.N !== d.K ) ? 'rectangular' : ( ( d.alpha !== 1 || d.beta !== 0 ) ? 'alpha-beta' : 'layout' );
		return r;
	});
	out.e0 = e0Rows();
	out.pilot = pilotLib.pilot( built.cells, { 'frozen': frozen, 'tauStar': tauStar, 'levels': levels, 'design': campaign.design } );
	out.memory = derive.memory( data.mems, tauStar, levels );
	out.accuracy = accLib.aggregate( data.accuracy, { 'warnings': data.accuracyWarnings } );
	out.pairing = pairing( out.accuracy );
	out.sentinel = derive.sentinel( data.envChecks );
	out.position = position();
	out.exclusions = exclusions();
	return out;

	function findCell( pred ) {
		var i;
		for ( i = 0; i < built.cells.length; i++ ) {
			if ( pred( built.cells[ i ].desc, built.cells[ i ] ) ) {
				return built.cells[ i ];
			}
		}
		return null;
	}

	function e2Cell( alg, n ) {
		var want = ( alg === 'A1' ) ? [ 1, 1 ] : [ tauStar, levels ];
		var exact = findCell( function f( d, c ) {
			return c.inference && d.experiment === 'E2' && d.alg === alg && d.ld_pad === 0 && isDefaultSquare( d, n ) && d.cutoff === want[ 0 ] && d.levels === want[ 1 ];
		});
		return exact || findCell( function f( d, c ) {
			return c.inference && d.experiment === 'E2' && d.alg === alg && d.ld_pad === 0 && isDefaultSquare( d, n );
		});
	}

	function getPoint( alg, n ) {
		var c = e2Cell( alg, n );
		var ref;
		if ( !c || !c.speedup || c.speedup.pairing !== 'paired' ) {
			return null;
		}
		ref = built.cells.filter( function f( x ) {
			return x.id === c.speedup.ref;
		})[ 0 ];
		return { 'n': n, 'ref': ref.byBlock, 'alg': c.byBlock, 'S': c.speedup.est, 'lo': c.speedup.lo, 'hi': c.speedup.hi, 'verdict': c.speedup.verdict, 'low_replication': c.speedup.low_replication, 'cell': c.id, 'ref_cell': ref.id };
	}

	function ladders() {
		var sizes = [];
		built.cells.forEach( function each( c ) {
			if ( c.inference && c.desc.experiment === 'E3' && c.desc.alg === 'A2' && sizes.indexOf( c.desc.M ) < 0 ) {
				sizes.push( c.desc.M );
			}
		});
		return sizes.sort( function cmp( a, b ) {
			return a - b;
		}).map( function each( n ) {
			var getE3 = e3Getter( n );
			var a2 = getE3( 'A2', 0 ) || getE3( 'A2', 8 );
			var res;
			if ( !a2 ) {
				return null;
			}
			res = stats.ladder( getE3, cellsLib.depthOf( a2.desc ), {
				'B': B,
				'seedFor': function f( name ) {
					return prng.deriveSeed( seed, 'L|' + n + '|' + name );
				}
			});
			res.n = n;
			res.a2_params = { 'cutoff': a2.desc.cutoff, 'levels': a2.desc.levels };
			res.cells = {};
			[ 'A0', 'A2', 'C1', 'C2' ].forEach( function f( alg ) {
				[ 0, 8 ].forEach( function g( pad ) {
					var c = getE3( alg, pad );
					if ( c ) {
						res.cells[ alg + '@' + pad ] = { 'id': c.id, 'median_ns': c.median_ns, 'src': c.src };
					}
				});
			});
			return res;
		}).filter( Boolean );
	}

	function e3Getter( n ) {
		return function getE3( alg, pad ) {
			var c = findCell( function f( d, x ) {
				return x.inference && d.experiment === 'E3' && d.alg === alg && d.ld_pad === pad && isDefaultSquare( d, n ) && x.r > 0;
			});
			return ( c ) ? { 'id': c.id, 'byBlock': c.byBlock, 'desc': c.desc, 'median_ns': c.median_ns, 'src': c.src } : null;
		};
	}

	function rowsFor( group ) {
		return built.cells.filter( function f( c ) {
			return c.inference && c.desc.group === group && c.desc.alg !== 'A0';
		}).map( function each( c ) {
			var ref = built.cells.filter( function f( x ) {
				return c.speedup && x.id === c.speedup.ref;
			})[ 0 ];
			return { 'cell': c.id, 'desc': c.desc, 'L': c.L, 'r': c.r, 'median_ns': c.median_ns, 'gflops': c.gflops, 'ref_cell': ( ref ) ? ref.id : null, 'ref_median_ns': ( ref ) ? ref.median_ns : NaN, 'speedup': c.speedup || null, 'speedup_missing': c.speedup_missing || null, 'src': [ ( ref ) ? ref.src : null, c.src ].filter( Boolean ) };
		});
	}

	function e0Rows() {
		return built.cells.filter( function f( c ) {
			return c.inference && c.desc.group === 'E0' && c.r > 0;
		}).map( function each( c ) {
			var base = findCell( function f( d, x ) {
				return x.inference && d.group === 'E0' && d.alg === c.desc.alg && d.ld_pad === 0 && isDefaultSquare( d, c.desc.M ) && x.r > 0;
			});
			return { 'cell': c.id, 'desc': c.desc, 'r': c.r, 'median_ns': c.median_ns, 'gflops': c.gflops, 'lda': ( c.procs[ 0 ] ) ? c.procs[ 0 ].lda : null, 'rel_to_rm_nn': ( base ) ? c.median_ns / base.median_ns : NaN, 'base_cell': ( base ) ? base.id : null, 'src': [ c.src ] };
		});
	}

	function pairing( acc ) {
		var rows = [];
		built.cells.forEach( function each( c ) {
			var d = c.desc;
			var row;
			if ( !c.inference || !c.speedup || !( ( d.experiment === 'E2' && ( d.alg === 'A1' || d.alg === 'A2' ) ) || ( d.group === 'E4' && d.alg !== 'A0' ) ) ) {
				return;
			}
			if ( d.M !== d.N || d.N !== d.K || d.ld_pad !== 0 || !( c.L >= 1 ) ) {
				return;
			}
			// S cites its A0 reference cell as well as the algorithm's cell (§11 rule 1):
			row = { 'cell': c.id, 'ref_cell': c.speedup.ref, 'pairing': c.speedup.pairing, 'experiment': d.experiment, 'alg': d.alg, 'n': d.M, 'cutoff': d.cutoff, 'levels': d.levels, 'L': c.L, 'S': c.speedup.est, 'lo': c.speedup.lo, 'hi': c.speedup.hi, 'verdict': c.speedup.verdict, 'acc': {}, 'src': [ c.src, { 'cell': c.speedup.ref } ] };
			PAIRING_RN.forEach( function f( fam ) {
				var g = accLib.lookupWorst( acc, fam, d.M, 'SW', c.L, 'R_N' );
				row.acc[ fam ] = ( g ) ? { 'R_N': g.R_N.median, 'eta_N': g.metrics.eta_N.median, 'frac_ge1': g.metrics.frac_ge1.median, 'params': g.params, 'seeds': g.seeds } : null;
				if ( g ) {
					row.src.push( g.src );
				}
			});
			PAIRING_DIGITS.forEach( function f( fam ) {
				var g = accLib.lookupWorst( acc, fam, d.M, 'SW', c.L, 'frac_ge1' );
				row.acc[ fam ] = ( g ) ? { 'R_N': g.R_N.median, 'frac_ge1': g.metrics.frac_ge1.median, 'frac_ge1_max': g.metrics.frac_ge1.max, 'params': g.params, 'seeds': g.seeds } : null;
				if ( g ) {
					row.src.push( g.src );
				}
			});
			rows.push( row );
		});
		return rows;
	}

	function position() {
		var by = {};
		var all = [];
		var res = [];
		built.cells.forEach( function each( c ) {
			if ( !c.inference || c.r < 2 ) {
				return;
			}
			c.procs.forEach( function f( s ) {
				var p = { 'cell': c.key, 'block_id': c.desc.group + '|' + s.block_id, 'pos_in_block': s.pos_in_block, 'median_ns': s.median_ns };
				( by[ c.desc.group ] = by[ c.desc.group ] || [] ).push( p );
				all.push( p );
			});
		});
		Object.keys( by ).sort().forEach( function each( exp ) {
			var r = stats.positionEffect( by[ exp ], { 'B': B, 'seed': prng.deriveSeed( seed, 'P|' + exp ) } );
			r.experiment = exp;
			res.push( r );
		});
		if ( res.length > 1 ) {
			res.push( Object.assign( stats.positionEffect( all, { 'B': B, 'seed': prng.deriveSeed( seed, 'P|all' ) } ), { 'experiment': 'all' } ) );
		}
		return res;
	}

	function exclusions() {
		var rows = [];
		built.cells.forEach( function each( c ) {
			c.excluded.forEach( function f( s ) {
				rows.push( { 'proc_id': s.proc_id, 'cell': c.id, 'desc': c.desc, 'block_id': s.block_id, 'reason': s.exclusion_reason || 'no samples', 'src': { 'file': 'campaign.jsonl', 'ids': [ s.proc_id ], 'lines': [ s.line ] } } );
			});
		});
		return rows;
	}
}

/**
* Writes derived JSON files and `tables.md`.
*
* @param {string} outDir - derived directory
* @param {Object} derived - analysis result
*/
function writeDerived( outDir, derived ) {
	DERIVED.forEach( function each( name ) {
		io.writeJson( path.join( outDir, name + '.json' ), derived[ name ] );
	});
	io.writeText( path.join( outDir, 'tables.md' ), tables.renderAll( derived ) );
}

/**
* Reads the derived JSON files of a campaign.
*
* @param {string} derivedDir - derived directory
* @returns {Object} derived results
*/
function loadDerived( derivedDir ) {
	var out = {};
	DERIVED.forEach( function each( name ) {
		var f = path.join( derivedDir, name + '.json' );
		if ( !fs.existsSync( f ) ) {
			throw new Error( 'missing ' + f + ' (run summarize.js first)' );
		}
		out[ name ] = io.readJson( f );
	});
	return out;
}

/**
* Command-line entry point.
*
* @param {Array<string>} argv - arguments
* @returns {Object} `{ dir, outDir, derived }`
*/
function main( argv ) {
	var opts = io.parseArgs( argv );
	var dir = io.campaignDir( opts );
	var outDir = ( opts.out ) ? path.resolve( opts.out ) : path.join( dir, 'derived' );
	var derived = analyze( io.loadCampaign( dir ), { 'B': opts.B, 'seed': opts.seed } );
	writeDerived( outDir, derived );
	return { 'dir': dir, 'outDir': outDir, 'derived': derived };
}


// EXPORTS //

module.exports = {
	'DERIVED': DERIVED,
	'findCommit': runsLib.findCommit,
	'envSummary': runsLib.envSummary,
	'analyze': analyze,
	'writeDerived': writeDerived,
	'loadDerived': loadDerived,
	'main': main
};

if ( require.main === module ) {
	try {
		var res = main( process.argv.slice( 2 ) ); // eslint-disable-line vars-on-top, no-var
		console.log( 'summarize: ' + res.derived.cells.length + ' cells, ' + res.derived.accuracy.n_records + ' accuracy records -> ' + path.relative( process.cwd(), res.outDir ) );
	} catch ( err ) {
		console.error( 'summarize: ' + err.message );
		process.exitCode = 1;
	}
}
