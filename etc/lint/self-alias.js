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
* Module-resolution preload used by `etc/lint.sh` (loaded via `node --require`).
*
* ## Why
*
* stdlib's doctest lint rules (`stdlib/jsdoc-doctest` for source files and `stdlib/doctest` for examples) evaluate example code and resolve every `@stdlib/*` require against `<stdlib>/lib/node_modules/<name>` of the monorepo hosting the rules. `stdlib/jsdoc-main-export` requires the `@module` JSDoc of `lib/index.js` to contain the canonical self-require `require( '@stdlib/blas/ext/base/dgemmsw' )`. Outside the monorepo, that path does not exist, so the doctest fails with `MODULE_NOT_FOUND` even though the code is correct.
*
* ## What
*
* Requests for this one package (or one of its subpaths) are rewritten to the copy in this repository, both as a bare specifier and as the absolute monorepo path built by the doctest rules. Every other request resolves unchanged, so no other lint result is affected.
*
* ## Environment
*
* -   `STDLIB`: path of the stdlib monorepo (default: `/Users/kaustubh/workspace/stdlib-js/stdlib`), matching `etc/lint.sh`.
* -   `STRATAMM_LINT_ALIAS_DEBUG`: if set, log every rewritten request to `stderr`.
*/

'use strict';

// MODULES //

var Module = require( 'module' );
var path = require( 'path' );
var fs = require( 'fs' );


// VARIABLES //

var PKG_NAME = '@stdlib/blas/ext/base/dgemmsw';
var PKG_DIR = path.resolve( __dirname, '..', '..', 'lib', 'node_modules', PKG_NAME );
var STDLIB = process.env.STDLIB || '/Users/kaustubh/workspace/stdlib-js/stdlib';
var DEBUG = Boolean( process.env.STRATAMM_LINT_ALIAS_DEBUG );
var resolveFilename = Module._resolveFilename;
var PREFIXES;


// FUNCTIONS //

/**
* Returns the list of request prefixes which refer to the package.
*
* @private
* @returns {StringArray} prefixes
*/
function prefixes() {
	var roots;
	var out;
	var i;

	roots = [ path.resolve( STDLIB ) ];
	try {
		roots.push( fs.realpathSync( STDLIB ) );
	} catch ( err ) {
		// The monorepo path does not exist (only the bare specifier and the path as given are mapped)...
	}
	out = [ PKG_NAME ];
	for ( i = 0; i < roots.length; i++ ) {
		out.push( path.join( roots[ i ], 'lib', 'node_modules', PKG_NAME ) );
	}
	return out;
}

/**
* Returns the path which the package root resolves to.
*
* ## Notes
*
* -   When the package has a `package.json`, Node.js honors its `main` field. Otherwise, fall back to `./lib` (the `main` of every stdlib package), such that linting `lib/` does not depend on the presence of `package.json`.
*
* @private
* @returns {string} path
*/
function packageRoot() {
	if ( fs.existsSync( path.join( PKG_DIR, 'package.json' ) ) ) {
		return PKG_DIR;
	}
	return path.join( PKG_DIR, 'lib' );
}

/**
* Rewrites a request for the package to this repository's copy.
*
* @private
* @param {string} request - module request
* @returns {(string|null)} rewritten request or `null`
*/
function rewrite( request ) {
	var p;
	var i;
	if ( typeof request !== 'string' ) {
		return null;
	}
	for ( i = 0; i < PREFIXES.length; i++ ) {
		p = PREFIXES[ i ];
		if ( request === p || request === p + '/' ) {
			return packageRoot();
		}
		if ( request.slice( 0, p.length + 1 ) === p + '/' ) {
			return path.join( PKG_DIR, request.slice( p.length + 1 ) );
		}
	}
	return null;
}

/**
* Resolves a module request, rewriting requests for the package.
*
* @private
* @param {string} request - module request
* @returns {string} resolved filename
*/
function resolve( request ) {
	var args;
	var out;
	var i;

	out = rewrite( request );
	if ( out === null ) {
		return resolveFilename.apply( this, arguments );
	}
	if ( DEBUG ) {
		process.stderr.write( 'self-alias: ' + request + ' -> ' + out + '\n' );
	}
	args = [ out ];
	for ( i = 1; i < arguments.length; i++ ) {
		args.push( arguments[ i ] );
	}
	return resolveFilename.apply( this, args );
}


// MAIN //

PREFIXES = prefixes();
Module._resolveFilename = resolve;
