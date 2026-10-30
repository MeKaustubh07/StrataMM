'use strict';

/*
* Wall-time budget model for the StrataMM campaign (`orchestrator.js --dry-run`, ETA lines).
*
* Model (protocol.json `time_model`, research-protocol.md §4–§5):
*   T_A0(M,N,K) = 2MNK / gflops_A0 s
*   A1/A2 (SW): T_A0 / ((8/7)^L * sw_efficiency) for L >= 1 levels (L from the package's own depth.js), T_A0 if L = 0
*   C1 = T_A0 / c1_speedup, C2 = T_A0 / c2_speedup, A0 = SENTINEL = T_A0
*   timing process = startup + (gate + warmup_calls) * T + k * batch * T + pause
*   memory process = startup + T + pause
*   block = env_check + sentinel process + its processes
*/

// MODULES //

var path = require( 'path' );


// VARIABLES //

var REPO = path.resolve( __dirname, '..', '..' );
var depth = require( path.join( REPO, 'lib', 'node_modules', '@stdlib', 'blas', 'ext', 'base', 'dgemmsw', 'lib', 'depth.js' ) ); // eslint-disable-line max-len
var SW_BASE = 8.0 / 7.0;
var SW_ALGS = {
	'A1': true,
	'A2': true
};


// FUNCTIONS //

/**
* Returns the modeled A0 (`dgemm`) time of one call in seconds.
*
* @param {Object} model - time model (protocol.json `time_model`)
* @param {PositiveInteger} M - rows of op(A) and C
* @param {PositiveInteger} N - columns of op(B) and C
* @param {PositiveInteger} K - inner dimension
* @returns {number} seconds
*/
function tA0( model, M, N, K ) {
	return ( 2.0 * M * N * K ) / model.gflops_A0;
}

/**
* Returns the number of recursion levels a recursive algorithm performs for a process specification.
*
* @param {Object} spec - process specification (fields `M`, `N`, `K`, `params`)
* @returns {NonNegativeInteger} levels
*/
function levelsOf( spec ) {
	var p = spec.params;
	if ( !p || p.cutoff === null || p.cutoff === void 0 ) {
		return 0;
	}
	return depth( spec.M, spec.N, spec.K, p.cutoff, p.levels );
}

/**
* Returns the modeled time of one call of the specified algorithm in seconds.
*
* @param {Object} model - time model
* @param {Object} spec - process specification
* @returns {number} seconds
*/
function callTime( model, spec ) {
	var t = tA0( model, spec.M, spec.N, spec.K );
	var L;
	if ( SW_ALGS[ spec.alg ] ) {
		L = levelsOf( spec );
		return ( L > 0 ) ? t / ( Math.pow( SW_BASE, L ) * model.sw_efficiency ) : t;
	}
	if ( spec.alg === 'C1' ) {
		return t / model.c1_speedup;
	}
	if ( spec.alg === 'C2' ) {
		return t / model.c2_speedup;
	}
	return t;
}

/**
* Returns the modeled batch size max(1, ceil(target / T_A0)) used before the pilot has measured T_A0.
*
* @param {Object} P - (effective) protocol
* @param {PositiveInteger} M - rows
* @param {PositiveInteger} N - columns
* @param {PositiveInteger} K - inner dimension
* @returns {PositiveInteger} batch size
*/
function modelBatch( P, M, N, K ) {
	return Math.max( 1, Math.ceil( P.timing.sample_target_s / tA0( P.time_model, M, N, K ) ) );
}

/**
* Returns the modeled wall time of one child process (including its trailing pause) in seconds.
*
* @param {Object} model - time model
* @param {Object} spec - process specification (`meta.pause_s` is the pause after it)
* @returns {number} seconds
*/
function procTime( model, spec ) {
	var tc = callTime( model, spec );
	var pause = ( spec.meta && spec.meta.pause_s ) || 0;
	var inv;
	var w;
	if ( spec.mode === 'memory' ) {
		return model.startup_s + tc + pause;
	}
	// Warmup (protocol §12, 2026-10-30c): at least `warmup_calls` calls and `warmup_min_seconds`, and until the arm has made `warmup_target_invocations` dgemm invocations, capped at `warmup_max_seconds`:
	inv = dgemmInvocationsPerCall( spec );
	w = Math.max( spec.warmup_calls * tc, spec.warmup_min_seconds || 0 );
	if ( spec.warmup_target_invocations ) {
		w = Math.max( w, Math.min( Math.ceil( spec.warmup_target_invocations / inv ) * tc, spec.warmup_max_seconds || 0 ) );
	}
	return model.startup_s + tc + w + ( spec.k * spec.batch * tc ) + pause;
}

/**
* Returns the (lower-bound) number of `dgemm` invocations one call of an algorithm makes: 7^L for Strassen–Winograd, 8^L for the conventional recursion (C2), and 1 otherwise (peeling calls are not counted).
*
* @param {Object} spec - process specification
* @returns {PositiveInteger} invocations per call
*/
function dgemmInvocationsPerCall( spec ) {
	var L;
	if ( SW_ALGS[ spec.alg ] ) {
		L = levelsOf( spec );
		return Math.pow( 7, L );
	}
	if ( spec.alg === 'C2' ) {
		L = levelsOf( spec );
		return Math.pow( 8, L );
	}
	return 1;
}

/**
* Returns the modeled wall time of one block in seconds.
*
* @param {Object} model - time model
* @param {Object} block - block (`procs` array)
* @param {(Object|null)} sentinel - sentinel process specification, or null when the stage has no sentinels
* @returns {number} seconds
*/
function blockTime( model, block, sentinel ) {
	var s = model.env_check_s + ( ( sentinel ) ? procTime( model, sentinel ) : 0 );
	var i;
	for ( i = 0; i < block.procs.length; i++ ) {
		s += procTime( model, block.procs[ i ] );
	}
	return s;
}

/**
* Computes the budget of one stage design.
*
* @param {Object} model - time model
* @param {Object} design - stage design (`stage`, `blocks`)
* @param {(Object|null)} sentinel - sentinel specification (null: no sentinels in this stage)
* @returns {Object} budget (`stage`, `blocks`, `procs`, `sentinels`, `seconds`, `by_label`)
*/
function stageBudget( model, design, sentinel ) {
	var out = {
		'stage': design.stage,
		'blocks': design.blocks.length,
		'procs': 0,
		'sentinels': ( sentinel ) ? design.blocks.length : 0,
		'seconds': 0,
		'by_label': {}
	};
	design.blocks.forEach( function each( b ) {
		var t = blockTime( model, b, sentinel );
		var key = b.experiment + ' ' + b.label;
		out.procs += b.procs.length;
		out.seconds += t;
		out.by_label[ key ] = ( out.by_label[ key ] || 0 ) + t;
	});
	return out;
}

/**
* Formats a duration in seconds.
*
* @param {number} s - seconds
* @returns {string} formatted duration
*/
function fmt( s ) {
	var h;
	var m;
	if ( s < 90 ) {
		return s.toFixed( 0 ) + ' s';
	}
	if ( s < 3600 ) {
		return ( s / 60 ).toFixed( 1 ) + ' min';
	}
	h = Math.floor( s / 3600 );
	m = Math.round( ( s - ( h * 3600 ) ) / 60 );
	if ( m === 60 ) {
		h += 1;
		m = 0;
	}
	return h + ' h ' + ( ( m < 10 ) ? '0' : '' ) + m + ' min';
}

/**
* Computes the campaign budget: every stage design plus the fixed E6 estimate.
*
* @param {Object} P - (effective) protocol
* @param {Array<Object>} designs - stage designs in run order (`{ stage, blocks, sentinel }`)
* @returns {Object} budget (`stages`, `timing_s`, `total_s`)
*/
function campaignBudget( P, designs ) {
	var stages = [];
	var timing = 0;
	var total = 0;
	designs.forEach( function each( d ) {
		var b = stageBudget( P.time_model, d, d.sentinel || null );
		stages.push( b );
		total += b.seconds;
		if ( d.stage !== 'E7' ) {
			timing += b.seconds;
		}
	});
	if ( P.time_model.E6_minutes ) {
		stages.push({
			'stage': 'E6',
			'blocks': 0,
			'procs': 0,
			'sentinels': 0,
			'seconds': P.time_model.E6_minutes * 60,
			'by_label': {},
			'note': 'protocol estimate (research/accuracy/run.js; not modeled here)'
		});
		total += P.time_model.E6_minutes * 60;
	}
	return {
		'stages': stages,
		'timing_s': timing,
		'total_s': total
	};
}

/**
* Renders a budget as human-readable lines.
*
* @param {Object} budget - campaign budget
* @param {boolean} verbose - whether to list per-cell lines
* @returns {Array<string>} lines
*/
function render( budget, verbose ) {
	var lines = [];
	lines.push( 'stage   blocks  procs  sentinels  estimate' );
	budget.stages.forEach( function each( s ) {
		lines.push( s.stage.padEnd( 8 ) + String( s.blocks ).padStart( 6 ) + String( s.procs ).padStart( 7 ) + String( s.sentinels ).padStart( 11 ) + '  ' + fmt( s.seconds ) + ( ( s.note ) ? '  (' + s.note + ')' : '' ) ); // eslint-disable-line max-len
		if ( verbose ) {
			Object.keys( s.by_label ).forEach( function each2( k ) {
				lines.push( '          ' + k.padEnd( 34 ) + fmt( s.by_label[ k ] ) );
			});
		}
	});
	lines.push( 'timing stages (pilot..E0): ' + fmt( budget.timing_s ) );
	lines.push( 'TOTAL (incl. E7 memory and E6 accuracy): ' + fmt( budget.total_s ) );
	return lines;
}


function uniq( procs, field ) {
	return procs.map( function f( p ) {
		return p[ field ];
	}).filter( function u( x, i, arr ) {
		return arr.indexOf( x ) === i;
	}).join( '/' );
}

/**
* Renders the dry-run report: time model, per-stage cell table (r, processes per block, k, b, algorithms, modeled
* time) and the per-stage/total budget.
*
* @param {Object} P - effective protocol
* @param {Array<Object>} designs - designs in run order
* @param {Object} o - `{ tau, sha256, file, verbose }`
* @returns {Array<string>} lines
*/
function dryRunLines( P, designs, o ) {
	var m = P.time_model;
	var t = P.timing;
	var lines = [
		'DRY RUN (' + P.mode + ') ' + o.file + ' sha256 ' + o.sha256 + ', master seed ' + P.master_seed,
		'A2/C2 cutoff assumed ' + o.tau + ' (L_max ' + P.algorithms.A2.levels + ') until the pilot freezes tau_star; b(n) from the model until the pilot measures T_A0', // eslint-disable-line max-len
		'model: T_A0 = 2MNK/' + m.gflops_A0 + ' s; A1/A2 = T_A0/((8/7)^L*' + m.sw_efficiency + '); C1 = T_A0/' + m.c1_speedup + '; C2 = T_A0/' + m.c2_speedup + '; process = ' + m.startup_s + ' s + (gate + ' + t.warmup_calls + ' warmup + k*b) calls + pause ' + t.pause_s + '/' + t.pause_large_s + ' s (n >= ' + t.pause_large_min_n + '); block = ' + m.env_check_s + ' s env check + sentinel (A0 n=' + P.sentinel.n + ', gate + ' + P.sentinel.warmup_calls + ' warmup + ' + P.sentinel.k + ' samples)' // eslint-disable-line max-len
	];
	designs.forEach( function each( d ) {
		var cells = {};
		lines.push( '', d.stage + ': ' + d.blocks.length + ' blocks, ' + d.blocks.reduce( function s( x, b ) {
			return x + b.procs.length;
		}, 0 ) + ' processes' + ( ( d.sentinel ) ? ' (+1 sentinel per block)' : '' ) );
		d.blocks.forEach( function blk( b ) {
			var k = b.experiment + ' ' + b.label;
			var c = cells[ k ] || ( cells[ k ] = { 'r': 0, 'b': b, 's': 0 } );
			c.r += 1;
			c.s += blockTime( m, b, d.sentinel || null );
		});
		Object.keys( cells ).forEach( function line( k ) {
			var b = cells[ k ].b;
			var algs = b.procs.map( function f( p ) {
				return p.alg + ( ( p.params.cutoff === null || p.alg === 'A1' ) ? '' : '(' + p.params.cutoff + ',' + p.params.levels + ')' ) + ( ( p.ld_pad ) ? '+' + p.ld_pad : '' ); // eslint-disable-line max-len
			}).filter( function u( x, i, arr ) {
				return arr.indexOf( x ) === i;
			}).sort();
			lines.push( '  ' + k.padEnd( 34 ) + ' r=' + String( cells[ k ].r ).padEnd( 3 ) + String( b.procs.length ).padStart( 3 ) + ' procs/block  k=' + uniq( b.procs, 'k' ).padEnd( 6 ) + ' b=' + uniq( b.procs, 'batch' ).padEnd( 16 ) + ' ' + fmt( cells[ k ].s ).padStart( 9 ) + '  ' + algs.join( ' ' ) ); // eslint-disable-line max-len
			if ( o.verbose ) {
				lines.push( '      order: ' + b.procs.map( function f( p ) {
					return p.alg + '@' + p.meta.shape + ( ( p.ld_pad ) ? '+' + p.ld_pad : '' );
				}).join( ' ' ) );
			}
		});
	});
	lines.push( '' );
	return lines.concat( render( campaignBudget( P, designs ), o.verbose ) );
}


// EXPORTS //

module.exports = {
	'dryRunLines': dryRunLines,
	'tA0': tA0,
	'levelsOf': levelsOf,
	'callTime': callTime,
	'modelBatch': modelBatch,
	'procTime': procTime,
	'blockTime': blockTime,
	'stageBudget': stageBudget,
	'campaignBudget': campaignBudget,
	'render': render,
	'fmt': fmt,
	'depth': depth
};
