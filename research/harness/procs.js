'use strict';

/*
* Process-table analysis of the pre-flight (research-protocol.md §2; campaign-runbook.md §2–§4). Pure functions of
* `ps -axww -o pid=,ppid=,pcpu=,command=` rows (unit-tested on captured outputs):
*
* -   this process tree (`descendants`) and its launchers (`ancestors`: caffeinate, the shell);
* -   busy processes (CPU threshold);
* -   blocked processes (`classifyBlocked`): processes outside this process tree and its harness launchers
*     (`blockedExempt`: the caffeinate wrapper or shell whose command line runs this harness; other launchers are not
*     exempt, so a launch from inside a blocked application fails) whose command line matches the blocked-process
*     pattern, a case-insensitive regular expression taken from the STRATAMM_BLOCKED_PROCESSES environment variable
*     when it is set and non-empty, else from the protocol's `preflight.blocked_pattern`, else none (no process is
*     blocked by name; the CPU-threshold check still applies). Application updaters such as Squirrel's ShipIt (a
*     launchd job that can outlive its app) are recorded but block only above `ignore_max_pcpu` percent CPU;
* -   other harness processes (`findHarness`): any process outside this tree and its launchers whose command line runs
*     research/(harness|accuracy|correctness)/ (another orchestrator, an orphaned child, E6, another clone);
* -   the screen saver (`findScreenSaver`).
*
* The protocol's `preflight` section may override the rule defaults below (`blocked_pattern`, `ignore_pattern`,
* `ignore_max_pcpu`, `harness_pattern`); the effective rules, with the source of the blocked-process pattern, are
* recorded in the campaign record.
*/

// VARIABLES //

var ENV_VAR = 'STRATAMM_BLOCKED_PROCESSES';
var DEFAULTS = {
	'blocked_pattern': null,
	'ignore_pattern': '/ShipIt(\\s|$)|Squirrel\\.framework/', // Squirrel/ShipIt updaters of Electron apps
	'ignore_max_pcpu': 5,
	'harness_pattern': 'research/(harness|accuracy|correctness)/'
};
var SCREENSAVER = /\/ScreenSaverEngine(\.app\/|\s|$)/;


// FUNCTIONS //

/**
* Parses `ps -axww -o pid=,ppid=,pcpu=,command=`.
*
* @param {(string|null)} text - output
* @returns {Array<Object>} rows `{ pid, ppid, pcpu, command }`
*/
function parsePs( text ) {
	var out = [];
	( text || '' ).split( '\n' ).forEach( function each( line ) {
		var m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec( line );
		if ( m ) {
			out.push( { 'pid': Number( m[ 1 ] ), 'ppid': Number( m[ 2 ] ), 'pcpu': Number( m[ 3 ] ), 'command': m[ 4 ].trim() } );
		}
	});
	return out;
}

/**
* Returns a process and all its descendants.
*
* @param {Array<Object>} procs - `ps` rows
* @param {integer} root - root pid
* @returns {Set} pids
*/
function descendants( procs, root ) {
	var set = new Set( [ root ] );
	var grew = true;
	while ( grew ) {
		grew = false;
		procs.forEach( function each( p ) {
			if ( set.has( p.ppid ) && !set.has( p.pid ) ) {
				set.add( p.pid );
				grew = true;
			}
		});
	}
	return set;
}

/**
* Returns the ancestors of a process (its parent, the parent's parent, ... up to launchd), excluding the process.
*
* @param {Array<Object>} procs - `ps` rows
* @param {integer} pid - process id
* @returns {Set} pids
*/
function ancestors( procs, pid ) {
	var byPid = new Map();
	var set = new Set();
	var cur = pid;
	var row;
	procs.forEach( function each( p ) {
		byPid.set( p.pid, p );
	});
	row = byPid.get( cur );
	while ( row && row.ppid > 0 && !set.has( row.ppid ) && row.ppid !== pid ) {
		set.add( row.ppid );
		row = byPid.get( row.ppid );
	}
	return set;
}

/**
* Returns the processes outside `mine` above a CPU threshold (percent of one core), busiest first.
*
* @param {Array<Object>} procs - `ps` rows
* @param {Set} mine - pids to ignore (this process tree)
* @param {number} threshold - percent
* @returns {Array<Object>} rows
*/
function findBusy( procs, mine, threshold ) {
	return procs.filter( function busy( p ) {
		return !mine.has( p.pid ) && p.pcpu > threshold;
	}).sort( function cmp( a, b ) {
		return b.pcpu - a.pcpu;
	});
}

/**
* Returns the processes outside `mine` whose command line matches a blocked-process pattern (case-insensitive).
*
* @param {Array<Object>} procs - `ps` rows
* @param {Set} mine - pids to ignore
* @param {(string|null)} pattern - regular expression source (null or empty: no process is blocked)
* @returns {Array<Object>} rows
*/
function findBlocked( procs, mine, pattern ) {
	var re;
	if ( !pattern ) {
		return [];
	}
	re = new RegExp( pattern, 'i' );
	return procs.filter( function blocked( p ) {
		return !mine.has( p.pid ) && re.test( p.command );
	});
}

/**
* Returns the effective process rules: the protocol `preflight` section over the defaults, with the blocked-process
* pattern taken from STRATAMM_BLOCKED_PROCESSES when that variable is set and non-empty.
*
* @param {Object} [cfg] - protocol `preflight` section
* @throws {TypeError} protocol `blocked_pattern` neither a string nor null
* @throws {Error} blocked-process pattern that is not a valid regular expression
* @returns {Object} rules (`blocked_pattern_source`: env, protocol or none)
*/
function rules( cfg ) {
	var env = process.env[ ENV_VAR ];
	var c = cfg || {};
	var out = {};
	Object.keys( DEFAULTS ).forEach( function each( k ) {
		out[ k ] = ( c[ k ] === void 0 || c[ k ] === null ) ? DEFAULTS[ k ] : c[ k ];
	});
	if ( out.blocked_pattern !== null && typeof out.blocked_pattern !== 'string' ) {
		throw new TypeError( 'protocol preflight.blocked_pattern must be a string or null' );
	}
	if ( typeof env === 'string' && env !== '' ) {
		out.blocked_pattern = env;
		out.blocked_pattern_source = 'env';
	} else if ( out.blocked_pattern ) {
		out.blocked_pattern_source = 'protocol';
	} else {
		out.blocked_pattern = null;
		out.blocked_pattern_source = 'none';
	}
	if ( out.blocked_pattern !== null ) {
		try {
			RegExp( out.blocked_pattern, 'i' );
		} catch ( err ) {
			throw new Error( 'invalid blocked-process pattern (' + ( ( out.blocked_pattern_source === 'env' ) ? ENV_VAR : 'protocol preflight.blocked_pattern' ) + '): ' + err.message ); // eslint-disable-line max-len
		}
	}
	return out;
}

/**
* Returns the blocked-process kind of a command line, or null.
*
* @param {string} command - command line
* @param {Object} r - rules (see `rules`)
* @returns {(Object|null)} `{ kind, match }` (kind: updater or blocked; null when no pattern is set or none matches)
*/
function blockedKind( command, r ) {
	var m = ( r.blocked_pattern ) ? new RegExp( r.blocked_pattern, 'i' ).exec( command ) : null;
	var ign;
	if ( !m ) {
		return null;
	}
	ign = new RegExp( r.ignore_pattern ).exec( command );
	if ( ign ) {
		return { 'kind': 'updater', 'match': ign[ 0 ].trim() };
	}
	return { 'kind': 'blocked', 'match': m[ 0 ] };
}

/**
* Returns a short, secret-free description of a process: the basename of its command up to the first option.
*
* @param {Object} p - `ps` row
* @returns {Object} `{ pid, pcpu, name }`
*/
function brief( p ) {
	var cmd = p.command.split( ' -' )[ 0 ];
	return { 'pid': p.pid, 'pcpu': p.pcpu, 'name': cmd.slice( cmd.lastIndexOf( '/' ) + 1 ).slice( 0, 60 ) };
}

/**
* Classifies the blocked processes outside `mine`: blocking ones, and idle updaters that are only recorded.
*
* @param {Array<Object>} procs - `ps` rows
* @param {Set} mine - pids to ignore (this process tree)
* @param {Object} cfg - protocol `preflight` section
* @returns {Object} `{ blocking, ignored }`, rows `{ pid, pcpu, name, kind, match }`
*/
function classifyBlocked( procs, mine, cfg ) {
	var r = rules( cfg );
	var out = { 'blocking': [], 'ignored': [] };
	procs.forEach( function each( p ) {
		var k = ( mine.has( p.pid ) ) ? null : blockedKind( p.command, r );
		if ( k ) {
			( ( k.kind === 'updater' && p.pcpu <= r.ignore_max_pcpu ) ? out.ignored : out.blocking ).push( Object.assign( brief( p ), k ) ); // eslint-disable-line max-len
		}
	});
	return out;
}

/**
* Returns the harness processes outside `exclude` (this process tree and its launchers).
*
* @param {Array<Object>} procs - `ps` rows
* @param {Set} exclude - pids to ignore
* @param {string} [pattern] - regular expression source (default research/(harness|accuracy|correctness)/)
* @returns {Array<Object>} rows `{ pid, pcpu, name, match }`
*/
function findHarness( procs, exclude, pattern ) {
	var re = new RegExp( pattern || DEFAULTS.harness_pattern );
	return procs.filter( function other( p ) {
		return !exclude.has( p.pid ) && re.test( p.command );
	}).map( function each( p ) {
		return Object.assign( brief( p ), { 'match': re.exec( p.command )[ 0 ] } );
	});
}

/**
* Returns the running screen-saver processes (ScreenSaverEngine).
*
* @param {Array<Object>} procs - `ps` rows
* @returns {Array<Object>} rows `{ pid, pcpu, name }`
*/
function findScreenSaver( procs ) {
	return procs.filter( function saver( p ) {
		return SCREENSAVER.test( p.command );
	}).map( brief );
}

/**
* Returns the set of pids the harness check ignores: this process tree plus its launchers.
*
* @param {Array<Object>} procs - `ps` rows
* @param {integer} self - this process id
* @returns {Set} pids
*/
function ownProcesses( procs, self ) {
	var set = descendants( procs, self );
	ancestors( procs, self ).forEach( function add( p ) {
		set.add( p );
	});
	return set;
}

/**
* Returns the set of pids the blocked-process check ignores: this process tree plus the launchers whose command line
* runs this harness (the caffeinate wrapper, a `zsh -c 'nohup caffeinate ...'` shell). Other launchers (the terminal,
* an interactive shell) are not exempt, so a launch from inside a blocked application fails.
*
* @param {Array<Object>} procs - `ps` rows
* @param {integer} self - this process id
* @param {string} [pattern] - harness pattern (default research/(harness|accuracy|correctness)/)
* @returns {Set} pids
*/
function blockedExempt( procs, self, pattern ) {
	var set = descendants( procs, self );
	var anc = ancestors( procs, self );
	findHarness( procs, set, pattern ).forEach( function add( p ) {
		if ( anc.has( p.pid ) ) {
			set.add( p.pid );
		}
	});
	return set;
}


// EXPORTS //

module.exports = {
	'ENV_VAR': ENV_VAR,
	'DEFAULTS': DEFAULTS,
	'parsePs': parsePs,
	'descendants': descendants,
	'ancestors': ancestors,
	'ownProcesses': ownProcesses,
	'blockedExempt': blockedExempt,
	'findBusy': findBusy,
	'findBlocked': findBlocked,
	'rules': rules,
	'blockedKind': blockedKind,
	'classifyBlocked': classifyBlocked,
	'findHarness': findHarness,
	'findScreenSaver': findScreenSaver,
	'brief': brief
};
