'use strict';

/*
* Campaign control of the orchestrator (campaign-runbook.md §3–§5; research-protocol.md §5, §8):
*
* -   STOP file: `research/data/<id>/STOP` asks for a clean stop between children; one older than the launch is stale.
* -   Stage scripts (E6/E1): run with stdout inherited and stderr appended to `research/data/<id>/<stage>.stderr.log`,
*     whose new tail is returned (the orchestrator writes it to campaign.log and campaign_end.reason).
* -   Outcomes: E6 exit 2 (hard gate, certification or precondition) means investigate, never resume implicitly; any
*     other failure (exit 1, timeout, signal) is resumable. An E7 abort ends the campaign 'incomplete' after E6.
* -   Resume admission: never resume a campaign of another mode, one started under a different protocol.json, an
*     auto-selected one whose last write is older than 12 h (another night: amendment 6), or one stopped by an E6
*     hard gate (unless --override-e6-stop).
* -   End line and exit code; sentinel re-check budget (10 min by default); bounded wait for display sleep.
*/

// MODULES //

var spawnSync = require( 'child_process' ).spawnSync;
var fs = require( 'fs' );


// VARIABLES //

var EXIT = { 'complete': 0, 'stopped': 2, 'incomplete': 3, 'investigate': 4, 'refused': 64, 'locked': 75 };
var AUTO_RESUME_MAX_AGE_H = 12;
var DISPLAY_WAIT_S = 900;
var DISPLAY_POLL_S = 15;
var TAIL_LINES = 30;
var TAIL_BYTES = 65536;


// FUNCTIONS //

/**
* Removes a STOP file older than this launch (a leftover); a newer one is kept and will stop the campaign.
*
* @param {string} file - STOP path
* @param {number} t0 - launch time (ms since epoch)
* @returns {(string|null)} 'removed', 'pending' or null (no STOP file)
*/
function clearStaleStop( file, t0 ) {
	var st;
	try {
		st = fs.statSync( file );
	} catch ( err ) { // eslint-disable-line no-unused-vars
		return null;
	}
	if ( st.mtimeMs >= t0 ) {
		return 'pending';
	}
	fs.unlinkSync( file );
	return 'removed';
}

/**
* Returns the last non-empty lines of a text.
*
* @param {string} text - text
* @param {PositiveInteger} [n] - lines (default 30)
* @returns {Array<string>} lines (each at most 400 characters)
*/
function tail( text, n ) {
	return String( text || '' ).split( '\n' ).map( function trim( l ) {
		return l.replace( /\s+$/, '' ).slice( 0, 400 );
	}).filter( function nonEmpty( l ) {
		return l !== '';
	}).slice( -( n || TAIL_LINES ) );
}

function readFrom( file, offset ) {
	var size = fs.statSync( file ).size;
	var start = Math.max( offset, size - TAIL_BYTES );
	var buf = Buffer.alloc( Math.max( 0, size - start ) );
	var fd = fs.openSync( file, 'r' );
	fs.readSync( fd, buf, 0, buf.length, start );
	fs.closeSync( fd );
	return buf.toString( 'utf8' );
}

/**
* Runs a stage script (`node <file> <args>`): stdout inherited, stderr appended to `o.stderrFile`.
*
* @param {string} file - script (absolute path)
* @param {Array<string>} args - arguments
* @param {Object} o - `{ timeoutS (0: none), cwd, env, stderrFile }`
* @returns {Object} `{ ok, status, signal, timed_out, timeout_s, error, stderr_tail, stderr_file }`
*/
function runStageScript( file, args, o ) {
	var offset = ( fs.existsSync( o.stderrFile ) ) ? fs.statSync( o.stderrFile ).size : 0;
	var fd = fs.openSync( o.stderrFile, 'a' );
	var r;
	try {
		r = spawnSync( process.execPath, [ file ].concat( args ), { 'cwd': o.cwd, 'env': o.env, 'stdio': [ 'ignore', 'inherit', fd ], 'timeout': ( o.timeoutS ) ? o.timeoutS * 1000 : void 0, 'killSignal': 'SIGKILL' } ); // eslint-disable-line max-len
	} finally {
		fs.closeSync( fd );
	}
	return {
		'ok': r.status === 0,
		'status': r.status,
		'signal': r.signal || null,
		'timed_out': !!( r.error && r.error.code === 'ETIMEDOUT' ),
		'timeout_s': o.timeoutS || null,
		'error': ( r.error ) ? r.error.message : null,
		'stderr_tail': tail( readFrom( o.stderrFile, offset ) ),
		'stderr_file': o.stderrFile
	};
}

/**
* Classifies the result of a stage script.
*
* @param {string} name - 'E6' or 'E1'
* @param {Object} r - `runStageScript` result
* @param {Object} c - `{ id, mode }` (for the recovery command)
* @returns {Object} `{ ok, kind: 'ok'|'investigate'|'stage', label, reason }`
*/
function stageOutcome( name, r, c ) {
	var cmd = '--' + c.mode + ' --id ' + c.id;
	var label;
	var kind;
	var reason;
	if ( r.ok ) {
		return { 'ok': true, 'kind': 'ok', 'label': 'exit 0', 'reason': null };
	}
	if ( r.timed_out ) {
		label = 'timeout after ' + r.timeout_s + ' s';
	} else if ( typeof r.status === 'number' ) {
		label = 'exit ' + r.status;
	} else {
		label = ( r.signal ) ? 'killed by ' + r.signal : 'could not run: ' + r.error;
	}
	kind = ( name === 'E6' && r.status === 2 ) ? 'investigate' : 'stage';
	reason = name + ' failed (' + label + ') - ' + ( ( kind === 'investigate' ) ? 'INVESTIGATE, do not resume: E6 exit 2 is a hard-gate, certification or precondition stop, i.e. a bug signal; after investigating, ' + cmd + ' --override-e6-stop re-runs E6' : 'resumable: re-run the launch command (or ' + cmd + '); completed stages are skipped and ' + name + ' runs again' ); // eslint-disable-line max-len
	if ( r.stderr_tail && r.stderr_tail.length ) {
		reason += ' | stderr: ' + r.stderr_tail.slice( -5 ).join( ' | ' ).slice( -800 );
	}
	return { 'ok': false, 'kind': kind, 'label': label, 'reason': reason };
}

/**
* Decides whether a campaign may be resumed (null) or the launch must be refused (the message).
*
* @param {Object} st - `resume.loadState` of the campaign directory
* @param {Object} o - `{ id, mode, sha, auto (picked by findResumable), ageH (hours since the last write), override }`
* @returns {(string|null)} refusal
*/
function admit( st, o ) {
	var flag = '--' + o.mode;
	var e6 = st.e6Stop;
	if ( !st.campaigns.length ) {
		return null;
	}
	if ( st.mode && st.mode !== o.mode ) {
		return 'campaign ' + o.id + ' is a ' + st.mode + ' campaign; resume it with --' + st.mode + ' --id ' + o.id + ', or start a new one with ' + flag + ' --new'; // eslint-disable-line max-len
	}
	if ( st.protocolSha && st.protocolSha !== o.sha ) {
		return 'campaign ' + o.id + ' was started under a different research/protocol.json (' + st.protocolSha.slice( 0, 12 ) + ' -> ' + o.sha.slice( 0, 12 ) + ') and cannot be resumed; start a new campaign with ' + flag + ' --new'; // eslint-disable-line max-len
	}
	if ( o.auto && typeof o.ageH === 'number' && o.ageH > AUTO_RESUME_MAX_AGE_H ) {
		return 'the latest unfinished ' + o.mode + ' campaign ' + o.id + ' last wrote data ' + o.ageH.toFixed( 1 ) + ' h ago (another night: sentinel baselines are per campaign); start a new campaign with ' + flag + ' --new, or resume it explicitly with ' + flag + ' --id ' + o.id; // eslint-disable-line max-len
	}
	if ( e6 && !e6.cleared && !o.override ) {
		return 'campaign ' + o.id + ' stopped on an E6 hard gate (exit ' + e6.exit_code + ', ' + e6.t_wall + '): investigate first (a bug signal; see research/data/' + o.id + '/campaign.log and E6.stderr.log). After investigating, ' + flag + ' --id ' + o.id + ' --override-e6-stop re-runs E6; or start a new campaign with ' + flag + ' --new'; // eslint-disable-line max-len
	}
	return null;
}

/**
* Returns the final log line.
*
* @param {string} status - 'complete', 'incomplete', 'stopped' or 'error'
* @param {(string|null)} reason - reason
* @returns {string} line
*/
function endLine( status, reason ) {
	if ( status === 'complete' ) {
		return 'CAMPAIGN COMPLETE';
	}
	return ( ( status === 'incomplete' ) ? 'CAMPAIGN INCOMPLETE: ' : 'CAMPAIGN STOPPED: ' ) + String( reason ).replace( /\s*\n\s*/g, ' | ' ); // eslint-disable-line max-len
}

/**
* Returns the process exit code of a campaign end.
*
* @param {string} status - end status
* @param {(string|null)} kind - StopError kind
* @returns {integer} 0 complete, 3 incomplete, 4 investigate (E6 hard gate), 2 any other stop or error
*/
function exitCode( status, kind ) {
	if ( status === 'complete' ) {
		return EXIT.complete;
	}
	if ( status === 'incomplete' ) {
		return EXIT.incomplete;
	}
	return ( kind === 'investigate' ) ? EXIT.investigate : EXIT.stopped;
}

/**
* Returns the sentinel re-check budget: `sentinel.max_wait_s`, else `preflight.max_wait_s` (600 s; tiny 30 s).
*
* @param {Object} P - effective protocol
* @returns {number} seconds
*/
function sentinelBudgetS( P ) {
	return ( typeof P.sentinel.max_wait_s === 'number' ) ? P.sentinel.max_wait_s : P.preflight.max_wait_s;
}

/**
* Decides whether failing sentinels stop the campaign: at least `max_consecutive_failures` consecutive failures and
* the first of them at least `budgetS` ago (pause `pause_s` and re-check until then).
*
* @param {PositiveInteger} fails - consecutive failures
* @param {number} waitedS - seconds since the first failure of the streak
* @param {Object} cfg - protocol `sentinel` section
* @param {number} budgetS - `sentinelBudgetS`
* @returns {boolean} whether to stop
*/
function sentinelGivesUp( fails, waitedS, cfg, budgetS ) {
	return fails >= cfg.max_consecutive_failures && waitedS >= budgetS;
}

/**
* Returns the display-sleep wait budget: `preflight.display_wait_s`, else 900 s (tiny: `preflight.max_wait_s`).
*
* @param {Object} P - effective protocol
* @returns {number} seconds
*/
function displayBudgetS( P ) {
	if ( typeof P.preflight.display_wait_s === 'number' ) {
		return P.preflight.display_wait_s;
	}
	return ( P.mode === 'tiny' ) ? P.preflight.max_wait_s : DISPLAY_WAIT_S;
}

/**
* Waits until the display is asleep and no screen saver runs, polling every `pollS` for at most `budgetS`.
*
* @param {Object} o - `{ budgetS, pollS, probe, pause(ms), log(msg), now() }`
* @returns {Object} `{ ok, waited_s, budget_s, polls, timed_out, unavailable, display_asleep, screensaver_running,
*   warning }` (`warning` null when ok)
*/
function waitForDisplay( o ) {
	var poll = ( o.pollS || DISPLAY_POLL_S ) * 1000;
	var now = o.now || Date.now;
	var t0 = now();
	var nextLog = 0;
	var polls = 0;
	var d;
	var w;
	function done( ok, extra ) {
		var r = Object.assign( { 'ok': ok, 'waited_s': w, 'budget_s': o.budgetS, 'polls': polls, 'timed_out': false, 'unavailable': false, 'display_asleep': d.display_asleep, 'screensaver_running': d.screensaver_running, 'warning': null }, extra || {} ); // eslint-disable-line max-len
		if ( r.unavailable ) {
			r.warning = 'display state unavailable (CGDisplayIsAsleep); timing started without the display-sleep check';
		} else if ( !ok ) {
			r.warning = 'timing started with the display ' + ( ( r.display_asleep ) ? 'asleep' : 'awake' ) + ( ( r.screensaver_running ) ? ' and the screen saver running' : '' ) + ' after a ' + o.budgetS + ' s wait'; // eslint-disable-line max-len
		}
		return r;
	}
	for ( ;; ) {
		d = o.probe();
		polls += 1;
		w = ( now() - t0 ) / 1000;
		if ( d.display_asleep === null ) {
			return done( false, { 'unavailable': true } );
		}
		if ( d.display_asleep && !d.screensaver_running ) {
			return done( true );
		}
		if ( w >= o.budgetS ) {
			return done( false, { 'timed_out': true } );
		}
		if ( w >= nextLog ) {
			o.log( 'WAIT for display sleep: display ' + ( ( d.display_asleep ) ? 'asleep' : 'awake' ) + ', screen saver ' + ( ( d.screensaver_running ) ? 'running' : 'not running' ) + ' (' + Math.round( w ) + ' of ' + o.budgetS + ' s; timing starts once the display sleeps: pmset displaysleepnow)' ); // eslint-disable-line max-len
			nextLog += 60;
		}
		o.pause( Math.min( poll, Math.max( 1, ( o.budgetS - w ) * 1000 ) ) );
	}
}


// EXPORTS //

module.exports = {
	'EXIT': EXIT,
	'AUTO_RESUME_MAX_AGE_H': AUTO_RESUME_MAX_AGE_H,
	'clearStaleStop': clearStaleStop,
	'tail': tail,
	'runStageScript': runStageScript,
	'stageOutcome': stageOutcome,
	'admit': admit,
	'endLine': endLine,
	'exitCode': exitCode,
	'sentinelBudgetS': sentinelBudgetS,
	'sentinelGivesUp': sentinelGivesUp,
	'displayBudgetS': displayBudgetS,
	'waitForDisplay': waitForDisplay
};
