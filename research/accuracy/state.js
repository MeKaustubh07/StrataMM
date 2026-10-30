'use strict';

// E6 campaign state read back from accuracy.jsonl when run.js (re)starts, and the resume preconditions:
//   -   a torn last line (interrupted write) is newline-terminated and skipped; its arm counts as missing;
//   -   hard gates are sticky: a record whose persisted `gate_violations` or recomputed gates (gates.recordViolations)
//       are non-empty stops the run (exit 2) and keeps the campaign from ever being reported COMPLETE. A violating
//       re-evaluation of an arm that is already recorded (non-determinism or changed code) is kept as an
//       `accuracy_reeval_violation` record (same fields as `accuracy`; never counted as data) so that it stays sticky;
//   -   records written by other package sources (pkg_sha256) stop the run: one campaign, one code version.
// `--accept-violations` / `--accept-pkg-change` let a run continue past these checks (logged); the final gate check
// in run.js still exits 2 while any violation is recorded.

// MODULES //

var path = require( 'path' );
var paths = require( './paths.js' );
var design = require( './design.js' );
var families = require( './families.js' );
var records = require( './records.js' );
var gates = require( './gates.js' );


// VARIABLES //

var EXIT_GATE = 2;
var MAX_LISTED = 20;
var REEVAL = 'accuracy_reeval_violation';


// FUNCTIONS //

/**
* Returns an error that makes run.js exit with code 2 (gate, certification or precondition stop).
*
* @param {string} msg - message
* @returns {Error} error with `exitCode = 2`
*/
function stopError( msg ) {
	var err = new Error( msg );
	err.exitCode = EXIT_GATE;
	return err;
}

/**
* Returns the remedy printed with a hard-gate stop.
*
* @param {string} file - accuracy.jsonl
* @returns {string} remedy
*/
function remedy( file ) {
	return 'Remedy: fix the cause, then run E6 under a new campaign id (node research/accuracy/run.js --campaign <new-id>) or move ' + path.relative( paths.ROOT, file ) + ' aside. --accept-violations evaluates the remaining arms for diagnosis, but the run still exits 2.';
}

/**
* Returns the arm key of an accuracy record (`design.armKey` of its shard).
*
* @param {Object} r - accuracy record
* @returns {string} key
*/
function recordKey( r ) {
	return design.armKey( r.family + '|' + families.paramsKey( r.params ) + '|' + r.seed + '|' + r.N, r.alg, r.levels );
}

/**
* Loads the state of accuracy.jsonl, after newline-terminating a torn last line.
*
* @param {string} file - accuracy.jsonl
* @param {string} campaign - campaign identifier
* @returns {Object} `{ repaired, bad, all, accuracy, gated, done }`: repair info (or null), malformed line numbers,
*   every record, the `accuracy` records (any campaign), the records subject to the gates (`accuracy` and
*   `accuracy_reeval_violation`), and the arm keys recorded for `campaign`
*/
function load( file, campaign ) {
	var repaired = records.repairTail( file );
	var done = new Set();
	var bad = [];
	var all = records.readJsonl( file, bad );
	var acc = all.filter( function isAccuracy( r ) {
		return r.type === 'accuracy';
	});
	acc.forEach( function add( r ) {
		if ( r.campaign === campaign ) {
			done.add( recordKey( r ) );
		}
	});
	return {
		'repaired': repaired,
		'bad': bad,
		'all': all,
		'accuracy': acc,
		'gated': all.filter( function isGated( r ) {
			return r.type === 'accuracy' || r.type === REEVAL;
		}),
		'done': done
	};
}

/**
* Returns the hard-gate violations of records (persisted ∪ recomputed), one line per violating record.
*
* @param {Array<Object>} recs - `accuracy` (and `accuracy_reeval_violation`) records
* @returns {Array<string>} `<arm key>[ (re-evaluation)]: <violation>; ...`
*/
function violations( recs ) {
	var out = [];
	recs.forEach( function check( r ) {
		var v = gates.recordViolations( r );
		if ( v.length ) {
			out.push( recordKey( r ) + ( ( r.type === REEVAL ) ? ' (re-evaluation)' : '' ) + ': ' + v.join( '; ' ) );
		}
	});
	return out;
}

/**
* Returns the record that keeps a violating re-evaluation of an already recorded arm (sticky, never counted as data).
*
* @param {Object} r - accuracy record (with `gate_violations`)
* @returns {Object} `accuracy_reeval_violation` record
*/
function reevalRecord( r ) {
	return Object.assign( {}, r, {
		'type': REEVAL
	});
}

/**
* Returns the package hashes of accuracy records that differ from the current one, with record counts.
*
* @param {Array<Object>} recs - accuracy records
* @param {string} sha - current package hash
* @returns {Object} `{ <pkg_sha256>: count }`
*/
function otherPackages( recs, sha ) {
	var out = {};
	recs.forEach( function check( r ) {
		if ( typeof r.pkg_sha256 === 'string' && r.pkg_sha256 !== sha ) {
			out[ r.pkg_sha256 ] = ( out[ r.pkg_sha256 ] || 0 ) + 1;
		}
	});
	return out;
}

/**
* Returns the arm keys of a design that are not recorded.
*
* @param {Array<Object>} shards - shards
* @param {Set<string>} done - recorded arm keys
* @returns {Array<string>} missing arm keys
*/
function missing( shards, done ) {
	var out = [];
	shards.forEach( function check( s ) {
		s.arms.forEach( function arm( a ) {
			var k = design.armKey( s.key, a.alg, a.levels );
			if ( !done.has( k ) ) {
				out.push( k );
			}
		});
	});
	return out;
}

/**
* Logs the repair of a torn last line and any malformed lines of a loaded state.
*
* @param {Object} st - state from `load`
* @param {string} file - accuracy.jsonl
* @param {Function} log - logger
*/
function report( st, file, log ) {
	var rel = path.relative( paths.ROOT, file );
	if ( st.repaired ) {
		log( 'WARNING ' + rel + ': line ' + st.repaired.line + ' was cut short by an interrupted write (' + st.repaired.bytes + ' bytes); newline-terminated, ' + ( ( st.repaired.kept ) ? 'the record is complete and kept' : 'the torn record is skipped and its arm evaluated again' ) );
	}
	if ( st.bad.length ) {
		log( 'WARNING ' + rel + ': ' + st.bad.length + ' malformed line(s) skipped (line ' + st.bad.slice( 0, MAX_LISTED ).join( ', ' ) + ( ( st.bad.length > MAX_LISTED ) ? ', …' : '' ) + '); their arms count as missing' );
	}
}

/**
* Applies the resume preconditions to the records already in accuracy.jsonl (sticky hard gates, one package version).
*
* @param {Object} st - state from `load`
* @param {Object} o - options (`campaign`, `pkgSha`, `acceptViolations`, `acceptPkgChange`)
* @param {string} file - accuracy.jsonl
* @param {Function} log - logger
* @throws {Error} stop (exit 2) unless overridden by the corresponding flag
*/
function check( st, o, file, log ) {
	var v = violations( st.gated );
	var pk = otherPackages( st.accuracy, o.pkgSha );
	var shas = Object.keys( pk );
	var msg;
	var i;
	for ( i = 0; i < Math.min( v.length, MAX_LISTED ); i++ ) {
		log( 'recorded HARD GATE VIOLATION ' + v[ i ] );
	}
	if ( v.length > MAX_LISTED ) {
		log( '… and ' + ( v.length - MAX_LISTED ) + ' more record(s) with hard-gate violations' );
	}
	if ( v.length && !o.acceptViolations ) {
		throw stopError( 'E6 HARD GATE VIOLATION recorded earlier in campaign ' + o.campaign + ': ' + v.length + ' record(s) (first: ' + v[ 0 ] + '). Hard gates are sticky: this campaign is never COMPLETE. ' + remedy( file ) );
	}
	if ( v.length ) {
		log( 'WARNING --accept-violations: evaluating the remaining arms despite ' + v.length + ' record(s) with hard-gate violations; the run still exits 2' );
	}
	if ( shas.length ) {
		msg = 'package sources changed since campaign ' + o.campaign + ' recorded accuracy data (' + shas.map( function f( s ) {
			return pk[ s ] + ' record(s) with pkg_sha256 ' + s.slice( 0, 12 );
		}).join( ', ' ) + '; current ' + o.pkgSha.slice( 0, 12 ) + ')';
		if ( !o.acceptPkgChange ) {
			throw stopError( 'E6 STOP: ' + msg + '. One campaign must come from one code version: run E6 under a new campaign id, or pass --accept-pkg-change.' );
		}
		log( 'WARNING --accept-pkg-change: ' + msg );
	}
}


// EXPORTS //

module.exports = {
	'EXIT_GATE': EXIT_GATE,
	'REEVAL': REEVAL,
	'stopError': stopError,
	'remedy': remedy,
	'recordKey': recordKey,
	'load': load,
	'violations': violations,
	'reevalRecord': reevalRecord,
	'otherPackages': otherPackages,
	'missing': missing,
	'report': report,
	'check': check
};
