'use strict';

/*
* Machine pre-flight of the StrataMM campaign (research-protocol.md §2; campaign-runbook.md §3–§4), plus the env and
* provenance of the `campaign` record (research/harness/env.js when present, else a minimal fallback).
*
* Checks: AC power (`pmset -g batt`), Low Power Mode off (JXA NSProcessInfo and `pmset -g`), thermalState = 0 (JXA),
* no foreign process above the CPU threshold (`ps`), no blocked process outside this process tree and its harness
* launchers (command line matching STRATAMM_BLOCKED_PROCESSES, else the protocol's `preflight.blocked_pattern`; none
* by default; idle updaters such as ShipIt are only recorded), no other harness process outside this tree and its
* launchers (research/(harness|accuracy|correctness)/; CPU-independent), swap not growing (`sysctl vm.swapusage`),
* `kern.memorystatus_vm_pressure_level` = 1; `vm_stat` swapouts, display sleep (JXA `CGDisplayIsAsleep`) and a running
* ScreenSaverEngine are recorded. Every parser is a pure function of a command's output (unit-tested on captured
* outputs); the process-table rules live in procs.js.
*/

// MODULES //

var execFileSync = require( 'child_process' ).execFileSync;
var crypto = require( 'crypto' );
var fs = require( 'fs' );
var os = require( 'os' );
var path = require( 'path' );
var procs = require( './procs.js' );


// VARIABLES //

var PMSET = '/usr/bin/pmset';
var OSASCRIPT = '/usr/bin/osascript';
var PS = '/bin/ps';
var SYSCTL = '/usr/sbin/sysctl';
var VMSTAT = '/usr/bin/vm_stat';
var JXA = 'ObjC.import("Foundation"); var p = $.NSProcessInfo.processInfo; JSON.stringify({ "thermal_state": Number(p.thermalState), "low_power_mode": Boolean(p.isLowPowerModeEnabled) })'; // eslint-disable-line max-len
var JXA_DISPLAY = 'ObjC.import("Foundation"); var p = $.NSProcessInfo.processInfo; var d = null; try { ObjC.import("CoreGraphics"); d = Boolean($.CGDisplayIsAsleep($.CGMainDisplayID())); } catch (e) {} JSON.stringify({ "thermal_state": Number(p.thermalState), "low_power_mode": Boolean(p.isLowPowerModeEnabled), "display_asleep": d })'; // eslint-disable-line max-len
var PS_ARGS = [ '-axww', '-o', 'pid=,ppid=,pcpu=,command=' ];
var SLEEPER = new Int32Array( new SharedArrayBuffer( 4 ) );


// FUNCTIONS //

/**
* Sleeps synchronously (the orchestrator stays idle).
*
* @param {number} ms - milliseconds (no-op if ≤ 0)
*/
function sleep( ms ) {
	if ( ms > 0 ) {
		Atomics.wait( SLEEPER, 0, 0, ms );
	}
}

function run( cmd, args, cwd ) {
	try {
		return execFileSync( cmd, args, { 'encoding': 'utf8', 'stdio': [ 'ignore', 'pipe', 'ignore' ], 'timeout': 10000, 'maxBuffer': 16777216, 'cwd': cwd } ); // eslint-disable-line max-len
	} catch ( err ) { // eslint-disable-line no-unused-vars
		return null;
	}
}

/**
* Parses `pmset -g batt`.
*
* @param {(string|null)} text - output
* @returns {Object} `{ source, ac, battery_pct, state }`
*/
function parsePmsetBatt( text ) {
	var src = /Now drawing from '([^']+)'/.exec( text || '' );
	var pct = /\t(\d+)%;\s*([^;]+);/.exec( text || '' );
	return {
		'source': ( src ) ? src[ 1 ] : null,
		'ac': ( src ) ? src[ 1 ] === 'AC Power' : false,
		'battery_pct': ( pct ) ? Number( pct[ 1 ] ) : null,
		'state': ( pct ) ? pct[ 2 ].trim() : null
	};
}

/**
* Parses the `lowpowermode` line of `pmset -g`.
*
* @param {(string|null)} text - output
* @returns {(number|null)} 0 or 1 (null when absent)
*/
function parsePmsetLowPower( text ) {
	var m = /^\s*lowpowermode\s+(\d+)/m.exec( text || '' );
	return ( m ) ? Number( m[ 1 ] ) : null;
}

/**
* Parses the JXA NSProcessInfo probe (JSON, or a bare thermalState number).
*
* @param {(string|null)} text - output
* @returns {Object} `{ thermal_state, low_power_mode }` (null fields when unavailable)
*/
function parseJxa( text ) {
	var t = ( text || '' ).trim();
	var o = {};
	if ( /^\d+$/.test( t ) ) {
		return { 'thermal_state': Number( t ), 'low_power_mode': null };
	}
	try {
		o = JSON.parse( t ) || {};
	} catch ( err ) { // eslint-disable-line no-unused-vars
		o = {};
	}
	return {
		'thermal_state': ( o.thermal_state === void 0 || o.thermal_state === null || isNaN( Number( o.thermal_state ) ) ) ? null : Number( o.thermal_state ), // eslint-disable-line max-len
		'low_power_mode': ( typeof o.low_power_mode === 'boolean' ) ? o.low_power_mode : null
	};
}

/**
* Parses the display field of the JXA probe (`CGDisplayIsAsleep` of the main display).
*
* @param {(string|null)} text - output
* @returns {(boolean|null)} whether the display is asleep (null when unavailable)
*/
function parseDisplay( text ) {
	var o;
	try {
		o = JSON.parse( ( text || '' ).trim() ) || {};
	} catch ( err ) { // eslint-disable-line no-unused-vars
		o = {};
	}
	return ( typeof o.display_asleep === 'boolean' ) ? o.display_asleep : null;
}

/**
* Parses `sysctl vm.swapusage`.
*
* @param {(string|null)} text - output
* @returns {Object} `{ total_mb, used_mb, free_mb }` (null fields when unavailable)
*/
function parseSwapUsage( text ) {
	function f( name ) {
		var m = new RegExp( name + '\\s*=\\s*([\\d.]+)M' ).exec( text || '' );
		return ( m ) ? Number( m[ 1 ] ) : null;
	}
	return { 'total_mb': f( 'total' ), 'used_mb': f( 'used' ), 'free_mb': f( 'free' ) };
}

/**
* Parses `sysctl -n kern.memorystatus_vm_pressure_level` (1 normal, 2 warn, 4 critical).
*
* @param {(string|null)} text - output
* @returns {(number|null)} level
*/
function parsePressure( text ) {
	var m = /^\s*(\d+)\s*$/.exec( text || '' );
	return ( m ) ? Number( m[ 1 ] ) : null;
}

/**
* Parses `vm_stat` (page size and swap/page counters).
*
* @param {(string|null)} text - output
* @returns {Object} `{ page_size, swapins, swapouts, pageins, pageouts }` (null fields when unavailable)
*/
function parseVmStat( text ) {
	var ps = /page size of (\d+) bytes/.exec( text || '' );
	function f( name ) {
		var m = new RegExp( '^' + name + ':\\s+(\\d+)\\.?\\s*$', 'm' ).exec( text || '' );
		return ( m ) ? Number( m[ 1 ] ) : null;
	}
	return { 'page_size': ( ps ) ? Number( ps[ 1 ] ) : null, 'swapins': f( 'Swapins' ), 'swapouts': f( 'Swapouts' ), 'pageins': f( 'Pageins' ), 'pageouts': f( 'Pageouts' ) }; // eslint-disable-line max-len
}

/**
* Takes an environment snapshot (runs the read-only commands once).
*
* @param {Object} cfg - protocol `preflight` section
* @param {integer} [selfPid] - root of the process tree to ignore (default: this process)
* @returns {Object} snapshot
*/
function collect( cfg, selfPid ) {
	var jxText = run( OSASCRIPT, [ '-l', 'JavaScript', '-e', JXA_DISPLAY ] );
	var jx = parseJxa( jxText );
	var lpm = parsePmsetLowPower( run( PMSET, [ '-g' ] ) );
	var rows = procs.parsePs( run( PS, PS_ARGS ) );
	var self = selfPid || process.pid;
	var harness = procs.rules( cfg ).harness_pattern;
	var mine = procs.descendants( rows, self );
	var blocked = procs.classifyBlocked( rows, procs.blockedExempt( rows, self, harness ), cfg );
	var swap = parseSwapUsage( run( SYSCTL, [ 'vm.swapusage' ] ) );
	return {
		't_wall': new Date().toISOString(),
		'power': parsePmsetBatt( run( PMSET, [ '-g', 'batt' ] ) ),
		'low_power_mode': ( jx.low_power_mode === null && lpm === null ) ? null : ( jx.low_power_mode === true || lpm === 1 ),
		'thermal_state': jx.thermal_state,
		'load_avg': os.loadavg(),
		'swap_used_mb': swap.used_mb,
		'swap_total_mb': swap.total_mb,
		'pressure_level': parsePressure( run( SYSCTL, [ '-n', 'kern.memorystatus_vm_pressure_level' ] ) ),
		'swapouts': parseVmStat( run( VMSTAT, [] ) ).swapouts,
		'top_cpu': procs.findBusy( rows, mine, -1 ).slice( 0, 5 ).map( procs.brief ),
		'busy': procs.findBusy( rows, mine, cfg.cpu_threshold_pct ).map( procs.brief ),
		'blocked': blocked.blocking,
		'blocked_ignored': blocked.ignored,
		'harness_procs': procs.findHarness( rows, procs.ownProcesses( rows, self ), harness ),
		'display_asleep': parseDisplay( jxText ),
		'screensaver_running': ( rows.length ) ? procs.findScreenSaver( rows ).length > 0 : null,
		'ps_ok': rows.length > 0
	};
}

/**
* Evaluates a snapshot against the pre-flight rules.
*
* @param {Object} snap - snapshot
* @param {Object} cfg - protocol `preflight` section
* @param {(number|null)} prevSwapMb - swap used at the previous check (null: no growth check)
* @returns {Object} `{ pass, reasons }`
*/
function evaluate( snap, cfg, prevSwapMb ) {
	var src;
	var r = [];
	if ( !snap.power.source ) {
		r.push( 'power source unavailable (pmset -g batt)' );
	} else if ( !snap.power.ac ) {
		r.push( 'not on AC power (' + snap.power.source + ')' );
	}
	if ( snap.low_power_mode === null ) {
		r.push( 'Low Power Mode state unavailable' );
	} else if ( snap.low_power_mode ) {
		r.push( 'Low Power Mode is on' );
	}
	if ( snap.thermal_state === null ) {
		r.push( 'thermalState unavailable (osascript)' );
	} else if ( snap.thermal_state !== cfg.thermal_state_required ) {
		r.push( 'thermalState = ' + snap.thermal_state + ' (need ' + cfg.thermal_state_required + ')' );
	}
	if ( !snap.ps_ok ) {
		r.push( 'process list unavailable (ps)' );
	}
	snap.busy.forEach( function each( p ) {
		r.push( 'busy process > ' + cfg.cpu_threshold_pct + '% CPU: ' + p.name + ' (pid ' + p.pid + ', ' + p.pcpu + '%)' );
	});
	if ( ( snap.blocked || [] ).length ) {
		src = ( procs.rules( cfg ).blocked_pattern_source === 'protocol' ) ? 'protocol preflight.blocked_pattern' : procs.ENV_VAR; // eslint-disable-line max-len
		r.push( snap.blocked.length + ' blocked process(es) running (' + src + '): ' + snap.blocked.slice( 0, 4 ).map( function each( p ) { // eslint-disable-line max-len
			return p.name + ' (pid ' + p.pid + ')';
		}).join( ', ' ) + ( ( snap.blocked.length > 4 ) ? ', ...' : '' ) );
	}
	if ( ( snap.harness_procs || [] ).length ) {
		r.push( 'another harness process is running (outside this process tree): ' + snap.harness_procs.slice( 0, 4 ).map( function each( p ) { // eslint-disable-line max-len
			return p.name + ' (pid ' + p.pid + ')';
		}).join( ', ' ) + ( ( snap.harness_procs.length > 4 ) ? ', ...' : '' ) );
	}
	if ( snap.swap_used_mb === null ) {
		r.push( 'swap usage unavailable (sysctl vm.swapusage)' );
	} else if ( prevSwapMb !== null && prevSwapMb !== void 0 && snap.swap_used_mb - prevSwapMb > cfg.swap_growth_tolerance_mb ) { // eslint-disable-line max-len
		r.push( 'swap growing: +' + ( snap.swap_used_mb - prevSwapMb ).toFixed( 1 ) + ' MB since the previous check' );
	}
	if ( snap.pressure_level !== cfg.pressure_level_required ) {
		r.push( 'memory pressure level ' + snap.pressure_level + ' (need ' + cfg.pressure_level_required + ')' );
	}
	return { 'pass': r.length === 0, 'reasons': r };
}

/**
* Full pre-flight: two snapshots `windowS` apart (swap growth measured over the window).
*
* @param {Object} cfg - protocol `preflight` section
* @param {number} [windowS] - window (default `cfg.swap_window_s`)
* @param {Function} [pause] - sleep function (default `sleep`; the orchestrator's honours the STOP file)
* @returns {Object} `{ pass, reasons, snap, first }`
*/
function check( cfg, windowS, pause ) {
	var s0 = collect( cfg );
	var e0 = evaluate( s0, cfg, null );
	var s1, e1, kinds; // eslint-disable-line one-var
	( pause || sleep )( ( ( windowS === void 0 ) ? cfg.swap_window_s : windowS ) * 1000 );
	s1 = collect( cfg );
	e1 = evaluate( s1, cfg, s0.swap_used_mb );
	kinds = e1.reasons.concat( e0.reasons ).map( function kind( x ) { // one line per reason kind (numbers ignored)
		return x.replace( /\d+(\.\d+)?/g, '#' );
	});
	return { 'pass': e0.pass && e1.pass, 'snap': s1, 'first': s0, 'reasons': e1.reasons.concat( e0.reasons ).filter( function uniq( x, i ) { // eslint-disable-line max-len
		return kinds.indexOf( kinds[ i ] ) === i;
	}) };
}

/**
* Waits for a passing environment: on failure pauses `cfg.pause_s` and re-checks, for at most `cfg.max_wait_s`.
*
* @param {Object} o - `{ cfg, prevSwapMb, powerSource (stop if it changes), windowS (full check), skip, log, sleep }`
* @returns {Object} `{ status: 'pass'|'skipped'|'fail'|'stop', reasons, snap, waited_s }`
*/
function gate( o ) {
	var cfg = o.cfg;
	var t0 = Date.now();
	var prev = ( o.prevSwapMb === void 0 ) ? null : o.prevSwapMb;
	var res, snap; // eslint-disable-line one-var
	function done( status, reasons ) {
		return { 'status': status, 'reasons': reasons, 'snap': snap, 'waited_s': ( Date.now() - t0 ) / 1000 };
	}
	for ( ;; ) {
		if ( o.windowS ) {
			res = check( cfg, o.windowS, o.sleep );
			snap = res.snap;
		} else {
			snap = collect( cfg );
			res = evaluate( snap, cfg, prev );
		}
		if ( o.powerSource && snap.power.source && snap.power.source !== o.powerSource ) {
			return done( 'stop', [ 'power source changed: ' + o.powerSource + ' -> ' + snap.power.source ] );
		}
		if ( res.pass || o.skip ) {
			return done( ( res.pass ) ? 'pass' : 'skipped', res.reasons );
		}
		if ( ( Date.now() - t0 ) / 1000 >= cfg.max_wait_s ) {
			return done( 'fail', res.reasons );
		}
		if ( o.log ) {
			o.log( 'PAUSE ' + cfg.pause_s + ' s (environment: ' + res.reasons.join( '; ' ) + ')' );
		}
		( o.sleep || sleep )( cfg.pause_s * 1000 );
		prev = snap.swap_used_mb;
	}
}

/**
* Cheap post-process checks.
*
* @returns {Object} `{ power_source, swapouts, pressure_level, thermal_state }`
*/
function quick() {
	return {
		'power_source': parsePmsetBatt( run( PMSET, [ '-g', 'batt' ] ) ).source,
		'swapouts': parseVmStat( run( VMSTAT, [] ) ).swapouts,
		'pressure_level': parsePressure( run( SYSCTL, [ '-n', 'kern.memorystatus_vm_pressure_level' ] ) ),
		'thermal_state': parseJxa( run( OSASCRIPT, [ '-l', 'JavaScript', '-e', JXA ] ) ).thermal_state
	};
}

/**
* Returns the whole-process exclusion reasons seen after a child (§4): swapouts, pressure/thermal ≥ min, power change.
*
* @param {Object} q - `quick()` result taken after the child
* @param {(number|null)} sw0 - swapouts before the child
* @param {Object} ex - protocol `exclusion` section
* @param {(string|null)} powerSource - power source at campaign start
* @returns {Array<string>} reasons (empty: keep)
*/
function exclusionReasons( q, sw0, ex, powerSource ) {
	var why = [];
	if ( sw0 !== null && q.swapouts !== null && q.swapouts > sw0 ) {
		why.push( 'swapouts+' + ( q.swapouts - sw0 ) );
	}
	if ( q.pressure_level !== null && q.pressure_level >= ex.pressure_level_min ) {
		why.push( 'pressure=' + q.pressure_level );
	}
	if ( q.thermal_state !== null && q.thermal_state >= ex.thermal_state_min ) {
		why.push( 'thermal=' + q.thermal_state );
	}
	if ( powerSource && q.power_source && q.power_source !== powerSource ) {
		why.push( 'power_change' );
	}
	return why;
}

/**
* Returns the current `vm_stat` swapouts counter (null when unavailable).
*
* @returns {(number|null)} swapouts
*/
function swapouts() {
	return parseVmStat( run( VMSTAT, [] ) ).swapouts;
}

/**
* Probes the display (JXA `CGDisplayIsAsleep`) and the screen saver (a running ScreenSaverEngine).
*
* @returns {Object} `{ display_asleep, screensaver_running }` (null fields when unavailable)
*/
function display() {
	var rows = procs.parsePs( run( PS, PS_ARGS ) );
	return {
		'display_asleep': parseDisplay( run( OSASCRIPT, [ '-l', 'JavaScript', '-e', JXA_DISPLAY ] ) ),
		'screensaver_running': ( rows.length ) ? procs.findScreenSaver( rows ).length > 0 : null
	};
}

/**
* Describes a snapshot in one line.
*
* @param {Object} s - snapshot
* @returns {string} description
*/
function describe( s ) {
	var top = s.top_cpu.map( function f( p ) {
		return p.name + ' ' + p.pcpu + '%';
	});
	return 'power: ' + s.power.source + ' (' + s.power.battery_pct + '%, ' + s.power.state + ') | Low Power Mode: ' + s.low_power_mode + ' | thermalState: ' + s.thermal_state + ' | pressure: ' + s.pressure_level + ' | swap used: ' + s.swap_used_mb + ' MB | swapouts: ' + s.swapouts + ' | load: ' + s.load_avg.join( ' ' ) + ' | display asleep: ' + s.display_asleep + ' | screen saver: ' + s.screensaver_running + ' | top: ' + top.join( ', ' ) + ( ( s.blocked_ignored && s.blocked_ignored.length ) ? ' | ignored idle updaters: ' + s.blocked_ignored.map( function f( p ) { // eslint-disable-line max-len
		return p.match + ' (pid ' + p.pid + ', ' + p.pcpu + '%)';
	}).join( ', ' ) : '' );
}

function sha256File( f ) {
	return crypto.createHash( 'sha256' ).update( fs.readFileSync( f ) ).digest( 'hex' );
}

/**
* Returns the env and provenance of the `campaign` record: env.js `collect(repoRoot)` when the file exists, else a
* minimal fallback (Node/V8/OS/hardware, git commit and dirty flag, library and dgemm hashes) with `minimal: true`.
*
* @param {string} repo - repository root
* @param {Object} P - effective protocol (`paths.env`, `paths.package_base`)
* @param {boolean} [minimal] - force the minimal fallback
* @throws {Error} env.js present but failing (the caller decides whether that stops the campaign)
* @returns {Promise<Object>} `{ env, provenance, source }`
*/
async function envRecord( repo, P, minimal ) {
	var f = path.join( repo, P.paths.env );
	var base = path.join( repo, P.paths.package_base );
	var dg = require.resolve( '@stdlib/blas/base/dgemm/lib/base.js' );
	var mod;
	var res;
	if ( !minimal && fs.existsSync( f ) ) {
		mod = require( f ); // eslint-disable-line stdlib/no-dynamic-require
		res = await ( ( typeof mod === 'function' ) ? mod( repo ) : mod.collect( repo ) );
		return { 'env': res.env, 'provenance': res.provenance, 'source': path.relative( repo, f ) };
	}
	return {
		'env': {
			'minimal': true,
			'node': process.versions.node,
			'v8': process.versions.v8,
			'exec_path': process.execPath,
			'os_release': os.release(),
			'macos': ( run( '/usr/bin/sw_vers', [ '-productVersion' ] ) || '' ).trim() || null,
			'hw_model': ( run( SYSCTL, [ '-n', 'hw.model' ] ) || '' ).trim() || null,
			'cpu': ( os.cpus()[ 0 ] || {} ).model || null,
			'logical_cpus': os.cpus().length,
			'total_memory': os.totalmem(),
			'v8_enable_maglev': ( process.config.variables || {} ).v8_enable_maglev
		},
		'provenance': {
			'minimal': true,
			'commit': ( run( 'git', [ 'rev-parse', 'HEAD' ], repo ) || '' ).trim() || null,
			'dirty': ( run( 'git', [ 'status', '--porcelain', '--', '.', ':(exclude)research/data' ], repo ) || '' ).trim().length > 0, // eslint-disable-line max-len
			'package_base': path.relative( repo, base ),
			'package_base_sha256': ( fs.existsSync( base ) ) ? sha256File( base ) : null,
			'dgemm': path.relative( repo, dg ),
			'dgemm_sha256': sha256File( dg )
		},
		'source': 'minimal'
	};
}


// EXPORTS //

module.exports = {
	'sleep': sleep,
	'parsePmsetBatt': parsePmsetBatt,
	'parsePmsetLowPower': parsePmsetLowPower,
	'parseJxa': parseJxa,
	'parseDisplay': parseDisplay,
	'parsePs': procs.parsePs,
	'descendants': procs.descendants,
	'findBusy': procs.findBusy,
	'findBlocked': procs.findBlocked,
	'parseSwapUsage': parseSwapUsage,
	'parsePressure': parsePressure,
	'parseVmStat': parseVmStat,
	'collect': collect,
	'evaluate': evaluate,
	'check': check,
	'gate': gate,
	'quick': quick,
	'display': display,
	'swapouts': swapouts,
	'exclusionReasons': exclusionReasons,
	'describe': describe,
	'envRecord': envRecord
};
