'use strict';

// Tests for research/harness/diagnostics.js: V8 trace classification on lines captured from Node 22.14 tier-up traces
// (`--trace-opt --trace-deopt`, plus `--trace-turbo-inlining`) of stdlib dgemm and the Strassen-Winograd driver, the
// MEASURE_START split, the child launcher's RESULT parsing, the sample helpers, and the orchestrator's argument parser.

var tape = require( 'tape' );
var fs = require( 'fs' );
var os = require( 'os' );
var path = require( 'path' );
var diagnostics = require( './../diagnostics.js' );
var design = require( './../design.js' );
var orchestrator = require( './../orchestrator.js' );

var REPO = path.resolve( __dirname, '..', '..', '..' );
var FUNCS = [ 'blocked', 'naive', 'ddot', 'winograd', 'add', 'sub' ];
var KERNELS = [ 'blocked', 'naive', 'ddot', 'zeros', 'scal', 'add', 'sub' ];
var DRIVERS = [ 'winograd', 'dgemm', 'resolve', 'str2enum' ];
var WINOGRAD = '[marking 0x1 <JSFunction winograd (sfi = 0x2)> for optimization to TURBOFAN, ConcurrencyMode::kConcurrent, reason: hot and stable]'; // eslint-disable-line max-len
var DGEMM = '[completed optimizing 0x3 <JSFunction dgemm (sfi = 0x4)> (target TURBOFAN) - took 0.1, 1.2, 0.0 ms]';
var INLINE_BLOCKED = 'Inlining 0xc8aeaaa70 {0x04797ddf94a1 <SharedFunctionInfo blocked>} into 0xc8aeaa2b8 {0x04797ddf94f9 <SharedFunctionInfo dgemm>}'; // eslint-disable-line max-len
var INLINE_STR2ENUM = 'Inlining 0xca28b31d0 {0x380f802afa19 <SharedFunctionInfo str2enum>} into 0xca28b22b8 {0x380f802bfb79 <SharedFunctionInfo dgemm>}'; // eslint-disable-line max-len
var CONSIDER = 'Considering 0xca28ba5a8 {0x380f802b32c1 <SharedFunctionInfo zeros>} for inlining with 0xca28baf98 {0x2f8cec692391 <FeedbackVector[19]>}'; // eslint-disable-line max-len
var BEFORE = [
	'[marking 0x2702709ef031 <JSFunction blocked (sfi = 0x13454bd7af71)> for optimization to TURBOFAN, ConcurrencyMode::kConcurrent, reason: hot and stable]', // eslint-disable-line max-len
	'[compiling method 0x2702709eee41 <JSFunction sub (sfi = 0x3e4549a70721)> (target TURBOFAN) OSR, mode: ConcurrencyMode::kConcurrent]', // eslint-disable-line max-len
	'[OSR - entry. function: blocked, osr offset: 321]'
];
var AFTER = [
	'[OSR - entry. function: blocked, osr offset: 325]',
	'[bailout (kind: deopt-eager, reason: Insufficient type feedback for compare operation): begin. deoptimizing 0x28631693b6a9 <JSFunction ddot (sfi = 0x396a90bc5a79)>, 0x2832d0e43c41 <Code TURBOFAN>, opt id 1, bytecode offset 250]', // eslint-disable-line max-len
	'[marking dependent code 0x2832d0e78279 <Code TURBOFAN> (0x3ba1bb07e9f1 <SharedFunctionInfo winograd>) (opt id 16) for deoptimization, reason: weak objects]', // eslint-disable-line max-len
	'[completed optimizing 0x3c825d66a629 <JSFunction addListener (sfi = 0x31a8157c2991)> (target TURBOFAN)]',
	'[OSR - entry. function: zeros, osr offset: 127]',
	'[compiling method 0x152086290539 <JSFunction (sfi = 0x26ef83a99941)> (target TURBOFAN) OSR, mode: ConcurrencyMode::kConcurrent]', // eslint-disable-line max-len
	'RESULT {"proc":{}}'
];

tape( 'classify and functionNames on captured trace lines', function test( t ) {
	t.equal( diagnostics.classify( BEFORE[ 0 ] ), 'optimize', 'marking' );
	t.equal( diagnostics.classify( BEFORE[ 1 ] ), 'compile', 'compiling (OSR)' );
	t.equal( diagnostics.classify( AFTER[ 0 ] ), 'osr', 'OSR entry' );
	t.equal( diagnostics.classify( AFTER[ 1 ] ), 'deopt', 'bailout' );
	t.equal( diagnostics.classify( AFTER[ 2 ] ), 'deopt', 'dependent code deoptimization' );
	t.equal( diagnostics.classify( 'MEASURE_START' ), null, 'not a JIT line' );
	t.deepEqual( diagnostics.functionNames( BEFORE[ 0 ] ), [ 'blocked' ], 'JSFunction name' );
	t.deepEqual( diagnostics.functionNames( AFTER[ 0 ] ), [ 'blocked' ], 'OSR function name' );
	t.deepEqual( diagnostics.functionNames( AFTER[ 2 ] ), [ 'winograd' ], 'SharedFunctionInfo name' );
	t.deepEqual( diagnostics.functionNames( AFTER[ 5 ] ), [], 'anonymous function' );
	t.end();
});

tape( 'analyze: kernel events after MEASURE_START fail, events before it and non-kernels do not', function test( t ) {
	var a = diagnostics.analyze( BEFORE.concat( [ 'MEASURE_START' ], AFTER ).join( '\n' ), { 'marker': 'MEASURE_START', 'functions': FUNCS } ); // eslint-disable-line max-len
	var clean = diagnostics.analyze( BEFORE.concat( [ 'MEASURE_START', AFTER[ 3 ], AFTER[ 4 ], AFTER[ 6 ] ] ).join( '\r\n' ), { 'marker': 'MEASURE_START', 'functions': FUNCS } ); // eslint-disable-line max-len
	var none = diagnostics.analyze( BEFORE.join( '\n' ), { 'marker': 'MEASURE_START', 'functions': FUNCS } );
	t.equal( a.marker_found, true, 'marker found' );
	t.equal( a.before, 3, 'kernel events before the marker counted' );
	t.deepEqual( a.offending.map( function f( e ) {
		return e.kind + ':' + e.functions.join( ',' );
	}), [ 'osr:blocked', 'deopt:ddot', 'deopt:winograd' ], 'offending events (addListener is not add)' );
	t.equal( a.offending[ 0 ].line, BEFORE.length + 2, '1-based line numbers' );
	t.equal( clean.offending.length, 0, 'clean measurement phase (CRLF tolerated)' );
	t.equal( none.marker_found, false, 'missing marker detected' );
	t.end();
});

tape( 'analyze: element-loop kernels fail, report-only drivers are attributed to samples and never fail', function test( t ) { // eslint-disable-line max-len
	var text = BEFORE.concat( [ WINOGRAD, 'MEASURE_START', 'SAMPLE 0', DGEMM, 'SAMPLE 1', WINOGRAD, AFTER[ 0 ], 'SAMPLE 2', 'MEASURE_END', AFTER[ 2 ], AFTER[ 4 ], AFTER[ 6 ] ] ).join( '\n' ); // eslint-disable-line max-len
	var a = diagnostics.analyze( text, { 'marker': 'MEASURE_START', 'functions': KERNELS, 'report_only': DRIVERS } );
	var s = diagnostics.eventSummary( a.report_only );
	t.deepEqual( [ a.before, a.report_before, a.samples_seen, a.end_found ], [ 3, 1, 3, true ], 'counts before the marker, sample markers, end marker' ); // eslint-disable-line max-len
	t.deepEqual( a.offending.map( function f( e ) {
		return [ e.kind, e.functions.join( ',' ), e.sample, e.phase ];
	}), [ [ 'osr', 'blocked', 1, 'measure' ], [ 'osr', 'zeros', null, 'after' ] ], 'kernel events: sample index during the samples, null after MEASURE_END' ); // eslint-disable-line max-len
	t.deepEqual( a.report_only.map( function f( e ) {
		return [ e.kind, e.functions.join( ',' ), e.sample, e.phase ];
	}), [ [ 'compile', 'dgemm', 0, 'measure' ], [ 'optimize', 'winograd', 1, 'measure' ], [ 'deopt', 'winograd', null, 'after' ] ], 'report-only events' ); // eslint-disable-line max-len
	t.deepEqual( s, { 'count': 3, 'first_sample': 0, 'after_end': 1, 'by_function': { 'dgemm': { 'count': 1, 'first_sample': 0 }, 'winograd': { 'count': 2, 'first_sample': 1 } } }, 'event summary' ); // eslint-disable-line max-len
	a = diagnostics.analyze( [ 'MEASURE_START', WINOGRAD, AFTER[ 0 ] ].join( '\n' ), { 'marker': 'MEASURE_START', 'functions': KERNELS } ); // eslint-disable-line max-len
	t.deepEqual( [ a.offending.length, a.offending[ 0 ].sample, a.report_only.length, a.samples_seen ], [ 1, null, 0, 0 ], 'no sample markers: sample null; no report_only list: drivers ignored' ); // eslint-disable-line max-len
	t.deepEqual( diagnostics.eventSummary( [] ), { 'count': 0, 'first_sample': null, 'after_end': 0, 'by_function': {} }, 'empty summary' ); // eslint-disable-line max-len
	t.end();
});

tape( 'analyze: element-loop kernels inlined into a function compiled after the marker are reported', function test( t ) {
	var text = [ INLINE_BLOCKED, 'MEASURE_START', 'SAMPLE 0', CONSIDER, 'SAMPLE 1', INLINE_STR2ENUM, DGEMM, INLINE_BLOCKED, 'MEASURE_END' ].join( '\n' ); // eslint-disable-line max-len
	var a = diagnostics.analyze( text, { 'marker': 'MEASURE_START', 'functions': KERNELS, 'report_only': DRIVERS } );
	t.strictEqual( a.inlined_before, 1, 'kernel inlining before the marker counted' );
	t.deepEqual( a.kernel_inlined.map( function f( e ) {
		return [ e.kind, e.functions[ 0 ], e.into, e.sample, e.phase, e.line ];
	}), [ [ 'inline', 'blocked', 'dgemm', 1, 'measure', 8 ] ], 'blocked into dgemm in sample 1 (str2enum inlining and "Considering" lines ignored)' ); // eslint-disable-line max-len
	t.deepEqual( [ a.offending.length, a.report_only.length ], [ 0, 1 ], 'the dgemm compile stays report-only; nothing fails' );
	t.end();
});

tape( 'traceLines/analyze: markers glued to a partial V8 line (concurrent compile output) are split off', function test( t ) {
	var text = [
		'  - target: 0x9f68a26a0 {0x04863fa33661 <SharedFunctionInfo isRowMajor>}, bytecode size: MEASURE_START',
		'42, existing opt code\'s inlined bytecode size: 19',
		'SAMPLE 0',
		'Inlining 0xc8aeaaa70 {0x04797ddf94a1 <SharedFunctionInfo blocked>} into 0xc8aeaa2b8 SAMPLE 1',
		'{0x04797ddf94f9 <SharedFunctionInfo dgemm>}',
		'Inlining small function(s) at call site #303:JSCallMEASURE_END',
		''
	].join( '\n' );
	var e = diagnostics.traceLines( text, 'MEASURE_START' );
	var a = diagnostics.analyze( text, { 'marker': 'MEASURE_START', 'functions': KERNELS, 'report_only': DRIVERS } );
	t.deepEqual( e.slice( 0, 5 ).map( function f( x ) {
		return [ x.text.slice( 0, 30 ), x.line ];
	}), [ [ '- target: 0x9f68a26a0 {0x04863', 1 ], [ 'MEASURE_START', 1 ], [ 'SAMPLE 0', 3 ], [ 'Inlining 0xc8aeaaa70 {0x04797d', 4 ], [ 'SAMPLE 1', 4 ] ], 'partial lines rejoined before their marker' ); // eslint-disable-line max-len
	t.deepEqual( [ a.marker_found, a.marker_index, a.samples_seen, a.end_found ], [ true, 0, 2, true ], 'glued start/sample/end markers found' ); // eslint-disable-line max-len
	t.deepEqual( a.kernel_inlined.map( function f( x ) {
		return [ x.functions[ 0 ], x.into, x.sample, x.line ];
	}), [ [ 'blocked', 'dgemm', 0, 4 ] ], 'the rejoined inlining line counts in the sample it started in' );
	t.end();
});

tape( 'cfgFields leaves out fields a specification does not define', function test( t ) {
	var f = diagnostics.cfgFields( { 'alg': 'A0', 'params': null, 'M': 8, 'warmup_calls': 3, 'meta': {} } );
	t.deepEqual( f, { 'alg': 'A0', 'params': null, 'M': 8, 'warmup_calls': 3 }, 'defined fields only (null kept)' );
	t.strictEqual( diagnostics.cfgFields( { 'warmup_min_seconds': 0.25 } ).warmup_min_seconds, 0.25, 'warmup_min_seconds passed through' ); // eslint-disable-line max-len
	t.end();
});

tape( 'run: invalid sizes or tau fail before spawning anything', function test( t ) {
	var P = design.effective( design.loadProtocol().protocol, false );
	var lines = [];
	function print( l ) {
		lines.push( l );
	}
	var dir = path.join( os.tmpdir(), 'stratamm-diag-none-' + process.pid );
	t.strictEqual( diagnostics.run( P, { 'sizes': [ NaN ], 'tau': 64, 'outDir': dir, 'print': print } ), false, 'NaN size' );
	t.strictEqual( diagnostics.run( P, { 'sizes': [], 'tau': 64, 'outDir': dir, 'print': print } ), false, 'no sizes' );
	t.strictEqual( diagnostics.run( P, { 'sizes': [ 512 ], 'tau': 0, 'outDir': dir, 'print': print } ), false, 'tau 0' );
	t.ok( lines.every( function f( l ) {
		return /^DIAGNOSTICS FAIL: invalid/.test( l );
	}) && !fs.existsSync( dir ), 'FAIL lines; no output directory' );
	t.end();
});

tape( 'protocol: pre-registered diagnostics sizes, element-loop kernels and report-only drivers', function test( t ) {
	var D = design.loadProtocol().protocol.diagnostics;
	t.deepEqual( D.default_sizes, [ 512, 2048 ], 'default sizes = the pre-registered {512, 2048}' );
	t.ok( D.sizes.indexOf( 1024 ) >= 0 && D.default_sizes.every( function f( n ) {
		return D.sizes.indexOf( n ) >= 0;
	}), '1024 accepted; defaults accepted' );
	t.deepEqual( D.algs, [ 'A0', 'A2' ], 'A0 and A2' );
	t.ok( D.functions.indexOf( 'winograd' ) < 0 && D.report_only.indexOf( 'winograd' ) >= 0, 'winograd is report-only' );
	t.ok( KERNELS.every( function f( k ) {
		return D.functions.indexOf( k ) >= 0;
	}), 'element-loop kernels fail' );
	t.ok( D.functions.every( function f( k ) {
		return D.report_only.indexOf( k ) < 0;
	}), 'lists are disjoint' );
	t.end();
});

tape( 'run: traced children with sample markers, PASS/FAIL lines and summary.json (n = 16, k = 4)', function test( t ) {
	var P = design.effective( design.loadProtocol().protocol, false );
	var dir = fs.mkdtempSync( path.join( os.tmpdir(), 'stratamm-diag-run-' ) );
	var lines = [];
	var ok;
	var s;
	P.timing.tiers = [ { 'name': 'T', 'max_n': null, 'k': 4, 'r': 1 } ];
	P.timing.sample_target_s = 0.001;
	P.timing.warmup_min_seconds = 0.02;
	ok = diagnostics.run( P, { 'sizes': [ 16 ], 'tau': 4, 'outDir': dir, 'print': function print( l ) {
		lines.push( l );
	}});
	s = JSON.parse( fs.readFileSync( path.join( dir, 'summary.json' ), 'utf8' ) );
	t.strictEqual( s.pass, ok, 'summary pass = return value' );
	t.ok( s.complete === true && s.tau === 4 && s.warmup_min_seconds === 0.02 && s.id === path.basename( dir ), 'summary header' ); // eslint-disable-line max-len
	t.deepEqual( s.runs.map( function f( r ) {
		return [ r.alg, r.n, r.tau, r.size_status, r.samples_seen, r.end_marker_found, r.k ];
	}), [ [ 'A0', 16, null, 'exploratory', 4, true, 4 ], [ 'A2', 16, 4, 'exploratory', 4, true, 4 ] ], 'one run per algorithm, all samples marked' ); // eslint-disable-line max-len
	t.ok( s.runs.every( function f( r ) {
		return r.child && r.child.warmup_calls_effective >= 3 && r.child.warmup_elapsed_ns >= 0.02e9 && typeof r.report_only.count === 'number' && Array.isArray( r.kernel_inlined.events ) && fs.existsSync( path.join( REPO, r.trace_file ) ); // eslint-disable-line max-len
	}), 'child warmup recorded; report-only and kernel-inlining summaries; traces saved' );
	t.ok( s.runs.every( function f( r ) {
		return r.kernel_inlined.events_before > 0;
	}), 'the traces include --trace-turbo-inlining output (kernels inlined during the warmup)' );
	t.strictEqual( s.runs[ 1 ].child.depth, 2, 'A2 recursed (n = 16, tau = 4)' );
	t.strictEqual( lines[ lines.length - 1 ], 'DIAGNOSTICS ' + ( ( ok ) ? 'PASS' : 'FAIL' ), 'final line' );
	t.ok( /^DIAGNOSTICS A2\(tau=4\) n=16 \[exploratory\]: (PASS|FAIL) \(/.test( lines.filter( function f( l ) {
		return l.indexOf( 'DIAGNOSTICS A2' ) === 0;
	})[ 0 ] ), 'per-run line' );
	fs.rmSync( dir, { 'recursive': true, 'force': true } );
	t.end();
});

tape( 'spawnChild parses exactly one RESULT line and reports failures', function test( t ) {
	var dir = fs.mkdtempSync( path.join( os.tmpdir(), 'stratamm-diag-' ) );
	function script( name, body ) {
		var f = path.join( dir, name );
		fs.writeFileSync( f, body );
		return f;
	}
	var ok = script( 'ok.js', 'var c = JSON.parse(process.argv[2]); console.log("MEASURE_START"); console.log("RESULT " + JSON.stringify({ proc: { alg: c.alg, pad: process.env.BENCH_PAD.length, lang: process.env.LANG, opts: process.env.NODE_OPTIONS || null }, samples: [] }));' ); // eslint-disable-line max-len
	var two = script( 'two.js', 'console.log("RESULT {}"); console.log("RESULT {}");' );
	var bad = script( 'bad.js', 'console.error("child: invalid config: alg"); process.exitCode = 2;' );
	var slow = script( 'slow.js', 'setTimeout(function(){}, 10000);' );
	var r = diagnostics.spawnChild( ok, [ '--expose-gc' ], { 'alg': 'A0' }, { 'pad': 17 } );
	t.equal( r.error, null, 'no error' );
	t.deepEqual( r.result.proc, { 'alg': 'A0', 'pad': 17, 'lang': 'C', 'opts': null }, 'RESULT parsed; minimal env with BENCH_PAD' );
	t.equal( diagnostics.spawnChild( two, [], {}, { 'pad': 0 } ).error, '2 RESULT lines', 'two RESULT lines rejected' );
	t.ok( /^exit 2: child: invalid config/.test( diagnostics.spawnChild( bad, [], {}, { 'pad': 0 } ).error ), 'exit code and stderr tail' );
	t.ok( /^timeout after 1 s/.test( diagnostics.spawnChild( slow, [], {}, { 'pad': 0, 'timeoutS': 1 } ).error ), 'timeout' );
	t.equal( diagnostics.childEnv( null ).BENCH_PAD, void 0, 'no BENCH_PAD for stage scripts' );
	t.end();
});

tape( 'sample helpers: flagged fraction and IQR', function test( t ) {
	var s = [ { 'flags': [ 'preempt' ] }, { 'flags': [ 'gc' ] }, { 'flags': [] }, { 'flags': [ 'slow_mode', 'tukey3' ] }, {} ];
	t.equal( diagnostics.flaggedFraction( s, [ 'preempt', 'slow_mode' ] ), 0.4, 'preempt or slow_mode' );
	t.equal( diagnostics.flaggedFraction( [], [ 'preempt' ] ), 0, 'no samples' );
	t.equal( diagnostics.iqr( [ 1, 2, 3, 4, 5 ] ), 2, 'IQR' );
	t.equal( diagnostics.iqr( [ NaN ] ), null, 'no finite values' );
	t.end();
});

tape( 'orchestrator argument parser', function test( t ) {
	var a = orchestrator.parseArgs( [ '--tiny', '--skip-preflight', '--id', 'tiny-x', '--tau', '32' ] );
	t.deepEqual( a, { 'flags': { 'tiny': true, 'skip-preflight': true }, 'opts': { 'id': 'tiny-x', 'tau': '32' } }, 'flags and options' ); // eslint-disable-line max-len
	t.throws( function f() {
		orchestrator.parseArgs( [ '--campaing' ] );
	}, /unknown/, 'unknown flag' );
	t.throws( function f() {
		orchestrator.parseArgs( [ '--id' ] );
	}, /incomplete/, 'missing option value' );
	t.end();
});
