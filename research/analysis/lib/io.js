'use strict';

/**
* Campaign I/O: reads the append-only `sw-bench/2` JSONL files of one campaign directory and writes derived outputs.
*
* Every parsed record is annotated with its source file name (`_file`) and 1-based line number (`_line`), so that
* derived numbers can cite the raw records they come from (protocol §11, rule 1).
*/

var fs = require( 'fs' );
var path = require( 'path' );
var crypto = require( 'crypto' );

var SCHEMA = 'sw-bench/2';
var REPO_ROOT = path.resolve( __dirname, '..', '..', '..' );


/**
* Reads a JSONL file. Blank lines are skipped; unparsable lines (e.g., a line truncated by an interrupted write) are
* reported in `errors` instead of throwing.
*
* @param {string} file - file path
* @returns {Object} `{ records, errors }`
*/
function readJsonl( file ) {
	var records = [];
	var errors = [];
	var lines;
	var base;
	var rec;
	var s;
	var i;
	if ( !fs.existsSync( file ) ) {
		return { 'records': records, 'errors': errors };
	}
	base = path.basename( file );
	lines = fs.readFileSync( file, 'utf8' ).split( '\n' );
	for ( i = 0; i < lines.length; i++ ) {
		s = lines[ i ].trim();
		if ( s === '' ) {
			continue;
		}
		try {
			rec = JSON.parse( s );
		} catch ( err ) {
			errors.push( { 'file': base, 'line': i+1, 'message': err.message } );
			continue;
		}
		if ( rec === null || typeof rec !== 'object' ) {
			errors.push( { 'file': base, 'line': i+1, 'message': 'not an object' } );
			continue;
		}
		Object.defineProperty( rec, '_file', { 'value': base, 'enumerable': false } );
		Object.defineProperty( rec, '_line', { 'value': i+1, 'enumerable': false } );
		records.push( rec );
	}
	return { 'records': records, 'errors': errors };
}

/**
* Returns the SHA-256 hex digest of a file, or `null` if it does not exist.
*
* @param {string} file - file path
* @returns {(string|null)} digest
*/
function sha256File( file ) {
	if ( !fs.existsSync( file ) ) {
		return null;
	}
	return crypto.createHash( 'sha256' ).update( fs.readFileSync( file ) ).digest( 'hex' );
}

/**
* Reads `frozen.json` (a single JSON object, or JSONL whose last `frozen` record wins).
*
* @private
* @param {string} file - file path
* @returns {(Object|null)} frozen record
*/
function readFrozen( file ) {
	var recs;
	var txt;
	if ( !fs.existsSync( file ) ) {
		return null;
	}
	txt = fs.readFileSync( file, 'utf8' );
	try {
		return JSON.parse( txt );
	} catch ( err ) {
		recs = readJsonl( file ).records.filter( function f( r ) {
			return r.type === 'frozen';
		});
		return ( recs.length ) ? recs[ recs.length-1 ] : null;
	}
}

/**
* Loads one campaign directory (`research/data/<campaign_id>/`).
*
* @param {string} dir - campaign directory
* @returns {Object} campaign data grouped by record type
*/
function loadCampaign( dir ) {
	var schemaWarnings = 0;
	var samples = new Map();
	var errors = [];
	var out;
	var acc;
	var e1;
	var c;
	var i;
	var r;

	dir = path.resolve( dir );
	if ( !fs.existsSync( dir ) ) {
		throw new Error( 'campaign directory not found: ' + dir );
	}
	c = readJsonl( path.join( dir, 'campaign.jsonl' ) );
	acc = readJsonl( path.join( dir, 'accuracy.jsonl' ) );
	e1 = readJsonl( path.join( dir, 'e1.jsonl' ) );
	errors = errors.concat( c.errors, acc.errors, e1.errors );
	out = {
		'dir': dir,
		'id': path.basename( dir ),
		'campaign': null,
		'campaigns': [],
		'frozen': readFrozen( path.join( dir, 'frozen.json' ) ),
		'envChecks': [],
		'procs': [],
		'samples': samples,
		'mems': [],
		'accuracy': acc.records.filter( isType( 'accuracy' ) ),
		'accuracyWarnings': acc.records.filter( isType( 'accuracy_warning' ) ),
		'e1': e1.records.filter( isType( 'e1' ) ),
		'end': null,
		'ends': [],
		'other': [],
		'parseErrors': errors,
		'schemaWarnings': 0,
		'logTail': logTail( [ path.join( dir, 'campaign.log' ), path.join( dir, '..', 'campaign.log' ) ] )
	};
	for ( i = 0; i < c.records.length; i++ ) {
		r = c.records[ i ];
		if ( r.schema !== SCHEMA ) {
			schemaWarnings += 1;
		}
		switch ( r.type ) {
		case 'campaign':
			// One record per run (a resume appends one with `resumed: true`): all are kept (`lib/runs.js`); the first
			// describes the campaign's first run.
			out.campaigns.push( r );
			out.campaign = out.campaign || r;
			break;
		case 'env_check':
			out.envChecks.push( r );
			break;
		case 'frozen':
			out.frozen = out.frozen || r;
			break;
		case 'proc':
			out.procs.push( r );
			break;
		case 'sample':
			if ( !samples.has( r.proc_id ) ) {
				samples.set( r.proc_id, [] );
			}
			samples.get( r.proc_id ).push( r );
			break;
		case 'mem':
			out.mems.push( r );
			break;
		case 'campaign_end':
			// One record per stop; all are kept, `end` is the last one:
			out.ends.push( r );
			out.end = r;
			break;
		default:
			out.other.push( r );
		}
	}
	out.schemaWarnings = schemaWarnings + countSchema( out.accuracy ) + countSchema( out.accuracyWarnings ) + countSchema( out.e1 );
	return out;

	function countSchema( recs ) {
		return recs.filter( function f( x ) {
			return x.schema !== SCHEMA;
		}).length;
	}
}

/**
* Returns the last non-empty line of the first existing log file (the runbook writes `research/data/campaign.log`; the
* schema places it in the campaign directory).
*
* @private
*/
function logTail( files ) {
	var lines;
	var i;
	for ( i = 0; i < files.length; i++ ) {
		if ( fs.existsSync( files[ i ] ) ) {
			lines = fs.readFileSync( files[ i ], 'utf8' ).split( '\n' ).filter( function f( l ) {
				return l.trim() !== '';
			});
			return ( lines.length ) ? { 'file': path.basename( files[ i ] ), 'line': lines[ lines.length-1 ].trim() } : null;
		}
	}
	return null;
}

/**
* Returns a filter predicate for a record type.
*
* @private
* @param {string} t - record type
* @returns {Function} predicate
*/
function isType( t ) {
	return function f( r ) {
		return r.type === t;
	};
}

/**
* Writes a JSON file (pretty-printed), creating parent directories.
*
* @param {string} file - output path
* @param {*} obj - value
*/
function writeJson( file, obj ) {
	fs.mkdirSync( path.dirname( file ), { 'recursive': true } );
	fs.writeFileSync( file, JSON.stringify( obj, null, 1 ) + '\n' );
}

/**
* Writes a text file, creating parent directories.
*
* @param {string} file - output path
* @param {string} text - contents
*/
function writeText( file, text ) {
	fs.mkdirSync( path.dirname( file ), { 'recursive': true } );
	fs.writeFileSync( file, text );
}

/**
* Reads a JSON file.
*
* @param {string} file - file path
* @returns {*} parsed value
*/
function readJson( file ) {
	return JSON.parse( fs.readFileSync( file, 'utf8' ) );
}

/**
* Parses `--key value` / `--flag` command-line arguments; positional arguments go to `_`.
*
* @param {Array<string>} argv - arguments (without node and script)
* @returns {Object} options
*/
function parseArgs( argv ) {
	var out = { '_': [] };
	var key;
	var i;
	for ( i = 0; i < argv.length; i++ ) {
		if ( argv[ i ].slice( 0, 2 ) === '--' ) {
			key = argv[ i ].slice( 2 );
			if ( i+1 < argv.length && argv[ i+1 ].slice( 0, 2 ) !== '--' ) {
				out[ key ] = argv[ i+1 ];
				i += 1;
			} else {
				out[ key ] = true;
			}
		} else {
			out._.push( argv[ i ] );
		}
	}
	return out;
}

/**
* Resolves the campaign directory from CLI options: `--dir <path>` or a campaign id under `research/data/`.
*
* @param {Object} opts - parsed options
* @returns {string} absolute directory
*/
function campaignDir( opts ) {
	if ( opts.dir ) {
		return path.resolve( opts.dir );
	}
	if ( !opts._.length ) {
		throw new Error( 'usage: <campaign_id> | --dir <campaign directory>' );
	}
	return path.join( REPO_ROOT, 'research', 'data', opts._[ 0 ] );
}


// EXPORTS //

module.exports = {
	'SCHEMA': SCHEMA,
	'REPO_ROOT': REPO_ROOT,
	'readJsonl': readJsonl,
	'readJson': readJson,
	'sha256File': sha256File,
	'loadCampaign': loadCampaign,
	'writeJson': writeJson,
	'writeText': writeText,
	'parseArgs': parseArgs,
	'campaignDir': campaignDir
};
