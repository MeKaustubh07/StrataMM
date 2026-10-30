'use strict';

/*
* Tests for research/harness/child.js: configuration validation, sample flags, gate handling (in-process, injected
* closures), and the full factorial of fresh child processes (spawnSync, minimal env, cwd '/'): every algorithm key ×
* both orders × both transposes of A and B × ld_pad ∈ {0, 8} × (α, β) ∈ {(1, 0), (1, 1), (0.5, 2)} on a tiny odd shape.
*/

// MODULES //

var tape = require( 'tape' );
var path = require( 'path' );
var spawnSync = require( 'child_process' ).spawnSync;
var algorithms = require( './../algorithms.js' );
var child = require( './../child.js' );


// VARIABLES //

var CHILD = path.resolve( __dirname, '..', 'child.js' );
var ORDERS = [ 'row-major', 'column-major' ];
var TRANS = [ 'no-transpose', 'transpose' ];
var AB = [ [ 1.0, 0.0 ], [ 1.0, 1.0 ], [ 0.5, 2.0 ] ];
var PARAMS = {
	'A0': { 'cutoff': null, 'levels': null }, // what design.js passes for non-recursive keys
	'A1': { 'cutoff': 1, 'levels': 1 },
	'A2': { 'cutoff': 2, 'levels': 4 },
	'C1': { 'cutoff': null, 'levels': null },
	'C2': { 'cutoff': 2, 'levels': 4 },
	'SENTINEL': null
};
var PAD = 'x'.repeat( 123 );
var ENV = {
	'PATH': process.env.PATH,
	'HOME': process.env.HOME,
	'LANG': 'C',
	'BENCH_PAD': PAD
};


// FUNCTIONS //

function noop() {}

function config( over ) {
	var cfg = {
		'campaign': 'test',
		'stage': 'test',
		'experiment': 'T',
		'block_id': 0,
		'pos_in_block': 0,
		'proc_id': 'p0',
		'alg': 'A0',
		'params': null,
		'M': 13,
		'N': 11,
		'K': 9,
		'order': 'row-major',
		'transA': 'no-transpose',
		'transB': 'no-transpose',
		'ld_pad': 0,
		'alpha': 1.0,
		'beta': 0.0,
		'seed': 42,
		'batch': 2,
		'k': 3,
		'warmup_min_seconds': 0, // count-only warmup keeps the 288-process factorial fast (the default 0.25 s is tested below)
		'warmup_target_invocations': 0, // likewise for the dgemm-invocation target (tested separately below)
		'mode': 'timing',
		'repoRoot': algorithms.DEFAULT_REPO_ROOT,
		'meta': { 'tier': 'S' }
	};
	return Object.assign( cfg, over || {} );
}

// Returns a closure factory whose closures busy-wait `ms` milliseconds per call, then call A0.
function slowA0( ms ) {
	return function create( alg, params, prob, lib ) {
		var f = algorithms.create( 'A0', null, prob, lib );
		return function g() {
			var t = process.hrtime.bigint();
			while ( Number( process.hrtime.bigint() - t ) < ms*1e6 ) {
				// busy-wait
			}
			return f();
		};
	};
}

// Returns synthetic samples with the given per-call times (no other flags).
function synth( pcs ) {
	return pcs.map( function each( pc, i ) {
		return { 'i': i, 'per_call_ns': pc, 'wall_ns': pc, 'cpu_us': pc/1000, 'gc_n': 0, 'flags': [] };
	});
}

function spawn( cfg, flags, env ) {
	return spawnSync( process.execPath, ( flags || [ '--expose-gc' ] ).concat( [ CHILD, ( typeof cfg === 'string' ) ? cfg : JSON.stringify( cfg ) ] ), {
		'cwd': '/',
		'env': env || ENV,
		'encoding': 'utf8',
		'timeout': 60000
	});
}

// Returns a list of problems with a child run (empty when everything holds).
function problems( cfg, res ) {
	var out = [];
	var lines;
	var proc;
	var lay;
	var idx;
	var r;
	if ( res.status !== 0 ) {
		return [ 'exit ' + res.status + ': ' + res.stderr ];
	}
	lines = res.stdout.split( '\n' ).filter( Boolean );
	idx = lines.map( function f( l ) {
		return l.indexOf( 'RESULT ' ) === 0;
	});
	if ( idx.filter( Boolean ).length !== 1 || !idx[ lines.length-1 ] ) {
		return [ 'expected exactly one RESULT line, last: ' + JSON.stringify( lines ) ];
	}
	if ( lines.indexOf( 'MEASURE_START' ) !== lines.length-2 ) {
		out.push( 'MEASURE_START must directly precede RESULT' );
	}
	r = JSON.parse( lines[ lines.length-1 ].slice( 7 ) );
	proc = r.proc;
	lay = algorithms.layout( cfg );
	if ( !proc.gate.pass || !proc.gate.intact || !proc.end_gate.pass || !( proc.gate.rel < 1e-12 ) ) {
		out.push( 'gates: ' + JSON.stringify( [ proc.gate, proc.end_gate ] ) );
	}
	if ( r.samples.length !== cfg.k ) {
		out.push( 'samples: ' + r.samples.length );
	}
	r.samples.forEach( function each( s, i ) {
		if ( s.i !== i || s.proc_id !== cfg.proc_id || s.batch !== cfg.batch || !( s.t_ns > 0 ) || s.per_call_ns !== s.t_ns/s.batch || !( s.wall_ns >= s.t_ns ) || !Array.isArray( s.flags ) || typeof s.cpu_us !== 'number' || typeof s.gc_n !== 'number' || typeof s.minflt !== 'number' ) {
			out.push( 'sample ' + i + ': ' + JSON.stringify( s ) );
		}
	});
	[ 'campaign', 'stage', 'experiment', 'block_id', 'pos_in_block', 'proc_id', 'alg', 'M', 'N', 'K', 'order', 'transA', 'transB', 'ld_pad', 'alpha', 'beta', 'seed', 'batch', 'k' ].forEach( function echo( key ) {
		if ( proc[ key ] !== cfg[ key ] ) {
			out.push( 'echo ' + key );
		}
	});
	if ( proc.lda !== lay.lda || proc.ldb !== lay.ldb || proc.ldc !== lay.ldc ) {
		out.push( 'leading dimensions' );
	}
	if ( JSON.stringify( proc.params ) !== JSON.stringify( algorithms.resolveParams( cfg.alg, cfg.params ) ) ) {
		out.push( 'params ' + JSON.stringify( proc.params ) );
	}
	if ( proc.warmup_calls !== 3 || proc.warmup_ns.length !== 3 || !( proc.first_call_ns > 0 ) || !isFinite( proc.sink ) || !( proc.per_call_median_ns > 0 ) || !( proc.max_rss_kib > 0 ) ) {
		out.push( 'process summary' );
	}
	if ( proc.warmup_min_seconds !== 0 || proc.warmup_calls_effective !== 3 || !( proc.warmup_elapsed_ns >= proc.warmup_ns[ 2 ] ) || typeof proc.first_sample_ratio !== 'number' ) {
		out.push( 'warmup/first_sample_ratio fields' );
	}
	if ( JSON.stringify( proc.exec_argv ) !== '["--expose-gc"]' || proc.env_pad_bytes !== PAD.length || proc.node_options !== '' ) {
		out.push( 'exec_argv/env_pad_bytes/node_options' );
	}
	if ( typeof proc.excluded !== 'boolean' || !Array.isArray( proc.flags ) || typeof proc.flag_counts.flagged !== 'number' ) {
		out.push( 'flags/exclusion fields' );
	}
	return out;
}


// TESTS //

tape( 'parseConfig: normalizes a valid configuration and ignores unknown keys', function test( t ) {
	var cfg = child.parseConfig( JSON.stringify( config({ 'alg': 'A2', 'params': { 'cutoff': 64 }, 'mode': void 0 }) ) );
	t.deepEqual( cfg.params, { 'cutoff': 64, 'levels': 4 }, 'params resolved (levels default 4)' );
	t.strictEqual( cfg.warmup_calls, 3, 'warmup_calls defaults to 3' );
	t.strictEqual( cfg.sample_markers, false, 'sample_markers defaults to false' );
	t.strictEqual( child.parseConfig( config({ 'warmup_min_seconds': void 0 }) ).warmup_min_seconds, 0.25, 'warmup_min_seconds defaults to 0.25 (protocol.json)' ); // eslint-disable-line max-len
	t.strictEqual( child.parseConfig( config({ 'warmup_min_seconds': 0.5, 'sample_markers': true }) ).sample_markers, true, 'sample_markers accepted' ); // eslint-disable-line max-len
	t.strictEqual( cfg.mode, 'timing', 'mode defaults to timing' );
	t.strictEqual( cfg.meta, void 0, 'unknown keys dropped' );
	cfg = child.parseConfig( config({ 'proc_id': void 0, 'repoRoot': void 0 }) );
	t.strictEqual( cfg.proc_id, null, 'missing echo fields become null' );
	t.strictEqual( cfg.repoRoot, algorithms.DEFAULT_REPO_ROOT, 'repoRoot defaults to this repository' );
	t.strictEqual( child.parseConfig( config({ 'mode': 'memory', 'k': 0, 'warmup_calls': 0 }) ).k, 0, 'memory mode accepts k = 0 (design.js)' );
	t.end();
});

tape( 'parseConfig: rejects invalid configurations with ECONFIG', function test( t ) {
	var bad = [
		[ 'not json', /not valid JSON/ ],
		[ '[1,2]', /expected a JSON object/ ],
		[ config({ 'M': void 0 }), /missing field `M`/ ],
		[ config({ 'alg': 'A3' }), /`alg` must be one of/ ],
		[ config({ 'K': 0 }), /`K` must be an integer/ ],
		[ config({ 'N': 2.5 }), /`N` must be an integer/ ],
		[ config({ 'order': 'row' }), /`order`/ ],
		[ config({ 'transB': 'conjugate-transpose' }), /`transA` and `transB`/ ],
		[ config({ 'ld_pad': -8 }), /`ld_pad`/ ],
		[ config({ 'beta': null }), /`alpha` and `beta`/ ],
		[ config({ 'seed': null }), /`seed`/ ],
		[ config({ 'seed': 0 }), /`seed`/ ],
		[ config({ 'k': 0 }), /`k`/ ],
		[ config({ 'batch': 0 }), /`batch`/ ],
		[ config({ 'warmup_calls': -1 }), /`warmup_calls`/ ],
		[ config({ 'warmup_min_seconds': -0.1 }), /`warmup_min_seconds`/ ],
		[ config({ 'warmup_min_seconds': 61 }), /`warmup_min_seconds`/ ],
		[ config({ 'warmup_min_seconds': '0.25' }), /`warmup_min_seconds`/ ],
		[ config({ 'warmup_min_seconds': null }), /`warmup_min_seconds`/ ],
		[ config({ 'sample_markers': 'yes' }), /`sample_markers`/ ],
		[ config({ 'mode': 'fast' }), /`mode`/ ],
		[ config({ 'repoRoot': 'relative/path' }), /`repoRoot`/ ],
		[ config({ 'alg': 'A1', 'params': { 'cutoff': 64, 'levels': 1 } }), /A1 is fixed/ ],
		[ config({ 'alg': 'A2', 'params': null }), /requires params.cutoff/ ],
		[ config({ 'M': 65536, 'K': 65536 }), /exceed/ ]
	];
	bad.forEach( function each( b ) {
		try {
			child.parseConfig( ( typeof b[ 0 ] === 'string' ) ? b[ 0 ] : JSON.stringify( b[ 0 ] ) );
			t.fail( 'accepted: ' + b[ 1 ] );
		} catch ( err ) {
			t.ok( err.code === 'ECONFIG' && b[ 1 ].test( err.message ), err.message );
		}
	});
	t.end();
});

tape( 'annotate: gc, preempt, slow_mode, tukey3, warmup_suspect and the 20% exclusion rule', function test( t ) {
	function s( pc, cpu, gc ) {
		return {
			'per_call_ns': pc,
			'wall_ns': pc,
			'cpu_us': ( cpu === void 0 ) ? pc/1000 : cpu,
			'gc_n': gc || 0,
			'flags': []
		};
	}
	var samples = [ s( 100e6 ), s( 100e6 ), s( 101e6 ), s( 99.5e6 ), s( 100e6, 80e3 ), s( 100e6, void 0, 2 ), s( 100.5e6 ), s( 99e6 ), s( 100e6 ), s( 300e6 ) ];
	var res = child.annotate( samples );
	t.strictEqual( res.per_call_median_ns, 100e6, 'median' );
	t.deepEqual( samples[ 9 ].flags, [ 'slow_mode', 'tukey3' ], '3× sample: slow_mode + tukey3' );
	t.deepEqual( samples[ 4 ].flags, [ 'preempt' ], 'cpu/wall = 0.8: preempt' );
	t.deepEqual( samples[ 5 ].flags, [ 'gc' ], 'GC events: gc' );
	t.deepEqual( res.flag_counts, { 'gc': 1, 'preempt': 1, 'slow_mode': 1, 'tukey3': 1, 'flagged': 2 }, 'counts' );
	t.strictEqual( res.excluded, false, '2/10 flagged is not > 20%' );
	t.deepEqual( res.flags, [], 'min/median = 0.99: no warmup_suspect' );
	samples = [ s( 100e6 ), s( 97e6 ), s( 100e6 ), s( 160e6 ), s( 100e6, 10e3 ) ];
	res = child.annotate( samples );
	t.deepEqual( res.flags, [ 'warmup_suspect' ], 'min/median = 0.97: warmup_suspect' );
	t.ok( res.excluded && res.exclusion_reason === 'flagged_samples_gt_20pct', '2/5 flagged: excluded' );
	t.end();
});

tape( 'annotate: early_slow = k ≥ 4 and sample 0 / median(samples ⌊k/2⌋…k−1) > 1.05; first_sample_ratio', function test( t ) {
	var flat = [];
	var res;
	var i;
	for ( i = 0; i < 29; i++ ) {
		flat.push( 100e3 + ( ( i%3 ) * 100 ) ); // 100.0–100.2 µs
	}
	res = child.annotate( synth( [ 106e3 ].concat( flat ) ) );
	t.deepEqual( res.flags, [ 'early_slow' ], 'k = 30, sample 0 at 1.06×: early_slow (warmup_suspect cannot see it)' );
	t.ok( Math.abs( res.first_sample_ratio - ( 106e3/100.1e3 ) ) < 1e-12, 'ratio against the median of samples 15–29' );
	t.strictEqual( res.per_call_median_ns, 100.1e3, 'process median unchanged (flags never delete samples)' );
	res = child.annotate( synth( [ 104e3 ].concat( flat ) ) );
	t.deepEqual( res.flags, [], 'sample 0 at 1.04×: no flag' );
	res = child.annotate( synth( [ 100e3, 100e3, 140e3, 100e3, 100e3, 100e3 ] ) );
	t.deepEqual( res.flags, [], 'a slow sample other than sample 0: no early_slow' );
	res = child.annotate( synth( [ 130e3, 100e3, 100e3, 100e3 ] ) );
	t.deepEqual( res.flags, [ 'early_slow' ], 'k = 4: early_slow (samples 2–3 as reference)' );
	t.strictEqual( res.first_sample_ratio, 1.3, 'k = 4 ratio' );
	res = child.annotate( synth( [ 130e3, 100e3, 100e3 ] ) );
	t.deepEqual( res.flags, [], 'k = 3: never early_slow' );
	t.strictEqual( res.first_sample_ratio, 1.3, 'k = 3: ratio still recorded' );
	t.strictEqual( child.annotate( synth( [ 100e3 ] ) ).first_sample_ratio, null, 'k = 1: no ratio' );
	t.end();
});

tape( 'timing (in-process): warmup runs until ≥ warmup_calls calls AND ≥ warmup_min_seconds, then gc()', function test( t ) {
	var calls = 0;
	var gcAt = [];
	var res;
	function counting( alg, params, prob, lib ) {
		var f = algorithms.create( 'A0', null, prob, lib );
		return function g() {
			calls += 1;
			return f();
		};
	}
	function gc() {
		gcAt.push( calls );
	}
	res = child.timing( child.parseConfig( config({ 'warmup_min_seconds': 0.03 }) ), { 'gc': gc, 'out': noop, 'create': counting } );
	t.ok( res.proc.warmup_calls_effective > 3, 'time-bound: ' + res.proc.warmup_calls_effective + ' warmup calls (> warmup_calls = 3)' );
	t.ok( res.proc.warmup_elapsed_ns >= 0.03e9, 'elapsed ' + res.proc.warmup_elapsed_ns + ' ns ≥ 0.03 s' );
	t.strictEqual( res.proc.warmup_ns.length, res.proc.warmup_calls_effective, 'every warmup duration recorded' );
	t.ok( res.proc.warmup_ns.every( function f( x ) {
		return Number.isInteger( x ) && x > 0;
	}), 'durations are positive integers (ns)' );
	t.deepEqual( gcAt, [ 1, 1 + res.proc.warmup_calls_effective ], 'gc() after the gate and after the last warmup call' );
	t.strictEqual( calls, 1 + res.proc.warmup_calls_effective + ( 3*2 ), 'gate + warmup + k·batch calls' );
	t.strictEqual( res.proc.warmup_min_seconds, 0.03, 'warmup_min_seconds echoed' );

	res = child.timing( child.parseConfig( config({ 'warmup_min_seconds': 0.01 }) ), { 'gc': noop, 'out': noop, 'create': slowA0( 15 ) } );
	t.strictEqual( res.proc.warmup_calls_effective, 3, 'count-bound: 3 calls of 15 ms exceed 0.01 s' );
	t.ok( res.proc.warmup_elapsed_ns >= 45e6, 'elapsed covers the 3 calls' );

	res = child.timing( child.parseConfig( config({ 'warmup_calls': 0, 'warmup_min_seconds': 0 }) ), { 'gc': noop, 'out': noop } );
	t.ok( res.proc.warmup_calls_effective === 0 && res.proc.warmup_ns.length === 0 && res.proc.warmup_elapsed_ns === 0, 'no warmup when both are 0' ); // eslint-disable-line max-len
	t.end();
});

tape( 'timing (in-process): the warmup continues until the dgemm-invocation target is met or warmup_max_seconds elapses', function test( t ) {
	var res;

	res = child.timing( child.parseConfig( config({ 'warmup_target_invocations': 50, 'warmup_max_seconds': 2.0 }) ), { 'gc': noop, 'out': noop, 'create': slowA0( 1 ) } );
	t.strictEqual( res.proc.warmup_calls_effective, 50, 'target-bound: 50 calls of one dgemm invocation each' );
	t.strictEqual( res.proc.warmup_invocations_per_call, 1, 'A0 makes one dgemm invocation per call' );
	t.strictEqual( res.proc.warmup_invocations_est, 50, 'estimated invocations recorded' );
	t.strictEqual( res.proc.warmup_target_met, true, 'target met' );
	t.strictEqual( res.proc.warmup_target_invocations, 50, 'target echoed' );

	res = child.timing( child.parseConfig( config({ 'warmup_target_invocations': 1000000, 'warmup_max_seconds': 0.05 }) ), { 'gc': noop, 'out': noop, 'create': slowA0( 15 ) } );
	t.ok( res.proc.warmup_elapsed_ns >= 0.05e9 && res.proc.warmup_calls_effective >= 3 && res.proc.warmup_calls_effective < 10, 'time-capped: ' + res.proc.warmup_calls_effective + ' calls in ' + ( res.proc.warmup_elapsed_ns/1e6 ).toFixed( 1 ) + ' ms' ); // eslint-disable-line max-len
	t.strictEqual( res.proc.warmup_target_met, false, 'target not met within the cap' );

	t.strictEqual( child.invocationsPerCall( 'A0', null ), 1, 'A0: 1' );
	t.strictEqual( child.invocationsPerCall( 'A2', 0 ), 1, 'A2 at depth 0 (delegated): 1' );
	t.strictEqual( child.invocationsPerCall( 'A2', 2 ), 49, 'A2 at depth 2: 7^2' );
	t.strictEqual( child.invocationsPerCall( 'A1', 1 ), 7, 'A1 at depth 1: 7' );
	t.strictEqual( child.invocationsPerCall( 'C2', 2 ), 64, 'C2 at depth 2: 8^2' );
	t.throws( function badValue() {
		child.parseConfig( config({ 'warmup_target_invocations': -1 }) );
	}, /warmup_target_invocations/, 'rejects a negative target' );
	t.throws( function badValue() {
		child.parseConfig( config({ 'warmup_max_seconds': 61 }) );
	}, /warmup_max_seconds/, 'rejects warmup_max_seconds > 60' );
	t.end();
});

tape( 'timing (in-process): sample_markers writes SAMPLE i before each sample and MEASURE_END after the last', function test( t ) {
	var lines = [];
	child.timing( child.parseConfig( config({ 'k': 4, 'sample_markers': true }) ), {
		'gc': noop,
		'out': function out( l ) {
			lines.push( l );
		}
	});
	t.deepEqual( lines, [ 'MEASURE_START', 'SAMPLE 0', 'SAMPLE 1', 'SAMPLE 2', 'SAMPLE 3', 'MEASURE_END' ], 'marker lines' );
	t.end();
});

tape( 'timing (in-process): gate, end-gate and early-return failures throw EGATE', function test( t ) {
	var opts = { 'gc': noop, 'out': noop };
	function broken( after ) {
		return function create( alg, params, prob, lib ) {
			var f = algorithms.create( 'A0', null, prob, lib );
			var n = 0;
			return function g() {
				n += 1;
				if ( n > after ) {
					prob.C[ 0 ] += 1.0; // wrong value
					return prob.C;
				}
				return f();
			};
		};
	}
	function expectGate( cfg, create, stage ) {
		try {
			child.timing( child.parseConfig( cfg ), Object.assign( { 'create': create }, opts ) );
			t.fail( stage + ' failure not detected' );
		} catch ( err ) {
			t.ok( err.code === 'EGATE' && err.info.stage === stage, stage + ': ' + err.message.slice( 0, 90 ) );
		}
	}
	expectGate( config(), broken( 0 ), 'gate' );
	expectGate( config(), broken( 4 ), 'end_gate' ); // correct for the gate and 3 warmup calls
	expectGate( config({ 'beta': 2.0 }), function create( alg, params, prob, lib ) {
		var f = algorithms.create( 'A2', { 'cutoff': 2, 'levels': 4 }, prob, lib );
		var n = 0;
		return function g() {
			n += 1;
			return ( n > 4 ) ? prob.C : f(); // early return: C stays at the restored C₀
		};
	}, 'end_gate' );
	t.end();
});

tape( 'timing (in-process): MEASURE_START written once; result structure', function test( t ) {
	var lines = [];
	var res = child.timing( child.parseConfig( config({ 'alg': 'C2', 'params': { 'cutoff': 2 }, 'beta': 1.0, 'k': 4, 'batch': 3 }) ), {
		'gc': noop,
		'out': function out( l ) {
			lines.push( l );
		}
	});
	t.deepEqual( lines, [ 'MEASURE_START' ], 'one MEASURE_START line' );
	t.strictEqual( res.samples.length, 4, 'k samples' );
	t.strictEqual( res.proc.depth, 2, 'depth recorded' );
	t.ok( res.samples.every( function f( s ) {
		return s.wall_ns >= s.t_ns && s.batch === 3;
	}), 'β ≠ 0: wall covers the untimed restores' );
	t.end();
});

tape( 'child processes: invalid invocations exit non-zero with a message and no RESULT', function test( t ) {
	var cases = [
		[ spawn( config({ 'alg': 'X' }) ), 2, /invalid config/ ],
		[ spawn( 'not json' ), 2, /not valid JSON/ ],
		[ spawn( config(), [] ), 2, /requires --expose-gc/ ],
		[ spawn( config({ 'mode': 'memory' }), [] ), 2, /requires --expose-gc/ ]
	];
	cases.forEach( function each( c ) {
		t.ok( c[ 0 ].status === c[ 1 ] && c[ 2 ].test( c[ 0 ].stderr ) && c[ 0 ].stdout.indexOf( 'RESULT' ) < 0, 'exit ' + c[ 0 ].status + ': ' + c[ 0 ].stderr.trim().split( '\n' )[ 0 ] );
	});
	t.end();
});

tape( 'child processes: default warmup is ≥ 3 calls and ≥ 0.25 s; markers only on request', function test( t ) {
	var res = spawn( config({ 'warmup_min_seconds': void 0, 'alg': 'A1', 'params': PARAMS.A1, 'k': 4 }) );
	var lines = res.stdout.split( '\n' ).filter( Boolean );
	var proc = JSON.parse( lines.pop().slice( 7 ) ).proc;
	t.strictEqual( proc.warmup_min_seconds, 0.25, 'default echoed' );
	t.ok( proc.warmup_elapsed_ns >= 0.25e9 && proc.warmup_calls_effective > 3 && proc.warmup_ns.length === proc.warmup_calls_effective, proc.warmup_calls_effective + ' warmup calls in ' + ( proc.warmup_elapsed_ns/1e6 ).toFixed( 1 ) + ' ms' ); // eslint-disable-line max-len
	t.deepEqual( lines, [ 'MEASURE_START' ], 'no SAMPLE/MEASURE_END lines by default' );
	res = spawn( config({ 'k': 2, 'sample_markers': true }) );
	lines = res.stdout.split( '\n' ).filter( Boolean );
	t.deepEqual( lines.slice( 0, -1 ), [ 'MEASURE_START', 'SAMPLE 0', 'SAMPLE 1', 'MEASURE_END' ], 'markers on stdout before RESULT' );
	t.end();
});

tape( 'child processes: BENCH_PAD absent ⇒ env_pad_bytes null', function test( t ) {
	var res = spawn( config(), null, {
		'PATH': process.env.PATH,
		'HOME': process.env.HOME
	});
	var proc = JSON.parse( res.stdout.split( '\n' ).filter( Boolean ).pop().slice( 7 ) ).proc;
	t.strictEqual( proc.env_pad_bytes, null, 'null' );
	t.end();
});

algorithms.ALGS.forEach( function each( alg ) {
	tape( 'child processes: ' + alg + ' × order × transA × transB × ld_pad × (α, β) (48 fresh processes)', function test( t ) {
		var t0 = Date.now();
		var n = 0;
		ORDERS.forEach( function o( order ) {
			TRANS.forEach( function ta( transA ) {
				TRANS.forEach( function tb( transB ) {
					[ 0, 8 ].forEach( function p( pad ) {
						AB.forEach( function ab( v ) {
							var cfg = config({
								'alg': alg,
								'params': PARAMS[ alg ],
								'order': order,
								'transA': transA,
								'transB': transB,
								'ld_pad': pad,
								'alpha': v[ 0 ],
								'beta': v[ 1 ],
								'seed': 1000 + n,
								'proc_id': alg + '-' + n
							});
							n += 1;
							t.deepEqual( problems( cfg, spawn( cfg ) ), [], [ alg, order, transA, transB, 'ld_pad=' + pad, 'α=' + v[ 0 ], 'β=' + v[ 1 ] ].join( ' ' ) );
						});
					});
				});
			});
		});
		t.comment( alg + ': ' + n + ' processes in ' + ( Date.now() - t0 ) + ' ms' );
		t.end();
	});
});
