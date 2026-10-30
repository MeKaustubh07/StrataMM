'use strict';

/**
* Process summaries and cells (protocol §6): a cell is one (experiment, algorithm, parameters, shape, layout, LD, α, β)
* configuration; its replicates are fresh processes, one per block.
*/

var path = require( 'path' );
var stats = require( '../stats.js' );
var prng = require( './prng.js' );
var io = require( './io.js' );

var PKG = path.join( io.REPO_ROOT, 'lib', 'node_modules', '@stdlib', 'blas', 'ext', 'base', 'dgemmsw', 'lib' );
var depth = require( path.join( PKG, 'depth.js' ) );

var NON_PARAM_ALGS = { 'A0': true, 'C1': true, 'SENTINEL': true };
var INFERENCE = { 'E0': true, 'E2': true, 'E3': true, 'E4': true, 'E5': true };
var EXP_ORDER = [ 'E2', 'E3', 'E5', 'E4', 'E0', 'pilot' ];
var ALG_ORDER = [ 'A0', 'A1', 'A2', 'C1', 'C2' ];


/**
* Returns `v` unless it is undefined or null.
*
* @private
*/
function dflt( v, d ) {
	return ( v === void 0 || v === null ) ? d : v;
}

/**
* Returns the configuration descriptor of a proc record (parameters are dropped for non-parametrized algorithms).
*
* @param {Object} p - proc record
* @returns {Object} descriptor
*/
function descriptor( p ) {
	var params = p.params || {};
	var np = NON_PARAM_ALGS[ p.alg ] === true;
	var exp = dflt( p.experiment, null );
	return {
		'experiment': exp,
		'group': ( exp === null ) ? null : String( exp ).split( '.' )[ 0 ],
		'alg': p.alg,
		'cutoff': ( np ) ? null : dflt( params.cutoff, null ),
		'levels': ( np ) ? null : dflt( params.levels, null ),
		'M': p.M,
		'N': p.N,
		'K': p.K,
		'order': dflt( p.order, 'row-major' ),
		'transA': dflt( p.transA, 'no-transpose' ),
		'transB': dflt( p.transB, 'no-transpose' ),
		'ld_pad': dflt( p.ld_pad, 0 ),
		'alpha': dflt( p.alpha, 1 ),
		'beta': dflt( p.beta, 0 )
	};
}

/**
* Returns the key of a descriptor (the experiment group is implied by the experiment label, e.g. `E5.layout` → `E5`).
*
* @param {Object} d - descriptor
* @returns {string} key
*/
function keyOf( d ) {
	return [ d.experiment, d.alg, d.cutoff, d.levels, d.M, d.N, d.K, d.order, d.transA, d.transB, d.ld_pad, d.alpha, d.beta ].join( '|' );
}

/**
* Returns the descriptor of the A0 reference for a descriptor (same experiment, shape, layout, LD, α, β).
*
* @param {Object} d - descriptor
* @param {string} [experiment] - override the experiment
* @returns {Object} reference descriptor
*/
function refDescriptor( d, experiment ) {
	var r = Object.assign( {}, d );
	r.alg = 'A0';
	r.cutoff = null;
	r.levels = null;
	if ( experiment !== void 0 ) {
		r.experiment = experiment;
		r.group = String( experiment ).split( '.' )[ 0 ];
	}
	return r;
}

/**
* Returns whether a proc belongs to the pilot (never quoted as a speedup, §5.1).
*
* @param {Object} p - proc record or descriptor-bearing object
* @returns {boolean} boolean
*/
function isPilot( p ) {
	return p.stage === 'pilot' || p.experiment === 'pilot';
}

/**
* Returns the recursion depth of a descriptor (0 for A0/C1).
*
* @param {Object} d - descriptor
* @returns {(NonNegativeInteger|null)} levels actually performed
*/
function depthOf( d ) {
	if ( d.cutoff === null || d.levels === null ) {
		return ( NON_PARAM_ALGS[ d.alg ] ) ? 0 : null;
	}
	return depth( d.M, d.N, d.K, d.cutoff, d.levels );
}

/**
* Summarizes one process from its proc record and samples.
*
* @param {Object} p - proc record
* @param {Array<Object>} [samples] - sample records
* @returns {Object} process summary
*/
function summarizeProcess( p, samples ) {
	var perCall = [];
	var flagged = 0;
	var flags = {};
	var med;
	samples = ( samples || [] ).slice().sort( function cmp( a, b ) {
		return a.i - b.i;
	});
	samples.forEach( function each( s ) {
		perCall.push( ( Number.isFinite( s.per_call_ns ) ) ? s.per_call_ns : s.t_ns / ( s.batch || 1 ) );
		if ( s.flags && s.flags.length ) {
			flagged += 1;
			s.flags.forEach( function f( name ) {
				flags[ name ] = ( flags[ name ] || 0 ) + 1;
			});
		}
	});
	if ( p.flag_counts ) {
		// `flagged` is the harness's count of flagged samples, not a flag:
		Object.keys( p.flag_counts ).forEach( function f( name ) {
			if ( name !== 'flagged' && flags[ name ] === void 0 && p.flag_counts[ name ] ) {
				flags[ name ] = p.flag_counts[ name ];
			}
		});
	}
	if ( Array.isArray( p.flags ) ) {
		// Process-level flags (e.g., `warmup_suspect`) count once per process:
		p.flags.forEach( function f( name ) {
			flags[ name ] = ( flags[ name ] || 0 ) + 1;
		});
	}
	med = ( perCall.length ) ? stats.median( perCall ) : dflt( p.per_call_median_ns, NaN );
	return {
		'proc_id': p.proc_id,
		'block_id': p.block_id,
		'pos_in_block': p.pos_in_block,
		'line': p._line,
		'excluded': p.excluded === true,
		'exclusion_reason': dflt( p.exclusion_reason, null ),
		'k': perCall.length,
		'batch': p.batch,
		'lda': dflt( p.lda, null ),
		'median_ns': med,
		'recorded_median_ns': dflt( p.per_call_median_ns, null ),
		'per_call': perCall,
		'first_call_ns': dflt( p.first_call_ns, NaN ),
		'flags': flags,
		'flagged_samples': flagged,
		'steady': stats.steadyClass( perCall ),
		't_wall': p.t_wall
	};
}

/**
* Builds all cells from a loaded campaign.
*
* @param {Object} data - loaded campaign (see `io.loadCampaign`)
* @returns {Object} `{ cells: Array, byKey: Map, anomalies: Array }`
*/
function buildCells( data ) {
	var anomalies = [];
	var byKey = new Map();
	var cells;

	data.procs.forEach( function each( p ) {
		var key;
		var d;
		var c;
		var s;
		d = descriptor( p );
		key = keyOf( d );
		if ( !byKey.has( key ) ) {
			byKey.set( key, {
				// The SENTINEL cell holds the sentinels of every stage (its first proc is a pilot one): never a pilot cell.
				'key': key, 'desc': d, 'pilot': isPilot( p ) && p.alg !== 'SENTINEL' && d.experiment !== 'sentinel',
				'inference': !isPilot( p ) && p.alg !== 'SENTINEL' && INFERENCE[ d.group ] === true,
				'procs': [], 'excluded': [], 'byBlock': new Map(), 'duplicates': []
			});
		}
		c = byKey.get( key );
		s = summarizeProcess( p, data.samples.get( p.proc_id ) );
		if ( s.excluded ) {
			c.excluded.push( s );
			return;
		}
		if ( !Number.isFinite( s.median_ns ) || s.median_ns <= 0 ) {
			anomalies.push( { 'kind': 'no_samples', 'proc_id': s.proc_id, 'line': s.line } );
			c.excluded.push( s );
			return;
		}
		if ( c.byBlock.has( s.block_id ) ) {
			// A resumed campaign may repeat a block; the first complete record is canonical (sentinel re-checks are expected):
			c.duplicates.push( s.proc_id );
			if ( d.alg !== 'SENTINEL' ) {
				anomalies.push( { 'kind': 'duplicate_block', 'proc_id': s.proc_id, 'block_id': s.block_id, 'line': s.line } );
			}
			return;
		}
		if ( s.recorded_median_ns !== null && s.k && Math.abs( s.recorded_median_ns / s.median_ns - 1.0 ) > 1e-6 ) {
			anomalies.push( { 'kind': 'median_mismatch', 'proc_id': s.proc_id, 'recorded': s.recorded_median_ns, 'recomputed': s.median_ns } );
		}
		c.byBlock.set( s.block_id, s.median_ns );
		c.procs.push( s );
	});
	cells = Array.from( byKey.values() ).sort( cmpCells );
	cells.forEach( function each( c, i ) {
		c.id = 'c' + String( i+1 ).padStart( 3, '0' );
		finalize( c );
	});
	return { 'cells': cells, 'byKey': byKey, 'anomalies': anomalies };
}

/**
* Orders cells by experiment, algorithm and configuration.
*
* @private
*/
function cmpCells( a, b ) {
	var fields = [ 'M', 'N', 'K', 'order', 'transA', 'transB', 'ld_pad', 'alpha', 'beta', 'cutoff', 'levels' ];
	var x = a.desc;
	var y = b.desc;
	var d = rank( EXP_ORDER, x.group ) - rank( EXP_ORDER, y.group );
	var i;
	if ( d ) {
		return d;
	}
	if ( x.experiment !== y.experiment ) {
		return ( String( x.experiment ) < String( y.experiment ) ) ? -1 : 1;
	}
	d = rank( ALG_ORDER, x.alg ) - rank( ALG_ORDER, y.alg );
	if ( d ) {
		return d;
	}
	if ( x.alg !== y.alg ) {
		return ( String( x.alg ) < String( y.alg ) ) ? -1 : 1;
	}
	for ( i = 0; i < fields.length; i++ ) {
		if ( x[ fields[ i ] ] !== y[ fields[ i ] ] ) {
			return ( String( x[ fields[ i ] ] ).localeCompare( String( y[ fields[ i ] ] ), 'en', { 'numeric': true } ) );
		}
	}
	return 0;
}

/**
* Returns the rank of a value in an ordering (unknown values last).
*
* @private
*/
function rank( order, v ) {
	var i = order.indexOf( v );
	return ( i < 0 ) ? order.length : i;
}

/**
* Computes the per-cell statistics (§6) in place.
*
* @private
*/
function finalize( c ) {
	var pooled = [];
	var steady = {};
	var reasons = {};
	var flags = {};
	var flagged = 0;
	var pm = [];
	var d;
	c.procs.forEach( function each( s ) {
		Array.prototype.push.apply( pooled, s.per_call );
		pm.push( s.median_ns );
		steady[ s.steady.class ] = ( steady[ s.steady.class ] || 0 ) + 1;
		flagged += s.flagged_samples;
		Object.keys( s.flags ).forEach( function f( k ) {
			flags[ k ] = ( flags[ k ] || 0 ) + s.flags[ k ];
		});
	});
	c.excluded.forEach( function each( s ) {
		var r = s.exclusion_reason || 'no samples';
		reasons[ r ] = ( reasons[ r ] || 0 ) + 1;
	});
	d = stats.describe( pooled );
	c.r = c.procs.length;
	c.k = stats.median( c.procs.map( function f( s ) {
		return s.k;
	}) );
	c.batch = Array.from( new Set( c.procs.map( function f( s ) {
		return s.batch;
	}) ) );
	c.median_ns = stats.median( pm );
	c.iqr_ns = d.iqr;
	c.min_ns = d.min;
	c.mean_ns = d.mean;
	c.p90_ns = d.p90;
	c.pm_min_ns = stats.describe( pm ).min;
	c.pm_max_ns = stats.describe( pm ).max;
	c.first_call_ns = stats.median( c.procs.map( function f( s ) {
		return s.first_call_ns;
	}) );
	c.flags = flags;
	c.flagged_samples = flagged;
	c.samples = pooled.length;
	c.steady = steady;
	c.excluded_count = c.excluded.length;
	c.exclusion_reasons = reasons;
	c.L = depthOf( c.desc );
	c.gflops = ( 2.0 * c.desc.M * c.desc.N * c.desc.K ) / c.median_ns;
	c.src = {
		'cell': c.id,
		'file': 'campaign.jsonl',
		'ids': c.procs.map( function f( s ) {
			return s.proc_id;
		}),
		'excluded_ids': c.excluded.map( function f( s ) {
			return s.proc_id;
		})
	};
}

/**
* Attaches `speedup` (S = cell(A0)/cell(alg), paired within blocks of the same experiment) to every inference cell
* other than A0.
*
* C2 is reported as an estimate with its CI, without a verdict (§6). S is never paired across experiments: the only
* unpaired reference is E2's A0 for E4 cells (§12 amendment 2026-10-30b item 4: E4 runs the SW arms only), labelled
* `pairing: 'unpaired'`. A cell without a reference gets no `speedup` and a `speedup_missing: { reason, ref }`.
*
* @param {Object} built - result of `buildCells`
* @param {Object} opts - `{ B, seed }` (master analysis seed)
*/
function attachSpeedups( built, opts ) {
	built.cells.forEach( function each( c ) {
		var seed;
		var ref;
		var res;
		var why;
		if ( !c.inference || c.desc.alg === 'A0' || c.r === 0 ) {
			return;
		}
		seed = prng.deriveSeed( opts.seed, 'S|' + c.key );
		ref = built.byKey.get( keyOf( refDescriptor( c.desc ) ) );
		if ( ref && ref.r > 0 ) {
			res = stats.pairedRatio( ref.byBlock, c.byBlock, { 'B': opts.B, 'seed': seed } );
		}
		if ( !res || res.r === 0 ) {
			if ( !ref ) {
				why = 'no A0 cell in ' + c.desc.experiment;
			} else {
				why = ( ref.r > 0 ) ? 'A0 cell ' + ref.id + ' shares no block' : 'A0 cell ' + ref.id + ' has no non-excluded process';
			}
			if ( c.desc.group !== 'E4' ) {
				c.speedup_missing = { 'reason': why, 'ref': ( ref ) ? ref.id : null };
				return;
			}
			ref = built.byKey.get( keyOf( refDescriptor( c.desc, 'E2' ) ) );
			if ( !ref || ref.r === 0 ) {
				c.speedup_missing = { 'reason': why + '; E2 A0 reference ' + ( ( ref ) ? ref.id + ' has no non-excluded process' : 'not run' ), 'ref': ( ref ) ? ref.id : null };
				return;
			}
			res = stats.unpairedRatio( ref.procs.map( med ), c.procs.map( med ), { 'B': opts.B, 'seed': seed } );
		}
		delete res.blocks;
		res.ref = ref.id;
		res.estimate_only = ( c.desc.alg === 'C2' );
		res.verdict = ( res.estimate_only ) ? null : stats.verdict( res.est, res.lo, res.hi );
		c.speedup = res;
	});

	function med( s ) {
		return s.median_ns;
	}
}

/**
* Returns a JSON-serializable view of a cell (drops per-process sample arrays and maps).
*
* @param {Object} c - cell
* @returns {Object} plain object
*/
function toJSON( c ) {
	var out = {};
	Object.keys( c ).forEach( function each( k ) {
		if ( k === 'procs' || k === 'excluded' || k === 'byBlock' ) {
			return;
		}
		out[ k ] = c[ k ];
	});
	out.processes = c.procs.map( function f( s ) {
		return {
			'proc_id': s.proc_id, 'block_id': s.block_id, 'pos_in_block': s.pos_in_block, 'line': s.line,
			'median_ns': s.median_ns, 'k': s.k, 'first_call_ns': s.first_call_ns, 'steady': s.steady,
			'flagged_samples': s.flagged_samples, 't_wall': s.t_wall
		};
	});
	out.excluded_processes = c.excluded.map( function f( s ) {
		return { 'proc_id': s.proc_id, 'block_id': s.block_id, 'line': s.line, 'reason': s.exclusion_reason };
	});
	return out;
}


// EXPORTS //

module.exports = {
	'descriptor': descriptor,
	'keyOf': keyOf,
	'refDescriptor': refDescriptor,
	'isPilot': isPilot,
	'depthOf': depthOf,
	'depth': depth,
	'workspaceLength': require( path.join( PKG, 'workspace_length.js' ) ),
	'summarizeProcess': summarizeProcess,
	'buildCells': buildCells,
	'attachSpeedups': attachSpeedups,
	'toJSON': toJSON
};
