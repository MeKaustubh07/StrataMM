'use strict';

// Tests for research/harness/resume.js on synthetic partial JSONL: done set (non-excluded only), attempts, sentinel
// baseline, truncated last line, frozen.json reuse, campaign discovery, the skip of recorded configurations, settled
// configurations (a completed block is never revisited), blocks with records, the E6 stop marker and env_check fields.

var tape = require( 'tape' );
var fs = require( 'fs' );
var os = require( 'os' );
var path = require( 'path' );
var resume = require( './../resume.js' );
var design = require( './../design.js' );

var P = design.effective( design.loadProtocol().protocol, false );
var STUB = { 'tau_star': 64, 'levels': 4, 'batch_by_n': {} };

function tmp() {
	return fs.mkdtempSync( path.join( os.tmpdir(), 'stratamm-resume-' ) );
}

// A proc record as the orchestrator writes it: child fields, then the configuration fields, then the owned fields.
function procRecord( spec, excluded, median ) {
	return Object.assign( { 'schema': 'sw-bench/2', 'type': 'proc', 'campaign': 'c1', 't_wall': '2026-10-30T23:00:00.000Z', 'lda': spec.K, 'first_call_ns': 1, 'per_call_median_ns': median || 1e6 }, spec, { 'meta': void 0, 'proc_id': spec.block_id + '.p' + spec.pos_in_block + '.t1', 'excluded': !!excluded, 'exclusion_reason': ( excluded ) ? 'swapouts+3' : null } ); // eslint-disable-line max-len
}

function sentinel( block, median, excluded ) {
	return { 'type': 'proc', 'experiment': 'sentinel', 'alg': 'SENTINEL', 'block_id': block, 'per_call_median_ns': median, 'excluded': !!excluded }; // eslint-disable-line max-len
}

function writePartial( dir, mode, end ) {
	var e2 = design.buildStage( P, STUB, 'E2' );
	var b0 = e2.blocks[ 0 ];
	var lines = [
		resume.record( 'c1', 'campaign', { 'protocol_sha256': 'abc', 'design': { 'mode': mode }, 'master_seed': 1 } ),
		sentinel( b0.block_id, 100, false ), sentinel( 'x1', 102, false ), sentinel( 'x2', 999, true ), sentinel( 'x3', 98, false ), sentinel( 'x4', 101, false ), sentinel( 'x5', 99, false ), sentinel( 'x6', 150, false ), // eslint-disable-line max-len
		procRecord( b0.procs[ 0 ], false ),
		procRecord( b0.procs[ 1 ], true ),
		procRecord( b0.procs[ 1 ], false ),
		procRecord( b0.procs[ 2 ], true )
	];
	if ( end ) {
		lines.push( resume.record( 'c1', 'campaign_end', { 'status': end, 'reason': null } ) );
	}
	fs.writeFileSync( path.join( dir, 'campaign.jsonl' ), lines.map( function f( r ) {
		return JSON.stringify( r );
	}).join( '\n' ) + '\n{"type":"proc","stage":"E2","trunc' ); // a line truncated by a crash
	return e2;
}

tape( 'loadState: done set holds non-excluded configurations only; attempts and bad lines counted', function test( t ) {
	var dir = tmp();
	var e2 = writePartial( dir, 'campaign', null );
	var b0 = e2.blocks[ 0 ];
	var st = resume.loadState( dir );
	t.equal( st.bad, 1, 'truncated line skipped' );
	t.equal( st.protocolSha, 'abc', 'protocol hash' );
	t.equal( st.mode, 'campaign', 'mode' );
	t.ok( st.done.has( resume.procKey( b0.procs[ 0 ] ) ), 'completed configuration' );
	t.ok( st.done.has( resume.procKey( b0.procs[ 1 ] ) ), 'excluded then re-run configuration' );
	t.notOk( st.done.has( resume.procKey( b0.procs[ 2 ] ) ), 'excluded configuration is not done' );
	t.equal( st.attempts[ resume.procKey( b0.procs[ 1 ] ) ], 2, 'two attempts' );
	t.deepEqual( st.sentinelMedians, [ 100, 102, 98, 101, 99, 150 ], 'excluded sentinel skipped' );
	t.equal( st.sentinelCount[ b0.block_id ], 1, 'sentinel count per block' );
	t.equal( resume.sentinelBaseline( st.sentinelMedians, 5 ), 100, 'median of the first 5 sentinels' );
	t.equal( resume.sentinelBaseline( [ 1, 2 ], 5 ), null, 'no baseline before 5 sentinels' );
	t.end();
});

tape( 'resume skips recorded configurations and re-runs excluded/missing ones', function test( t ) {
	var dir = tmp();
	var e2 = writePartial( dir, 'campaign', null );
	var st = resume.loadState( dir );
	var todo = [];
	e2.blocks.forEach( function each( b ) {
		b.procs.forEach( function p( x ) {
			if ( !st.done.has( resume.procKey( x ) ) ) {
				todo.push( x );
			}
		});
	});
	t.equal( todo.length, 510 - 2, 'all but the two completed configurations remain' );
	t.equal( todo[ 0 ].block_id, e2.blocks[ 0 ].block_id, 'the partial block comes first' );
	t.equal( todo[ 0 ].pos_in_block, 2, 'only its excluded configuration re-runs' );
	t.end();
});

tape( 'procKey ignores child-only fields and differs across configurations', function test( t ) {
	var e3 = design.buildStage( P, STUB, 'E3' ).blocks[ 0 ].procs;
	var keys = e3.map( resume.procKey );
	t.equal( resume.procKey( procRecord( e3[ 0 ], false ) ), keys[ 0 ], 'record key = spec key' );
	t.equal( keys.filter( function u( k, i ) {
		return keys.indexOf( k ) === i;
	}).length, e3.length, 'distinct keys within a block (alg, ld_pad)' );
	t.end();
});

tape( 'append after a truncated line starts a fresh line', function test( t ) {
	var dir = tmp();
	var f = path.join( dir, 'campaign.jsonl' );
	writePartial( dir, 'campaign', null );
	t.equal( resume.ensureTrailingNewline( f ), true, 'newline added' );
	t.equal( resume.ensureTrailingNewline( f ), false, 'idempotent' );
	resume.append( f, [ { 'type': 'env_check', 'block_id': 'b' }, { 'type': 'env_check', 'block_id': 'c' } ] );
	t.deepEqual( resume.readJsonl( f ).records.slice( -2 ).map( function m( r ) {
		return r.block_id;
	}), [ 'b', 'c' ], 'appended records parse' );
	t.equal( resume.readJsonl( f ).bad, 1, 'only the truncated line is bad' );
	t.end();
});

tape( 'frozen.json is reused (pilot never re-run) and stage markers are read from the log', function test( t ) {
	var dir = tmp();
	var fr = { 'type': 'frozen', 'tau_star': 64, 'levels': 4, 'batch_by_n': { '32': 400 }, 'protocol_sha256': 'abc' };
	writePartial( dir, 'campaign', null );
	resume.writeFrozen( dir, fr );
	fs.writeFileSync( path.join( dir, 'campaign.log' ), '2026-10-31T01:00:00Z STAGE E6 COMPLETE (39.0 min)\n2026-10-31T01:00:01Z STAGE E2 START: 3 of 170 blocks\n' ); // eslint-disable-line max-len
	t.deepEqual( resume.loadState( dir ).frozen, fr, 'frozen.json loaded' );
	t.ok( resume.loadState( dir ).stagesComplete.has( 'E6' ), 'E6 complete' );
	t.notOk( resume.loadState( dir ).stagesComplete.has( 'E2' ), 'E2 not complete' );
	t.notOk( fs.existsSync( path.join( dir, 'frozen.json.tmp' ) ), 'atomic write' );
	t.end();
});

tape( 'findResumable: latest unfinished campaign of the same mode', function test( t ) {
	var root = tmp();
	[ [ 'campaign-a', 'campaign', 'complete' ], [ 'campaign-b', 'campaign', 'stopped' ], [ 'tiny-c', 'tiny', null ] ].forEach( function each( x ) { // eslint-disable-line max-len
		fs.mkdirSync( path.join( root, x[ 0 ] ) );
		writePartial( path.join( root, x[ 0 ] ), x[ 1 ], x[ 2 ] );
	});
	fs.mkdirSync( path.join( root, 'diagnostics' ) );
	t.equal( resume.findResumable( root, 'campaign' ), 'campaign-b', 'stopped campaign resumes' );
	t.equal( resume.findResumable( root, 'tiny' ), 'tiny-c', 'tiny campaign that never ended' );
	t.equal( resume.findResumable( path.join( root, 'missing' ), 'campaign' ), null, 'no data dir' );
	t.ok( /^campaign-\d{8}-\d{6}$/.test( resume.newId( 'campaign', new Date( '2026-10-30T23:00:05Z' ) ) ), 'id format' );
	t.equal( resume.newId( 'tiny', new Date( '2026-10-30T23:00:05Z' ) ), 'tiny-20261030-230005', 'UTC stamp' );
	t.end();
});

tape( 'record and env_check builders', function test( t ) {
	var r = resume.record( 'c9', 'proc', { 'type': 'spoofed', 'schema': 'x', 'a': 1 } );
	var e = resume.envCheckRecord( 'c9', { 'block_id': 'E2.n32.b1', 'stage': 'E2' }, { 'power': { 'source': 'AC Power' }, 'low_power_mode': false, 'thermal_state': 0, 'load_avg': [ 1, 1, 1 ], 'swap_used_mb': 10, 'pressure_level': 1, 'swapouts': 5, 'top_cpu': [] }, { 'median_ns': 1, 'iqr_ns': 0, 'drift': 0.01 }, [], false ); // eslint-disable-line max-len
	t.equal( r.type, 'proc', 'type cannot be overridden' );
	t.equal( r.schema, 'sw-bench/2', 'schema' );
	t.equal( r.a, 1, 'fields kept' );
	t.ok( typeof r.t_wall === 'string', 't_wall ISO string' );
	t.equal( e.type, 'env_check', 'env_check type' );
	t.equal( e.sentinel.drift, 0.01, 'sentinel stats' );
	t.equal( e.pass, true, 'pass when no reasons' );
	t.end();
});

tape( 'settled: complete, or excluded after 1 + max_retries attempts; a completed block is never revisited', function test( t ) { // eslint-disable-line max-len
	var dir = tmp();
	var e2 = writePartial( dir, 'campaign', null );
	var b0 = e2.blocks[ 0 ];
	var st = resume.loadState( dir );
	var max = P.exclusion.max_retries;
	var k = b0.procs.map( resume.procKey );
	t.equal( resume.settled( st, k[ 0 ], max ), true, 'non-excluded record' );
	t.equal( resume.settled( st, k[ 1 ], max ), true, 'excluded, then completed by its retry' );
	t.equal( resume.settled( st, k[ 2 ], max ), false, 'excluded once: interrupted before its retry' );
	t.equal( resume.settled( st, k[ 3 ], max ), false, 'never ran' );
	resume.ensureTrailingNewline( path.join( dir, 'campaign.jsonl' ) ); // as the orchestrator does after a crash
	fs.appendFileSync( path.join( dir, 'campaign.jsonl' ), JSON.stringify( procRecord( b0.procs[ 2 ], true ) ) + '\n' );
	st = resume.loadState( dir );
	t.equal( st.attempts[ k[ 2 ] ], 2, 'second attempt recorded' );
	t.equal( resume.settled( st, k[ 2 ], max ), true, 'excluded after its retry: settled (replication stays fixed)' );
	t.notOk( st.done.has( k[ 2 ] ), 'but never counted as done' );
	t.deepEqual( Array.from( st.blocks ), [ b0.block_id ], 'blocks with proc/mem records (sentinels ignored)' );
	t.end();
});

tape( 'e6_stop: the last record wins; cleared lifts the stop', function test( t ) {
	var dir = tmp();
	var f = path.join( dir, 'campaign.jsonl' );
	writePartial( dir, 'campaign', 'stopped' );
	t.equal( resume.loadState( dir ).e6Stop, null, 'none' );
	fs.appendFileSync( f, '\n' + JSON.stringify( resume.record( 'c1', 'e6_stop', { 'stage': 'E6', 'exit_code': 2, 'cleared': false } ) ) + '\n' ); // eslint-disable-line max-len
	t.equal( resume.loadState( dir ).e6Stop.cleared, false, 'stop recorded' );
	fs.appendFileSync( f, JSON.stringify( resume.record( 'c1', 'e6_stop', { 'stage': 'E6', 'cleared': true } ) ) + '\n' );
	t.equal( resume.loadState( dir ).e6Stop.cleared, true, 'override recorded' );
	t.end();
});

tape( 'env_check records display, screen saver, blocked and harness processes, plus extra fields', function test( t ) {
	var s = { 'power': { 'source': 'AC Power' }, 'low_power_mode': false, 'thermal_state': 0, 'load_avg': [ 1, 1, 1 ], 'swap_used_mb': 10, 'pressure_level': 1, 'swapouts': 5, 'top_cpu': [], 'display_asleep': true, 'screensaver_running': false, 'blocked': [ { 'pid': 1521, 'kind': 'blocked' } ], 'blocked_ignored': [ { 'pid': 55593, 'kind': 'updater' } ], 'harness_procs': [ { 'pid': 6001, 'name': 'orchestrator.js' } ] }; // eslint-disable-line max-len
	var e = resume.envCheckRecord( 'c9', { 'block_id': 'E2.n32.b1', 'stage': 'E2' }, s, null, [], false, { 'start_index': 2 } ); // eslint-disable-line max-len
	t.equal( e.display_asleep, true, 'display_asleep' );
	t.equal( e.screensaver_running, false, 'screensaver_running' );
	t.equal( e.blocked[ 0 ].pid, 1521, 'blocked process recorded' );
	t.equal( e.blocked_ignored[ 0 ].pid, 55593, 'ignored updater recorded' );
	t.equal( e.harness_procs[ 0 ].pid, 6001, 'harness processes recorded' );
	t.equal( e.start_index, 2, 'extra field' );
	e = resume.envCheckRecord( 'c9', { 'block_id': 'b', 'stage': 'E2' }, { 'power': {}, 'top_cpu': [] }, null, [], false );
	t.deepEqual( [ e.display_asleep, e.screensaver_running, e.blocked, e.blocked_ignored, e.harness_procs ], [ null, null, null, null, null ], 'older snapshots: null fields' ); // eslint-disable-line max-len
	t.end();
});
