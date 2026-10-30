'use strict';

/*
* Tests for research/harness/memory.js (E7, protocol §9): fresh child processes in memory mode for every algorithm key,
* β ∈ {0, 1}; the measured ΔarrayBuffers of the one call must equal the analytic allocation exactly, and the workspace
* must be released by gc().
*/

// MODULES //

var tape = require( 'tape' );
var path = require( 'path' );
var spawnSync = require( 'child_process' ).spawnSync;
var algorithms = require( './../algorithms.js' );


// VARIABLES //

var CHILD = path.resolve( __dirname, '..', 'child.js' );
var MEMORY = path.resolve( __dirname, '..', 'memory.js' );
var LIB = algorithms.library();
var ENV = {
	'PATH': process.env.PATH,
	'HOME': process.env.HOME,
	'LANG': 'C'
};
var PARAMS = {
	'A1': { 'cutoff': 1, 'levels': 1 },
	'A2': { 'cutoff': 8, 'levels': 4 },
	'C2': { 'cutoff': 8, 'levels': 4 }
};


// FUNCTIONS //

function config( alg, n, beta, over ) {
	return Object.assign({
		'proc_id': 'm-' + alg + '-' + beta,
		'experiment': 'E7',
		'alg': alg,
		'params': PARAMS[ alg ] || { 'cutoff': null, 'levels': null },
		'M': n,
		'N': n,
		'K': n,
		'order': 'row-major',
		'transA': 'no-transpose',
		'transB': 'no-transpose',
		'ld_pad': 0,
		'alpha': 1.0,
		'beta': beta,
		'seed': 77,
		'batch': 1,
		'k': 0,
		'warmup_calls': 0,
		'mode': 'memory',
		'repoRoot': algorithms.DEFAULT_REPO_ROOT
	}, over || {} );
}

function run( script, cfg ) {
	var res = spawnSync( process.execPath, [ '--expose-gc', script, JSON.stringify( cfg ) ], {
		'cwd': '/',
		'env': ENV,
		'encoding': 'utf8',
		'timeout': 60000
	});
	var lines = res.stdout.split( '\n' ).filter( Boolean );
	return {
		'status': res.status,
		'stderr': res.stderr,
		'lines': lines,
		'mem': ( lines.length === 1 && lines[ 0 ].indexOf( 'RESULT ' ) === 0 ) ? JSON.parse( lines[ 0 ].slice( 7 ) ).mem : null
	};
}


// TESTS //

tape( 'memory mode: one RESULT {mem} per fresh process; ΔarrayBuffers = analytic bytes; released after gc()', function test( t ) {
	var t0 = Date.now();
	algorithms.ALGS.forEach( function each( alg ) {
		[ 0.0, 1.0 ].forEach( function b( beta ) {
			var cfg = config( alg, 64, beta );
			var r = run( CHILD, cfg );
			var m = r.mem;
			var expected = algorithms.analyticBytes( alg, algorithms.resolveParams( alg, cfg.params ), cfg, LIB );
			if ( r.status !== 0 || m === null ) {
				t.fail( alg + ' β=' + beta + ': exit ' + r.status + ' ' + r.stderr + JSON.stringify( r.lines ) );
				return;
			}
			t.ok(
				m.gate.pass &&
				m.analytic_bytes === expected &&
				m.ab1 - m.ab0 === expected &&
				m.ab2 === m.ab0 &&
				m.maxrss1_kib >= m.maxrss0_kib &&
				m.n === 64 && m.beta === beta && m.alg === alg && m.proc_id === cfg.proc_id &&
				typeof m.gc_during_call === 'number' && m.call_ns > 0,
				alg + ' β=' + beta + ': analytic ' + expected + ' B, ΔAB ' + ( m.ab1-m.ab0 ) + ' B, gc_during_call ' + m.gc_during_call + ', ΔmaxRSS ' + ( m.maxrss1_kib-m.maxrss0_kib ) + ' KiB'
			);
		});
	});
	t.comment( '12 memory processes in ' + ( Date.now() - t0 ) + ' ms' );
	t.end();
});

tape( 'memory mode: known analytic values (SW 64³ τ = 8: 8·E1 = 21504 B; +8·MN when β ≠ 0; C1 rectangular 8·K·N)', function test( t ) {
	var r = run( CHILD, config( 'A2', 64, 0.0 ) );
	t.strictEqual( r.mem.analytic_bytes, 21504, 'A2 β = 0' );
	r = run( CHILD, config( 'A2', 64, 2.0, { 'alpha': 0.5 } ) );
	t.strictEqual( r.mem.analytic_bytes, 21504 + ( 8*64*64 ), 'A2 β = 2' );
	r = run( CHILD, config( 'C1', 40, 0.0, { 'N': 24, 'K': 56, 'transB': 'transpose', 'order': 'column-major', 'ld_pad': 8 } ) );
	t.ok( r.mem.analytic_bytes === 8*56*24 && r.mem.ab1 - r.mem.ab0 === 8*56*24 && r.mem.n === null, 'C1 40×24×56 (column-major, Bᵀ, padded): 8·K·N measured exactly' );
	t.end();
});

tape( 'memory.js runs directly (mode forced to memory) and rejects invalid configs', function test( t ) {
	var r = run( MEMORY, config( 'A2', 32, 0.0, { 'mode': 'timing', 'k': 5 } ) );
	t.ok( r.status === 0 && r.mem !== null && r.mem.gate.pass, 'direct CLI: RESULT {mem}' );
	r = run( MEMORY, config( 'A2', 32, 0.0, { 'params': null } ) );
	t.ok( r.status === 2 && /requires params.cutoff/.test( r.stderr ) && r.mem === null, 'invalid config: exit 2' );
	t.end();
});
