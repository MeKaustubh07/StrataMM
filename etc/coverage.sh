#!/usr/bin/env bash
#
# @license Apache-2.0
#
# Copyright (c) 2026 The Stdlib Authors.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#    http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Runs every test file of `@stdlib/blas/ext/base/dgemmsw` (`test/test*.js`) in ONE c8 process and requires 100% statement, branch, function, and line coverage of the package's `lib/` files.
#
# Usage:
#
#   bash etc/coverage.sh
#
# Flags (c8 7.14.0, see `node_modules/.bin/c8 --help`):
#
#   --exclude-node-modules=false   the package lives under `lib/node_modules/`, which c8 excludes by default
#   -x ...                         replaces c8's default exclude list (dependencies, tests, benchmarks, examples, docs)
#   --include <pkg>/lib/**         only the package's implementation is measured
#   --all                          files that no test loads are reported with 0% coverage instead of being omitted
#   --100                          shorthand for `--check-coverage --lines 100 --functions 100 --branches 100 --statements 100`
#
# Canary: a coverage gate passes vacuously when nothing is measured (e.g., a wrong `--include` glob or a path the default excludes swallow, such as `node_modules`). After the run, the canary therefore reads `coverage/coverage-summary.json` and fails unless the set of measured files equals the set of `*.js` files under the package's `lib/` directory and `total.lines.total > 0`. The report directory is deleted before each run, so a stale summary can never satisfy the canary.
#
# Exit status: 0 if all tests pass, coverage is 100%, and the canary passes; 1 otherwise; 2 on setup errors.

# VARIABLES #

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_REL='lib/node_modules/@stdlib/blas/ext/base/dgemmsw'
PKG="${ROOT}/${PKG_REL}"
C8="${ROOT}/node_modules/.bin/c8"
TAPE="${ROOT}/node_modules/.bin/tape"
REPORT_DIR='coverage'


# FUNCTIONS #

# Prints an error message and exits with a setup error.
die() {
	echo "coverage.sh: $*" >&2
	exit 2
}


# MAIN #

[ -x "${C8}" ] || die "c8 not found at '${C8}' (run 'npm install')."
[ -x "${TAPE}" ] || die "tape not found at '${TAPE}' (run 'npm install')."
[ -d "${PKG}/lib" ] || die "package not found at '${PKG}'."
cd "${ROOT}" || die "unable to change directory to '${ROOT}'."

ntests=0
for f in "${PKG}"/test/test*.js; do
	[ -f "${f}" ] && ntests=$(( ntests + 1 ))
done
[ "${ntests}" -gt 0 ] || die "no test files match '${PKG_REL}/test/test*.js'."
echo "Running ${ntests} test file(s) in one c8 process: ${PKG_REL}/test/test*.js"

# Remove stale reports, so the canary only ever reads the summary written by this run...
rm -rf "${ROOT:?}/${REPORT_DIR}"

"${C8}" \
	--all \
	--exclude-node-modules=false \
	-x 'node_modules/**' \
	-x '**/test/**' \
	-x '**/benchmark/**' \
	-x '**/examples/**' \
	-x '**/docs/**' \
	--include "${PKG_REL}/lib/**" \
	--check-coverage \
	--100 \
	--reporter text \
	--reporter json-summary \
	--report-dir "${REPORT_DIR}" \
	"${TAPE}" "${PKG_REL}/test/test*.js"
status=$?

echo ''
echo '== Canary'
node - "${ROOT}/${REPORT_DIR}/coverage-summary.json" "${PKG}/lib" <<'EOF'
'use strict';
var fs = require( 'fs' );
var path = require( 'path' );
var summaryPath = process.argv[ 2 ];
var libDir = process.argv[ 3 ];
var problems = [];
var expected;
var measured;
var summary;
var lines;

function real( p ) {
	try {
		return fs.realpathSync( p );
	} catch ( err ) {
		return path.resolve( p );
	}
}

function walk( dir ) {
	var out = [];
	fs.readdirSync( dir ).forEach( function visit( name ) {
		var p = path.join( dir, name );
		if ( fs.statSync( p ).isDirectory() ) {
			out = out.concat( walk( p ) );
		} else if ( /\.js$/.test( name ) ) {
			out.push( real( p ) );
		}
	});
	return out;
}

function difference( a, b ) {
	return a.filter( function has( x ) {
		return b.indexOf( x ) < 0;
	});
}

if ( !fs.existsSync( summaryPath ) ) {
	console.log( 'FAIL: no coverage summary was written (' + summaryPath + ').' );
	process.exit( 1 );
}
summary = JSON.parse( fs.readFileSync( summaryPath, 'utf8' ) );
measured = Object.keys( summary ).filter( function notTotal( k ) {
	return k !== 'total';
}).map( real ).sort();
expected = walk( libDir ).sort();
lines = ( summary.total && summary.total.lines ) ? summary.total.lines.total : 0;

difference( expected, measured ).forEach( function missing( f ) {
	problems.push( 'not measured: ' + path.relative( libDir, f ) );
});
difference( measured, expected ).forEach( function extra( f ) {
	problems.push( 'unexpected measured file: ' + f );
});
if ( !( lines > 0 ) ) {
	problems.push( 'total.lines.total is ' + lines + ' (nothing was measured)' );
}
console.log( 'measured files: ' + measured.length + ', expected lib files: ' + expected.length + ', total lines: ' + lines );
if ( problems.length ) {
	problems.forEach( function print( p ) {
		console.log( 'FAIL: ' + p );
	});
	process.exit( 1 );
}
console.log( 'OK: measured files equal ' + path.relative( process.cwd(), libDir ) + '/**/*.js' );
EOF
canary=$?

echo ''
if [ "${status}" -ne 0 ]; then
	echo "Result: FAIL (c8 exit status ${status}: failing tests and/or coverage below 100%)"
	exit 1
fi
if [ "${canary}" -ne 0 ]; then
	echo 'Result: FAIL (canary)'
	exit 1
fi
echo 'Result: PASS (tests pass, 100% coverage, canary OK)'
exit 0
