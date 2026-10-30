'use strict';

/*
* Child-process launcher of the harness and the JIT diagnostics (research-protocol.md §4 "Diagnostics").
*
* -   `spawnChild` runs `node <flags> child.js <cfgJSON>` with the minimal env {PATH, HOME, LANG=C, BENCH_PAD} via
*     spawnSync (the caller stays idle) and parses the single `RESULT ` line.
* -   `run` traces child.js with the protocol.json `diagnostics.flags` for A0 and A2 and asserts that after the child's
*     MEASURE_START line no compile/optimize/OSR/deopt event names an element-loop kernel (`functions`: blocked,
*     naive, ddot, zeros, scal, add, sub, maxAbs, axpby, packed). Events of the call-only drivers and wrappers
*     (`report_only`: winograd, dgemm, resolve, str2enum, ...) are reported with their count and first sample index
*     (the child writes `SAMPLE <i>` markers) but never fail; so are element-loop kernels inlined into a function
*     compiled after the marker (`--trace-turbo-inlining`, e.g. `blocked` into `dgemm`). Trace parsing: jittrace.js.
*     Every run writes the raw traces and a machine-readable `summary.json` to its output directory. Diagnostic
*     processes are never timed.
*/

// MODULES //

var spawnSync = require( 'child_process' ).spawnSync;
var fs = require( 'fs' );
var os = require( 'os' );
var path = require( 'path' );
var budget = require( './budget.js' );
var design = require( './design.js' );
var jittrace = require( './jittrace.js' );


// VARIABLES //

var REPO = path.resolve( __dirname, '..', '..' );
var CFG_FIELDS = [ 'alg', 'params', 'M', 'N', 'K', 'order', 'transA', 'transB', 'ld_pad', 'alpha', 'beta', 'seed', 'batch', 'k', 'warmup_calls', 'warmup_min_seconds', 'warmup_target_invocations', 'warmup_max_seconds' ]; // eslint-disable-line max-len
var MAX_DIAG_N = 65536;


// FUNCTIONS //

/**
* Returns the minimal child environment: PATH, HOME, LANG=C and BENCH_PAD of `pad` characters (no NODE_OPTIONS).
*
* @param {NonNegativeInteger} pad - BENCH_PAD length (null: no BENCH_PAD)
* @returns {Object} environment
*/
function childEnv( pad ) {
	var env = { 'PATH': process.env.PATH || '/usr/bin:/bin', 'HOME': process.env.HOME || os.homedir(), 'LANG': 'C' };
	if ( pad !== null ) {
		env.BENCH_PAD = 'x'.repeat( pad );
	}
	return env;
}

/**
* Returns the configuration fields of a process specification (the fields a child reproduces); fields the
* specification does not define are left out, so the child's default (and its echo in the record) applies.
*
* @param {Object} spec - process specification
* @returns {Object} fields
*/
function cfgFields( spec ) {
	var out = {};
	CFG_FIELDS.forEach( function each( k ) {
		if ( spec[ k ] !== void 0 ) {
			out[ k ] = spec[ k ];
		}
	});
	return out;
}

/**
* Spawns one child process and parses its `RESULT ` line.
*
* @param {string} script - child script (absolute path)
* @param {Array<string>} flags - Node flags (e.g. `['--expose-gc']`)
* @param {Object} cfg - child configuration (serialized as argv[2])
* @param {Object} o - `{ pad, timeoutS, maxBuffer }`
* @returns {Object} `{ result, error, stdout, stderr, status }` (`result` null on any failure)
*/
function spawnChild( script, flags, cfg, o ) {
	var r = spawnSync( process.execPath, flags.concat( [ script, JSON.stringify( cfg ) ] ), {
		'cwd': REPO,
		'env': childEnv( o.pad ),
		'encoding': 'utf8',
		'maxBuffer': o.maxBuffer || 268435456,
		'timeout': ( o.timeoutS ) ? o.timeoutS * 1000 : void 0,
		'killSignal': 'SIGKILL'
	});
	var lines = ( r.stdout || '' ).split( '\n' ).filter( function res( l ) {
		return l.indexOf( 'RESULT ' ) === 0;
	});
	var out = { 'result': null, 'error': null, 'stdout': r.stdout || '', 'stderr': r.stderr || '', 'status': r.status };
	if ( r.error ) {
		out.error = ( r.error.code === 'ETIMEDOUT' ) ? 'timeout after ' + Math.round( o.timeoutS ) + ' s' : r.error.message;
	} else if ( r.status !== 0 ) {
		out.error = 'exit ' + ( ( r.status === null ) ? r.signal : r.status ) + ': ' + out.stderr.trim().split( '\n' ).slice( -2 ).join( ' | ' ).slice( 0, 400 ); // eslint-disable-line max-len
	} else if ( lines.length !== 1 ) {
		out.error = lines.length + ' RESULT lines';
	} else {
		try {
			out.result = JSON.parse( lines[ 0 ].slice( 7 ) );
		} catch ( err ) {
			out.error = 'bad RESULT JSON: ' + err.message;
		}
	}
	return out;
}

/**
* Returns the first existing path of a list of repository-relative paths (absolute), or null.
*
* @param {(string|Array<string>)} list - path or paths
* @returns {(string|null)} absolute path
*/
function firstExisting( list ) {
	return [].concat( list ).map( function abs( p ) {
		return path.join( REPO, p );
	}).filter( function exists( p ) {
		return fs.existsSync( p );
	})[ 0 ] || null;
}

/**
* Runs a stage script (E6/E1) with the minimal env, its output inherited (it reaches the campaign log).
*
* @param {string} file - script (absolute path)
* @param {Array<string>} args - arguments
* @param {number} [timeoutS] - timeout in seconds (0/undefined: none)
* @returns {Object} `{ ok, error }`
*/
function runScript( file, args, timeoutS ) {
	var r = spawnSync( process.execPath, [ file ].concat( args ), { 'cwd': REPO, 'env': childEnv( null ), 'stdio': [ 'ignore', 'inherit', 'inherit' ], 'timeout': ( timeoutS ) ? timeoutS * 1000 : void 0, 'killSignal': 'SIGKILL' } ); // eslint-disable-line max-len
	return { 'ok': r.status === 0, 'error': ( r.status === 0 ) ? null : ( ( r.error ) ? r.error.message : 'exit ' + r.status ) };
}

/**
* Returns the fraction of samples carrying any of the given flags.
*
* @param {Array<Object>} samples - sample records (`flags` arrays)
* @param {Array<string>} flags - flags that count (e.g. `preempt`, `slow_mode`)
* @returns {number} fraction (0 without samples)
*/
function flaggedFraction( samples, flags ) {
	var n = samples.filter( function flagged( s ) {
		return Array.isArray( s.flags ) && s.flags.some( function f( x ) {
			return flags.indexOf( x ) >= 0;
		});
	}).length;
	return ( samples.length ) ? n / samples.length : 0;
}

/**
* Returns the interquartile range (linear interpolation) of finite values, or null.
*
* @param {Array<number>} x - values
* @returns {(number|null)} Q3 − Q1
*/
function iqr( x ) {
	var s = x.filter( Number.isFinite ).sort( function cmp( a, b ) {
		return a - b;
	});
	function q( p ) {
		var h = ( s.length - 1 ) * p;
		var lo = Math.floor( h );
		return s[ lo ] + ( ( s[ Math.ceil( h ) ] - s[ lo ] ) * ( h - lo ) );
	}
	return ( s.length ) ? q( 0.75 ) - q( 0.25 ) : null;
}

/**
* Runs one traced child (A0 or A2 at n, row-major NN, α=1, β=0, LD=n, `sample_markers` on) and analyzes it; the raw
* trace is saved.
*
* @param {Object} P - effective protocol
* @param {string} alg - 'A0' or 'A2'
* @param {PositiveInteger} n - size
* @param {PositiveInteger} tau - A2 cutoff
* @param {string} outDir - directory for the raw trace
* @returns {Object} `{ alg, n, tau, pass, reason, analysis, trace_file, k, batch, child }`
*/
function runOne( P, alg, n, tau, outDir ) {
	var D = P.diagnostics;
	var cfg = {
		'campaign': 'diagnostics', 'stage': 'diagnostics', 'experiment': 'diagnostics', 'block_id': 'diag.n' + n, 'pos_in_block': 0, // eslint-disable-line object-property-newline
		'proc_id': 'diag.' + alg + '.n' + n, 'alg': alg, 'M': n, 'N': n, 'K': n, // eslint-disable-line object-property-newline
		'params': ( alg === 'A2' ) ? { 'cutoff': tau, 'levels': P.algorithms.A2.levels } : { 'cutoff': null, 'levels': null },
		'order': 'row-major', 'transA': 'no-transpose', 'transB': 'no-transpose', 'ld_pad': 0, 'alpha': 1, 'beta': 0, // eslint-disable-line object-property-newline
		'seed': design.deriveSeed( P.master_seed, 'diagnostics', n ), 'batch': budget.modelBatch( P, n, n, n ), // eslint-disable-line object-property-newline
		'k': design.tierOf( P, n, n, n ).k, 'warmup_calls': P.timing.warmup_calls, 'warmup_min_seconds': P.timing.warmup_min_seconds, // eslint-disable-line object-property-newline
		'sample_markers': true, 'mode': 'timing', 'repoRoot': REPO // eslint-disable-line object-property-newline
	};
	var file = path.join( outDir, alg + '-n' + n + '.trace.txt' );
	var res = spawnChild( path.join( REPO, P.paths.child ), P.timing.child_flags.concat( D.flags ), cfg, {
		'pad': 0,
		'maxBuffer': 1073741824
	});
	var a = jittrace.analyze( res.stdout, { 'marker': D.marker, 'functions': D.functions, 'report_only': D.report_only } );
	var proc = ( res.result && res.result.proc ) || null;
	var reason = null;
	fs.writeFileSync( file, res.stdout + ( ( res.stderr ) ? '\n# STDERR\n' + res.stderr : '' ) );
	if ( !res.result ) {
		reason = 'child failed: ' + res.error;
	} else if ( !a.marker_found ) {
		reason = 'no ' + D.marker + ' line in the child output';
	} else if ( a.offending.length ) {
		reason = a.offending.length + ' element-loop kernel JIT event(s) after ' + D.marker;
	}
	return {
		'alg': alg, 'n': n, 'tau': ( alg === 'A2' ) ? tau : null, 'pass': reason === null, 'reason': reason, 'analysis': a, 'trace_file': file, // eslint-disable-line object-property-newline
		'k': cfg.k, 'batch': cfg.batch, // eslint-disable-line object-property-newline
		'child': ( proc ) ? { 'warmup_calls_effective': proc.warmup_calls_effective, 'warmup_elapsed_ns': proc.warmup_elapsed_ns, 'first_call_ns': proc.first_call_ns, 'per_call_median_ns': proc.per_call_median_ns, 'first_sample_ratio': proc.first_sample_ratio, 'flags': proc.flags, 'depth': proc.depth } : null // eslint-disable-line max-len, object-property-newline
	};
}

/**
* Returns the `summary.json` record of one diagnostics run.
*
* @param {Object} P - effective protocol
* @param {Object} res - result of `runOne`
* @returns {Object} record
*/
function runRecord( P, res ) {
	var D = P.diagnostics;
	var a = res.analysis;
	var status = 'exploratory';
	if ( ( D.default_sizes || [] ).indexOf( res.n ) >= 0 ) {
		status = 'pre-registered';
	} else if ( ( D.sizes || [] ).indexOf( res.n ) >= 0 ) {
		status = 'accepted';
	}
	return {
		'alg': res.alg, 'n': res.n, 'tau': res.tau, 'size_status': status, 'pass': res.pass, 'reason': res.reason, 'k': res.k, 'batch': res.batch, // eslint-disable-line object-property-newline
		'kernel_events_before': a.before, 'kernel_events_after': a.offending.length, 'offending': a.offending, // eslint-disable-line object-property-newline
		'report_only': Object.assign( jittrace.eventSummary( a.report_only ), { 'events_before': a.report_before, 'events': a.report_only } ), // eslint-disable-line object-property-newline
		'kernel_inlined': Object.assign( jittrace.eventSummary( a.kernel_inlined ), { 'events_before': a.inlined_before, 'events': a.kernel_inlined } ), // eslint-disable-line max-len, object-property-newline
		'samples_seen': a.samples_seen, 'end_marker_found': a.end_found, 'child': res.child, 'trace_file': path.relative( REPO, res.trace_file ) // eslint-disable-line object-property-newline
	};
}

// Returns `<count>[ [name ×c, ...], first in sample i]` for an event summary (`arrow`: label inlinings kernel→caller).
function eventsText( sum, arrow ) {
	var counts = {};
	sum.events.forEach( function each( e ) {
		var k = ( arrow ) ? e.functions[ 0 ] + '→' + e.into : e.functions.join( ',' );
		counts[ k ] = ( counts[ k ] || 0 ) + 1;
	});
	return ( !sum.count ) ? '0' : sum.count + ' [' + Object.keys( counts ).map( function each( k ) {
		return k + ' ×' + counts[ k ];
	}).join( ', ' ) + '], ' + ( ( sum.first_sample === null ) ? 'after the last sample' : 'first in sample ' + sum.first_sample ); // eslint-disable-line max-len
}

// Returns the one-line description of a run (PASS/FAIL, kernel events, kernel inlining, report-only events, warmup, trace).
function describe( P, res, rec ) {
	var warm = ( res.child ) ? '; warmup ' + res.child.warmup_calls_effective + ' calls / ' + ( res.child.warmup_elapsed_ns / 1e9 ).toFixed( 2 ) + ' s' : ''; // eslint-disable-line max-len
	return 'DIAGNOSTICS ' + res.alg + ( ( res.tau ) ? '(tau=' + res.tau + ')' : '' ) + ' n=' + res.n + ' [' + rec.size_status + ']: ' + ( ( res.pass ) ? 'PASS' : 'FAIL' ) + // eslint-disable-line max-len
		' (' + ( res.reason || '0 element-loop kernel JIT events after ' + P.diagnostics.marker ) + '; ' + rec.kernel_events_before + ' before it; kernel inlining after it (reported): ' + eventsText( rec.kernel_inlined, true ) + // eslint-disable-line max-len
		'; report-only after it: ' + eventsText( rec.report_only, false ) + warm + '; trace ' + rec.trace_file + ')';
}

/**
* Runs the diagnostics for every (size, algorithm), prints PASS/FAIL with evidence and writes `summary.json`.
*
* ## Notes
*
* -   A run fails on any compile/optimize/OSR/deopt event naming an element-loop kernel after `MEASURE_START`; inlinings of element-loop kernels into functions compiled after it (`kernel_inlined`) and events of the `report_only` functions are reported (count, first sample index) and never fail.
* -   `<outDir>/summary.json` is rewritten after every run (`complete: false`, `pass: null` until the last one finishes).
*
* @param {Object} P - effective protocol
* @param {Object} o - `{ sizes, tau, outDir, print }`
* @returns {boolean} whether every run passed
*/
function run( P, o ) {
	var print = o.print || console.log; // eslint-disable-line no-console
	var file = path.join( o.outDir, 'summary.json' );
	var sizes = ( Array.isArray( o.sizes ) ) ? o.sizes : [];
	var runs = [];
	var all = true;
	var bad = sizes.filter( function invalid( n ) {
		return !( Number.isInteger( n ) && n >= 1 && n <= MAX_DIAG_N );
	});
	function write( complete ) {
		fs.writeFileSync( file, JSON.stringify( {
			'schema': 'sw-bench/diagnostics/1', 'id': path.basename( o.outDir ), 'created_at': new Date().toISOString(), 'complete': complete, // eslint-disable-line object-property-newline
			'node': process.version, 'v8': process.versions.v8, 'protocol_revision': ( P.protocol_revision === void 0 ) ? null : P.protocol_revision, // eslint-disable-line object-property-newline
			'tau': o.tau, 'sizes': sizes, 'algs': P.diagnostics.algs, 'marker': P.diagnostics.marker, // eslint-disable-line object-property-newline
			'criterion': 'no compile/optimize/OSR/deopt event naming an element-loop kernel (functions) after ' + P.diagnostics.marker + '; element-loop kernels inlined into a function compiled after it (kernel_inlined) and report_only functions are reported, never failed', // eslint-disable-line max-len, object-property-newline
			'functions': P.diagnostics.functions, 'report_only_functions': P.diagnostics.report_only || [], // eslint-disable-line object-property-newline
			'warmup_calls': P.timing.warmup_calls, 'warmup_min_seconds': ( P.timing.warmup_min_seconds === void 0 ) ? null : P.timing.warmup_min_seconds, // eslint-disable-line max-len, object-property-newline
			'pass': ( complete ) ? all : null, 'runs': runs // eslint-disable-line object-property-newline
		}, null, 2 ) + '\n' );
	}
	if ( !sizes.length || bad.length ) {
		print( 'DIAGNOSTICS FAIL: invalid sizes ' + JSON.stringify( o.sizes ) + ' (integers in [1, ' + MAX_DIAG_N + '])' );
		return false;
	}
	if ( !( Number.isInteger( o.tau ) && o.tau >= 1 ) ) {
		print( 'DIAGNOSTICS FAIL: invalid tau ' + o.tau );
		return false;
	}
	if ( !fs.existsSync( path.join( REPO, P.paths.child ) ) ) {
		print( 'DIAGNOSTICS FAIL: ' + P.paths.child + ' not found' );
		return false;
	}
	fs.mkdirSync( o.outDir, { 'recursive': true } );
	sizes.forEach( function each( n ) {
		P.diagnostics.algs.forEach( function alg( a ) {
			var res = runOne( P, a, n, o.tau, o.outDir );
			var rec = runRecord( P, res );
			all = all && res.pass;
			runs.push( rec );
			write( false );
			print( describe( P, res, rec ) );
			rec.offending.slice( 0, 12 ).forEach( function ev( e ) {
				print( '    line ' + e.line + ' [' + e.kind + '] sample ' + e.sample + ': ' + e.text );
			});
			rec.kernel_inlined.events.slice( 0, 6 ).forEach( function ev( e ) {
				print( '    kernel inlining line ' + e.line + ' sample ' + e.sample + ': ' + e.functions[ 0 ] + ' into ' + e.into );
			});
			rec.report_only.events.slice( 0, 4 ).forEach( function ev( e ) {
				print( '    report-only line ' + e.line + ' [' + e.kind + '] sample ' + e.sample + ': ' + e.text );
			});
		});
	});
	write( true );
	print( 'DIAGNOSTICS summary ' + path.relative( REPO, file ) );
	print( 'DIAGNOSTICS ' + ( ( all ) ? 'PASS' : 'FAIL' ) );
	return all;
}


// EXPORTS //

module.exports = {
	'childEnv': childEnv,
	'cfgFields': cfgFields,
	'spawnChild': spawnChild,
	'firstExisting': firstExisting,
	'runScript': runScript,
	'flaggedFraction': flaggedFraction,
	'iqr': iqr,
	'classify': jittrace.classify,
	'functionNames': jittrace.functionNames,
	'traceLines': jittrace.traceLines,
	'analyze': jittrace.analyze,
	'eventSummary': jittrace.eventSummary,
	'runOne': runOne,
	'runRecord': runRecord,
	'run': run
};
