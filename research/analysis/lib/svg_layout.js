'use strict';

/**
* Figure layout for `svg.js` panels: title, wrapped subtitle, legend row, a grid of panels (rows sized to their
* tallest panel) and wrapped notes.
*/

var svg = require( './svg.js' );

var esc = svg.esc;
var css = svg.css;
var markerPath = svg.markerPath;


/**
* Composes panels into a complete SVG document with a title, subtitle, legend and notes.
*
* @param {Object} o - `{ title, subtitle, desc, legend: [{name, slot, kind}], panels, cols, notes }`
* @returns {string} SVG document
*/
function figure( o ) {
	var cols = o.cols || Math.min( 3, o.panels.length );
	var pw = Math.max.apply( null, o.panels.map( function f( p ) {
		return p.width;
	}) );
	var width = Math.max( cols * pw, 480 );
	var chars = Math.floor( ( width - 32 ) / 6.6 );
	var sub = wrap( o.subtitle || '', chars );
	var notes = [];
	var legend = legendRow( o.legend || [], width );
	var top = 44 + ( 16 * Math.max( sub.length - 1, 0 ) ) + ( ( sub.length ) ? 16 : 0 ) + legend.height;
	var rowTop = [ top ];
	var height;
	var out;
	var i;
	( o.notes || [] ).forEach( function each( n ) {
		notes = notes.concat( wrap( n, Math.floor( ( width - 32 ) / 6 ) ) );
	});
	for ( i = 0; i < o.panels.length; i += cols ) {
		rowTop.push( rowTop[ rowTop.length-1 ] + Math.max.apply( null, o.panels.slice( i, i+cols ).map( function f( p ) {
			return p.height;
		}) ) );
	}
	height = rowTop[ rowTop.length-1 ] + ( notes.length * 14 ) + 10;
	out = '<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="t d" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">';
	out += '<title id="t">' + esc( o.title ) + '</title><desc id="d">' + esc( o.desc || o.subtitle || '' ) + '</desc><style>' + css() + '</style>';
	out += '<rect class="bg" width="' + width + '" height="' + height + '"/>';
	out += '<text class="title" x="16" y="24">' + esc( o.title ) + '</text>';
	sub.forEach( function each( line, j ) {
		out += '<text class="sub" x="16" y="' + ( 42 + ( 16*j ) ) + '">' + esc( line ) + '</text>';
	});
	out += '<g transform="translate(16,' + ( top - legend.height - 2 ) + ')">' + legend.svg + '</g>';
	o.panels.forEach( function each( p, j ) {
		out += '<g transform="translate(' + ( ( j % cols ) * pw ) + ',' + rowTop[ Math.floor( j / cols ) ] + ')">' + p.svg + '</g>';
	});
	notes.forEach( function each( n, j ) {
		out += '<text class="note" x="16" y="' + ( rowTop[ rowTop.length-1 ] + 12 + ( j * 14 ) ) + '">' + esc( n ) + '</text>';
	});
	return out + '</svg>\n';
}

/**
* Wraps text at word boundaries.
*
* @private
*/
function wrap( text, chars ) {
	var lines = [];
	var cur = '';
	String( text ).split( ' ' ).forEach( function each( word ) {
		if ( cur && ( cur.length + 1 + word.length ) > chars ) {
			lines.push( cur );
			cur = word;
		} else {
			cur = ( cur ) ? cur + ' ' + word : word;
		}
	});
	if ( cur ) {
		lines.push( cur );
	}
	return lines;
}

/**
* Renders the legend row (wrapping).
*
* @private
*/
function legendRow( items, width ) {
	var x = 0;
	var y = 12;
	var out = '';
	items.forEach( function each( it ) {
		var tw = 26 + ( 6.6 * String( it.name ).length ) + 14;
		var sw;
		if ( x + tw > width - 32 && x > 0 ) {
			x = 0;
			y += 18;
		}
		if ( it.kind === 'line' || it.kind === 'dashed' ) {
			sw = '<line class="line ' + ( ( it.slot ) ? 'l' + it.slot : 'ref' ) + ( ( it.kind === 'dashed' ) ? ' dash' : '' ) + '" x1="' + x + '" x2="' + ( x + 18 ) + '" y1="' + ( y - 4 ) + '" y2="' + ( y - 4 ) + '"/>';
		} else if ( it.kind === 'bar' ) {
			sw = '<rect class="f' + it.slot + '" x="' + x + '" y="' + ( y - 10 ) + '" width="12" height="12" rx="2"/>';
		} else {
			sw = '<path class="' + ( ( it.open ) ? 'open ' + ( ( it.slot ) ? 'l' + it.slot : '' ) : ( ( it.slot ) ? 'mk f' + it.slot : 'ink' ) ) + '" style="' + ( ( !it.slot && it.open ) ? 'stroke:var(--ink2)' : '' ) + '" d="' + markerPath( it.shape || 'circle', x + 6, y - 4, 4.5 ) + '"/>';
		}
		out += sw + '<text x="' + ( x + 24 ) + '" y="' + y + '">' + esc( it.name ) + '</text>';
		x += tw;
	});
	return { 'svg': out, 'height': ( items.length ) ? y + 8 : 0 };
}



// EXPORTS //

module.exports = {
	'figure': figure,
	'wrap': wrap
};
