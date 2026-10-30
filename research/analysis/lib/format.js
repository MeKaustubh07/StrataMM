'use strict';

/**
* Number formatting and Markdown tables for derived outputs and the report.
*/


/**
* Formats a time given in nanoseconds with an adaptive unit.
*
* @param {number} ns - nanoseconds
* @returns {string} formatted time
*/
function time( ns ) {
	var a;
	if ( !Number.isFinite( ns ) ) {
		return '—';
	}
	a = Math.abs( ns );
	if ( a >= 1e9 ) {
		return ( ns/1e9 ).toFixed( 3 ) + ' s';
	}
	if ( a >= 1e6 ) {
		return ( ns/1e6 ).toPrecision( 4 ) + ' ms';
	}
	if ( a >= 1e3 ) {
		return ( ns/1e3 ).toPrecision( 4 ) + ' µs';
	}
	return ns.toFixed( 0 ) + ' ns';
}

/**
* Formats a number with fixed decimals.
*
* @param {number} v - value
* @param {NonNegativeInteger} [d=3] - decimals
* @returns {string} formatted value
*/
function fixed( v, d ) {
	return ( Number.isFinite( v ) ) ? v.toFixed( ( d === void 0 ) ? 3 : d ) : '—';
}

/**
* Formats a number with significant digits, switching to exponent notation outside [1e-3, 1e5).
*
* @param {number} v - value
* @param {PositiveInteger} [s=3] - significant digits
* @returns {string} formatted value
*/
function sig( v, s ) {
	var a;
	s = s || 3;
	if ( v === Infinity ) {
		return '∞';
	}
	if ( !Number.isFinite( v ) ) {
		return '—';
	}
	a = Math.abs( v );
	if ( a === 0 ) {
		return '0';
	}
	if ( a >= 1e5 || a < 1e-3 ) {
		return v.toExponential( s-1 ).replace( 'e+', 'e' );
	}
	return String( Number( v.toPrecision( s ) ) );
}

/**
* Formats a confidence interval.
*
* @param {number} lo - lower bound
* @param {number} hi - upper bound
* @param {NonNegativeInteger} [d=3] - decimals
* @returns {string} formatted interval
*/
function ci( lo, hi, d ) {
	if ( !Number.isFinite( lo ) || !Number.isFinite( hi ) ) {
		return '—';
	}
	return '[' + fixed( lo, d ) + ', ' + fixed( hi, d ) + ']';
}

/**
* Formats a byte count as an integer with thousands separators.
*
* @param {number} v - bytes
* @returns {string} formatted count
*/
function bytes( v ) {
	return ( Number.isFinite( v ) ) ? Math.round( v ).toLocaleString( 'en-US' ) : '—';
}

/**
* Formats a fraction as a percentage.
*
* @param {number} v - fraction
* @param {NonNegativeInteger} [d=2] - decimals
* @returns {string} percentage
*/
function pct( v, d ) {
	return ( Number.isFinite( v ) ) ? ( 100*v ).toFixed( ( d === void 0 ) ? 2 : d ) + '%' : '—';
}

/**
* Formats a count map (`{ name: count }`) compactly.
*
* @param {Object} obj - counts
* @returns {string} e.g. `gc:2 preempt:1`, or `0`
*/
function counts( obj ) {
	var keys = Object.keys( obj || {} ).filter( function f( k ) {
		return obj[ k ];
	}).sort();
	if ( keys.length === 0 ) {
		return '0';
	}
	return keys.map( function f( k ) {
		return k + ':' + obj[ k ];
	}).join( ' ' );
}

/**
* Formats a shape.
*
* @param {number} M - rows
* @param {number} N - columns
* @param {number} K - inner dimension
* @returns {string} `n³` for square shapes, else `M×N×K`
*/
function shape( M, N, K ) {
	if ( M === N && N === K ) {
		return M + '³';
	}
	return M + '×' + N + '×' + K;
}

/**
* Formats a layout (order and transposes).
*
* @param {Object} d - descriptor with `order`, `transA`, `transB`
* @returns {string} e.g. `RM NN`
*/
function layout( d ) {
	var o = ( d.order === 'column-major' ) ? 'CM' : 'RM';
	var t = function t( x ) {
		return ( x === 'transpose' || x === 'conjugate-transpose' ) ? 'T' : 'N';
	};
	return o + ' ' + t( d.transA ) + t( d.transB );
}

/**
* Formats the leading dimension of a square-ish cell relative to n.
*
* @param {Object} d - descriptor with `ld_pad`
* @returns {string} `n` or `n+8`
*/
function ld( d ) {
	return ( d.ld_pad ) ? 'n+' + d.ld_pad : 'n';
}

/**
* Default source renderer (`derived/tables.md`): cell ids, else ids, else `file#Lx,Ly`; excluded records that are kept
* but not used are listed after the used ones.
*
* @param {Array<Object>} list - source descriptors
* @returns {string} reference
*/
function defaultSrc( list ) {
	return ( list || [] ).filter( Boolean ).map( function f( s ) {
		var out = '';
		if ( s.cell ) {
			return s.cell;
		}
		if ( s.ids && s.ids.length ) {
			return s.ids.slice( 0, 3 ).join( ',' ) + ( ( s.ids.length > 3 ) ? '…(' + s.ids.length + ')' : '' );
		}
		if ( s.lines && s.lines.length ) {
			out = s.file + '#L' + s.lines.slice( 0, 4 ).join( ',' ) + ( ( s.lines.length > 4 ) ? '…(' + s.lines.length + ')' : '' );
		}
		if ( s.excluded_lines && s.excluded_lines.length ) {
			out += ( ( out ) ? ' ' : s.file + ' ' ) + '(excluded: L' + s.excluded_lines.slice( 0, 4 ).join( ',' ) + ( ( s.excluded_lines.length > 4 ) ? '…(' + s.excluded_lines.length + ')' : '' ) + ')';
		}
		return out;
	}).join( '; ' );
}

/**
* Returns a table context with a source renderer (`ctx.src(list)`; default `defaultSrc`).
*
* @param {Object} [ctx] - context
* @returns {Object} context
*/
function srcContext( ctx ) {
	return { 'src': ( ctx && ctx.src ) || defaultSrc };
}

/**
* Escapes a Markdown table cell.
*
* @private
*/
function esc( v ) {
	return String( ( v === void 0 || v === null ) ? '' : v ).replace( /\|/g, '\\|' ).replace( /\n/g, ' ' );
}

/**
* Builds a Markdown table.
*
* @param {Array<string>} headers - column headers
* @param {Array<Array>} rows - rows of cell values
* @param {string} [align] - one character per column: `l`, `r` or `c`
* @returns {string} Markdown
*/
function table( headers, rows, align ) {
	var sep = headers.map( function f( h, i ) {
		var a = ( align && align[ i ] ) || 'l';
		if ( a === 'r' ) {
			return '---:';
		}
		if ( a === 'c' ) {
			return ':---:';
		}
		return '---';
	});
	var out = [ '| ' + headers.map( esc ).join( ' | ' ) + ' |', '| ' + sep.join( ' | ' ) + ' |' ];
	rows.forEach( function each( r ) {
		out.push( '| ' + r.map( esc ).join( ' | ' ) + ' |' );
	});
	if ( rows.length === 0 ) {
		out.push( '| ' + headers.map( function f( h, i ) {
			return ( i === 0 ) ? '_no data_' : '';
		}).join( ' | ' ) + ' |' );
	}
	return out.join( '\n' ) + '\n';
}


// EXPORTS //

module.exports = {
	'time': time,
	'fixed': fixed,
	'sig': sig,
	'ci': ci,
	'pct': pct,
	'bytes': bytes,
	'counts': counts,
	'shape': shape,
	'layout': layout,
	'ld': ld,
	'defaultSrc': defaultSrc,
	'srcContext': srcContext,
	'table': table
};
