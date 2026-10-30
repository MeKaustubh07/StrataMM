'use strict';

// Tests for research/harness/budget.js: the --dry-run time model (T_A0 = 2n^3/1.3e9, SW (8/7)^L*0.93, C1 = T_A0/2,
// per-process overheads, one sentinel per block) and the per-stage budget.

var tape = require( 'tape' );
var budget = require( './../budget.js' );
var design = require( './../design.js' );

var L = design.loadProtocol();
var P = design.effective( L.protocol, false );
var M = P.time_model;
var STUB = { 'tau_star': 64, 'levels': 4, 'batch_by_n': {} };

function spec( alg, n, params, extra ) {
	return Object.assign( { 'alg': alg, 'M': n, 'N': n, 'K': n, 'params': params || { 'cutoff': null, 'levels': null }, 'warmup_calls': 3, 'k': 10, 'batch': 1, 'mode': 'timing', 'meta': { 'pause_s': 0.5 } }, extra || {} ); // eslint-disable-line max-len
}

tape( 'call-time model', function test( t ) {
	var T512 = 2 * 512 * 512 * 512 / 1.3e9;
	t.ok( Math.abs( budget.tA0( M, 512, 512, 512 ) - T512 ) < 1e-15, 'T_A0 = 2n^3/1.3e9' );
	t.ok( Math.abs( budget.callTime( M, spec( 'A2', 512, { 'cutoff': 64, 'levels': 4 } ) ) - ( T512 / ( Math.pow( 8 / 7, 3 ) * 0.93 ) ) ) < 1e-12, 'A2(64) at 512: L=3' ); // eslint-disable-line max-len
	t.ok( Math.abs( budget.callTime( M, spec( 'A2', 512, { 'cutoff': 16, 'levels': 4 } ) ) - ( T512 / ( Math.pow( 8 / 7, 4 ) * 0.93 ) ) ) < 1e-12, 'level cap 4' ); // eslint-disable-line max-len
	t.ok( Math.abs( budget.callTime( M, spec( 'A1', 512, { 'cutoff': 1, 'levels': 1 } ) ) - ( T512 / ( ( 8 / 7 ) * 0.93 ) ) ) < 1e-12, 'A1: one level' ); // eslint-disable-line max-len
	t.equal( budget.callTime( M, spec( 'A2', 64, { 'cutoff': 64, 'levels': 4 } ) ), budget.tA0( M, 64, 64, 64 ), 'A2 at n <= tau delegates (L=0)' ); // eslint-disable-line max-len
	t.ok( Math.abs( budget.callTime( M, spec( 'C1', 512 ) ) - ( T512 / 2 ) ) < 1e-15, 'C1 = T_A0/2' );
	t.equal( budget.callTime( M, spec( 'C2', 512, { 'cutoff': 64, 'levels': 4 } ) ), T512, 'C2 = T_A0' );
	t.end();
});

tape( 'process and block times include start-up, gate, warmup, samples, pause and the sentinel', function test( t ) {
	var T512 = budget.tA0( M, 512, 512, 512 );
	var s = spec( 'A0', 512 );
	var sent = design.sentinelSpec( P );
	var T256 = budget.tA0( M, 256, 256, 256 );
	t.ok( Math.abs( budget.procTime( M, s ) - ( 0.07 + ( 4 * T512 ) + ( 10 * T512 ) + 0.5 ) ) < 1e-12, 'process = 0.07 + (1+3)T + k*b*T + pause' ); // eslint-disable-line max-len
	// Sentinel warmup (amendment 2026-10-30c): max( 5 calls, 0.25 s, min( 4000 invocations, 2 s ) ) = 2 s at n = 256:
	t.ok( Math.abs( budget.procTime( M, sent ) - ( 0.07 + T256 + Math.max( 5*T256, 0.25, Math.min( 4000*T256, 2.0 ) ) + ( 15 * T256 ) + 0.5 ) ) < 1e-12, 'sentinel: gate + warmup (count/time/invocation target) + 15 samples' ); // eslint-disable-line max-len
	t.ok( Math.abs( budget.procTime( M, spec( 'A0', 512, null, { 'warmup_min_seconds': 0.25, 'warmup_target_invocations': 4000, 'warmup_max_seconds': 2.0 } ) ) - ( 0.07 + T512 + 2.0 + ( 10 * T512 ) + 0.5 ) ) < 1e-12, 'A0 at n=512: the invocation target caps the warmup at 2 s' ); // eslint-disable-line max-len
	t.ok( Math.abs( budget.procTime( M, spec( 'A0', 32, null, { 'warmup_min_seconds': 0.25, 'warmup_target_invocations': 4000, 'warmup_max_seconds': 2.0, 'k': 30, 'batch': 1 } ) ) - ( 0.07 + budget.tA0( M, 32, 32, 32 ) + Math.max( 0.25, 4000*budget.tA0( M, 32, 32, 32 ) ) + ( 30 * budget.tA0( M, 32, 32, 32 ) ) + 0.5 ) ) < 1e-12, 'A0 at n=32: 4000 invocations' ); // eslint-disable-line max-len
	t.ok( Math.abs( budget.blockTime( M, { 'procs': [ s, s ] }, sent ) - ( M.env_check_s + budget.procTime( M, sent ) + ( 2 * budget.procTime( M, s ) ) ) ) < 1e-12, 'block = env check + sentinel + processes' ); // eslint-disable-line max-len
	t.ok( Math.abs( budget.procTime( M, spec( 'A0', 2048, null, { 'mode': 'memory', 'k': 0, 'warmup_calls': 0, 'meta': { 'pause_s': 2 } } ) ) - ( 0.07 + budget.tA0( M, 2048, 2048, 2048 ) + 2 ) ) < 1e-12, 'memory process = start-up + one call + pause' ); // eslint-disable-line max-len
	t.end();
});

tape( 'model batch b(n) = max(1, ceil(0.020 s / T_A0(n)))', function test( t ) {
	t.equal( budget.modelBatch( P, 32, 32, 32 ), Math.ceil( 0.02 / ( 2 * 32 * 32 * 32 / 1.3e9 ) ), 'n=32' );
	t.equal( budget.modelBatch( P, 192, 192, 192 ), 2, 'n=192' );
	t.equal( budget.modelBatch( P, 256, 256, 256 ), 1, 'n=256' );
	t.equal( budget.modelBatch( P, 2048, 2048, 2048 ), 1, 'n=2048' );
	t.end();
});

tape( 'campaign budget: positive per stage, totals add up, total within the protocol range', function test( t ) {
	var designs = design.buildAll( P, STUB );
	var b = budget.campaignBudget( P, designs );
	var sum = 0;
	t.deepEqual( b.stages.map( function f( s ) {
		return s.stage;
	}), [ 'pilot', 'E2', 'E3', 'E5', 'E4', 'E0', 'E7', 'E6' ], 'every stage in run order' );
	b.stages.forEach( function each( s ) {
		t.ok( s.seconds > 0 && isFinite( s.seconds ), s.stage + ' budget positive (' + budget.fmt( s.seconds ) + ')' );
		sum += s.seconds;
	});
	t.ok( Math.abs( sum - b.total_s ) < 1e-6, 'total = sum of stages' );
	t.ok( b.total_s > 2.5 * 3600 && b.total_s < 4.5 * 3600, 'total ' + budget.fmt( b.total_s ) + ' within 2.5–4.5 h' );
	t.equal( b.stages[ 1 ].sentinels, b.stages[ 1 ].blocks, 'one sentinel per E2 block' );
	t.equal( b.stages[ 6 ].sentinels, 0, 'no sentinels in E7' );
	t.end();
});

tape( 'tiny budget fits the 5-minute requirement', function test( t ) {
	var T = design.effective( L.protocol, true );
	var b = budget.campaignBudget( T, design.buildAll( T, { 'tau_star': 32, 'levels': 4, 'batch_by_n': {} } ) );
	t.ok( b.timing_s < 120, 'tiny timing stages ' + budget.fmt( b.timing_s ) );
	t.ok( b.total_s < 300, 'tiny total ' + budget.fmt( b.total_s ) );
	t.end();
});

tape( 'dry-run report lines', function test( t ) {
	var lines = budget.dryRunLines( P, design.buildAll( P, STUB ), { 'tau': 64, 'sha256': L.sha256, 'file': 'research/protocol.json', 'verbose': false } ); // eslint-disable-line max-len
	t.ok( lines[ 0 ].indexOf( L.sha256 ) > 0, 'header names the protocol hash' );
	t.ok( lines.some( function f( l ) {
		return /^TOTAL/.test( l );
	}), 'total line' );
	t.ok( lines.some( function f( l ) {
		return /^E2 +170 +510 +170/.test( l );
	}), 'E2 budget row' );
	t.equal( budget.fmt( 45 ), '45 s', 'fmt s' );
	t.equal( budget.fmt( 600 ), '10.0 min', 'fmt min' );
	t.equal( budget.fmt( 3 * 3600 + 1790 ), '3 h 30 min', 'fmt h' );
	t.end();
});
