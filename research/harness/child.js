'use strict';

/*
* Child process of the timing harness (protocol §4): one configuration in a fresh V8 instance.
*
*   node --expose-gc research/harness/child.js '<cfgJSON>'
*
* stdout: `MEASURE_START` (right before the timed samples), then exactly one line `RESULT {json}` — timing mode:
* `{proc, samples}`; memory mode (`cfg.mode = 'memory'`, see memory.js): `{mem}`. With `cfg.sample_markers` (JIT
* diagnostics only) the child also writes `SAMPLE <i>` before sample i and `MEASURE_END` after the last sample.
* On failure there is no RESULT line;
* stderr gets `child: <message>` (plus `FAIL {json}` for gate failures) and the exit code is 2 (invalid config or
* invocation), 3 (gate, end-gate or sink failure) or 1 (any other error). Output uses fs.writeSync on fds 1/2
* (process.stdout is never touched), so lines are synchronous and ordered on pipes; process.exit is never called.
*/

// MODULES //

var fs = require( 'fs' );
var path = require( 'path' );
var v8 = require( 'v8' );
var algorithms = require( './algorithms.js' );
var flags = require( './flags.js' );


// VARIABLES //

var ORDERS = [ 'row-major', 'column-major' ];
var TRANS = [ 'no-transpose', 'transpose' ];
var MODES = [ 'timing', 'memory' ];
var ECHO = [ 'campaign', 'stage', 'experiment', 'block_id', 'pos_in_block', 'proc_id' ];
var REQUIRED = [ 'alg', 'M', 'N', 'K', 'order', 'transA', 'transB', 'ld_pad', 'alpha', 'beta', 'seed', 'batch', 'k' ];
var PROC_FROM_CFG = ECHO.concat( [ 'alg', 'params', 'M', 'N', 'K', 'order', 'transA', 'transB', 'ld_pad', 'alpha', 'beta', 'seed', 'batch', 'k', 'warmup_calls', 'warmup_min_seconds', 'warmup_target_invocations', 'warmup_max_seconds' ] ); // eslint-disable-line max-len
var DEFAULT_WARMUP_CALLS = 3;
var DEFAULT_WARMUP_MIN_S = 0.25; // protocol.json timing.warmup_min_seconds
var DEFAULT_WARMUP_TARGET_INV = 4000; // protocol.json timing.warmup_target_invocations (V8 compiles the dgemm entry after ~3000 invocations)
var DEFAULT_WARMUP_MAX_S = 2.0; // protocol.json timing.warmup_max_seconds (cap of the invocation target)
var MAX_WARMUP_MIN_S = 60;
var MAX_WARMUP_CALLS = 100000; // safety cap of the time-based warmup (never reached for n ≥ 32: ~5000 calls at n = 32)
var SINK_STRIDE = 7919;
var MAX_DIM = 65536;
var MAX_ELEMENTS = 134217728; // 1 GiB per matrix
var EXIT_ERROR = 1;
var EXIT_CONFIG = 2;
var EXIT_GATE = 3;


// FUNCTIONS //

// Writes a line synchronously to a file descriptor (retrying on EAGAIN for non-blocking pipes).
function writeLine( fd, str ) {
	var buf = Buffer.from( str + '\n', 'utf8' );
	var off = 0;
	while ( off < buf.length ) {
		try {
			off += fs.writeSync( fd, buf, off, buf.length - off );
		} catch ( err ) {
			if ( err.code !== 'EAGAIN' ) {
				throw err;
			}
		}
	}
}

/**
* Writes a line to stdout (synchronously, via fd 1).
*
* @param {string} str - line without the trailing newline
*/
function stdoutLine( str ) {
	writeLine( 1, str );
}

// Returns an error reported as a configuration/invocation error (exit code 2, no stack trace).
function configError( msg, kind ) {
	var err = new Error( 'invalid ' + ( kind || 'config' ) + ': ' + msg );
	err.code = 'ECONFIG';
	return err;
}

function isIntIn( v, lo, hi ) {
	return ( typeof v === 'number' && Math.floor( v ) === v && v >= lo && v <= hi );
}

/**
* Validates and normalizes a child configuration (system boundary).
*
* ## Notes
*
* -   Required: `alg, M, N, K, order, transA, transB, ld_pad, alpha, beta, seed, batch, k` (`k` may be 0 in memory mode, where `batch` and `k` are ignored).
* -   Defaults: `warmup_calls = 3`, `warmup_min_seconds = 0.25`, `sample_markers = false`, `mode = 'timing'`, `repoRoot` = the repository containing this file, echo fields (`campaign, stage, experiment, block_id, pos_in_block, proc_id`) = `null`. `params` is stored resolved (`algorithms.resolveParams`). Unknown keys (e.g. `meta`) are ignored.
*
* @param {(string|Object)} input - JSON string or object
* @throws {Error} invalid configuration (`code = 'ECONFIG'`)
* @returns {Object} normalized configuration
*/
function parseConfig( input ) {
	var cfg = input;
	var out = {};
	var lay, i; // eslint-disable-line one-var

	if ( typeof input === 'string' ) {
		try {
			cfg = JSON.parse( input );
		} catch ( err ) {
			throw configError( 'not valid JSON (' + err.message + ')' );
		}
	}
	if ( cfg === null || typeof cfg !== 'object' || Array.isArray( cfg ) ) {
		throw configError( 'expected a JSON object' );
	}
	for ( i = 0; i < REQUIRED.length; i++ ) {
		if ( cfg[ REQUIRED[ i ] ] === void 0 ) {
			throw configError( 'missing field `' + REQUIRED[ i ] + '`' );
		}
	}
	ECHO.forEach( function echo( key ) {
		out[ key ] = ( cfg[ key ] === void 0 ) ? null : cfg[ key ];
	});
	if ( algorithms.ALGS.indexOf( cfg.alg ) < 0 ) {
		throw configError( '`alg` must be one of ' + algorithms.ALGS.join( ', ' ) + '; got ' + JSON.stringify( cfg.alg ) );
	}
	out.alg = cfg.alg;
	try {
		out.params = algorithms.resolveParams( cfg.alg, cfg.params );
	} catch ( err ) {
		throw configError( err.message );
	}
	[ 'M', 'N', 'K' ].forEach( function dim( key ) {
		if ( !isIntIn( cfg[ key ], 1, MAX_DIM ) ) {
			throw configError( '`' + key + '` must be an integer in [1, ' + MAX_DIM + ']; got ' + JSON.stringify( cfg[ key ] ) );
		}
		out[ key ] = cfg[ key ];
	});
	if ( ORDERS.indexOf( cfg.order ) < 0 ) {
		throw configError( '`order` must be one of ' + ORDERS.join( ', ' ) );
	}
	if ( TRANS.indexOf( cfg.transA ) < 0 || TRANS.indexOf( cfg.transB ) < 0 ) {
		throw configError( '`transA` and `transB` must be one of ' + TRANS.join( ', ' ) );
	}
	if ( !isIntIn( cfg.ld_pad, 0, MAX_DIM ) ) {
		throw configError( '`ld_pad` must be a nonnegative integer' );
	}
	if ( typeof cfg.alpha !== 'number' || !isFinite( cfg.alpha ) || typeof cfg.beta !== 'number' || !isFinite( cfg.beta ) ) {
		throw configError( '`alpha` and `beta` must be finite numbers' );
	}
	if ( !isIntIn( cfg.seed, 1, 4294967295 ) ) {
		throw configError( '`seed` must be an integer in [1, 2^32-1]; got ' + JSON.stringify( cfg.seed ) );
	}
	out.mode = ( cfg.mode === void 0 ) ? 'timing' : cfg.mode;
	if ( MODES.indexOf( out.mode ) < 0 ) {
		throw configError( '`mode` must be one of ' + MODES.join( ', ' ) );
	}
	if ( !isIntIn( cfg.batch, 1, 1e7 ) || !isIntIn( cfg.k, ( out.mode === 'timing' ) ? 1 : 0, 1e5 ) ) {
		throw configError( '`batch` must be a positive integer and `k` a positive integer (timing) or nonnegative (memory)' );
	}
	out.warmup_calls = ( cfg.warmup_calls === void 0 ) ? DEFAULT_WARMUP_CALLS : cfg.warmup_calls;
	if ( !isIntIn( out.warmup_calls, 0, 1000 ) ) {
		throw configError( '`warmup_calls` must be an integer in [0, 1000]' );
	}
	out.warmup_min_seconds = ( cfg.warmup_min_seconds === void 0 ) ? DEFAULT_WARMUP_MIN_S : cfg.warmup_min_seconds;
	if ( typeof out.warmup_min_seconds !== 'number' || !( out.warmup_min_seconds >= 0 && out.warmup_min_seconds <= MAX_WARMUP_MIN_S ) ) {
		throw configError( '`warmup_min_seconds` must be a number in [0, ' + MAX_WARMUP_MIN_S + ']' );
	}
	out.warmup_target_invocations = ( cfg.warmup_target_invocations === void 0 ) ? DEFAULT_WARMUP_TARGET_INV : cfg.warmup_target_invocations;
	if ( !isIntIn( out.warmup_target_invocations, 0, 1e7 ) ) {
		throw configError( '`warmup_target_invocations` must be an integer in [0, 1e7]' );
	}
	out.warmup_max_seconds = ( cfg.warmup_max_seconds === void 0 ) ? DEFAULT_WARMUP_MAX_S : cfg.warmup_max_seconds;
	if ( typeof out.warmup_max_seconds !== 'number' || !( out.warmup_max_seconds >= 0 && out.warmup_max_seconds <= MAX_WARMUP_MIN_S ) ) {
		throw configError( '`warmup_max_seconds` must be a number in [0, ' + MAX_WARMUP_MIN_S + ']' );
	}
	out.sample_markers = ( cfg.sample_markers === void 0 ) ? false : cfg.sample_markers;
	if ( typeof out.sample_markers !== 'boolean' ) {
		throw configError( '`sample_markers` must be a boolean' );
	}
	out.repoRoot = ( cfg.repoRoot === void 0 || cfg.repoRoot === null ) ? algorithms.DEFAULT_REPO_ROOT : cfg.repoRoot;
	if ( typeof out.repoRoot !== 'string' || !path.isAbsolute( out.repoRoot ) ) {
		throw configError( '`repoRoot` must be an absolute path' );
	}
	[ 'order', 'transA', 'transB', 'ld_pad', 'alpha', 'beta', 'seed', 'batch', 'k' ].forEach( function copy( key ) {
		out[ key ] = cfg[ key ];
	});
	lay = algorithms.layout( out );
	if ( lay.A.len > MAX_ELEMENTS || lay.B.len > MAX_ELEMENTS || lay.C.len > MAX_ELEMENTS ) {
		throw configError( 'matrices exceed ' + MAX_ELEMENTS + ' elements' );
	}
	return out;
}

// Returns a gate error (exit code 3) carrying a machine-readable `info` object for the `FAIL` line.
function gateError( stage, res, cfg ) {
	var err = new Error( stage + ' failed: ' + JSON.stringify( res ) );
	err.code = 'EGATE';
	err.info = { 'stage': stage, 'check': res, 'proc_id': cfg.proc_id, 'alg': cfg.alg, 'mode': cfg.mode, 'M': cfg.M, 'N': cfg.N, 'K': cfg.K, 'pid': process.pid }; // eslint-disable-line max-len
	return err;
}

// Storage offsets of the anti-DCE sink reads C[(i*7919) mod (M*N)], numbered logically row-major (padding never read).
function sinkOffsets( prob, k ) {
	var out = [];
	var idx;
	var i;
	for ( i = 0; i < k; i++ ) {
		idx = ( i*SINK_STRIDE ) % ( prob.M*prob.N );
		out.push( ( Math.floor( idx/prob.N )*prob.layout.sc1 ) + ( ( idx%prob.N )*prob.layout.sc2 ) );
	}
	return out;
}

function record( procId, i, batch, tns, wall, cpu, ru0, ru1, gcs ) {
	var stats = ( gcs && gcs.statistics ) ? gcs.statistics : [];
	var cost = 0.0;
	var j;
	for ( j = 0; j < stats.length; j++ ) {
		cost += stats[ j ].cost;
	}
	return {
		'proc_id': procId,
		'i': i,
		'batch': batch,
		't_ns': tns,
		'per_call_ns': tns / batch,
		'wall_ns': wall,
		'cpu_us': cpu.user + cpu.system,
		'minflt': ru1.minorPageFault - ru0.minorPageFault,
		'majflt': ru1.majorPageFault - ru0.majorPageFault,
		'ivcsw': ru1.involuntaryContextSwitches - ru0.involuntaryContextSwitches,
		'gc_n': stats.length,
		'gc_us': cost,
		'flags': []
	};
}

// Returns a lower bound on the number of dgemm invocations per call (7^L for SW, 8^L for C2, 1 otherwise; peeling calls
// are not counted), used by the warmup's invocation target.
function invocationsPerCall( alg, depth ) {
	if ( depth === null || depth === void 0 ) {
		return 1;
	}
	return Math.pow( ( alg === 'C2' ) ? 8 : 7, depth );
}

// Untimed full-size warmup calls (C₀ restored before each when β ≠ 0) until at least `warmup_calls` calls were made AND
// at least `warmup_min_seconds` elapsed since the first one started AND (the arm made at least
// `warmup_target_invocations` dgemm invocations OR `warmup_max_seconds` elapsed), so V8 also compiles the shared dgemm
// entry point (after ~3000 invocations) before the samples (protocol §4, §12); at most MAX_WARMUP_CALLS calls.
// Returns every call duration and the elapsed time (ns).
function warmup( cfg, prob, f, inv ) {
	var minNs = cfg.warmup_min_seconds * 1.0e9;
	var maxNs = cfg.warmup_max_seconds * 1.0e9;
	var ns = [];
	var t0 = process.hrtime.bigint();
	var t1 = t0;
	var t;
	while (
		(
			ns.length < cfg.warmup_calls ||
			Number( t1 - t0 ) < minNs ||
			( ns.length*inv < cfg.warmup_target_invocations && Number( t1 - t0 ) < maxNs )
		) &&
		ns.length < MAX_WARMUP_CALLS
	) {
		if ( prob.C0 ) {
			prob.C.set( prob.C0 );
		}
		t = process.hrtime.bigint();
		f();
		t1 = process.hrtime.bigint();
		ns.push( Number( t1 - t ) );
	}
	return { 'ns': ns, 'elapsed_ns': Number( t1 - t0 ) };
}

// Takes the k samples of `batch` calls. β = 0: one timed region per sample. β ≠ 0: C₀ is restored untimed before every
// call and t_ns sums the per-call timed regions (wall_ns covers the whole sample). resourceUsage, cpuUsage, the
// GCProfiler start/stop and the optional diagnostics markers (`mark`) lie outside the timed regions.
function measure( cfg, prob, f, mark ) {
	var offs = sinkOffsets( prob, cfg.k );
	var samples = [];
	var sink = 0.0;
	var C0 = prob.C0;
	var C = prob.C;
	var b = cfg.batch;
	var wall, prof, ru0, cu0, tns, t0, t1, w0, si, i, j; // eslint-disable-line one-var

	for ( i = 0; i < cfg.k; i++ ) {
		if ( mark ) {
			mark( 'SAMPLE ' + i );
		}
		si = offs[ i ];
		if ( C0 === null && i === cfg.k-1 ) {
			// β = 0: refill C with NaN (untimed) before the last sample, so the end gate also catches an algorithm which stopped writing C after an earlier call (protocol §12, amendment 2026-10-30b):
			C.fill( NaN );
		}
		ru0 = process.resourceUsage();
		cu0 = process.cpuUsage();
		prof = new v8.GCProfiler();
		prof.start();
		if ( C0 === null ) {
			t0 = process.hrtime.bigint();
			for ( j = 0; j < b; j++ ) {
				f();
				sink += C[ si ];
			}
			t1 = process.hrtime.bigint();
			tns = Number( t1 - t0 );
			wall = tns;
		} else {
			tns = 0;
			w0 = process.hrtime.bigint();
			for ( j = 0; j < b; j++ ) {
				C.set( C0 ); // untimed restore of C₀
				t0 = process.hrtime.bigint();
				f();
				sink += C[ si ];
				t1 = process.hrtime.bigint();
				tns += Number( t1 - t0 );
			}
			wall = Number( process.hrtime.bigint() - w0 );
		}
		prof = prof.stop();
		samples.push( record( cfg.proc_id, i, b, tns, wall, process.cpuUsage( cu0 ), ru0, process.resourceUsage(), prof ) );
	}
	if ( mark ) {
		mark( 'MEASURE_END' );
	}
	return { 'samples': samples, 'sink': sink };
}

/**
* Runs the timing procedure of protocol §4 for one configuration.
*
* ## Notes
*
* -   Seeded inputs → gate call (timed as `first_call_ns`, Freivalds-checked) → `gc()` → untimed full-size warmup calls until at least `warmup_calls` calls AND at least `warmup_min_seconds` have elapsed (every duration in `warmup_ns`, the count in `warmup_calls_effective`, the elapsed time in `warmup_elapsed_ns`) → `gc()` → `MEASURE_START` → `k` samples → end gate on the output of the last call → flags and summary (`flags.js`). With `β ≠ 0`, `C₀` is restored untimed before every call (gate, warmup and timed calls). With `β = 0`, `C` is refilled with `NaN` (untimed) before the last sample, so a stale `C` cannot pass the end gate.
* -   With `sample_markers` (JIT diagnostics only), `SAMPLE <i>` is written before sample i and `MEASURE_END` after the last sample (same writer as `MEASURE_START`, outside the timed regions).
*
* @param {Object} cfg - normalized configuration (see `parseConfig`)
* @param {Object} [opts] - injection points (tests)
* @param {Function} [opts.gc] - garbage collector (default: `global.gc`)
* @param {Function} [opts.create] - closure factory (default: `algorithms.create`)
* @param {Function} [opts.out] - line writer for `MEASURE_START` and the `sample_markers` lines (default: stdout)
* @throws {Error} gate failure (`code = 'EGATE'`), missing `--expose-gc` (`code = 'ECONFIG'`)
* @returns {Object} `{proc, samples}`
*/
function timing( cfg, opts ) {
	var params = cfg.params;
	var stats, first, setup, prob, warm, gate, proc, end, res, lib, out, inv, gc, f, t; // eslint-disable-line one-var

	opts = opts || {};
	out = opts.out || stdoutLine;
	gc = opts.gc || global.gc;
	if ( typeof gc !== 'function' ) {
		throw configError( 'timing mode requires --expose-gc', 'invocation' );
	}
	lib = algorithms.library( cfg.repoRoot );
	t = process.hrtime.bigint();
	prob = algorithms.createProblem( cfg );
	setup = Number( process.hrtime.bigint() - t );
	f = ( opts.create || algorithms.create )( cfg.alg, params, prob, lib );

	// Gate call (timed as the first call), then the Freivalds check:
	if ( prob.C0 ) {
		prob.C.set( prob.C0 );
	}
	t = process.hrtime.bigint();
	f();
	first = Number( process.hrtime.bigint() - t );
	gate = algorithms.check( prob );
	if ( !gate.pass ) {
		throw gateError( 'gate', gate, cfg );
	}
	gc();

	// Untimed warmup (count-, time- and invocation-based; gc() discards OSR code, so short calls need many calls to tier up):
	inv = invocationsPerCall( cfg.alg, algorithms.depthOf( cfg.alg, params, cfg.M, cfg.N, cfg.K, lib ) );
	warm = warmup( cfg, prob, f, inv );
	gc();

	out( 'MEASURE_START' );
	res = measure( cfg, prob, f, ( cfg.sample_markers ) ? out : null );

	end = algorithms.check( prob );
	if ( !end.pass ) {
		throw gateError( 'end_gate', end, cfg );
	}
	if ( res.sink !== res.sink ) { // eslint-disable-line no-self-compare
		throw gateError( 'sink', { 'sink': null }, cfg );
	}
	stats = flags.annotate( res.samples );
	proc = {};
	PROC_FROM_CFG.forEach( function copy( key ) {
		proc[ key ] = cfg[ key ];
	});
	proc.depth = algorithms.depthOf( cfg.alg, params, cfg.M, cfg.N, cfg.K, lib );
	proc.lda = prob.layout.lda;
	proc.ldb = prob.layout.ldb;
	proc.ldc = prob.layout.ldc;
	proc.exec_argv = process.execArgv;
	proc.node_options = process.env.NODE_OPTIONS || '';
	proc.env_pad_bytes = ( typeof process.env.BENCH_PAD === 'string' ) ? Buffer.byteLength( process.env.BENCH_PAD ) : null;
	proc.pid = process.pid;
	proc.setup_ns = setup;
	proc.first_call_ns = first;
	proc.warmup_ns = warm.ns;
	proc.warmup_calls_effective = warm.ns.length;
	proc.warmup_elapsed_ns = warm.elapsed_ns;
	proc.warmup_invocations_per_call = inv;
	proc.warmup_invocations_est = warm.ns.length * inv;
	proc.warmup_target_met = ( warm.ns.length * inv >= cfg.warmup_target_invocations );
	proc.gate = gate;
	proc.end_gate = end;
	proc.sink = res.sink;
	proc.max_rss_kib = process.resourceUsage().maxRSS;
	Object.keys( stats ).forEach( function copy( key ) { // per_call_median_ns, first_sample_ratio, flags, flag_counts, excluded, exclusion_reason
		proc[ key ] = stats[ key ];
	});
	return { 'proc': proc, 'samples': res.samples };
}

/**
* Reports a failure on stderr and sets `process.exitCode` (2 config/invocation, 3 gate, 1 other).
*
* @param {Error} err - error
*/
function fail( err ) {
	var code = EXIT_ERROR;
	if ( err.code === 'ECONFIG' ) {
		code = EXIT_CONFIG;
	} else if ( err.code === 'EGATE' ) {
		code = EXIT_GATE;
	}
	writeLine( 2, 'child: ' + ( ( code === EXIT_ERROR ) ? ( err.stack || String( err ) ) : err.message ) );
	if ( err.info ) {
		writeLine( 2, 'FAIL ' + JSON.stringify( err.info ) );
	}
	process.exitCode = code;
}

/**
* Command-line entry point.
*
* @param {StringArray} argv - `process.argv`
*/
function main( argv ) {
	var cfg;
	var res;
	try {
		if ( argv.length < 3 ) {
			throw configError( 'usage: node --expose-gc research/harness/child.js <cfgJSON>', 'invocation' );
		}
		cfg = parseConfig( argv[ 2 ] );
		if ( cfg.mode === 'memory' ) {
			res = require( './memory.js' ).run( cfg );
		} else {
			res = timing( cfg );
		}
		stdoutLine( 'RESULT ' + JSON.stringify( res ) );
	} catch ( err ) {
		fail( err );
	}
}


// EXPORTS //

module.exports = {
	'annotate': flags.annotate,
	'fail': fail,
	'invocationsPerCall': invocationsPerCall,
	'main': main,
	'parseConfig': parseConfig,
	'quantile': flags.quantile,
	'stdoutLine': stdoutLine,
	'timing': timing
};

if ( require.main === module ) {
	main( process.argv );
}
