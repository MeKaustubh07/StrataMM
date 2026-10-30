'use strict';

// JSONL helpers for the shared `sw-bench/2` schema (append-only raw data) and SHA-256 utilities.

// MODULES //

var crypto = require( 'crypto' );
var path = require( 'path' );
var fs = require( 'fs' );
var paths = require( './paths.js' );


// VARIABLES //

var SCHEMA = 'sw-bench/2';
var DEFAULT_MASTER_SEED = 20261030;
var NEWLINE = 0x0a;


// FUNCTIONS //

/**
* Returns a record carrying the common `sw-bench/2` fields followed by the provided fields.
*
* @param {string} type - record type
* @param {string} campaign - campaign identifier
* @param {Object} fields - record-specific fields
* @returns {Object} record
*/
function record( type, campaign, fields ) {
	var out = {
		'schema': SCHEMA,
		'type': type,
		'campaign': campaign,
		't_wall': new Date().toISOString()
	};
	return Object.assign( out, fields );
}

/**
* Appends one JSON object as a single line to a file (creating parent directories). Writers call `repairTail` once
* before their first append.
*
* @param {string} file - output file
* @param {Object} obj - object to append
*/
function appendLine( file, obj ) {
	fs.mkdirSync( path.dirname( file ), {
		'recursive': true
	});
	fs.appendFileSync( file, JSON.stringify( obj ) + '\n' );
}

/**
* Parses one line as a JSON object, or returns null.
*
* @private
* @param {string} line - line
* @returns {(Object|null)} record
*/
function parseRecord( line ) {
	var rec;
	try {
		rec = JSON.parse( line );
	} catch ( err ) { // eslint-disable-line no-unused-vars
		return null;
	}
	return ( rec !== null && typeof rec === 'object' && !Array.isArray( rec ) ) ? rec : null;
}

/**
* Terminates a partial last line (a write cut short by a crash, kill or power loss) so that appended records start on
* a fresh line, as the orchestrator does for campaign.jsonl: the bytes already written are never changed (append-only).
* A torn record thus becomes a malformed line that `readJsonl` skips (its arm counts as missing and is evaluated
* again); a complete record that only lacks its newline is kept.
*
* @param {string} file - JSONL file
* @returns {(Object|null)} null if the file is missing, empty or newline-terminated; otherwise `{ line, bytes, kept }`
*   (1-based number of the partial line, its length in bytes, whether it holds a complete JSON record)
*/
function repairTail( file ) {
	var last = Buffer.alloc( 1 );
	var start;
	var size;
	var buf;
	var fd;
	var n;
	var i;
	if ( !fs.existsSync( file ) ) {
		return null;
	}
	size = fs.statSync( file ).size;
	if ( size === 0 ) {
		return null;
	}
	fd = fs.openSync( file, 'r' );
	try {
		fs.readSync( fd, last, 0, 1, size-1 );
	} finally {
		fs.closeSync( fd );
	}
	if ( last[ 0 ] === NEWLINE ) {
		return null;
	}
	buf = fs.readFileSync( file ); // only after an interrupted write
	start = buf.lastIndexOf( NEWLINE ) + 1;
	n = 1;
	for ( i = buf.indexOf( NEWLINE ); i >= 0 && i < start; i = buf.indexOf( NEWLINE, i+1 ) ) {
		n += 1;
	}
	fs.appendFileSync( file, '\n' );
	return {
		'line': n,
		'bytes': buf.length - start,
		'kept': parseRecord( buf.subarray( start ).toString( 'utf8' ) ) !== null
	};
}

/**
* Reads a JSONL file. Blank lines are skipped; so are malformed lines (a record torn by an interrupted write, kept as
* its own line by `repairTail`), whose 1-based numbers are pushed to `bad` so that callers can report them.
*
* @param {string} file - input file
* @param {Array<number>} [bad] - receives the numbers of malformed lines
* @returns {Array<Object>} parsed records (empty if the file does not exist)
*/
function readJsonl( file, bad ) {
	var lines;
	var out;
	var rec;
	var i;
	if ( !fs.existsSync( file ) ) {
		return [];
	}
	lines = fs.readFileSync( file, 'utf8' ).split( '\n' );
	out = [];
	for ( i = 0; i < lines.length; i++ ) {
		if ( lines[ i ].trim() === '' ) {
			continue;
		}
		rec = parseRecord( lines[ i ] );
		if ( rec === null ) {
			if ( bad ) {
				bad.push( i+1 );
			}
			continue;
		}
		out.push( rec );
	}
	return out;
}

/**
* Returns the SHA-256 digest (hex) of the bytes of one or more typed arrays or buffers, in order.
*
* @param {Array<(TypedArray|Buffer)>} arrays - inputs
* @returns {string} hex digest
*/
function sha256Arrays( arrays ) {
	var hash = crypto.createHash( 'sha256' );
	var a;
	var i;
	for ( i = 0; i < arrays.length; i++ ) {
		a = arrays[ i ];
		hash.update( Buffer.from( a.buffer, a.byteOffset, a.byteLength ) );
	}
	return hash.digest( 'hex' );
}

/**
* Returns the SHA-256 digest (hex) of a file.
*
* @param {string} file - file path
* @returns {string} hex digest
*/
function sha256File( file ) {
	return crypto.createHash( 'sha256' ).update( fs.readFileSync( file ) ).digest( 'hex' );
}

/**
* Returns the SHA-256 digest over the package sources (`lib/*.js`, sorted by name, each prefixed by its name).
*
* @returns {string} hex digest
*/
function packageHash() {
	var files = fs.readdirSync( paths.PKG_LIB ).filter( isJS ).sort();
	var hash = crypto.createHash( 'sha256' );
	var i;
	for ( i = 0; i < files.length; i++ ) {
		hash.update( files[ i ] + '\n' );
		hash.update( fs.readFileSync( path.join( paths.PKG_LIB, files[ i ] ) ) );
	}
	return hash.digest( 'hex' );

	function isJS( f ) {
		return /\.js$/.test( f );
	}
}

/**
* Returns the campaign master seed: `research/protocol.json` (`master_seed`) when readable, else the default.
*
* @returns {PositiveInteger} master seed
*/
function protocolMasterSeed() {
	var file = path.join( paths.ROOT, 'research', 'protocol.json' );
	var p;
	try {
		p = JSON.parse( fs.readFileSync( file, 'utf8' ) );
		if ( typeof p.master_seed === 'number' && p.master_seed > 0 ) {
			return p.master_seed;
		}
	} catch ( err ) { // eslint-disable-line no-unused-vars
		// Fall through to the default...
	}
	return DEFAULT_MASTER_SEED;
}


// EXPORTS //

module.exports = {
	'SCHEMA': SCHEMA,
	'DEFAULT_MASTER_SEED': DEFAULT_MASTER_SEED,
	'record': record,
	'appendLine': appendLine,
	'repairTail': repairTail,
	'readJsonl': readJsonl,
	'sha256Arrays': sha256Arrays,
	'sha256File': sha256File,
	'packageHash': packageHash,
	'protocolMasterSeed': protocolMasterSeed
};
