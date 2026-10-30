#!/usr/bin/env node

/**
* @license Apache-2.0
*
* Copyright (c) 2026 The Stdlib Authors.
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*    http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

/*
* Mutation runner for `@stdlib/blas/ext/base/dgemmsw`.
*
* Usage: `node etc/mutation/run.js [--only <id>[,<id>...]] [--jobs <n>] [--timeout <ms>] [--keep]`
*
* -   The package directory is first copied to `.mutants/__snapshot__/`, and every later copy is made from this snapshot, so that all mutants run against the same files even while the test suite is being edited.
* -   Every mutant in `etc/mutation/mutants.json` (`{ id, file, find, replace, description[, expectKilledBy] }`, with `file` relative to the package directory) is validated first: `find` must occur exactly once in the original file. Any invalid mutant fails the run before anything is executed.
* -   The test files are the package's `test/test*.js` files that exist at run time (the same set as `npm test` and `etc/coverage.sh`).
* -   Baseline: the unmutated package is copied and tested exactly like a mutant. It must pass, otherwise the run fails (a broken copy or a failing suite would make every mutant look killed). Its duration sets the default per-mutant timeout (`max(60s, 5*baseline + 30s)`).
* -   Per mutant: the package directory is copied to `.mutants/<id>/` (inside the repository, so `@stdlib/*` requires resolve from the repository's `node_modules`; `NODE_PATH` is removed from the environment so that missing dependencies are not hidden), the string replacement is applied literally, and the copied test files are run one tape process per file. The first failing file (a `not ok` assertion, a non-zero exit, or a crash) kills the mutant, and the remaining files are skipped. Exceeding the per-mutant timeout also counts as killed. The copy is then deleted (unless `--keep`).
* -   `expectKilledBy` (optional) names a test file which is expected to kill the mutant. It runs first, and the report notes when it does not exist or does not kill the mutant.
* -   Exit status: `0` if every mutant was killed, `1` if at least one mutant survived, `2` on setup errors (invalid mutant, no test files, failing baseline, I/O error).
*/

'use strict';

// MODULES //

var fs = require( 'fs' );
var os = require( 'os' );
var path = require( 'path' );
var spawn = require( 'child_process' ).spawn;


// VARIABLES //

var ROOT = path.resolve( __dirname, '..', '..' );
var PKG_REL = path.join( 'lib', 'node_modules', '@stdlib', 'blas', 'ext', 'base', 'dgemmsw' );
var PKG = path.join( ROOT, PKG_REL );
var WORK = path.join( ROOT, '.mutants' );
var TAPE = path.join( ROOT, 'node_modules', 'tape', 'bin', 'tape' );
var MUTANTS_FILE = path.join( __dirname, 'mutants.json' );
var BASELINE_ID = '__baseline__';
var SNAPSHOT_ID = '__snapshot__';
var SRC = PKG; // copy source: the live package until the snapshot is taken
var RE_ID = /^[a-z0-9][a-z0-9._-]*$/i;
var RE_TEST = /^test.*\.js$/;
var RE_ERROR = /^\s*[A-Za-z]*Error( \[[A-Z_]+\])?: /;
var RM = {
	'recursive': true,
	'force': true
};
var children = []; // running test processes
var copies = []; // existing package copies
var opts = {
	'only': null,
	'jobs': Math.max( 1, Math.min( 4, os.cpus().length - 1 ) ),
	'timeout': 0,
	'keep': false
};


// FUNCTIONS //

// Prints a message to `stderr`, cleans up, and exits with a setup error.
function fatal( msg ) {
	process.stderr.write( 'mutation: ' + msg + '\n' );
	cleanup();
	process.exit( 2 );
}

// Parses command-line arguments into `opts`.
function parseArgs( argv ) {
	var arg;
	var i;
	for ( i = 0; i < argv.length; i++ ) {
		arg = argv[ i ];
		if ( arg === '--keep' ) {
			opts.keep = true;
		} else if ( arg === '--only' || arg === '--jobs' || arg === '--timeout' ) {
			i += 1;
			opts[ arg.slice( 2 ) ] = ( arg === '--only' ) ? String( argv[ i ] || '' ).split( ',' ).filter( Boolean ) : parseInt( argv[ i ], 10 );
		} else {
			process[ ( arg === '--help' ) ? 'stdout' : 'stderr' ].write( 'Usage: node etc/mutation/run.js [--only <id>[,<id>...]] [--jobs <n>] [--timeout <ms>] [--keep]\n' );
			process.exit( ( arg === '--help' ) ? 0 : 2 );
		}
	}
	if ( !( opts.jobs >= 1 ) || ( opts.timeout !== 0 && !( opts.timeout > 0 ) ) ) {
		fatal( '--jobs must be a positive integer and --timeout a positive number of milliseconds.' );
	}
}

// Counts (possibly overlapping) occurrences of `sub` in `str`.
function occurrences( str, sub ) {
	var n = 0;
	var i = str.indexOf( sub );
	while ( i >= 0 ) {
		n += 1;
		i = str.indexOf( sub, i+1 );
	}
	return n;
}

// Loads the mutant definitions and validates them against the original package files.
function loadMutants() {
	var problems = [];
	var seen = {};
	var mutants;
	var file;
	var m;
	var n;
	var i;

	try {
		mutants = JSON.parse( fs.readFileSync( MUTANTS_FILE, 'utf8' ) );
	} catch ( err ) {
		fatal( 'unable to read ' + MUTANTS_FILE + ': ' + err.message );
	}
	if ( !Array.isArray( mutants ) || mutants.length === 0 ) {
		fatal( MUTANTS_FILE + ' must contain a non-empty array.' );
	}
	for ( i = 0; i < mutants.length; i++ ) {
		m = mutants[ i ];
		if ( typeof m !== 'object' || m === null || typeof m.id !== 'string' || !RE_ID.test( m.id ) ) {
			problems.push( 'entry ' + i + ': not an object with a valid `id`' );
			continue;
		}
		if ( seen[ m.id ] || typeof m.description !== 'string' || !m.description || ( m.expectKilledBy !== void 0 && !RE_TEST.test( String( m.expectKilledBy ) ) ) ) {
			problems.push( m.id + ': duplicate id, missing description, or `expectKilledBy` not naming a test*.js file' );
		}
		seen[ m.id ] = true;
		if ( typeof m.find !== 'string' || m.find.length === 0 || typeof m.replace !== 'string' || m.find === m.replace ) {
			problems.push( m.id + ': `find` must be a non-empty string and `replace` a different string' );
			continue;
		}
		file = ( typeof m.file === 'string' ) ? path.resolve( SRC, m.file ) : '';
		if ( !file || file.indexOf( SRC + path.sep ) !== 0 || !fs.existsSync( file ) ) {
			problems.push( m.id + ': `file` must name an existing file inside the package (' + m.file + ')' );
			continue;
		}
		n = occurrences( fs.readFileSync( file, 'utf8' ), m.find );
		if ( n !== 1 ) {
			problems.push( m.id + ': `find` occurs ' + n + ' times in ' + m.file + ' (expected exactly once)' );
		}
	}
	if ( problems.length ) {
		fatal( 'invalid mutants:\n  ' + problems.join( '\n  ' ) );
	}
	return mutants;
}

// Returns the sorted names of the package's `test/test*.js` files.
function testFiles() {
	var dir = path.join( SRC, 'test' );
	return ( !fs.existsSync( dir ) ) ? [] : fs.readdirSync( dir ).filter( function isTest( name ) {
		return RE_TEST.test( name ) && fs.statSync( path.join( dir, name ) ).isFile();
	}).sort();
}

// Copies the package to `.mutants/<id>/` and applies the mutation (if any); returns the copy's path.
function prepare( id, mutant ) {
	var dir = path.join( WORK, id );
	var file;
	var src;
	var i;

	fs.rmSync( dir, RM );
	copies.push( dir );
	fs.cpSync( SRC, dir, {
		'recursive': true,
		'filter': function filter( p ) {
			return p === SRC || path.basename( p ) !== 'node_modules';
		}
	});
	if ( mutant ) {
		file = path.join( dir, mutant.file );
		src = fs.readFileSync( file, 'utf8' );
		if ( occurrences( src, mutant.find ) !== 1 ) {
			throw new Error( '`find` no longer occurs exactly once in the copied ' + mutant.file );
		}
		i = src.indexOf( mutant.find );

		// NOTE: avoid `String#replace`, which interprets `$` patterns in the replacement...
		fs.writeFileSync( file, src.slice( 0, i ) + mutant.replace + src.slice( i+mutant.find.length ) );
	}
	return dir;
}

// Runs one test file in a tape process (bailing out at the first `not ok`); calls `clbk( { status: 'pass'|'fail'|'timeout', detail } )`.
function runFile( dir, name, deadline, clbk ) {
	var finished = false;
	var testName = '';
	var stderr = '';
	var detail = '';
	var buf = '';
	var timer;
	var child;
	var env;

	env = Object.assign( {}, process.env );
	delete env.NODE_PATH;
	delete env.NODE_V8_COVERAGE;
	child = spawn( process.execPath, [ TAPE, path.join( dir, 'test', name ) ], {
		'cwd': dir,
		'env': env,
		'stdio': [ 'ignore', 'pipe', 'pipe' ]
	});
	children.push( child );
	timer = setTimeout( finish, Math.max( 1, deadline - Date.now() ), 'timeout', 'exceeded the per-mutant timeout' );
	child.on( 'error', function onError( err ) {
		finish( 'fail', 'unable to spawn tape: ' + err.message );
	});
	child.stderr.on( 'data', function onStderr( chunk ) {
		if ( stderr.length < 65536 ) {
			stderr += chunk.toString();
		}
	});
	child.stdout.on( 'data', function onStdout( chunk ) {
		var lines;
		var i;
		buf += chunk.toString();
		lines = buf.split( '\n' );
		buf = lines.pop();
		for ( i = 0; i < lines.length && !detail; i++ ) {
			if ( lines[ i ].slice( 0, 2 ) === '# ' ) {
				testName = lines[ i ].slice( 2 );
			} else if ( /^not ok \d+/.test( lines[ i ] ) ) {
				detail = ( testName ) ? testName + ' :: ' + lines[ i ] : lines[ i ];
				child.kill( 'SIGKILL' ); // bail out at the first failing assertion
			}
		}
	});
	child.on( 'close', function onClose( code, signal ) {
		var lines;
		var line;
		if ( detail ) {
			return finish( 'fail', detail );
		}
		if ( code !== 0 ) {
			// Prefer the error message (e.g., `RangeError: invalid argument...`) over the source line which threw...
			lines = stderr.split( '\n' );
			line = lines.filter( RE_ERROR.test.bind( RE_ERROR ) )[ 0 ] || lines.filter( function isError( s ) {
				return /Error/.test( s );
			})[ 0 ] || stderr.trim().split( '\n' ).pop() || '';
			return finish( 'fail', ( ( signal ) ? 'signal ' + signal : 'exit status ' + code ) + ' (crash)' + ( ( line ) ? ': ' + line.trim() : '' ) );
		}
		finish( 'pass', '' );
	});

	function finish( status, msg ) {
		if ( finished ) {
			return;
		}
		finished = true;
		clearTimeout( timer );

		// Kill the process before invoking the callback, as the callback chain may end in `process.exit()` (which would orphan a running process)...
		if ( child.exitCode === null && child.signalCode === null ) {
			child.kill( 'SIGKILL' );
		}
		if ( children.indexOf( child ) >= 0 ) {
			children.splice( children.indexOf( child ), 1 );
		}
		clbk({
			'status': status,
			'detail': msg
		});
	}
}

// Runs one mutant (or the baseline if `mutant` is `null`): test files run sequentially until one fails; calls `clbk( { id, status: 'killed'|'timeout'|'survived', by, detail, ms, note } )`.
function runMutant( mutant, files, timeout, clbk ) {
	var expected = ( mutant ) ? mutant.expectKilledBy : void 0;
	var ordered = files.slice();
	var start = Date.now();
	var deadline = start + timeout;
	var dir;
	var i;

	try {
		dir = prepare( ( mutant ) ? mutant.id : BASELINE_ID, mutant );
	} catch ( err ) {
		fatal( 'unable to prepare ' + ( ( mutant ) ? mutant.id : 'the baseline' ) + ': ' + err.message );
	}
	if ( expected && ordered.indexOf( expected ) >= 0 ) {
		ordered.splice( ordered.indexOf( expected ), 1 );
		ordered.unshift( expected );
	}
	i = 0;
	next();

	function next() {
		if ( i >= ordered.length ) {
			return done( 'survived', '', '' );
		}
		runFile( dir, ordered[ i ], deadline, function onFile( res ) {
			if ( res.status === 'pass' ) {
				i += 1;
				return next();
			}
			done( ( res.status === 'timeout' ) ? 'timeout' : 'killed', ordered[ i ], res.detail );
		});
	}

	function done( status, by, detail ) {
		var note = '';
		if ( expected && files.indexOf( expected ) < 0 ) {
			note = 'expected killer ' + expected + ' does not exist';
		} else if ( expected && by !== expected ) {
			note = 'expected killer ' + expected + ' did not kill it';
		}
		if ( !opts.keep ) {
			fs.rmSync( dir, RM );
			if ( copies.indexOf( dir ) >= 0 ) {
				copies.splice( copies.indexOf( dir ), 1 );
			}
		}
		clbk({
			'id': ( mutant ) ? mutant.id : BASELINE_ID,
			'status': status,
			'by': by,
			'detail': detail,
			'ms': Date.now() - start,
			'note': note
		});
	}
}

// Runs `worker( item, done )` over `items` with at most `jobs` concurrent tasks; calls `clbk( results )` (in item order).
function pool( items, jobs, worker, clbk ) {
	var results = [];
	var finished = 0;
	var next = 0;

	if ( items.length === 0 ) {
		return clbk( results );
	}
	while ( next < items.length && next < jobs ) {
		launch( next );
		next += 1;
	}

	function launch( idx ) {
		worker( items[ idx ], function done( res ) {
			results[ idx ] = res;
			finished += 1;
			if ( finished === items.length ) {
				return clbk( results );
			}
			if ( next < items.length ) {
				launch( next );
				next += 1;
			}
		});
	}
}

// Kills running test processes and removes package copies and the (then empty) work directory, unless `--keep`.
function cleanup() {
	children.forEach( function kill( child ) {
		child.kill( 'SIGKILL' );
	});
	if ( opts.keep ) {
		return;
	}
	copies.forEach( function rm( dir ) {
		fs.rmSync( dir, RM );
	});
	if ( fs.existsSync( WORK ) && fs.readdirSync( WORK ).length === 0 ) {
		fs.rmdirSync( WORK );
	}
}

// Formats a duration in seconds.
function seconds( ms ) {
	return ( ms/1000 ).toFixed( 1 ) + 's';
}

// Escapes a Markdown table cell.
function cell( str ) {
	return String( str ).replace( /\|/g, '\\|' ).replace( /\n/g, ' ' );
}

// Prints the report table and summary, and sets the exit code.
function report( mutants, results ) {
	var survived = [];
	var details = '';
	var timeouts = 0;
	var notes = [];
	var out = '';
	var r;
	var i;

	out += '\n| # | Mutant | File | Status | Killed by | Description |\n|---|--------|------|--------|-----------|-------------|\n';
	for ( i = 0; i < mutants.length; i++ ) {
		r = results[ i ];
		if ( r.status === 'survived' ) {
			survived.push( r.id );
		} else {
			timeouts += ( r.status === 'timeout' ) ? 1 : 0;
			details += '  ' + r.id + ' [' + r.by + ', ' + seconds( r.ms ) + ']: ' + r.detail + '\n';
		}
		if ( r.note ) {
			notes.push( r.id + ': ' + r.note );
		}
		out += '| ' + ( i+1 ) + ' | ' + cell( r.id ) + ' | ' + cell( mutants[ i ].file ) + ' | ' + ( ( r.status === 'survived' ) ? '**SURVIVED**' : r.status ) + ' | ' + cell( r.by || '-' ) + ' | ' + cell( mutants[ i ].description ) + ' |\n';
	}
	out += '\nKilled-by details (first failing assertion or error):\n' + details;
	if ( notes.length ) {
		out += '\nNotes:\n  ' + notes.join( '\n  ' ) + '\n';
	}
	out += '\nMutants: ' + mutants.length + ', killed: ' + ( mutants.length-survived.length ) + ' (timeouts: ' + timeouts + '), survived: ' + survived.length + ', mutation score: ' + ( 100*( mutants.length-survived.length )/mutants.length ).toFixed( 1 ) + '%\n';
	if ( survived.length ) {
		out += 'Survivors: ' + survived.join( ', ' ) + '\nResult: FAIL\n';
	} else {
		out += 'Result: PASS\n';
	}
	cleanup();
	process.stdout.write( out );

	// NOTE: set the exit code instead of calling `process.exit()`, so that output written to a pipe is flushed (no child processes or timers remain at this point)...
	process.exitCode = ( survived.length ) ? 1 : 0;
}


// MAIN //

function main() {
	var mutants;
	var files;

	parseArgs( process.argv.slice( 2 ) );
	process.on( 'SIGINT', onSignal );
	process.on( 'SIGTERM', onSignal );
	if ( !fs.existsSync( TAPE ) || !fs.existsSync( PKG ) ) {
		fatal( 'tape (' + TAPE + ') or the package (' + PKG + ') not found.' );
	}
	fs.mkdirSync( WORK, {
		'recursive': true
	});
	SRC = prepare( SNAPSHOT_ID, null ); // freeze the package: all copies and validations use this snapshot
	mutants = loadMutants();
	if ( opts.only ) {
		mutants = mutants.filter( function selected( m ) {
			return opts.only.indexOf( m.id ) >= 0;
		});
		if ( mutants.length !== opts.only.length ) {
			fatal( '--only names unknown mutant ids.' );
		}
	}
	files = testFiles();
	if ( files.length === 0 ) {
		fatal( 'no test files match ' + path.join( PKG_REL, 'test', 'test*.js' ) + '.' );
	}
	process.stdout.write( 'Package: ' + PKG_REL + '\nTest files (' + files.length + '): ' + files.join( ', ' ) + '\nRunning baseline (unmutated copy)...\n' );
	runMutant( null, files, opts.timeout || 600000, onBaseline );

	function onBaseline( res ) {
		var timeout;
		if ( res.status !== 'survived' ) {
			fatal( ( res.status === 'timeout' ) ? 'baseline exceeded the timeout in ' + res.by + ' (increase --timeout).' : 'baseline failed in ' + res.by + ' (' + res.detail + '); the unmutated suite must pass before mutants are run.' );
		}
		timeout = opts.timeout || Math.max( 60000, ( 5*res.ms ) + 30000 );
		process.stdout.write( 'Baseline passed in ' + seconds( res.ms ) + '. Mutants: ' + mutants.length + ', jobs: ' + opts.jobs + ', timeout per mutant: ' + seconds( timeout ) + '\n\n' );
		pool( mutants, opts.jobs, function worker( m, done ) {
			runMutant( m, files, timeout, function onResult( r ) {
				process.stdout.write( '  ' + ( ( r.status === 'survived' ) ? 'SURVIVED' : r.status ) + '  ' + r.id + ( ( r.by ) ? '  (' + r.by + ')' : '' ) + '  ' + seconds( r.ms ) + '\n' );
				done( r );
			});
		}, function onResults( results ) {
			report( mutants, results );
		});
	}

	function onSignal() {
		process.stderr.write( '\nmutation: interrupted; cleaning up.\n' );
		cleanup();
		process.exit( 130 );
	}
}

main();
