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

'use strict';

// MODULES //

var execSync = require( 'child_process' ).execSync;
var crypto = require( 'crypto' );
var path = require( 'path' );
var fs = require( 'fs' );
var os = require( 'os' );


// FUNCTIONS //

/**
* Runs a read-only shell command and returns its trimmed output (or `null` on failure).
*
* @private
* @param {string} cmd - command
* @returns {(string|null)} output
*/
function sh( cmd ) {
	try {
		return execSync( cmd, {
			'encoding': 'utf8',
			'stdio': [ 'ignore', 'pipe', 'ignore' ]
		}).trim();
	} catch ( err ) { // eslint-disable-line no-unused-vars
		return null;
	}
}

/**
* Returns the SHA-256 digest of the concatenated contents of the files in a directory.
*
* @private
* @param {string} dir - directory
* @returns {string} hex digest
*/
function hashDir( dir ) {
	var files;
	var hash;
	var i;

	hash = crypto.createHash( 'sha256' );
	files = fs.readdirSync( dir ).sort();
	for ( i = 0; i < files.length; i++ ) {
		hash.update( files[ i ] );
		hash.update( fs.readFileSync( path.join( dir, files[ i ] ) ) );
	}
	return hash.digest( 'hex' );
}


// MAIN //

/**
* Returns metadata describing the benchmark environment.
*
* @returns {Object} environment metadata
*/
function env() {
	var stdlib = process.env.STDLIB || path.join( os.homedir(), 'workspace', 'stdlib-js', 'stdlib' );
	var cpus = os.cpus();
	return {
		'timestamp': new Date().toISOString(),
		'node': process.versions.node,
		'v8': process.versions.v8,
		'execArgv': process.execArgv,
		'platform': process.platform,
		'arch': process.arch,
		'osRelease': os.release(),
		'macOS': sh( 'sw_vers -productVersion' ),
		'model': sh( 'sysctl -n hw.model' ),
		'cpu': ( cpus.length ) ? cpus[ 0 ].model : null,
		'logicalCPUs': cpus.length,
		'perfCores': sh( 'sysctl -n hw.perflevel0.physicalcpu' ),
		'efficiencyCores': sh( 'sysctl -n hw.perflevel1.physicalcpu' ),
		'totalMemoryBytes': os.totalmem(),
		'powerSource': sh( 'pmset -g batt | head -1' ),
		'lowPowerMode': sh( 'pmset -g | grep -i lowpowermode' ),
		'thermal': sh( 'pmset -g therm' ),
		'loadAverage': os.loadavg(),
		'stdlibCommit': sh( 'git -C "' + stdlib + '" rev-parse HEAD' ),
		'stdlibDgemmSha256': hashDir( path.join( stdlib, 'lib', 'node_modules', '@stdlib', 'blas', 'base', 'dgemm', 'lib' ) ),
		'pocLibSha256': hashDir( path.join( __dirname, '..', 'lib' ) )
	};
}


// EXPORTS //

module.exports = env;
