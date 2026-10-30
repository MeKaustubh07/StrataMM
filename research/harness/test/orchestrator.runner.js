'use strict';

// Tests for research/harness/runner.js with stubbed children, probes and stage scripts (proxyquire): the STOP file,
// E6/E1 failure paths (exit 2 → investigate + e6_stop record + stderr tail in campaign.log and campaign_end; exit 1 →
// resumable), an E7 abort ending 'incomplete' after E6, the 10-minute sentinel re-check budget (fake clock), and the
// settled-configuration rule of a resume.

var tape = require( 'tape' );
var proxyquire = require( 'proxyquire' );
var fs = require( 'fs' );
var os = require( 'os' );
var path = require( 'path' );
var design = require( './../design.js' );
var resume = require( './../resume.js' );
var control = require( './../control.js' );

var REPO = path.resolve( __dirname, '..', '..', '..' );
var PROTO = design.loadProtocol().protocol;
var SNAP = { 'power': { 'source': 'AC Power', 'ac': true }, 'low_power_mode': false, 'thermal_state': 0, 'load_avg': [ 1, 1, 1 ], 'swap_used_mb': 10, 'pressure_level': 1, 'swapouts': 5, 'top_cpu': [], 'busy': [], 'blocked': [], 'display_asleep': true, 'screensaver_running': false }; // eslint-disable-line max-len
var QUICK = { 'power_source': 'AC Power', 'swapouts': 5, 'pressure_level': 1, 'thermal_state': 0 };

function tmp() {
	return fs.mkdtempSync( path.join( os.tmpdir(), 'stratamm-runner-' ) );
}

// Runs fn with console.log silenced (the runner prints every log line); returns { value } or { error }.
function quiet( fn ) {
	var saved = console.log; // eslint-disable-line no-console
	console.log = function noop() {}; // eslint-disable-line no-console
	try {
		return { 'value': fn() };
	} catch ( err ) {
		return { 'error': err };
	} finally {
		console.log = saved; // eslint-disable-line no-console
	}
}

function session( dir, tiny, over ) {
	var P = design.effective( PROTO, tiny );
	return Object.assign( { 'id': path.basename( dir ), 'P': P, 'sha': 'x', 'dir': dir, 'skip': false, 'acc': { 'model': 0, 'actual': 0 }, 'algFails': {}, 'childFails': 0, 'sentinelFails': 0, 'sentinelSince': null, 'warnings': [], 'ran': 0, 'excluded': 0, 't0': Date.now(), 'lock': null, 'state': resume.loadState( dir ), 'startIndex': 1, 'resumedBlocks': new Set(), 'displayChecked': true, 'override': false, 'paths': { 'child': path.join( REPO, P.paths.child ) }, 'files': { 'jsonl': path.join( dir, 'campaign.jsonl' ), 'log': path.join( dir, 'campaign.log' ), 'stop': path.join( dir, 'STOP' ) }, 'sentinelMedians': [], 'powerSource': 'AC Power' }, over || {} ); // eslint-disable-line max-len
}

function records( C, type ) {
	return resume.readJsonl( C.files.jsonl ).records.filter( function f( r ) {
		return r.type === type;
	});
}

function lastLine( C ) {
	var lines = fs.readFileSync( C.files.log, 'utf8' ).trim().split( '\n' );
	return lines[ lines.length - 1 ];
}

function load( stubs ) {
	return proxyquire( './../runner.js', stubs || {} );
}

function scriptResult( status, tail ) {
	return function runStageScript( file, args, o ) {
		return { 'ok': status === 0, 'status': status, 'signal': null, 'timed_out': false, 'timeout_s': o.timeoutS, 'error': null, 'stderr_tail': tail || [], 'stderr_file': o.stderrFile }; // eslint-disable-line max-len
	};
}

tape( 'STOP file: checkStop and pause throw a resumable StopError; finish ends stopped with exit 2', function test( t ) {
	var runner = load( { './preflight.js': { 'sleep': function sleep() {} } } );
	var C = session( tmp(), true );
	var o;
	t.equal( quiet( function f() {
		return runner.checkStop( C );
	}).error, void 0, 'no STOP file: continue' );
	fs.writeFileSync( C.files.stop, '' );
	o = quiet( function f() {
		return runner.pause( C, 60000 );
	});
	t.ok( o.error instanceof runner.StopError, 'pause stops' );
	t.equal( o.error.kind, 'stop-file', 'kind' );
	t.ok( /STOP file found \(.*STOP\); resumable/.test( o.error.message ), o.error.message );
	quiet( function f() {
		runner.finish( C, 'stopped', o.error.message, o.error.kind );
	});
	t.equal( process.exitCode, 2, 'exit 2' );
	t.equal( records( C, 'campaign_end' )[ 0 ].status, 'stopped', 'campaign_end stopped' );
	t.equal( records( C, 'campaign_end' )[ 0 ].stop_kind, 'stop-file', 'stop kind recorded' );
	t.ok( /^CAMPAIGN STOPPED: STOP file found/.test( lastLine( C ) ), lastLine( C ) );
	process.exitCode = 0;
	t.end();
});

tape( 'E6 exit 2: investigate, e6_stop record, stderr tail in campaign.log and campaign_end, exit 4, resume refused', function test( t ) { // eslint-disable-line max-len
	var runner = load( { './control.js': { 'runStageScript': scriptResult( 2, [ 'HARD GATE: SW rho_N = 1.5 >= 1', 'E6 STOPPED (exit 2)' ] ) } } ); // eslint-disable-line max-len
	var C = session( tmp(), false );
	var o = quiet( function f() {
		return runner.runScript( C, 'E6', path.join( REPO, 'research/accuracy/run.js' ) );
	});
	var log;
	var st;
	t.ok( o.error instanceof runner.StopError, 'throws' );
	t.equal( o.error.kind, 'investigate', 'investigate' );
	t.equal( records( C, 'e6_stop' ).length, 1, 'e6_stop record' );
	t.deepEqual( records( C, 'e6_stop' )[ 0 ].stderr_tail, [ 'HARD GATE: SW rho_N = 1.5 >= 1', 'E6 STOPPED (exit 2)' ], 'stderr tail recorded' ); // eslint-disable-line max-len
	quiet( function f() {
		runner.finish( C, 'stopped', o.error.message, o.error.kind );
	});
	log = fs.readFileSync( C.files.log, 'utf8' );
	t.ok( /STAGE E6 FAILED: exit 2; stderr in .*E6\.stderr\.log, last lines:/.test( log ), 'failure logged' );
	t.ok( /  E6 stderr\| HARD GATE: SW rho_N = 1\.5 >= 1\n/.test( log ), 'stderr tail in campaign.log' );
	t.ok( /^CAMPAIGN STOPPED: E6 failed \(exit 2\) - INVESTIGATE, do not resume/.test( lastLine( C ) ), lastLine( C ) );
	t.ok( /HARD GATE: SW rho_N/.test( records( C, 'campaign_end' )[ 0 ].reason ), 'stderr tail in campaign_end.reason' );
	t.equal( records( C, 'campaign_end' )[ 0 ].exit_code, 4, 'exit code recorded' );
	t.equal( process.exitCode, 4, 'exit 4' );
	process.exitCode = 0;
	st = resume.loadState( C.dir );
	t.notOk( st.stagesComplete.has( 'E6' ), 'E6 not complete' );
	st.campaigns = [ { 'type': 'campaign' } ];
	st.mode = 'campaign';
	t.ok( /stopped on an E6 hard gate/.test( control.admit( st, { 'id': C.id, 'mode': 'campaign', 'sha': 'x', 'auto': true, 'ageH': 1 } ) ), 'a resume is refused' ); // eslint-disable-line max-len
	t.end();
});

tape( 'E6 exit 1 and E1 failures are resumable stops (exit 2); success marks the stage complete', function test( t ) {
	var C = session( tmp(), true );
	var o = quiet( function f() {
		return load( { './control.js': { 'runStageScript': scriptResult( 1, [ 'E6 ERROR: no space left on device' ] ) } } ).runScript( C, 'E6', path.join( REPO, 'research/accuracy/run.js' ) ); // eslint-disable-line max-len
	});
	t.equal( o.error.kind, 'stage', 'E6 exit 1: resumable' );
	t.ok( /^E6 failed \(exit 1\) - resumable: re-run the launch command \(or --tiny --id /.test( o.error.message ), o.error.message ); // eslint-disable-line max-len
	t.equal( records( C, 'e6_stop' ).length, 0, 'no e6_stop record' );
	t.equal( control.exitCode( 'stopped', o.error.kind ), 2, 'exit 2' );
	o = quiet( function f() {
		return load( { './control.js': { 'runStageScript': scriptResult( 1, [ 'E1 FAILED: [{"n":3}]' ] ) } } ).runScript( C, 'E1', path.join( REPO, 'research/correctness/e1.js' ) ); // eslint-disable-line max-len
	});
	t.equal( o.error.kind, 'stage', 'E1 failure stops the campaign' );
	o = quiet( function f() {
		return load( { './control.js': { 'runStageScript': scriptResult( 0 ) } } ).runScript( C, 'E6', path.join( REPO, 'research/accuracy/run.js' ) ); // eslint-disable-line max-len
	});
	t.equal( o.error, void 0, 'success' );
	t.ok( resume.loadState( C.dir ).stagesComplete.has( 'E6' ), 'STAGE E6 COMPLETE marker' );
	fs.writeFileSync( C.files.stop, '' );
	o = quiet( function f() {
		return load( { './control.js': { 'runStageScript': function never() {
			throw new Error( 'must not run' );
		} } } ).runScript( C, 'E1', path.join( REPO, 'research/correctness/e1.js' ) );
	});
	t.equal( o.error.kind, 'stop-file', 'a STOP file prevents the next stage script' );
	t.end();
});

tape( 'E7 aborted by repeated child failures: E6 and E1 still run, the campaign ends INCOMPLETE (exit 3)', function test( t ) { // eslint-disable-line max-len
	var calls = [];
	var runner = load( {
		'./preflight.js': { 'gate': function gate() {
			return { 'status': 'pass', 'reasons': [], 'snap': SNAP, 'waited_s': 0 };
		}, 'quick': function quick() {
			return QUICK;
		}, 'swapouts': function swapouts() {
			return 5;
		}, 'sleep': function sleep() {} },
		'./diagnostics.js': { 'spawnChild': function spawnChild() {
			return { 'result': null, 'error': 'exit 1: memory.js crashed', 'stdout': '', 'stderr': '', 'status': 1 };
		} },
		'./control.js': { 'runStageScript': function runStageScript( file, args, o ) {
			calls.push( path.basename( file ) );
			return scriptResult( 0 )( file, args, o );
		} }
	});
	var C = session( tmp(), true, { 'frozen': { 'tau_star': 32, 'levels': 4, 'batch_by_n': {} } } );
	var o = quiet( function f() {
		return runner.postTiming( C );
	});
	t.equal( o.error, void 0, 'no throw' );
	t.deepEqual( calls, [ 'run.js', 'e1.js' ], 'E6 and E1 ran after the abort' );
	t.equal( records( C, 'campaign_end' )[ 0 ].status, 'incomplete', 'status incomplete' );
	t.ok( /^CAMPAIGN INCOMPLETE: E7 aborted: repeated child failures/.test( lastLine( C ) ), lastLine( C ) );
	t.equal( process.exitCode, 3, 'exit 3' );
	t.equal( records( C, 'mem' ).length, 3, 'three failed memory processes recorded' );
	t.ok( records( C, 'mem' ).every( function f( r ) {
		return r.excluded && r.start_index === 1 && r.block_resumed === false;
	}), 'excluded, with start_index and block_resumed' );
	process.exitCode = 0;
	t.end();
});

tape( 'sentinel drift: pause and re-check for 10 minutes before stopping; a recovery continues', function test( t ) {
	var clock = 1.0e12;
	var medians;
	var realNow = Date.now;
	var runner = load( {
		'./preflight.js': { 'gate': function gate() {
			return { 'status': 'pass', 'reasons': [], 'snap': SNAP, 'waited_s': 0 };
		}, 'quick': function quick() {
			return QUICK;
		}, 'swapouts': function swapouts() {
			return 5;
		}, 'sleep': function sleep( ms ) {
			clock += Math.max( 0, ms );
		} },
		'./diagnostics.js': { 'spawnChild': function spawnChild() {
			clock += 1000;
			return { 'result': { 'proc': { 'per_call_median_ns': medians.shift(), 'excluded': false }, 'samples': [] }, 'error': null };
		} }
	});
	var C = session( tmp(), false, { 'sentinelMedians': [ 100, 100, 100, 100, 100 ] } );
	var block = { 'block_id': 'E2.P.n512.b1', 'stage': 'E2' };
	var t0 = clock;
	var o;
	var n;
	Date.now = function now() {
		return clock;
	};
	try {
		medians = new Array( 40 ).fill( 110 ); // +10% drift, never recovers
		o = quiet( function f() {
			return runner.preBlock( C, block, design.sentinelSpec( C.P ) );
		});
		n = records( C, 'proc' ).length;
	} finally {
		Date.now = realNow;
	}
	t.ok( o.error instanceof runner.StopError, 'stops' );
	t.equal( o.error.kind, 'sentinel', 'kind sentinel' );
	t.ok( n > 3, n + ' sentinel attempts (the old rule stopped after 3)' );
	t.ok( ( clock - t0 ) / 1000 >= 600, 'after at least 10 minutes (' + ( ( clock - t0 ) / 1000 ) + ' s)' );
	t.ok( ( clock - t0 ) / 1000 < 700, 'and not much later' );
	t.ok( /sentinel failed \d+ consecutive checks over \d+ s \(sentinel drift 10\.00%/.test( o.error.message ), o.error.message ); // eslint-disable-line max-len
	t.ok( /SENTINEL FAIL 3 \(1\d\d of 600 s\)/.test( fs.readFileSync( C.files.log, 'utf8' ) ), 'progress logged' );
	C = session( tmp(), false, { 'sentinelMedians': [ 100, 100, 100, 100, 100 ] } );
	Date.now = function now() {
		return clock;
	};
	try {
		medians = [ 110, 110, 110, 110, 101 ];
		o = quiet( function f() {
			return runner.preBlock( C, block, design.sentinelSpec( C.P ) );
		});
	} finally {
		Date.now = realNow;
	}
	t.equal( o.error, void 0, 'recovers on the 5th check (after 4 minutes)' );
	t.equal( C.sentinelFails, 0, 'counter reset' );
	t.equal( records( C, 'env_check' ).length, 5, 'one env_check per sentinel' );
	t.equal( records( C, 'env_check' )[ 0 ].start_index, 1, 'env_check carries start_index' );
	t.end();
});

tape( 'resume: only unsettled configurations run (missing, or excluded before their in-block retry)', function test( t ) {
	var runner = load();
	var P = design.effective( PROTO, false );
	var b = design.buildStage( P, { 'tau_star': 64, 'levels': 4, 'batch_by_n': {} }, 'E3' ).blocks[ 0 ];
	var C = session( tmp(), false );
	var keys = b.procs.map( resume.procKey );
	C.state.done.add( keys[ 0 ] );
	C.state.attempts[ keys[ 0 ] ] = 1;
	C.state.attempts[ keys[ 1 ] ] = 2; // excluded twice: retry spent, stays excluded
	C.state.attempts[ keys[ 2 ] ] = 1; // excluded once: the block was interrupted before its retry
	t.deepEqual( runner.todoOf( C, b.procs ).map( function f( p ) {
		return p.pos_in_block;
	}), b.procs.slice( 2 ).map( function f( p ) {
		return p.pos_in_block;
	}), 'complete and retried-excluded configurations are settled' );
	t.end();
});
