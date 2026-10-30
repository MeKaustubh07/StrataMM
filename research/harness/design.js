'use strict';

/*
* Experiment grid of the StrataMM campaign (research-protocol.md §4–§5, §9), built from research/protocol.json.
*
* -   A design is `{ stage, blocks, sentinel }`; a block is `{ block_id, stage, experiment, rep, r, label, procs }`;
*     each proc is a child configuration (spec) plus orchestrator-only `meta` (pause, tier, shape, rep).
* -   Randomized complete blocks: replicate j of every cell forms round j; rounds run in order; blocks inside a round
*     and processes inside a block are shuffled with seeded PRNGs (`pos_in_block` recorded). All processes of a block
*     share one input seed (paired inputs). Everything is a pure function of protocol.json (+ frozen values).
* -   The pilot freeze (§5.1 selection rule and b(n)) lives in resume.js (`freeze`).
*/

// MODULES //

var fs = require( 'fs' );
var path = require( 'path' );
var crypto = require( 'crypto' );
var discreteUniform = require( '@stdlib/random/base/discrete-uniform' );
var budget = require( './budget.js' );


// VARIABLES //

var PROTOCOL_PATH = path.resolve( __dirname, '..', 'protocol.json' );
var TIMING_STAGES = [ 'E2', 'E3', 'E5', 'E4', 'E0' ];
var BUILDERS = {};


// FUNCTIONS //

/**
* Loads protocol.json and hashes its exact bytes.
*
* @param {string} [file] - protocol path (default: research/protocol.json)
* @returns {Object} `{ protocol, sha256, path }`
*/
function loadProtocol( file ) {
	var f = file || PROTOCOL_PATH;
	var text = fs.readFileSync( f, 'utf8' );
	return { 'protocol': JSON.parse( text ), 'sha256': crypto.createHash( 'sha256' ).update( text ).digest( 'hex' ), 'path': f };
}

/**
* Returns the effective protocol of a mode: in tiny mode every section listed under `tiny` replaces its namesake.
*
* @param {Object} protocol - parsed protocol.json
* @param {boolean} tiny - whether to apply the tiny sections
* @returns {Object} effective protocol (deep copy with `mode`)
*/
function effective( protocol, tiny ) {
	var P = JSON.parse( JSON.stringify( protocol ) );
	if ( tiny ) {
		Object.keys( P.tiny || {} ).forEach( function each( k ) {
			if ( k.charAt( 0 ) !== '_' ) {
				P[ k ] = P.tiny[ k ];
			}
		});
	}
	delete P.tiny;
	P.mode = ( tiny ) ? 'tiny' : 'campaign';
	return P;
}

/**
* Derives a deterministic nonzero uint32 seed from the master seed and labels (first 4 bytes of a SHA-256).
*
* @param {...*} parts - master seed and labels
* @returns {PositiveInteger} seed
*/
function deriveSeed() {
	var s = crypto.createHash( 'sha256' ).update( Array.prototype.join.call( arguments, '|' ) ).digest().readUInt32BE( 0 );
	return ( s === 0 ) ? 1 : s;
}

/**
* Returns a seeded integer PRNG `randi(a, b)` on [a, b] (@stdlib/random/base/discrete-uniform).
*
* @param {PositiveInteger} seed - seed
* @returns {Function} PRNG
*/
function rng( seed ) {
	return discreteUniform.factory({ 'seed': seed });
}

/**
* Shuffles an array in place (Fisher–Yates).
*
* @param {Array} arr - array
* @param {Function} randi - integer PRNG
* @returns {Array} input array
*/
function shuffle( arr, randi ) {
	var tmp;
	var i;
	var j;
	for ( i = arr.length - 1; i > 0; i-- ) {
		j = randi( 0, i );
		tmp = arr[ i ];
		arr[ i ] = arr[ j ];
		arr[ j ] = tmp;
	}
	return arr;
}

/**
* Returns the median of a numeric array (NaN when empty).
*
* @param {NumericArray} x - values
* @returns {number} median
*/
function median( x ) {
	var s = Array.prototype.slice.call( x ).sort( function cmp( a, b ) {
		return a - b;
	});
	var n = s.length;
	if ( n === 0 ) {
		return NaN;
	}
	return ( n % 2 ) ? s[ ( n - 1 ) / 2 ] : ( s[ ( n / 2 ) - 1 ] + s[ n / 2 ] ) / 2.0;
}

/**
* Returns the shape key: `"n"` for square shapes, `"MxNxK"` otherwise.
*
* @param {PositiveInteger} M - rows
* @param {PositiveInteger} N - columns
* @param {PositiveInteger} K - inner dimension
* @returns {string} key
*/
function shapeKey( M, N, K ) {
	return ( M === N && N === K ) ? String( M ) : M + 'x' + N + 'x' + K;
}

function sizeOf( M, N, K ) {
	return ( M === N && N === K ) ? M : Math.round( Math.cbrt( M * N * K ) );
}

/**
* Returns the timing tier (k, r) of a shape: by n for square shapes, by round(cbrt(MNK)) otherwise.
*
* @param {Object} P - effective protocol
* @param {PositiveInteger} M - rows
* @param {PositiveInteger} N - columns
* @param {PositiveInteger} K - inner dimension
* @returns {Object} tier
*/
function tierOf( P, M, N, K ) {
	var tiers = P.timing.tiers;
	var n = sizeOf( M, N, K );
	var i;
	for ( i = 0; i < tiers.length; i++ ) {
		if ( tiers[ i ].max_n === null || n <= tiers[ i ].max_n ) {
			return tiers[ i ];
		}
	}
	return tiers[ tiers.length - 1 ];
}

function algParams( P, alg, tau ) {
	if ( alg === 'A1' ) {
		return { 'cutoff': P.algorithms.A1.cutoff, 'levels': P.algorithms.A1.levels };
	}
	if ( alg === 'A2' || alg === 'C2' ) {
		return { 'cutoff': tau, 'levels': P.algorithms.A2.levels };
	}
	return { 'cutoff': null, 'levels': null };
}

function makeSpec( P, ctx, o ) {
	var d = P.timing.defaults;
	var mem = ( o.mode === 'memory' );
	var t = tierOf( P, o.M, o.N, o.K );
	var big = sizeOf( o.M, o.N, o.K ) >= P.timing.pause_large_min_n;
	return {
		'stage': ctx.stage,
		'experiment': o.experiment,
		'block_id': null,
		'pos_in_block': null,
		'alg': o.alg,
		'params': o.params || algParams( P, o.alg, ctx.tau ),
		'M': o.M,
		'N': o.N,
		'K': o.K,
		'order': o.order || d.order,
		'transA': o.transA || d.transA,
		'transB': o.transB || d.transB,
		'ld_pad': ( o.ld_pad === void 0 ) ? d.ld_pad : o.ld_pad,
		'alpha': ( o.alpha === void 0 ) ? d.alpha : o.alpha,
		'beta': ( o.beta === void 0 ) ? d.beta : o.beta,
		'seed': null,
		'batch': ( mem ) ? 1 : ctx.batch( o.M, o.N, o.K ),
		'k': ( mem ) ? 0 : t.k,
		'warmup_calls': ( mem ) ? 0 : P.timing.warmup_calls,
		'warmup_min_seconds': ( mem ) ? 0 : P.timing.warmup_min_seconds,
		'warmup_target_invocations': ( mem ) ? 0 : P.timing.warmup_target_invocations,
		'warmup_max_seconds': ( mem ) ? 0 : P.timing.warmup_max_seconds,
		'mode': ( mem ) ? 'memory' : 'timing',
		'meta': { 'pause_s': ( big ) ? P.timing.pause_large_s : P.timing.pause_s, 'tier': t.name, 'shape': shapeKey( o.M, o.N, o.K ), 'rep': null } // eslint-disable-line max-len
	};
}

function sq( P, ctx, experiment, alg, n, extra ) {
	return makeSpec( P, ctx, Object.assign( { 'experiment': experiment, 'alg': alg, 'M': n, 'N': n, 'K': n }, extra || {} ) );
}

// A cell is one design point replicated `r` times; `make(rep)` builds its block for replicate `rep`.
function cell( P, ctx, randi, experiment, cellId, r, label, mk ) {
	return {
		'r': r,
		'make': function make( rep ) {
			var specs = shuffle( mk(), randi );
			var seed = deriveSeed( P.master_seed, 'input', cellId, rep );
			var id = cellId + '.b' + rep;
			specs.forEach( function each( s, i ) {
				s.block_id = id;
				s.pos_in_block = i;
				s.seed = seed;
				s.meta.rep = rep;
			});
			return { 'block_id': id, 'stage': ctx.stage, 'experiment': experiment, 'rep': rep, 'r': r, 'label': label, 'procs': specs }; // eslint-disable-line max-len
		}
	};
}

// Round j holds replicate j of every cell with r >= j, in a shuffled order.
function rounds( cells, randi ) {
	var out = [];
	var maxR = 0;
	var rep;
	var bl;
	cells.forEach( function each( c ) {
		maxR = Math.max( maxR, c.r );
	});
	for ( rep = 1; rep <= maxR; rep++ ) {
		bl = [];
		cells.forEach( function each( c ) {
			if ( c.r >= rep ) {
				bl.push( c.make( rep ) );
			}
		});
		out = out.concat( shuffle( bl, randi ) );
	}
	return out;
}

function context( P, stage, frozen ) {
	return {
		'stage': stage,
		'tau': ( frozen ) ? frozen.tau_star : null,
		'batch': function batch( M, N, K ) {
			var b = ( frozen && frozen.batch_by_n ) ? frozen.batch_by_n[ shapeKey( M, N, K ) ] : void 0;
			return b || budget.modelBatch( P, M, N, K );
		}
	};
}

/**
* Builds the pilot (§5.1): A0 + A2(τ) at the select sizes, A0 + A2(xl.tau) at the XL size, A0 at the batch sizes.
*
* @param {Object} P - effective protocol
* @returns {Object} design
*/
function buildPilot( P ) {
	var pil = P.pilot;
	var randi = rng( deriveSeed( P.master_seed, 'order', 'pilot' ) );
	var ctx = context( P, 'pilot', null );
	function a2( experiment, n, tau ) {
		return sq( P, ctx, experiment, 'A2', n, { 'params': { 'cutoff': tau, 'levels': pil.levels } } );
	}
	var cells = pil.select_sizes.map( function each( n ) {
		return cell( P, ctx, randi, 'pilot.tau', 'pilot.tau.n' + n, pil.r, 'n=' + n, function mk() {
			return [ sq( P, ctx, 'pilot.tau', 'A0', n ) ].concat( pil.taus.map( function tau( t ) {
				return a2( 'pilot.tau', n, t );
			}) );
		});
	});
	cells.push( cell( P, ctx, randi, 'pilot.xl', 'pilot.xl.n' + pil.xl.n, pil.r, 'n=' + pil.xl.n, function mk() {
		return [ sq( P, ctx, 'pilot.xl', 'A0', pil.xl.n ), a2( 'pilot.xl', pil.xl.n, pil.xl.tau ) ];
	}) );
	cells.push( cell( P, ctx, randi, 'pilot.batch', 'pilot.batch', pil.r, 'A0 n=' + pil.batch_sizes.join( ',' ), function mk() {
		return pil.batch_sizes.map( function each( n ) {
			return sq( P, ctx, 'pilot.batch', 'A0', n );
		});
	}) );
	return { 'stage': 'pilot', 'blocks': rounds( cells, randi ), 'sentinel': sentinelSpec( P ) };
}

BUILDERS.E2 = function buildE2( P, ctx, randi ) {
	var e = P.E2;
	var sizes = [];
	Object.keys( e.families ).forEach( function each( f ) {
		sizes = sizes.concat( e.families[ f ] );
	});
	sizes = sizes.filter( function uniq( n, i ) {
		return sizes.indexOf( n ) === i;
	}).sort( function cmp( a, b ) {
		return a - b;
	});
	return sizes.map( function each( n ) {
		return cell( P, ctx, randi, 'E2', 'E2.n' + n, tierOf( P, n, n, n ).r, 'n=' + n, function mk() {
			return e.algs.map( function alg( a ) {
				return sq( P, ctx, 'E2', a, n );
			});
		});
	});
};

BUILDERS.E3 = function buildE3( P, ctx, randi ) {
	var e = P.E3;
	return e.sizes.map( function each( n ) {
		var r = e.r_by_n[ String( n ) ] || e.r_by_n[ 'default' ];
		return cell( P, ctx, randi, 'E3', 'E3.n' + n, r, 'n=' + n, function mk() {
			var specs = [];
			e.ld_pads.forEach( function pad( ld ) {
				e.algs.forEach( function alg( a ) {
					specs.push( sq( P, ctx, 'E3', a, n, { 'ld_pad': ld } ) );
				});
			});
			e.extra.forEach( function extra( x ) {
				specs.push( sq( P, ctx, 'E3', x.alg, n, { 'ld_pad': x.ld_pad } ) );
			});
			return specs;
		});
	});
};

BUILDERS.E5 = function buildE5( P, ctx, randi ) {
	var e = P.E5;
	var lay = e.layouts;
	function pairs( experiment, n, variants ) {
		var specs = [];
		variants.forEach( function each( v ) {
			e.algs.forEach( function alg( a ) {
				specs.push( sq( P, ctx, experiment, a, n, v ) );
			});
		});
		return specs;
	}
	var cells = [ cell( P, ctx, randi, 'E5.layout', 'E5.layout.n' + lay.n, e.r, 'layouts n=' + lay.n, function mk() {
		return pairs( 'E5.layout', lay.n, lay.combos );
	}) ];
	e.alpha_beta.sizes.forEach( function each( n ) {
		cells.push( cell( P, ctx, randi, 'E5.alphabeta', 'E5.alphabeta.n' + n, e.r, 'alpha/beta n=' + n, function mk() {
			return pairs( 'E5.alphabeta', n, e.alpha_beta.values );
		}) );
	});
	e.rect.shapes.forEach( function each( s ) {
		var key = shapeKey( s[ 0 ], s[ 1 ], s[ 2 ] );
		cells.push( cell( P, ctx, randi, 'E5.rect', 'E5.rect.' + key, e.r, 'rect ' + key, function mk() {
			return e.algs.map( function alg( a ) {
				return makeSpec( P, ctx, { 'experiment': 'E5.rect', 'alg': a, 'M': s[ 0 ], 'N': s[ 1 ], 'K': s[ 2 ] } );
			});
		}) );
	});
	return cells;
};

BUILDERS.E4 = function buildE4( P, ctx, randi ) {
	var e = P.E4;
	return e.sizes.map( function each( n ) {
		return cell( P, ctx, randi, 'E4', 'E4.n' + n, e.r || tierOf( P, n, n, n ).r, 'n=' + n, function mk() {
			var specs = e.leaf_sizes.map( function leaf( l ) { // levels uncapped: the full recursion depth at (n, leaf)
				return sq( P, ctx, 'E4', e.alg, n, { 'params': { 'cutoff': l, 'levels': budget.depth( n, n, n, l, 64 ) } } );
			});
			if ( e.include_A0 ) {
				specs.push( sq( P, ctx, 'E4', 'A0', n ) );
			}
			return specs;
		});
	});
};

BUILDERS.E0 = function buildE0( P, ctx, randi ) {
	var e = P.E0;
	return e.sizes.map( function each( n ) {
		var pads = e.ld_pads_at[ String( n ) ] || [ 0 ];
		return cell( P, ctx, randi, 'E0', 'E0.n' + n, e.r, 'n=' + n, function mk() {
			var specs = [];
			e.orders.forEach( function order( o ) {
				e.trans.forEach( function trans( t ) {
					pads.forEach( function pad( ld ) {
						specs.push( sq( P, ctx, 'E0', e.alg, n, { 'order': o, 'transA': t[ 0 ], 'transB': t[ 1 ], 'ld_pad': ld } ) );
					});
				});
			});
			return specs;
		});
	});
};

/**
* Returns the sentinel process specification (A0 at the sentinel size, fixed seed and batch).
*
* @param {Object} P - effective protocol
* @returns {Object} spec
*/
function sentinelSpec( P ) {
	var s = P.sentinel;
	var d = P.timing.defaults;
	return {
		'stage': null,
		'experiment': 'sentinel',
		'block_id': null,
		'pos_in_block': -1,
		'alg': s.alg,
		'params': { 'cutoff': null, 'levels': null },
		'M': s.n,
		'N': s.n,
		'K': s.n,
		'order': d.order,
		'transA': d.transA,
		'transB': d.transB,
		'ld_pad': s.ld_pad,
		'alpha': 1,
		'beta': 0,
		'seed': s.seed,
		'batch': s.batch,
		'k': s.k,
		'warmup_calls': s.warmup_calls,
		'warmup_min_seconds': s.warmup_min_seconds,
		'warmup_target_invocations': s.warmup_target_invocations,
		'warmup_max_seconds': s.warmup_max_seconds,
		'mode': 'timing',
		'meta': { 'pause_s': P.timing.pause_s, 'tier': 'sentinel', 'shape': shapeKey( s.n, s.n, s.n ), 'rep': null }
	};
}

/**
* Builds one post-freeze timing stage (E2, E3, E5, E4 or E0).
*
* @param {Object} P - effective protocol
* @param {Object} frozen - `{ tau_star, levels, batch_by_n }`
* @param {string} stage - stage name
* @returns {Object} design
*/
function buildStage( P, frozen, stage ) {
	var randi = rng( deriveSeed( P.master_seed, 'order', stage ) );
	var ctx = context( P, stage, frozen );
	return { 'stage': stage, 'blocks': rounds( BUILDERS[ stage ]( P, ctx, randi ), randi ), 'sentinel': sentinelSpec( P ) };
}

/**
* Builds E7 (§9): one block per replicate holding every (algorithm, n, β) memory process.
*
* @param {Object} P - effective protocol
* @param {Object} frozen - frozen parameters
* @returns {Object} design (no sentinels)
*/
function buildMemory( P, frozen ) {
	var e = P.E7;
	var randi = rng( deriveSeed( P.master_seed, 'order', 'E7' ) );
	var ctx = context( P, 'E7', frozen );
	var c = cell( P, ctx, randi, 'E7', 'E7', e.r, 'memory', function mk() {
		var specs = [];
		e.algs.forEach( function alg( a ) {
			e.sizes.forEach( function size( n ) {
				e.betas.forEach( function beta( b ) {
					specs.push( sq( P, ctx, 'E7', a, n, { 'beta': b, 'mode': 'memory' } ) );
				});
			});
		});
		return specs;
	});
	return { 'stage': 'E7', 'blocks': rounds( [ c ], randi ), 'sentinel': null };
}

/**
* Builds every design in run order: pilot, E2, E3, E5, E4, E0, E7.
*
* @param {Object} P - effective protocol
* @param {Object} frozen - frozen parameters (or a stub with an assumed τ for budgeting)
* @returns {Array<Object>} designs
*/
function buildAll( P, frozen ) {
	return [ buildPilot( P ) ].concat( TIMING_STAGES.map( function each( s ) {
		return buildStage( P, frozen, s );
	}), [ buildMemory( P, frozen ) ] );
}


// EXPORTS //

module.exports = {
	'PROTOCOL_PATH': PROTOCOL_PATH,
	'TIMING_STAGES': TIMING_STAGES,
	'loadProtocol': loadProtocol,
	'effective': effective,
	'deriveSeed': deriveSeed,
	'rng': rng,
	'shuffle': shuffle,
	'median': median,
	'shapeKey': shapeKey,
	'tierOf': tierOf,
	'sentinelSpec': sentinelSpec,
	'buildPilot': buildPilot,
	'buildStage': buildStage,
	'buildMemory': buildMemory,
	'buildAll': buildAll
};
