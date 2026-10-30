'use strict';

/*
* Single-instance lock of the orchestrator (campaign-runbook.md §4). Every timing mode (--campaign, --tiny,
* --diagnostics) creates `research/data/.orchestrator.lock` exclusively ('wx') before it picks a campaign id, with
* `{ pid, lstart, command, argv, mode, id, t_wall }`.
*
* -   A lock whose pid is running with the same start time (`ps -o lstart=`) and an orchestrator.js command line belongs
*     to a live instance: the launch is refused (never another campaign).
* -   Any other lock is stale (dead process, or a pid reused after a reboot, or an unreadable lock older than 5 s): it is
*     removed and the create retried. Missing information (no start time, no command) counts as live.
* -   The owner releases it in finish() and on process exit; `release` removes only a lock that is still its own.
*/

// MODULES //

var execFileSync = require( 'child_process' ).execFileSync;
var fs = require( 'fs' );
var path = require( 'path' );


// VARIABLES //

var NAME = '.orchestrator.lock';
var PS = '/bin/ps';
var LSTART = /^\s*([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;
var ORCHESTRATOR = /orchestrator\.js/;
var FRESH_MS = 5000;


// FUNCTIONS //

/**
* Parses `ps -o lstart=,command= -p <pid>` (C locale).
*
* @param {(string|null)} text - output
* @returns {(Object|null)} `{ lstart, command }` (single-spaced start time)
*/
function parseProcInfo( text ) {
	var m = LSTART.exec( ( text || '' ).split( '\n' )[ 0 ] );
	return ( m ) ? { 'lstart': m[ 1 ].replace( /\s+/g, ' ' ), 'command': m[ 2 ].trim() } : null;
}

/**
* Probes a process: whether it runs, its start time and its command line.
*
* @param {integer} pid - process id
* @returns {Object} `{ alive, lstart, command }` (null fields when unavailable)
*/
function procInfo( pid ) {
	var out = { 'alive': true, 'lstart': null, 'command': null };
	var info;
	try {
		process.kill( pid, 0 );
	} catch ( err ) {
		out.alive = ( err.code === 'EPERM' );
	}
	if ( !out.alive ) {
		return out;
	}
	try {
		info = parseProcInfo( execFileSync( PS, [ '-o', 'lstart=,command=', '-p', String( pid ) ], { 'encoding': 'utf8', 'stdio': [ 'ignore', 'pipe', 'ignore' ], 'timeout': 10000, 'env': { 'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'LANG': 'C' } } ) ); // eslint-disable-line max-len
	} catch ( err ) { // eslint-disable-line no-unused-vars
		info = null; // `ps -p` exits 1 when the process vanished meanwhile
	}
	return Object.assign( out, info || {} );
}

/**
* Decides whether a lock holder is a live orchestrator.
*
* @param {Object} holder - lock contents
* @param {Function} [probe] - `procInfo`
* @returns {Object} `{ live, why }`
*/
function holderState( holder, probe ) {
	var pid = ( holder ) ? holder.pid : null;
	var info;
	if ( typeof pid !== 'number' || pid <= 0 || pid % 1 !== 0 ) {
		return { 'live': false, 'why': 'malformed lock (no pid)' };
	}
	info = ( probe || procInfo )( pid );
	if ( !info.alive ) {
		return { 'live': false, 'why': 'pid ' + pid + ' is not running' };
	}
	if ( info.lstart && holder.lstart && info.lstart !== holder.lstart ) {
		return { 'live': false, 'why': 'pid ' + pid + ' now belongs to another process (started ' + info.lstart + ', the lock says ' + holder.lstart + ')' }; // eslint-disable-line max-len
	}
	if ( info.command && !ORCHESTRATOR.test( info.command ) ) {
		return { 'live': false, 'why': 'pid ' + pid + ' is not an orchestrator (' + info.command.slice( 0, 80 ) + ')' };
	}
	return { 'live': true, 'why': 'pid ' + pid + ' is running' + ( ( info.lstart ) ? ' since ' + info.lstart : '' ) };
}

/**
* Reads a lock file.
*
* @param {string} file - lock path
* @returns {Object} `{ missing }` or `{ holder (null if unreadable), mtimeMs }`
*/
function read( file ) {
	var text;
	var st;
	try {
		st = fs.statSync( file );
		text = fs.readFileSync( file, 'utf8' );
	} catch ( err ) {
		if ( err.code === 'ENOENT' ) {
			return { 'missing': true };
		}
		throw err;
	}
	try {
		return { 'holder': JSON.parse( text ), 'mtimeMs': st.mtimeMs };
	} catch ( err ) { // eslint-disable-line no-unused-vars
		return { 'holder': null, 'mtimeMs': st.mtimeMs };
	}
}

function unlink( file ) {
	try {
		fs.unlinkSync( file );
	} catch ( err ) {
		if ( err.code !== 'ENOENT' ) {
			throw err;
		}
	}
}

/**
* Inspects a lock without taking it.
*
* @param {string} file - lock path
* @param {Object} [o] - `{ probe, now }`
* @returns {Object} `{ held, holder, why }` (`held`: a live instance owns it)
*/
function inspect( file, o ) {
	var opts = o || {};
	var cur = read( file );
	var st;
	if ( cur.missing ) {
		return { 'held': false, 'holder': null, 'why': 'no lock' };
	}
	if ( !cur.holder ) {
		return ( ( ( opts.now || Date.now )() - cur.mtimeMs ) < FRESH_MS ) ? { 'held': true, 'holder': null, 'why': 'the lock is being written by another launch' } : { 'held': false, 'holder': null, 'why': 'unreadable lock' }; // eslint-disable-line max-len
	}
	st = holderState( cur.holder, opts.probe );
	return { 'held': st.live, 'holder': cur.holder, 'why': st.why };
}

/**
* Acquires the lock: exclusive create; a stale lock is removed and the create retried.
*
* @param {string} file - lock path
* @param {Object} info - contents (`pid` defaults to this process)
* @param {Object} [o] - `{ probe, now }` (tests)
* @returns {Object} `{ ok, lock, removed }` or `{ ok: false, holder, why, removed }`
*/
function acquire( file, info, o ) {
	var rec = Object.assign( {}, info, { 'pid': ( info && info.pid ) || process.pid } );
	var removed = [];
	var cur;
	var i;
	for ( i = 0; i < 3; i++ ) {
		try {
			fs.writeFileSync( file, JSON.stringify( rec ) + '\n', { 'flag': 'wx' } );
			return { 'ok': true, 'lock': { 'file': file, 'pid': rec.pid, 'lstart': rec.lstart || null }, 'removed': removed }; // eslint-disable-line max-len
		} catch ( err ) {
			if ( err.code !== 'EEXIST' ) {
				throw err;
			}
		}
		cur = inspect( file, o );
		if ( cur.held ) {
			return { 'ok': false, 'holder': cur.holder, 'why': cur.why, 'removed': removed };
		}
		if ( cur.why !== 'no lock' ) {
			removed.push( { 'holder': cur.holder, 'why': cur.why } );
			unlink( file );
		}
	}
	return { 'ok': false, 'holder': null, 'why': 'the lock was re-created by a concurrent launch', 'removed': removed };
}

/**
* Rewrites the contents of an owned lock (atomic rename), e.g. once the campaign id is known.
*
* @param {Object} lock - `acquire(...).lock`
* @param {Object} fields - fields to merge
* @returns {boolean} whether the lock was still owned
*/
function update( lock, fields ) {
	var cur = ( lock ) ? read( lock.file ) : { 'missing': true };
	if ( cur.missing || !cur.holder || cur.holder.pid !== lock.pid || ( cur.holder.lstart || null ) !== lock.lstart ) {
		return false;
	}
	fs.writeFileSync( lock.file + '.tmp', JSON.stringify( Object.assign( cur.holder, fields ) ) + '\n' );
	fs.renameSync( lock.file + '.tmp', lock.file );
	return true;
}

/**
* Releases an owned lock (no-op if the lock is gone or belongs to another process).
*
* @param {Object} [lock] - `acquire(...).lock`
* @returns {boolean} whether the lock was removed
*/
function release( lock ) {
	var cur;
	if ( !lock ) {
		return false;
	}
	cur = read( lock.file );
	if ( cur.missing || !cur.holder || cur.holder.pid !== lock.pid || ( cur.holder.lstart || null ) !== lock.lstart ) {
		return false;
	}
	unlink( lock.file );
	return true;
}

/**
* Describes a live holder for the refusal message.
*
* @param {Object} r - `acquire` or `inspect` result
* @param {string} file - lock path (shown relative to the repository root)
* @returns {string} message
*/
function describeHolder( r, file ) {
	var h = r.holder || {};
	return 'another orchestrator instance is running (' + r.why + ( ( h.id ) ? ', campaign ' + h.id : '' ) + ( ( h.argv ) ? ', argv ' + h.argv.join( ' ' ) : '' ) + '; lock ' + file + '). Wait for it, or stop it first (touch research/data/<campaign-id>/STOP, or pkill -TERM -f \'research/(harness|accuracy|correctness)/\'), then check that pgrep -fl \'research/(harness|accuracy|correctness)/\' prints nothing'; // eslint-disable-line max-len
}

/**
* Returns the lock path inside a data directory.
*
* @param {string} dataDir - research/data
* @returns {string} path
*/
function lockFile( dataDir ) {
	return path.join( dataDir, NAME );
}


// EXPORTS //

module.exports = {
	'NAME': NAME,
	'lockFile': lockFile,
	'parseProcInfo': parseProcInfo,
	'procInfo': procInfo,
	'holderState': holderState,
	'inspect': inspect,
	'acquire': acquire,
	'update': update,
	'release': release,
	'describeHolder': describeHolder
};
