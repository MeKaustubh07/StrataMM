'use strict';

// Tests for the pre-flight parsers (research/harness/preflight.js, procs.js) on command outputs captured on the
// campaign machine (MacBook Air M2, macOS 26.4.1) and on process tables of the same shape, plus the rule evaluation
// and the post-process exclusion reasons: blocked processes (STRATAMM_BLOCKED_PROCESSES, else the protocol's
// `blocked_pattern`, else none; idle updaters only recorded), other harness processes outside this tree and its
// launchers, the screen saver and the display probe. The machine need not pass pre-flight.

var tape = require( 'tape' );
var preflight = require( './../preflight.js' );
var procs = require( './../procs.js' );
var design = require( './../design.js' );

var CFG = design.effective( design.loadProtocol().protocol, false ).preflight;
var BATT_BATTERY = 'Now drawing from \'Battery Power\'\n -InternalBattery-0 (id=23658595)\t21%; discharging; 3:00 remaining present: true\n';
var BATT_AC = 'Now drawing from \'AC Power\'\n -InternalBattery-0 (id=23658595)\t20%; charging; (no estimate) present: true\n';
var BATT_AC_HOLD = 'Now drawing from \'AC Power\'\n -InternalBattery-0 (id=23658595)\t80%; AC attached; not charging present: true\n';
var PMSET_G = 'System-wide power settings:\nCurrently in use:\n standby              1\n Sleep On Power Button 1\n hibernatefile        /var/vm/sleepimage\n powernap             1\n networkoversleep     0\n disksleep            10\n sleep                1 (sleep prevented by powerd, caffeinate)\n hibernatemode        3\n ttyskeepawake        1\n displaysleep         2\n tcpkeepalive         1\n lowpowermode         0\n womp                 0\n'; // eslint-disable-line max-len
var SWAP = 'vm.swapusage: total = 5120.00M  used = 3911.50M  free = 1208.50M  (encrypted)\n';
var VMSTAT = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                                4683.\nPages active:                            102006.\nPages stored in compressor:              691085.\nPageins:                               27103206.\nPageouts:                                216496.\nSwapins:                                7523945.\nSwapouts:                               8976477.\n'; // eslint-disable-line max-len
var SHIPIT = '/Applications/ExampleChat.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt com.example.chat.ShipIt';
var PS = [
	'    1     0   0.3 /sbin/launchd',
	'  347     1   0.6 /usr/libexec/logd',
	'  689     1  27.8 /System/Library/ExtensionKit/Extensions/WallpaperAerialsExtension.appex/Contents/MacOS/WallpaperAerialsExtension -LaunchArguments eyJ',
	' 1061     1   0.2 /Applications/ExampleChat.app/Contents/MacOS/ExampleChat',
	' 1109  1061   7.3 /Applications/ExampleChat.app/Contents/Frameworks/ExampleChat Helper (Renderer).app/Contents/MacOS/ExampleChat Helper (Renderer) --type=renderer',
	' 1521  1520   0.1 /opt/homebrew/bin/example-cli --watch',
	' 2001     1   0.0 node /opt/homebrew/bin/example-daemon start',
	' 3100     1   1.2 /System/Library/Frameworks/CoreServices.framework/Frameworks/Metadata.framework/Versions/A/Support/mdworker_shared -s mdworker -c MDSImporterWorker -m com.apple.mdworker.shared',
	' 5000  4999   0.0 caffeinate -i node research/harness/orchestrator.js --campaign',
	' 5001  5000  99.0 node research/harness/orchestrator.js --campaign',
	' 5002  5001  98.5 node --expose-gc research/harness/child.js {"alg":"A0"}',
	' 5003  5001   0.0 /bin/ps -axww -o pid=,ppid=,pcpu=,command=',
	'garbage line'
].join( '\n' );
var PS2 = [ // an application with its helpers and updater, a command-line tool, a daemon, launchers, other harness processes and the screen saver
	'    1     0   0.3 /sbin/launchd',
	'  700     1   0.0 /Applications/ExampleChat.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler --no-rate-limit', // eslint-disable-line max-len
	' 1061     1   0.2 /Applications/ExampleChat.app/Contents/MacOS/ExampleChat',
	' 1109  1061   7.3 /Applications/ExampleChat.app/Contents/Frameworks/ExampleChat Helper (Renderer).app/Contents/MacOS/ExampleChat Helper (Renderer) --type=renderer', // eslint-disable-line max-len
	' 1521  4200   0.1 /opt/homebrew/bin/example-cli --watch',
	' 2001     1   0.0 node /opt/homebrew/bin/example-daemon start',
	'55593     1   0.0 ' + SHIPIT + ' /Users/kaustubh/Library/Caches/com.example.chat.ShipIt/ShipItState.plist',
	' 3100     1   1.2 /System/Library/Frameworks/CoreServices.framework/Frameworks/Metadata.framework/Versions/A/Support/mdworker_shared -s mdworker -c MDSImporterWorker -m com.apple.mdworker.shared', // eslint-disable-line max-len
	' 4000     1   3.1 /System/Library/CoreServices/ScreenSaverEngine.app/Contents/MacOS/ScreenSaverEngine',
	' 4200     1   0.0 /bin/zsh -l',
	' 4990  4200   0.0 /bin/zsh -c nohup caffeinate -i node research/harness/orchestrator.js --campaign',
	' 5000  4990   0.0 caffeinate -i node research/harness/orchestrator.js --campaign',
	' 5001  5000  99.0 node research/harness/orchestrator.js --campaign',
	' 5002  5001  98.5 node --expose-gc research/harness/child.js {"alg":"A0"}',
	' 6001     1   0.0 node research/harness/orchestrator.js --tiny --skip-preflight',
	' 6002     1  97.0 node --expose-gc /Users/kaustubh/other/StrataMM/research/harness/child.js {"alg":"A2"}',
	' 6003     1  12.0 node research/accuracy/run.js --campaign campaign-20261029-221500',
	' 6004     1   0.0 tail -f research/data/campaign-20261030-223105/campaign.log',
	' 7001  4200   0.0 node research/harness/orchestrator.js --preflight-only'
].join( '\n' );
var PS3 = [ // launched from a terminal inside an application
	'    1     0   0.0 /sbin/launchd',
	' 1061     1   0.2 /Applications/ExampleChat.app/Contents/MacOS/ExampleChat',
	' 1300  1061   0.0 /bin/zsh -l',
	' 1301  1300   0.0 caffeinate -i node research/harness/orchestrator.js --campaign',
	' 1302  1301  99.0 node research/harness/orchestrator.js --campaign'
].join( '\n' );
var PS4 = [ // launched from Terminal.app as in the runbook, plus a foreign Node server
	'    1     0   0.0 /sbin/launchd',
	'  612     1   0.5 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal',
	'  700   612   0.0 login -pfl kaustubh /bin/bash -c exec -la zsh /bin/zsh',
	'  701   700   0.0 -zsh',
	'  900   701   0.0 caffeinate -i node research/harness/orchestrator.js --campaign --new',
	'  901   900  99.0 node research/harness/orchestrator.js --campaign --new',
	' 1500     1   0.0 node /opt/homebrew/bin/example-server'
].join( '\n' );

// The suite must not depend on the caller's environment: the variable is unset unless a test sets it (withBlocked).
delete process.env.STRATAMM_BLOCKED_PROCESSES;

function snap( over ) {
	return Object.assign({
		'power': preflight.parsePmsetBatt( BATT_AC ),
		'low_power_mode': false,
		'thermal_state': 0,
		'load_avg': [ 1, 1, 1 ],
		'swap_used_mb': 100,
		'swap_total_mb': 1024,
		'pressure_level': 1,
		'swapouts': 5,
		'top_cpu': [],
		'busy': [],
		'blocked': [],
		'ps_ok': true
	}, over || {} );
}

function pids( rows ) {
	return rows.map( function f( p ) {
		return p.pid;
	});
}

function kinds( rows ) {
	return rows.map( function f( p ) {
		return [ p.pid, p.kind, p.match ];
	});
}

// Runs fn with STRATAMM_BLOCKED_PROCESSES set to `value` (undefined: unset), then restores the caller's value.
function withBlocked( value, fn ) {
	var saved = process.env.STRATAMM_BLOCKED_PROCESSES;
	if ( value === void 0 ) {
		delete process.env.STRATAMM_BLOCKED_PROCESSES;
	} else {
		process.env.STRATAMM_BLOCKED_PROCESSES = value;
	}
	try {
		return fn();
	} finally {
		if ( saved === void 0 ) {
			delete process.env.STRATAMM_BLOCKED_PROCESSES;
		} else {
			process.env.STRATAMM_BLOCKED_PROCESSES = saved;
		}
	}
}

tape( 'pmset -g batt', function test( t ) {
	t.deepEqual( preflight.parsePmsetBatt( BATT_BATTERY ), { 'source': 'Battery Power', 'ac': false, 'battery_pct': 21, 'state': 'discharging' }, 'battery' ); // eslint-disable-line max-len
	t.deepEqual( preflight.parsePmsetBatt( BATT_AC ), { 'source': 'AC Power', 'ac': true, 'battery_pct': 20, 'state': 'charging' }, 'AC charging' ); // eslint-disable-line max-len
	t.equal( preflight.parsePmsetBatt( BATT_AC_HOLD ).ac, true, 'AC attached, not charging' );
	t.equal( preflight.parsePmsetBatt( 'Now drawing from \'UPS Power\'\n' ).ac, false, 'UPS is not AC' );
	t.deepEqual( preflight.parsePmsetBatt( null ), { 'source': null, 'ac': false, 'battery_pct': null, 'state': null }, 'command failed' ); // eslint-disable-line max-len
	t.end();
});

tape( 'pmset -g lowpowermode', function test( t ) {
	t.equal( preflight.parsePmsetLowPower( PMSET_G ), 0, 'off' );
	t.equal( preflight.parsePmsetLowPower( PMSET_G.replace( 'lowpowermode         0', 'lowpowermode         1' ) ), 1, 'on' );
	t.equal( preflight.parsePmsetLowPower( 'Currently in use:\n sleep 1\n' ), null, 'absent' );
	t.end();
});

tape( 'JXA NSProcessInfo probe', function test( t ) {
	t.deepEqual( preflight.parseJxa( '{"thermal_state":0,"low_power_mode":false}\n' ), { 'thermal_state': 0, 'low_power_mode': false }, 'JSON' ); // eslint-disable-line max-len
	t.deepEqual( preflight.parseJxa( '{"thermal_state":"2","low_power_mode":true}' ), { 'thermal_state': 2, 'low_power_mode': true }, 'bridged string number' ); // eslint-disable-line max-len
	t.deepEqual( preflight.parseJxa( '0\n' ), { 'thermal_state': 0, 'low_power_mode': null }, 'bare thermalState' );
	t.deepEqual( preflight.parseJxa( 'execution error: Error: object does not respond to selector (-2700)' ), { 'thermal_state': null, 'low_power_mode': null }, 'error output' ); // eslint-disable-line max-len
	t.deepEqual( preflight.parseJxa( null ), { 'thermal_state': null, 'low_power_mode': null }, 'command failed' );
	t.end();
});

tape( 'ps: rows, own process tree, busy and blocked processes', function test( t ) {
	var rows = preflight.parsePs( PS );
	var mine = preflight.descendants( rows, 5001 );
	var rows3 = preflight.parsePs( PS3 );
	t.equal( rows.length, 12, 'garbage skipped' );
	t.equal( rows[ 4 ].command.indexOf( 'ExampleChat Helper (Renderer)' ) > 0, true, 'commands keep their spaces' );
	t.deepEqual( Array.from( mine ).sort(), [ 5001, 5002, 5003 ], 'self, child and ps' );
	t.deepEqual( pids( preflight.findBusy( rows, mine, CFG.cpu_threshold_pct ) ), [ 689 ], 'only the foreign process above 20% (the child at 98.5% is ours)' ); // eslint-disable-line max-len
	t.deepEqual( pids( preflight.findBlocked( rows, mine, 'example' ) ), [ 1061, 1109, 1521, 2001 ], 'case-insensitive: the application, its helper, the command-line tool and the daemon' ); // eslint-disable-line max-len
	t.deepEqual( pids( preflight.findBlocked( rows, mine, 'research/harness/' ) ), [ 5000 ], 'the process tree alone does not cover the caffeinate launcher' ); // eslint-disable-line max-len
	t.deepEqual( pids( preflight.findBlocked( rows, procs.blockedExempt( rows, 5001 ), 'research/harness/' ) ), [], 'this process tree and its caffeinate launcher are exempt' ); // eslint-disable-line max-len
	t.deepEqual( [ preflight.findBlocked( rows, mine, null ), preflight.findBlocked( rows, mine, '' ) ], [ [], [] ], 'no pattern: nothing is blocked by name' ); // eslint-disable-line max-len
	t.deepEqual( pids( procs.findHarness( rows3, procs.ownProcesses( rows3, 1302 ) ) ), [], 'own tree and launchers are not other harness processes' ); // eslint-disable-line max-len
	t.deepEqual( pids( procs.classifyBlocked( rows3, procs.blockedExempt( rows3, 1302 ), Object.assign( {}, CFG, { 'blocked_pattern': 'ExampleChat' } ) ).blocking ), [ 1061 ], 'launched from inside a blocked application: that launcher still blocks' ); // eslint-disable-line max-len
	t.end();
});

tape( 'blocked processes: the harness launcher is exempt, other launchers are not', function test( t ) {
	var rows = preflight.parsePs( PS4 );
	var exempt = procs.blockedExempt( rows, 901 );
	t.deepEqual( Array.from( exempt ).sort(), [ 900, 901 ], 'this process and the caffeinate wrapper that runs it' );
	withBlocked( 'node', function node() {
		t.deepEqual( pids( procs.classifyBlocked( rows, exempt, CFG ).blocking ), [ 1500 ], 'a pattern matching the launcher line: only the foreign Node server blocks' ); // eslint-disable-line max-len
	});
	withBlocked( 'Terminal', function terminal() {
		t.deepEqual( pids( procs.classifyBlocked( rows, exempt, CFG ).blocking ), [ 612 ], 'the terminal application is not exempt' ); // eslint-disable-line max-len
	});
	t.end();
});

tape( 'sysctl vm.swapusage, pressure level, vm_stat', function test( t ) {
	t.deepEqual( preflight.parseSwapUsage( SWAP ), { 'total_mb': 5120, 'used_mb': 3911.5, 'free_mb': 1208.5 }, 'swapusage' );
	t.deepEqual( preflight.parseSwapUsage( null ), { 'total_mb': null, 'used_mb': null, 'free_mb': null }, 'unavailable' );
	t.equal( preflight.parsePressure( '1\n' ), 1, 'pressure 1' );
	t.equal( preflight.parsePressure( '4' ), 4, 'pressure 4' );
	t.equal( preflight.parsePressure( '' ), null, 'pressure unavailable' );
	t.deepEqual( preflight.parseVmStat( VMSTAT ), { 'page_size': 16384, 'swapins': 7523945, 'swapouts': 8976477, 'pageins': 27103206, 'pageouts': 216496 }, 'vm_stat' ); // eslint-disable-line max-len
	t.equal( preflight.parseVmStat( null ).swapouts, null, 'vm_stat unavailable' );
	t.end();
});

tape( 'evaluate: every rule', function test( t ) {
	var r;
	t.deepEqual( preflight.evaluate( snap(), CFG, 100 ), { 'pass': true, 'reasons': [] }, 'quiet machine passes' );
	r = preflight.evaluate( snap( { 'power': preflight.parsePmsetBatt( BATT_BATTERY ), 'low_power_mode': true, 'thermal_state': 1, 'busy': [ { 'pid': 689, 'pcpu': 27.8, 'name': 'WallpaperAerialsExtension' } ], 'blocked': [ { 'pid': 1061, 'pcpu': 0.2, 'name': 'ExampleChat', 'kind': 'blocked', 'match': 'ExampleChat' } ], 'swap_used_mb': 130, 'pressure_level': 2 } ), CFG, 100 ); // eslint-disable-line max-len
	t.equal( r.pass, false, 'noisy machine fails' );
	[ /not on AC power \(Battery Power\)/, /Low Power Mode is on/, /thermalState = 1/, /busy process > 20% CPU: WallpaperAerialsExtension/, /1 blocked process\(es\) running \(STRATAMM_BLOCKED_PROCESSES\): ExampleChat \(pid 1061\)/, /swap growing: \+30\.0 MB/, /memory pressure level 2/ ].forEach( function each( re ) { // eslint-disable-line max-len
		t.ok( r.reasons.some( function f( x ) {
			return re.test( x );
		}), 'reason ' + re );
	});
	t.equal( preflight.evaluate( snap( { 'swap_used_mb': 100.9 } ), CFG, 100 ).pass, true, 'swap within the 1 MB tolerance' );
	t.equal( preflight.evaluate( snap( { 'swap_used_mb': 50 } ), CFG, 100 ).pass, true, 'shrinking swap passes' );
	t.equal( preflight.evaluate( snap( { 'thermal_state': null } ), CFG, null ).pass, false, 'unknown thermal state fails' );
	t.end();
});

tape( 'evaluate: blocked-process reason wording', function test( t ) {
	var two = [ { 'pid': 1521, 'pcpu': 0.1, 'name': 'example-cli', 'kind': 'blocked', 'match': 'example' }, { 'pid': 55593, 'pcpu': 35, 'name': 'ShipIt com.example.chat.ShipIt', 'kind': 'updater', 'match': 'Squirrel.framework/' } ]; // eslint-disable-line max-len
	var five = [ 1, 2, 3, 4, 5 ].map( function f( i ) {
		return { 'pid': 2000 + i, 'pcpu': 0, 'name': 'example-daemon', 'kind': 'blocked', 'match': 'example' };
	});
	t.deepEqual( preflight.evaluate( snap( { 'blocked': two } ), CFG, 100 ), { 'pass': false, 'reasons': [ '2 blocked process(es) running (STRATAMM_BLOCKED_PROCESSES): example-cli (pid 1521), ShipIt com.example.chat.ShipIt (pid 55593)' ] }, 'count, variable, names and pids' ); // eslint-disable-line max-len
	t.equal( preflight.evaluate( snap( { 'blocked': five } ), CFG, 100 ).reasons[ 0 ], '5 blocked process(es) running (STRATAMM_BLOCKED_PROCESSES): example-daemon (pid 2001), example-daemon (pid 2002), example-daemon (pid 2003), example-daemon (pid 2004), ...', 'at most four named' ); // eslint-disable-line max-len
	t.equal( preflight.evaluate( snap( { 'blocked': void 0 } ), CFG, 100 ).pass, true, 'snapshot without the field: pass' );
	t.equal( preflight.evaluate( snap( { 'blocked': two.slice( 0, 1 ) } ), Object.assign( {}, CFG, { 'blocked_pattern': 'example' } ), 100 ).reasons[ 0 ], '1 blocked process(es) running (protocol preflight.blocked_pattern): example-cli (pid 1521)', 'a protocol pattern is named as such' ); // eslint-disable-line max-len
	t.end();
});

tape( 'post-process exclusion reasons (swapouts, pressure >= 2, thermal >= 2, power change)', function test( t ) {
	var ex = design.effective( design.loadProtocol().protocol, false ).exclusion;
	var ok = { 'power_source': 'AC Power', 'swapouts': 10, 'pressure_level': 1, 'thermal_state': 1 };
	t.deepEqual( preflight.exclusionReasons( ok, 10, ex, 'AC Power' ), [], 'thermal 1 does not exclude a process' );
	t.deepEqual( preflight.exclusionReasons( { 'power_source': 'Battery Power', 'swapouts': 13, 'pressure_level': 2, 'thermal_state': 2 }, 10, ex, 'AC Power' ), [ 'swapouts+3', 'pressure=2', 'thermal=2', 'power_change' ], 'all reasons' ); // eslint-disable-line max-len
	t.deepEqual( preflight.exclusionReasons( { 'power_source': null, 'swapouts': null, 'pressure_level': null, 'thermal_state': null }, null, ex, 'AC Power' ), [], 'unavailable readings never exclude' ); // eslint-disable-line max-len
	t.end();
});

tape( 'blocked pattern: STRATAMM_BLOCKED_PROCESSES, else the protocol, else none', function test( t ) {
	var rows = preflight.parsePs( PS2 );
	var mine = preflight.descendants( rows, 5001 );
	var proto = Object.assign( {}, CFG, { 'blocked_pattern': 'example-(cli|daemon)' } );
	var saved = process.env.STRATAMM_BLOCKED_PROCESSES;
	t.equal( procs.ENV_VAR, 'STRATAMM_BLOCKED_PROCESSES', 'variable name' );
	t.equal( CFG.blocked_pattern, null, 'the protocol names no process' );
	withBlocked( void 0, function unset() {
		var r = procs.rules( CFG );
		var b = procs.classifyBlocked( rows, mine, CFG );
		t.deepEqual( [ r.blocked_pattern, r.blocked_pattern_source ], [ null, 'none' ], 'variable unset, protocol null: none' );
		t.deepEqual( b, { 'blocking': [], 'ignored': [] }, 'none: nothing is blocked by name, not even an updater recorded' );
		t.equal( procs.blockedKind( SHIPIT, r ), null, 'none: no kind' );
		t.equal( preflight.evaluate( snap( { 'blocked': b.blocking } ), CFG, 100 ).pass, true, 'none: pass' );
		r = procs.rules( proto );
		t.deepEqual( [ r.blocked_pattern, r.blocked_pattern_source ], [ 'example-(cli|daemon)', 'protocol' ], 'protocol pattern' ); // eslint-disable-line max-len
		t.deepEqual( kinds( procs.classifyBlocked( rows, mine, proto ).blocking ), [ [ 1521, 'blocked', 'example-cli' ], [ 2001, 'blocked', 'example-daemon' ] ], 'protocol: the command-line tool and the daemon' ); // eslint-disable-line max-len
	});
	withBlocked( 'EXAMPLECHAT', function set() {
		var r = procs.rules( proto );
		var b = procs.classifyBlocked( rows, mine, proto );
		t.deepEqual( [ r.blocked_pattern, r.blocked_pattern_source ], [ 'EXAMPLECHAT', 'env' ], 'the variable overrides the protocol' ); // eslint-disable-line max-len
		t.deepEqual( kinds( b.blocking ), [ [ 700, 'blocked', 'ExampleChat' ], [ 1061, 'blocked', 'ExampleChat' ], [ 1109, 'blocked', 'ExampleChat' ] ], 'case-insensitive: the application and its helpers, with kind and match' ); // eslint-disable-line max-len
		t.equal( b.blocking[ 0 ].name, 'chrome_crashpad_handler', 'secret-free name (command cut at the first option)' );
		t.deepEqual( pids( b.ignored ), [ 55593 ], 'its idle updater is only recorded' );
	});
	withBlocked( '', function empty() {
		t.equal( procs.rules( proto ).blocked_pattern_source, 'protocol', 'an empty variable counts as unset' );
	});
	withBlocked( 'example(', function invalid() {
		t.throws( function f() {
			procs.rules( CFG );
		}, /invalid blocked-process pattern \(STRATAMM_BLOCKED_PROCESSES\)/, 'invalid regular expression in the variable' );
	});
	withBlocked( void 0, function invalidProtocol() {
		t.throws( function f() {
			procs.rules( Object.assign( {}, CFG, { 'blocked_pattern': '[' } ) );
		}, /invalid blocked-process pattern \(protocol preflight\.blocked_pattern\)/, 'invalid regular expression in the protocol' ); // eslint-disable-line max-len
		t.throws( function f() {
			procs.rules( Object.assign( {}, CFG, { 'blocked_pattern': 42 } ) );
		}, TypeError, 'protocol pattern neither a string nor null' );
	});
	t.equal( process.env.STRATAMM_BLOCKED_PROCESSES, saved, 'the caller\'s value is restored' );
	t.end();
});

tape( 'updaters: an idle updater is only recorded, a busy one blocks', function test( t ) {
	var rows = preflight.parsePs( PS2 );
	var busy = preflight.parsePs( '55593     1  35.0 ' + SHIPIT + '\n' );
	withBlocked( 'example', function set() {
		var b = procs.classifyBlocked( rows, preflight.descendants( rows, 5001 ), CFG );
		t.deepEqual( pids( b.blocking ), [ 700, 1061, 1109, 1521, 2001 ], 'the application, its helpers, the command-line tool and the daemon block' ); // eslint-disable-line max-len
		t.deepEqual( kinds( b.ignored ), [ [ 55593, 'updater', 'Squirrel.framework/' ] ], 'ShipIt at 0% CPU is recorded, not blocking' ); // eslint-disable-line max-len
		t.notOk( b.blocking.concat( b.ignored ).some( function f( p ) {
			return [ 3100, 4000, 4990, 5000, 6004 ].indexOf( p.pid ) >= 0;
		}), 'mdworker, the screen saver, the shell, caffeinate and tail do not match' );
		b = procs.classifyBlocked( busy, new Set(), CFG );
		t.deepEqual( [ kinds( b.blocking ), b.ignored ], [ [ [ 55593, 'updater', 'Squirrel.framework/' ] ], [] ], 'an updater above 5% CPU blocks' ); // eslint-disable-line max-len
		t.deepEqual( pids( procs.classifyBlocked( busy, new Set(), Object.assign( {}, CFG, { 'ignore_max_pcpu': 50 } ) ).ignored ), [ 55593 ], 'protocol override of the CPU threshold' ); // eslint-disable-line max-len
		t.deepEqual( kinds( procs.classifyBlocked( busy, new Set(), Object.assign( {}, CFG, { 'ignore_pattern': 'no-such-updater' } ) ).blocking ), [ [ 55593, 'blocked', 'Example' ] ], 'protocol override of the updater pattern' ); // eslint-disable-line max-len
	});
	t.deepEqual( [ procs.rules( CFG ).ignore_pattern, procs.rules( CFG ).ignore_max_pcpu ], [ procs.DEFAULTS.ignore_pattern, 5 ], 'defaults' ); // eslint-disable-line max-len
	t.end();
});

tape( 'harness processes outside this tree and its launchers fail the pre-flight (CPU-independent)', function test( t ) { // eslint-disable-line max-len
	var rows = preflight.parsePs( PS2 );
	var own = procs.ownProcesses( rows, 5001 );
	t.deepEqual( Array.from( procs.ancestors( rows, 5001 ) ), [ 5000, 4990, 4200, 1 ], 'launchers: caffeinate, shell, login shell, launchd' ); // eslint-disable-line max-len
	t.deepEqual( pids( procs.findHarness( rows, own ) ), [ 6001, 6002, 6003, 7001 ], 'another instance, an orphaned child (another clone), an orphaned E6 and a --preflight-only run; never caffeinate, our child or tail' ); // eslint-disable-line max-len
	t.equal( procs.findHarness( rows, own )[ 2 ].match, 'research/accuracy/', 'what matched' );
	t.deepEqual( pids( procs.findHarness( rows, procs.ownProcesses( rows, 7001 ) ) ), [ 4990, 5000, 5001, 5002, 6001, 6002, 6003 ], '--preflight-only sees the running campaign' ); // eslint-disable-line max-len
	t.ok( /another harness process is running \(outside this process tree\): orchestrator\.js \(pid 6001\)/.test( preflight.evaluate( snap( { 'harness_procs': procs.findHarness( rows, own ) } ), CFG, 100 ).reasons.join( '\n' ) ), 'reason' ); // eslint-disable-line max-len
	t.equal( preflight.evaluate( snap( { 'harness_procs': [] } ), CFG, 100 ).pass, true, 'none: pass' );
	t.end();
});

tape( 'screen saver and display probe', function test( t ) {
	t.deepEqual( pids( procs.findScreenSaver( preflight.parsePs( PS2 ) ) ), [ 4000 ], 'ScreenSaverEngine' );
	t.deepEqual( procs.findScreenSaver( preflight.parsePs( PS ) ), [], 'none' );
	t.equal( preflight.parseDisplay( '{"thermal_state":0,"low_power_mode":false,"display_asleep":true}\n' ), true, 'asleep' ); // eslint-disable-line max-len
	t.equal( preflight.parseDisplay( '{"thermal_state":0,"low_power_mode":false,"display_asleep":false}' ), false, 'awake' );
	t.equal( preflight.parseDisplay( '{"thermal_state":0,"low_power_mode":false,"display_asleep":null}' ), null, 'CoreGraphics unavailable' ); // eslint-disable-line max-len
	t.equal( preflight.parseDisplay( 'execution error' ), null, 'error output' );
	t.equal( preflight.parseDisplay( null ), null, 'command failed' );
	t.deepEqual( preflight.parseJxa( '{"thermal_state":0,"low_power_mode":false,"display_asleep":true}' ), { 'thermal_state': 0, 'low_power_mode': false }, 'the thermal probe ignores the display field' ); // eslint-disable-line max-len
	t.end();
});

tape( 'collect (this machine): the snapshot records display, screen saver, blocked and harness processes', function test( t ) { // eslint-disable-line max-len
	var d = preflight.display();
	withBlocked( void 0, function unset() {
		var s = preflight.collect( CFG );
		t.ok( s.display_asleep === null || typeof s.display_asleep === 'boolean', 'display_asleep ' + s.display_asleep );
		t.equal( typeof s.screensaver_running, 'boolean', 'screensaver_running' );
		t.ok( Array.isArray( s.blocked ) && Array.isArray( s.blocked_ignored ) && Array.isArray( s.harness_procs ), 'lists' ); // eslint-disable-line max-len
		t.deepEqual( [ s.blocked, s.blocked_ignored ], [ [], [] ], 'no blocked-process pattern: nothing is blocked by name' ); // eslint-disable-line max-len
		t.ok( /display asleep: .* \| screen saver: (true|false)/.test( preflight.describe( s ) ), 'describe' );
		t.ok( / \| ignored idle updaters: Squirrel\.framework\/ \(pid 55593, 0%\)$/.test( preflight.describe( Object.assign( {}, s, { 'blocked_ignored': [ { 'pid': 55593, 'pcpu': 0, 'match': 'Squirrel.framework/' } ] } ) ) ), 'describe names ignored idle updaters' ); // eslint-disable-line max-len
	});
	withBlocked( '.', function all() {
		var s = preflight.collect( CFG );
		var rows = s.blocked.concat( s.blocked_ignored );
		t.ok( s.blocked.length > 0, 'a pattern matching every command line blocks the processes outside this tree (' + s.blocked.length + ')' ); // eslint-disable-line max-len
		t.notOk( rows.some( function f( p ) {
			return p.pid === process.pid;
		}), 'never this process' );
		t.ok( rows.every( function f( p ) {
			return ( p.kind === 'blocked' || p.kind === 'updater' ) && typeof p.match === 'string' && typeof p.name === 'string';
		}), 'every row names its kind, match and name' );
		t.ok( s.blocked_ignored.every( function f( p ) {
			return p.kind === 'updater' && p.pcpu <= 5;
		}), 'only idle updaters are ignored' );
		t.ok( /blocked process\(es\) running \(STRATAMM_BLOCKED_PROCESSES\): /.test( preflight.evaluate( s, CFG, null ).reasons.join( '\n' ) ), 'reason' ); // eslint-disable-line max-len
	});
	t.ok( d.display_asleep === null || typeof d.display_asleep === 'boolean', 'display probe' );
	t.end();
});
