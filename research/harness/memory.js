/**
* @license Apache-2.0
*
* Copyright (c) 2026 The Stdlib Authors.
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*    http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

/* eslint-disable max-len */

'use strict';

// Memory measurement E7 (protocol §9), one call in a fresh process. Normally reached through
//   node --expose-gc research/harness/child.js '{"mode":"memory", ...}'
// and also runnable directly as `node --expose-gc research/harness/memory.js '<cfgJSON>'` (mode forced to memory).
// Prints `RESULT {"mem": {...}}`. ΔarrayBuffers (ab1 − ab0) is valid for single-allocation arms when read immediately on return, regardless of GCs during the call (protocol §12, amendment 2026-10-30b item 2; gc_during_call is recorded); ΔmaxRSS only in a
// fresh process (rss0 vs maxrss0_kib shows how much earlier peaks can mask it).

// MODULES //

var v8 = require( 'v8' );
var algorithms = require( './algorithms.js' );


// FUNCTIONS //

/**
* Returns a memory snapshot.
*
* @private
* @returns {Object} `{ab, rss, heap, maxrss_kib}` (bytes, except `maxrss_kib`)
*/
function snapshot() {
	var mu = process.memoryUsage();
	return {
		'ab': mu.arrayBuffers,
		'rss': mu.rss,
		'heap': mu.heapUsed,
		'maxrss_kib': process.resourceUsage().maxRSS
	};
}

/**
* Runs the memory procedure for one configuration.
*
* ## Notes
*
* -   Allocate and touch A, B, C (and the C₀ copy when `β ≠ 0`) → `gc()` → snapshot (`memoryUsage`, `maxRSS`) → one call under `v8.GCProfiler` → snapshot → `gc()` → snapshot → Freivalds gate (after all snapshots, so its temporaries are not measured). Each `gc()` is issued twice so that V8's concurrent ArrayBuffer sweeping has finished when `arrayBuffers` is read.
* -   `analytic_bytes` = `algorithms.analyticBytes` (8·E1, +8·M·N when `β ≠ 0`; 8·K·N for C1; 0 for A0, SENTINEL and C2).
*
* @param {Object} cfg - normalized configuration (see `child.parseConfig`)
* @param {Object} [opts] - options
* @param {Function} [opts.gc] - garbage collector (default: `global.gc`)
* @throws {Error} missing `--expose-gc`, or gate failure (`code = 'EGATE'`)
* @returns {Object} `{mem}`
*/
function run( cfg, opts ) {
	var params;
	var prob;
	var gate;
	var prof;
	var stats;
	var cost;
	var lib;
	var err;
	var gc;
	var s0;
	var s1;
	var s2;
	var t0;
	var t1;
	var f;
	var i;

	gc = ( opts && opts.gc ) || global.gc;
	if ( typeof gc !== 'function' ) {
		err = new Error( 'invalid invocation: memory mode requires --expose-gc' );
		err.code = 'ECONFIG';
		throw err;
	}
	lib = algorithms.library( cfg.repoRoot );
	params = cfg.params;
	prob = algorithms.createProblem( cfg );
	f = algorithms.create( cfg.alg, params, prob, lib );

	gc();
	gc(); // the second collection first completes V8's concurrent ArrayBuffer sweep of the first
	s0 = snapshot();
	prof = new v8.GCProfiler();
	prof.start();
	t0 = process.hrtime.bigint();
	f();
	s1 = snapshot(); // read before any allocation: a GC after the return could free the (now dead) workspace first
	t1 = process.hrtime.bigint();
	stats = prof.stop().statistics;
	gc();
	gc();
	s2 = snapshot();

	gate = algorithms.check( prob );
	if ( !gate.pass ) {
		err = new Error( 'gate failed: ' + JSON.stringify( gate ) );
		err.code = 'EGATE';
		err.info = {
			'stage': 'gate',
			'check': gate,
			'proc_id': cfg.proc_id,
			'alg': cfg.alg,
			'mode': 'memory',
			'pid': process.pid
		};
		throw err;
	}
	cost = 0.0;
	for ( i = 0; i < stats.length; i++ ) {
		cost += stats[ i ].cost;
	}
	return {
		'mem': {
			'campaign': cfg.campaign,
			'proc_id': cfg.proc_id,
			'stage': cfg.stage,
			'experiment': cfg.experiment,
			'block_id': cfg.block_id,
			'pos_in_block': cfg.pos_in_block,
			'alg': cfg.alg,
			'params': params,
			'depth': algorithms.depthOf( cfg.alg, params, cfg.M, cfg.N, cfg.K, lib ),
			'n': ( cfg.M === cfg.N && cfg.N === cfg.K ) ? cfg.M : null,
			'M': cfg.M,
			'N': cfg.N,
			'K': cfg.K,
			'order': cfg.order,
			'transA': cfg.transA,
			'transB': cfg.transB,
			'ld_pad': cfg.ld_pad,
			'alpha': cfg.alpha,
			'beta': cfg.beta,
			'seed': cfg.seed,
			'ab0': s0.ab,
			'ab1': s1.ab,
			'ab2': s2.ab,
			'gc_during_call': stats.length,
			'gc_us': cost,
			'maxrss0_kib': s0.maxrss_kib,
			'maxrss1_kib': s1.maxrss_kib,
			'maxrss2_kib': s2.maxrss_kib,
			'rss0': s0.rss,
			'rss1': s1.rss,
			'rss2': s2.rss,
			'heap0': s0.heap,
			'heap1': s1.heap,
			'heap2': s2.heap,
			'analytic_bytes': algorithms.analyticBytes( cfg.alg, params, prob, lib ),
			'call_ns': Number( t1 - t0 ),
			'gate': gate,
			'exec_argv': process.execArgv,
			'env_pad_bytes': ( typeof process.env.BENCH_PAD === 'string' ) ? Buffer.byteLength( process.env.BENCH_PAD ) : null,
			'pid': process.pid
		}
	};
}

/**
* Command-line entry point (mode forced to `memory`).
*
* @private
* @param {StringArray} argv - `process.argv`
*/
function main( argv ) {
	var child = require( './child.js' );
	var cfg;
	try {
		cfg = JSON.parse( argv[ 2 ] || 'null' );
		if ( cfg && typeof cfg === 'object' ) {
			cfg.mode = 'memory';
		}
	} catch ( err ) {
		cfg = argv[ 2 ]; // let parseConfig report the JSON error
	}
	try {
		cfg = child.parseConfig( cfg );
		child.stdoutLine( 'RESULT ' + JSON.stringify( run( cfg ) ) );
	} catch ( err ) {
		child.fail( err );
	}
}


// EXPORTS //

module.exports = {
	'run': run
};

if ( require.main === module ) {
	main( process.argv );
}
