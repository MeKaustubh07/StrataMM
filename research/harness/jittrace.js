'use strict';

/*
* V8 JIT trace parsing for the diagnostics (research-protocol.md §4 "Diagnostics"; used by diagnostics.js).
*
* -   `classify`/`functionNames` read `--trace-opt --trace-deopt --trace-osr` lines; `analyze` splits a traced child's
*     stdout at the start marker, attributes events to samples via the child's `SAMPLE <i>` / `MEASURE_END` lines, and
*     separates element-loop kernel events (fail), kernel inlining into functions compiled after the marker
*     (`--trace-turbo-inlining`, reported) and report-only driver/wrapper events (reported).
*/

// VARIABLES //

var KINDS = [
	[ /^\[marking dependent code/, 'deopt' ],
	[ /^\[marking /, 'optimize' ],
	[ /^\[(compiling method|completed compiling|completed optimizing|optimizing)/, 'compile' ],
	[ /^\[OSR\b/, 'osr' ],
	[ /^\[(bailout|deoptimiz)/, 'deopt' ],
	[ /deoptimiz/i, 'deopt' ]
];
var NAMES = [ /<JSFunction\s+([A-Za-z_$][\w$]*)\s*\(sfi/g, /function:\s*([A-Za-z_$][\w$]*)\s*[,\]]/g, /<SharedFunctionInfo\s+([A-Za-z_$][\w$]*)\s*>/g ]; // eslint-disable-line max-len
var SAMPLE_RE = /^SAMPLE (\d+)$/; // child.js `sample_markers` lines
var INLINE_RE = /^Inlining \S+ \{\S+ <SharedFunctionInfo ([A-Za-z_$][\w$]*)>\} into \S+ \{\S+ <SharedFunctionInfo ([A-Za-z_$][\w$]*)>\}/; // --trace-turbo-inlining
var END_MARKER = 'MEASURE_END';


// FUNCTIONS //

/**
* Classifies a V8 trace line.
*
* @param {string} line - trace line
* @returns {(string|null)} 'compile', 'optimize', 'osr', 'deopt' or null (not a JIT event)
*/
function classify( line ) {
	var i;
	for ( i = 0; i < KINDS.length; i++ ) {
		if ( KINDS[ i ][ 0 ].test( line ) ) {
			return KINDS[ i ][ 1 ];
		}
	}
	return null;
}

/**
* Extracts the function names a trace line mentions (`<JSFunction name (sfi`, `function: name,`, `<SharedFunctionInfo name>`).
*
* @param {string} line - trace line
* @returns {Array<string>} names
*/
function functionNames( line ) {
	var out = [];
	NAMES.forEach( function each( re ) {
		var m;
		re.lastIndex = 0;
		for ( m = re.exec( line ); m; m = re.exec( line ) ) {
			out.push( m[ 1 ] );
		}
	});
	return out;
}

/**
* Splits a trace into `{ text, line }` entries (trimmed text, 1-based line number in the raw trace).
*
* ## Notes
*
* -   The child writes each marker line (`SAMPLE <i>`, the start marker, `MEASURE_END`) with one write, so a marker can only end a raw line. Text before it is a partial V8 trace line (concurrent compile jobs, e.g. `--trace-turbo-inlining`, print in chunks) whose rest is the next raw line: the two are rejoined and placed before the marker.
*
* @param {string} text - stdout
* @param {string} marker - start marker
* @returns {Array<Object>} entries
*/
function traceLines( text, marker ) {
	var raw = text.split( '\n' );
	var tail = new RegExp( '^(.*?)(SAMPLE \\d+|' + marker.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' ) + '|' + END_MARKER + ')\\r?$' );
	var out = [];
	var m;
	var i;
	for ( i = 0; i < raw.length; i++ ) {
		m = tail.exec( raw[ i ] );
		if ( m && m[ 1 ].trim() ) {
			out.push( { 'text': ( m[ 1 ] + ( raw[ i+1 ] || '' ) ).replace( /\r$/, '' ).trim(), 'line': i + 1 } );
			out.push( { 'text': m[ 2 ], 'line': i + 1 } );
			i += 1;
		} else {
			out.push( { 'text': raw[ i ].replace( /\r$/, '' ).trim(), 'line': i + 1 } );
		}
	}
	return out;
}

/**
* Splits a traced child's stdout at the first marker line and lists the JIT events after it.
*
* ## Notes
*
* -   `offending`: events naming an element-loop kernel (`o.functions`) after the marker (these fail a run); `report_only`: events naming only call-only drivers/wrappers (`o.report_only`) after it; `kernel_inlined`: `--trace-turbo-inlining` lines after it that inline an element-loop kernel into another function being compiled (e.g. `blocked` into `dgemm` when the `dgemm` entry point tiers up), i.e. a recompilation of the kernel's loops under the caller's name (reported, `kind: 'inline'`, `into`: the caller). Events before the marker are counted (`before`, `report_before`, `inlined_before`).
* -   Each event after the marker carries `sample`: the index of the latest `SAMPLE <i>` line (0 before the first one; null when the trace has no such lines or after `MEASURE_END`) and `phase` ('measure', or 'after' once `MEASURE_END` was seen).
*
* @param {string} text - stdout
* @param {Object} o - `{ marker, functions, report_only }` (`report_only` optional)
* @returns {Object} `{ marker_found, marker_index, before, report_before, inlined_before, offending, report_only, kernel_inlined, samples_seen, end_found }`
*/
function analyze( text, o ) {
	var lines = traceLines( text, o.marker );
	var report = o.report_only || [];
	var out = { 'marker_found': false, 'marker_index': -1, 'before': 0, 'report_before': 0, 'inlined_before': 0, 'offending': [], 'report_only': [], 'kernel_inlined': [], 'samples_seen': 0, 'end_found': false }; // eslint-disable-line max-len
	var markers = false;
	var cur = 0;
	var idx = lines.map( function get( e ) {
		return e.text;
	}).indexOf( o.marker );
	out.marker_found = ( idx >= 0 );
	out.marker_index = ( idx >= 0 ) ? lines[ idx ].line - 1 : -1;
	markers = ( idx >= 0 ) && lines.slice( idx + 1 ).some( function sample( e ) {
		return SAMPLE_RE.test( e.text );
	});
	lines.forEach( function each( entry, j ) {
		var line = entry.text;
		var kind, names, hit, rep, m; // eslint-disable-line one-var
		if ( idx >= 0 && j > idx ) {
			m = SAMPLE_RE.exec( line );
			if ( m ) {
				cur = Number( m[ 1 ] );
				out.samples_seen += 1;
				return;
			}
			if ( line === END_MARKER ) {
				out.end_found = true;
				return;
			}
		}
		m = INLINE_RE.exec( line );
		if ( m ) {
			if ( o.functions.indexOf( m[ 1 ] ) < 0 ) {
				return;
			}
			if ( idx < 0 || j <= idx ) {
				out.inlined_before += 1;
				return;
			}
			out.kernel_inlined.push( { 'line': entry.line, 'kind': 'inline', 'functions': [ m[ 1 ] ], 'into': m[ 2 ], 'sample': ( markers && !out.end_found ) ? cur : null, 'phase': ( out.end_found ) ? 'after' : 'measure', 'text': line.slice( 0, 200 ) } ); // eslint-disable-line max-len
			return;
		}
		kind = classify( line );
		names = ( kind === null ) ? [] : functionNames( line );
		hit = names.filter( function kernel( n ) {
			return o.functions.indexOf( n ) >= 0;
		});
		rep = names.filter( function driver( n ) {
			return report.indexOf( n ) >= 0 && o.functions.indexOf( n ) < 0;
		});
		if ( !hit.length && !rep.length ) {
			return;
		}
		if ( idx < 0 || j <= idx ) {
			out[ ( hit.length ) ? 'before' : 'report_before' ] += 1;
			return;
		}
		out[ ( hit.length ) ? 'offending' : 'report_only' ].push({
			'line': entry.line,
			'kind': kind,
			'functions': ( hit.length ) ? hit : rep,
			'sample': ( markers && !out.end_found ) ? cur : null,
			'phase': ( out.end_found ) ? 'after' : 'measure',
			'text': line.slice( 0, 200 )
		});
	});
	return out;
}

/**
* Summarizes events: their count, the first sample index, the count after `MEASURE_END`, and the same per function.
*
* @param {Array<Object>} events - events (see `analyze`)
* @returns {Object} `{ count, first_sample, after_end, by_function: { name: { count, first_sample } } }`
*/
function eventSummary( events ) {
	var out = { 'count': events.length, 'first_sample': null, 'after_end': 0, 'by_function': {} };
	function first( a, s ) {
		return ( s === null || ( a !== null && a <= s ) ) ? a : s;
	}
	events.forEach( function each( e ) {
		out.after_end += ( e.phase === 'after' ) ? 1 : 0;
		out.first_sample = first( out.first_sample, e.sample );
		e.functions.forEach( function fn( name ) {
			var s = out.by_function[ name ] || { 'count': 0, 'first_sample': null };
			s.count += 1;
			s.first_sample = first( s.first_sample, e.sample );
			out.by_function[ name ] = s;
		});
	});
	return out;
}


// EXPORTS //

module.exports = {
	'classify': classify,
	'functionNames': functionNames,
	'traceLines': traceLines,
	'analyze': analyze,
	'eventSummary': eventSummary
};
