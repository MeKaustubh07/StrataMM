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

# Lints `@stdlib/blas/ext/base/dgemmsw` with stdlib's own ESLint setup, as stdlib CI does, from outside the monorepo.
#
# Usage:
#
#   bash etc/lint.sh
#
# Environment:
#
#   STDLIB   path of a stdlib monorepo checkout with installed dependencies (default: /Users/kaustubh/workspace/stdlib-js/stdlib). The monorepo is only read.
#
# File groups and configurations mirror `.github/workflows/lint_changed_files.yml` (step "Lint JavaScript files"), which runs `make lint-javascript-files` (`eslint --report-unused-disable-directives --config <conf> <file>`):
#
#   lib        every `*.js` outside `examples/`, `test/`, `benchmark/`   $STDLIB/etc/eslint/.eslintrc.js
#   test       `test/**/*.js`                                           $STDLIB/etc/eslint/.eslintrc.tests.js
#   benchmark  `benchmark/**/*.js`                                      $STDLIB/etc/eslint/.eslintrc.benchmarks.js
#   examples   `examples/**/*.js`                                       $STDLIB/etc/eslint/.eslintrc.examples.js
#
# Inside the monorepo, ESLint additionally cascades the root `.eslintrc.js` (`etc/eslint/.eslintrc.overrides.js`). Its per-group overrides set the same rules as the group configurations above, which are passed via `--config` and thus take precedence, so `--no-eslintrc` yields the same effective configuration. `--no-ignore` is required because the package lives under `lib/node_modules/`.
#
# Self-require in `lib/index.js`: `stdlib/jsdoc-main-export` requires the `@module` examples to contain `require( '@stdlib/blas/ext/base/dgemmsw' )`, while `stdlib/jsdoc-doctest` (and `stdlib/doctest` for examples) resolves `@stdlib/*` requires against `$STDLIB/lib/node_modules`, where this package does not exist. Rather than waiving a rule, ESLint runs with the resolver preload `etc/lint/self-alias.js` (`node --require`), which maps this one package (bare name and monorepo path) to this repository's copy, so the examples are executed and checked like in the monorepo. All other requests resolve unchanged.
#
# Exit status: 0 if no group has errors (warnings are reported but, as in stdlib CI, do not fail the run); 1 if any group has errors or ESLint fails to run; 2 on setup errors.

# VARIABLES #

S="${STDLIB:-/Users/kaustubh/workspace/stdlib-js/stdlib}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_REL='lib/node_modules/@stdlib/blas/ext/base/dgemmsw'
PKG="${ROOT}/${PKG_REL}"
ESLINT="${S}/node_modules/.bin/eslint"
PRELOAD="${ROOT}/etc/lint/self-alias.js"
STYLISH="${S}/node_modules/eslint/lib/cli-engine/formatters/stylish.js"
GROUP_NAMES='lib test benchmark examples'


# FUNCTIONS #

# Prints an error message and exits with a setup error.
die() {
	echo "lint.sh: $*" >&2
	exit 2
}

# Prints the ESLint configuration path for a file group.
config_for() {
	case "$1" in
		lib) echo "${S}/etc/eslint/.eslintrc.js" ;;
		test) echo "${S}/etc/eslint/.eslintrc.tests.js" ;;
		benchmark) echo "${S}/etc/eslint/.eslintrc.benchmarks.js" ;;
		examples) echo "${S}/etc/eslint/.eslintrc.examples.js" ;;
		*) die "unknown file group: $1" ;;
	esac
}

# Prints the files of a file group (one per line, sorted).
files_for() {
	case "$1" in
		lib)
			find "${PKG}" -type f -name '*.js' \
				-not -path "${PKG}/examples/*" \
				-not -path "${PKG}/test/*" \
				-not -path "${PKG}/benchmark/*" \
				-not -path "${PKG}/node_modules/*"
			;;
		*)
			if [ -d "${PKG}/$1" ]; then
				find "${PKG}/$1" -type f -name '*.js'
			fi
			;;
	esac | LC_ALL=C sort
}

# Prints a stylish report of ESLint JSON results and writes `<errors> <warnings> <fixable>` to a file.
#
# $1 - JSON results file
# $2 - output file for the counts
report() {
	node - "$1" "$2" "${STYLISH}" "${ROOT}" <<'EOF'
'use strict';
var fs = require( 'fs' );
var path = require( 'path' );
var results = JSON.parse( fs.readFileSync( process.argv[ 2 ], 'utf8' ) );
var errors = 0;
var warnings = 0;
var fixable = 0;
var out = '';
results.forEach( function count( r ) {
	errors += r.errorCount; // includes fatal (parse) errors
	warnings += r.warningCount;
	fixable += r.fixableErrorCount + r.fixableWarningCount;
});
try {
	out = require( process.argv[ 4 ] )( results ); // ESLint's default (stylish) formatter
} catch ( err ) {
	results.forEach( function print( r ) {
		r.messages.forEach( function line( m ) {
			out += path.relative( process.argv[ 5 ], r.filePath ) + ':' + m.line + ':' + m.column + '  ' + ( ( m.severity === 2 ) ? 'error' : 'warning' ) + '  ' + m.message + '  ' + ( m.ruleId || '' ) + '\n';
		});
	});
}
process.stdout.write( out || 'No problems.\n' );
fs.writeFileSync( process.argv[ 3 ], errors + ' ' + warnings + ' ' + fixable + '\n' );
EOF
}


# MAIN #

[ -d "${S}/etc/eslint" ] || die "stdlib monorepo not found at '${S}' (set STDLIB)."
[ -x "${ESLINT}" ] || die "ESLint not found at '${ESLINT}' (install the monorepo's dependencies)."
[ -f "${PRELOAD}" ] || die "resolver preload not found at '${PRELOAD}'."
[ -d "${PKG}" ] || die "package not found at '${PKG}'."
command -v node >/dev/null 2>&1 || die 'node not found.'

TMP="$(mktemp -d "${TMPDIR:-/tmp}/stratamm-lint.XXXXXX")" || die 'unable to create a temporary directory.'
trap 'rm -rf "${TMP}"' EXIT

cd "${ROOT}" || die "unable to change directory to '${ROOT}'."

echo "stdlib monorepo: ${S}"
echo "ESLint: $(node "${ESLINT}" --version)"
echo "Package: ${PKG_REL}"

failed=0
summary=''
for group in ${GROUP_NAMES}; do
	conf="$(config_for "${group}")"
	[ -f "${conf}" ] || die "ESLint configuration not found: '${conf}'."

	# Collect the files (Bash 3.2 compatible: no `mapfile`)...
	files=()
	while IFS= read -r f; do
		files+=( "${f}" )
	done < <(files_for "${group}")
	nfiles="${#files[@]}"

	echo ''
	echo "== ${group}: ${nfiles} file(s), config ${conf#"${S}/"}"
	if [ "${nfiles}" -eq 0 ]; then
		echo 'No files.'
		summary="${summary}$(printf '%-10s skipped (no files)' "${group}")"$'\n'
		continue
	fi
	for f in "${files[@]}"; do
		echo "   ${f#"${PKG}/"}"
	done

	NODE_PATH="${S}/lib/node_modules:${S}/node_modules" STDLIB="${S}" \
		node --require "${PRELOAD}" "${ESLINT}" \
			--no-eslintrc \
			-c "${conf}" \
			--resolve-plugins-relative-to "${S}" \
			--no-ignore \
			--report-unused-disable-directives \
			--format json \
			--output-file "${TMP}/${group}.json" \
			"${files[@]}" \
		2> "${TMP}/${group}.stderr"
	status=$?

	# ESLint exits with 0 (no errors), 1 (lint errors), or 2 (configuration error or crash; no results)...
	if [ "${status}" -gt 1 ] || [ ! -s "${TMP}/${group}.json" ]; then
		cat "${TMP}/${group}.stderr" >&2
		echo "ESLint failed to run (exit status ${status})."
		summary="${summary}$(printf '%-10s ESLINT FAILED (exit status %d)' "${group}" "${status}")"$'\n'
		failed=1
		continue
	fi
	if [ -s "${TMP}/${group}.stderr" ]; then
		cat "${TMP}/${group}.stderr" >&2
	fi
	report "${TMP}/${group}.json" "${TMP}/${group}.counts" || die 'unable to process ESLint results.'
	read -r nerr nwarn nfix < "${TMP}/${group}.counts"
	if [ "${nerr}" -gt 0 ] || [ "${status}" -ne 0 ]; then
		failed=1
	fi
	summary="${summary}$(printf '%-10s %3d file(s) %4d error(s) %4d warning(s)  (%d fixable)' "${group}" "${nfiles}" "${nerr}" "${nwarn}" "${nfix}")"$'\n'
done

echo ''
echo '== Summary'
printf '%s' "${summary}"
if [ "${failed}" -ne 0 ]; then
	echo 'Result: FAIL'
	exit 1
fi
echo 'Result: PASS'
exit 0
