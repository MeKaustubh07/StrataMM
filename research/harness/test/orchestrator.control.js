'use strict';

// Tests for research/harness/control.js: the STOP file, the stage-script runner (real child processes writing to
// stderr), E6/E1 outcome classification, resume admission, the end line and exit code, the sentinel re-check budget
// and the bounded display-sleep wait (fake clock and probe).

var tape = require( 'tape' );
var fs = require( 'fs' );
var os = require( 'os' );
var path = require( 'path' );
var control = require( './../control.js' );
var design = require( './../design.js' );

var PROTO = design.loadProtocol().protocol;
var P = design.effective( PROTO, false );
var PT = design.effective( PROTO, true );

function tmp() {
	return fs.mkdtempSync( path.join( os.tmpdir(), 'stratamm-control-' ) );
}

function state( over ) {
	return Object.assign( { 'campaigns': [ { 'type': 'campaign' } ], 'mode': 'campaign', 'protocolSha': 'a'.repeat( 64 ), 'e6Stop': null }, over || {} ); // eslint-disable-line max-len
}

function opts( over ) {
	return Object.assign( { 'id': 'campaign-20261030-223105', 'mode': 'campaign', 'sha': 'a'.repeat( 64 ), 'auto': true, 'ageH': 2, 'override': false }, over || {} ); // eslint-disable-line max-len
}

tape( 'STOP file: one older than the launch is removed, a newer one is kept', function test( t ) {
	var f = path.join( tmp(), 'STOP' );
	var t0 = Date.now();
	t.equal( control.clearStaleStop( f, t0 ), null, 'no STOP file' );
	fs.writeFileSync( f, '' );
	fs.utimesSync( f, new Date( t0 - 3600e3 ), new Date( t0 - 3600e3 ) );
	t.equal( control.clearStaleStop( f, t0 ), 'removed', 'stale STOP removed' );
	t.notOk( fs.existsSync( f ), 'gone' );
	fs.writeFileSync( f, '' );
	fs.utimesSync( f, new Date( t0 + 5000 ), new Date( t0 + 5000 ) );
	t.equal( control.clearStaleStop( f, t0 ), 'pending', 'STOP written after the launch is honoured' );
	t.ok( fs.existsSync( f ), 'kept' );
	t.end();
});

tape( 'runStageScript keeps stdout inherited and returns the new stderr tail (appended file)', function test( t ) {
	var dir = tmp();
	var script = path.join( dir, 'gate.js' );
	var errFile = path.join( dir, 'E6.stderr.log' );
	var r;
	fs.writeFileSync( script, 'console.error( "HARD GATE: SW rho_N = 1.5 >= 1 (F2 n=64 seed 3)" ); console.error( "E6 STOPPED (exit 2)" ); process.exit( Number( process.argv[ 2 ] ) );\n' ); // eslint-disable-line max-len
	r = control.runStageScript( script, [ '2' ], { 'timeoutS': 30, 'cwd': dir, 'env': { 'PATH': process.env.PATH }, 'stderrFile': errFile } ); // eslint-disable-line max-len
	t.equal( r.ok, false, 'failed' );
	t.equal( r.status, 2, 'exit 2' );
	t.deepEqual( r.stderr_tail, [ 'HARD GATE: SW rho_N = 1.5 >= 1 (F2 n=64 seed 3)', 'E6 STOPPED (exit 2)' ], 'stderr tail' );
	r = control.runStageScript( script, [ '0' ], { 'timeoutS': 30, 'cwd': dir, 'env': { 'PATH': process.env.PATH }, 'stderrFile': errFile } ); // eslint-disable-line max-len
	t.equal( r.ok, true, 'exit 0' );
	t.equal( r.stderr_tail.length, 2, 'only this run\'s stderr' );
	t.equal( fs.readFileSync( errFile, 'utf8' ).split( '\n' ).filter( Boolean ).length, 4, 'the file keeps every run' );
	fs.writeFileSync( script, 'setTimeout( function () {}, 60000 );\n' );
	r = control.runStageScript( script, [], { 'timeoutS': 1, 'cwd': dir, 'env': { 'PATH': process.env.PATH }, 'stderrFile': errFile } ); // eslint-disable-line max-len
	t.equal( r.timed_out, true, 'timeout detected' );
	t.equal( r.status, null, 'no exit status' );
	t.end();
});

tape( 'stageOutcome: E6 exit 2 means investigate; exit 1, timeouts and signals are resumable', function test( t ) {
	var c = { 'id': 'campaign-x', 'mode': 'campaign' };
	var tail = [ 'HARD GATE: classic eta_N >= K^2', 'E6 STOPPED (exit 2)' ];
	var o = control.stageOutcome( 'E6', { 'ok': false, 'status': 2, 'signal': null, 'timed_out': false, 'stderr_tail': tail }, c ); // eslint-disable-line max-len
	t.equal( o.kind, 'investigate', 'E6 exit 2' );
	t.equal( o.label, 'exit 2', 'label' );
	t.ok( /^E6 failed \(exit 2\) - INVESTIGATE, do not resume/.test( o.reason ), o.reason );
	t.ok( /--campaign --id campaign-x --override-e6-stop/.test( o.reason ), 'names the override' );
	t.ok( /\| stderr: HARD GATE: classic eta_N >= K\^2 \| E6 STOPPED \(exit 2\)$/.test( o.reason ), 'stderr tail kept in the reason' ); // eslint-disable-line max-len
	o = control.stageOutcome( 'E6', { 'ok': false, 'status': 1, 'signal': null, 'timed_out': false, 'stderr_tail': [ 'E6 ERROR: cache dir' ] }, c ); // eslint-disable-line max-len
	t.equal( o.kind, 'stage', 'E6 exit 1' );
	t.ok( /^E6 failed \(exit 1\) - resumable: re-run the launch command/.test( o.reason ), o.reason );
	t.equal( control.stageOutcome( 'E6', { 'ok': false, 'status': null, 'signal': 'SIGKILL', 'timed_out': true, 'timeout_s': 14400, 'stderr_tail': [] }, c ).label, 'timeout after 14400 s', 'timeout' ); // eslint-disable-line max-len
	t.equal( control.stageOutcome( 'E6', { 'ok': false, 'status': null, 'signal': 'SIGTERM', 'timed_out': false, 'stderr_tail': [] }, c ).kind, 'stage', 'signal: resumable' ); // eslint-disable-line max-len
	t.equal( control.stageOutcome( 'E1', { 'ok': false, 'status': 2, 'signal': null, 'timed_out': false, 'stderr_tail': [] }, c ).kind, 'stage', 'E1 exit 2 is not an E6 gate' ); // eslint-disable-line max-len
	t.equal( control.stageOutcome( 'E6', { 'ok': true, 'status': 0 }, c ).ok, true, 'success' );
	t.end();
});

tape( 'end line and exit code', function test( t ) {
	t.equal( control.endLine( 'complete', null ), 'CAMPAIGN COMPLETE', 'complete' );
	t.equal( control.endLine( 'incomplete', 'E7 aborted: x' ), 'CAMPAIGN INCOMPLETE: E7 aborted: x', 'incomplete' );
	t.equal( control.endLine( 'stopped', 'a\n  b' ), 'CAMPAIGN STOPPED: a | b', 'stopped, one line' );
	t.equal( control.exitCode( 'complete', null ), 0, 'complete: 0' );
	t.equal( control.exitCode( 'stopped', 'stage' ), 2, 'resumable stop: 2' );
	t.equal( control.exitCode( 'stopped', 'stop-file' ), 2, 'STOP file: 2' );
	t.equal( control.exitCode( 'error', 'error' ), 2, 'error: 2' );
	t.equal( control.exitCode( 'incomplete', 'e7' ), 3, 'incomplete: 3' );
	t.equal( control.exitCode( 'stopped', 'investigate' ), 4, 'E6 hard gate: 4' );
	t.end();
});

tape( 'admit: mode, protocol hash, stale auto-resume, E6 hard-gate stop', function test( t ) {
	t.equal( control.admit( state( { 'campaigns': [] } ), opts() ), null, 'nothing recorded: start' );
	t.equal( control.admit( state(), opts() ), null, 'same protocol, recent: resume' );
	t.ok( /is a tiny campaign; resume it with --tiny --id/.test( control.admit( state( { 'mode': 'tiny' } ), opts() ) ), 'other mode refused' ); // eslint-disable-line max-len
	t.ok( /different research\/protocol\.json \(aaaaaaaaaaaa -> bbbbbbbbbbbb\) and cannot be resumed; start a new campaign with --campaign --new/.test( control.admit( state(), opts( { 'sha': 'b'.repeat( 64 ) } ) ) ), 'protocol changed: refused, names --new' ); // eslint-disable-line max-len
	t.ok( /different research\/protocol\.json/.test( control.admit( state(), opts( { 'sha': 'b'.repeat( 64 ), 'auto': false } ) ) ), 'also with --id' ); // eslint-disable-line max-len
	t.ok( /last wrote data 30\.0 h ago .*--campaign --new, or resume it explicitly with --campaign --id campaign-20261030-223105/.test( control.admit( state(), opts( { 'ageH': 30 } ) ) ), 'stale auto-resume refused' ); // eslint-disable-line max-len
	t.equal( control.admit( state(), opts( { 'ageH': 30, 'auto': false } ) ), null, 'an explicit --id resumes an old campaign' ); // eslint-disable-line max-len
	t.ok( /stopped on an E6 hard gate \(exit 2, .*--override-e6-stop/.test( control.admit( state( { 'e6Stop': { 'exit_code': 2, 't_wall': '2026-10-31T02:10:00Z', 'cleared': false } } ), opts() ) ), 'E6 stop refused' ); // eslint-disable-line max-len
	t.equal( control.admit( state( { 'e6Stop': { 'exit_code': 2, 'cleared': false } } ), opts( { 'override': true, 'auto': false } ) ), null, 'explicit override' ); // eslint-disable-line max-len
	t.equal( control.admit( state( { 'e6Stop': { 'cleared': true } } ), opts() ), null, 'a cleared stop no longer blocks' );
	t.end();
});

tape( 'sentinel re-check budget: 10 min by default (tiny: 30 s), at least max_consecutive_failures', function test( t ) {
	var cfg = P.sentinel;
	t.equal( control.sentinelBudgetS( P ), P.preflight.max_wait_s, 'campaign: preflight.max_wait_s' );
	t.equal( control.sentinelBudgetS( P ), 600, '600 s' );
	t.equal( control.sentinelBudgetS( PT ), 30, 'tiny: 30 s' );
	t.equal( control.sentinelBudgetS( { 'sentinel': { 'max_wait_s': 120 }, 'preflight': { 'max_wait_s': 600 } } ), 120, 'sentinel.max_wait_s wins' ); // eslint-disable-line max-len
	t.equal( control.sentinelGivesUp( 3, 125, cfg, 600 ), false, '3 failures in about 2 min: keep re-checking (was the old stop)' ); // eslint-disable-line max-len
	t.equal( control.sentinelGivesUp( 10, 599, cfg, 600 ), false, 'under 10 min' );
	t.equal( control.sentinelGivesUp( 11, 605, cfg, 600 ), true, 'after 10 min' );
	t.equal( control.sentinelGivesUp( 2, 900, cfg, 600 ), false, 'needs max_consecutive_failures' );
	t.end();
});

tape( 'display wait: polls until the display sleeps with no screen saver, bounded, never blocking on a missing probe', function test( t ) { // eslint-disable-line max-len
	var clock = 0;
	var seq;
	var logs = [];
	var w;
	function run( states, budgetS ) {
		seq = states.slice();
		clock = 0;
		logs = [];
		return control.waitForDisplay( { 'budgetS': budgetS, 'pollS': 15, 'now': function now() {
			return clock;
		}, 'pause': function pause( ms ) {
			clock += ms;
		}, 'log': function log( m ) {
			logs.push( m );
		}, 'probe': function probe() {
			return ( seq.length > 1 ) ? seq.shift() : seq[ 0 ];
		} } );
	}
	t.equal( control.displayBudgetS( P ), 900, 'campaign: 15 min' );
	t.equal( control.displayBudgetS( PT ), 30, 'tiny: preflight.max_wait_s' );
	w = run( [ { 'display_asleep': true, 'screensaver_running': false } ], 900 );
	t.deepEqual( [ w.ok, w.waited_s, w.polls, w.warning ], [ true, 0, 1, null ], 'already asleep: no wait' );
	w = run( [ { 'display_asleep': false, 'screensaver_running': true }, { 'display_asleep': false, 'screensaver_running': true }, { 'display_asleep': true, 'screensaver_running': true }, { 'display_asleep': true, 'screensaver_running': false } ], 900 ); // eslint-disable-line max-len
	t.equal( w.ok, true, 'asleep after the screen saver ended' );
	t.equal( w.waited_s, 45, 'three 15 s polls' );
	t.equal( logs.length, 1, 'logged once a minute' );
	t.ok( /display awake, screen saver running \(0 of 900 s/.test( logs[ 0 ] ), logs[ 0 ] );
	w = run( [ { 'display_asleep': false, 'screensaver_running': false } ], 900 );
	t.deepEqual( [ w.ok, w.timed_out, w.waited_s ], [ false, true, 900 ], 'never asleep: stops waiting after 15 min' );
	t.ok( /timing started with the display awake after a 900 s wait/.test( w.warning ), w.warning );
	t.equal( logs.length, 15, 'one log line per minute' );
	w = run( [ { 'display_asleep': null, 'screensaver_running': false } ], 900 );
	t.deepEqual( [ w.ok, w.unavailable, w.waited_s ], [ false, true, 0 ], 'probe unavailable: no wait, a warning' );
	t.ok( /unavailable/.test( w.warning ), w.warning );
	t.end();
});

tape( 'tail: last non-empty lines, trimmed', function test( t ) {
	t.deepEqual( control.tail( 'a\n\nb  \nc\n', 2 ), [ 'b', 'c' ], 'last two' );
	t.deepEqual( control.tail( '', 5 ), [], 'empty' );
	t.equal( control.tail( 'x'.repeat( 1000 ) )[ 0 ].length, 400, 'line cap' );
	t.end();
});
