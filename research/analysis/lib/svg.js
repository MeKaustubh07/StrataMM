'use strict';

/**
* Minimal dependency-free SVG charts (small multiples, lines with CI bands or whiskers, markers, bars from a
* baseline, reference lines, legend). Colors follow a validated categorical palette (light and dark steps, selected
* by `prefers-color-scheme`); text uses ink tokens, never series colors; every mark carries a `<title>` tooltip.
*/

var LIGHT = { 'surface': '#fcfcfb', 'ink': '#0b0b0b', 'ink2': '#52514e', 'muted': '#898781', 'grid': '#e1e0d9', 'axis': '#c3c2b7', 's': [ '#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948' ] };
var DARK = { 'surface': '#1a1a19', 'ink': '#f0efec', 'ink2': '#c3c2b7', 'muted': '#898781', 'grid': '#2c2c2a', 'axis': '#383835', 's': [ '#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767' ] };
var FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
var M = { 'l': 56, 'r': 16, 't': 28, 'b': 42 };


/**
* Escapes text for SVG.
*
* @param {*} s - text
* @returns {string} escaped text
*/
function esc( s ) {
	return String( s ).replace( /&/g, '&amp;' ).replace( /</g, '&lt;' ).replace( />/g, '&gt;' ).replace( /"/g, '&quot;' );
}

/**
* Rounds a coordinate.
*
* @private
*/
function r2( v ) {
	return Math.round( v * 100 ) / 100;
}

/**
* Returns the CSS block (palette tokens, dark-mode steps, mark classes).
*
* @private
*/
function css() {
	var vars = function vars( t ) {
		return '--surface:' + t.surface + ';--ink:' + t.ink + ';--ink2:' + t.ink2 + ';--muted:' + t.muted + ';--grid:' + t.grid + ';--axis:' + t.axis + ';' + t.s.map( function f( c, i ) {
			return '--s' + ( i+1 ) + ':' + c;
		}).join( ';' );
	};
	var slots = '.l0{stroke:var(--muted)}.f0{fill:var(--muted)}' + [ 1, 2, 3, 4, 5, 6, 7, 8 ].map( function f( i ) {
		return '.l' + i + '{stroke:var(--s' + i + ')}.f' + i + '{fill:var(--s' + i + ')}';
	}).join( '' );
	return 'svg{' + vars( LIGHT ) + '}@media (prefers-color-scheme: dark){svg{' + vars( DARK ) + '}}' +
		'.bg{fill:var(--surface)}text{font-family:' + FONT + ';fill:var(--ink2);font-size:11px;font-variant-numeric:tabular-nums}' +
		'.title{font-size:14px;font-weight:600;fill:var(--ink)}.sub{font-size:12px}.ptitle{font-size:12px;font-weight:600;fill:var(--ink)}' +
		'.tick{fill:var(--muted);font-size:10px}.note{fill:var(--muted);font-size:10px}.lbl{font-size:10px}' +
		'.grid{stroke:var(--grid);stroke-width:1}.axis{stroke:var(--axis);stroke-width:1}.ref{stroke:var(--muted);stroke-width:1;fill:none}.dash{stroke-dasharray:4 3}' +
		'.line{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}.band{stroke:none;fill-opacity:0.12}.wh{stroke-width:1.5}' +
		'.mk{stroke:var(--surface);stroke-width:2}.open{fill:var(--surface);stroke-width:2}.ink{fill:var(--ink2)}.hit{fill:transparent;stroke:none}' + slots;
}

/**
* Creates a scale.
*
* @param {string} type - `linear`, `log2` or `log10`
* @param {Array<number>} domain - `[min, max]`
* @param {Array<number>} range - pixel range
* @returns {Object} scale with `map(v)` and `ticks()`
*/
function scale( type, domain, range ) {
	var f = ( type === 'log2' ) ? Math.log2 : ( ( type === 'log10' ) ? Math.log10 : function id( v ) {
		return v;
	});
	var d0 = f( domain[ 0 ] );
	var d1 = f( domain[ 1 ] );
	if ( d1 === d0 ) {
		d1 = d0 + 1;
	}
	return {
		'type': type,
		'domain': domain,
		'range': range,
		'map': function map( v ) {
			return range[ 0 ] + ( ( f( v ) - d0 ) / ( d1 - d0 ) * ( range[ 1 ] - range[ 0 ] ) );
		},
		'ticks': function t() {
			return ticks( type, domain );
		}
	};
}

/**
* Returns tick values for a scale type and domain.
*
* @private
*/
function ticks( type, domain ) {
	var out = [];
	var step;
	var lo;
	var hi;
	var e;
	var v;
	if ( type === 'log2' || type === 'log10' ) {
		var base = ( type === 'log2' ) ? 2 : 10; // eslint-disable-line no-var
		lo = Math.ceil( Math.log( domain[ 0 ] ) / Math.log( base ) - 1e-9 );
		hi = Math.floor( Math.log( domain[ 1 ] ) / Math.log( base ) + 1e-9 );
		step = Math.max( 1, Math.ceil( ( hi - lo + 1 ) / 8 ) );
		for ( e = lo; e <= hi; e += step ) {
			out.push( Math.pow( base, e ) );
		}
		if ( out.length < 3 ) {
			return ticks( 'linear', domain ).filter( function f( x ) {
				return x > 0;
			});
		}
		return out;
	}
	step = niceStep( ( domain[ 1 ] - domain[ 0 ] ) / 5 );
	for ( v = Math.ceil( domain[ 0 ] / step ) * step; v <= domain[ 1 ] + ( step*1e-9 ); v += step ) {
		out.push( Number( v.toPrecision( 12 ) ) );
	}
	return out;
}

/**
* Returns a 1-2-5 step not smaller than `raw`.
*
* @private
*/
function niceStep( raw ) {
	var p = Math.pow( 10, Math.floor( Math.log10( raw ) ) );
	var m = raw / p;
	if ( m <= 1 ) {
		return p;
	}
	if ( m <= 2 ) {
		return 2*p;
	}
	return ( m <= 5 ) ? 5*p : 10*p;
}

/**
* Returns a padded domain covering finite values (multiplicative padding for log scales).
*
* @param {Array<number>} values - values
* @param {string} type - scale type
* @param {Array<number>} [include] - values that must be inside the domain
* @returns {Array<number>} `[min, max]`
*/
function domainOf( values, type, include ) {
	var v = values.concat( include || [] ).filter( function f( x ) {
		return Number.isFinite( x ) && ( type === 'linear' || x > 0 );
	});
	var lo;
	var hi;
	var pad;
	if ( v.length === 0 ) {
		return ( type === 'linear' ) ? [ 0, 1 ] : [ 1, 10 ];
	}
	lo = Math.min.apply( null, v );
	hi = Math.max.apply( null, v );
	if ( type === 'linear' ) {
		pad = ( hi - lo ) * 0.08 || Math.abs( hi ) * 0.05 || 1;
		return [ lo - pad, hi + pad ];
	}
	return [ lo / 1.15, hi * 1.15 ];
}

/**
* Formats a tick label.
*
* @private
*/
function tickLabel( v, type ) {
	var e;
	if ( type === 'log10' ) {
		e = Math.round( Math.log10( v ) );
		if ( Math.abs( v - Math.pow( 10, e ) ) < 1e-9 * v ) {
			return '10<tspan dy="-4" font-size="8">' + e + '</tspan>';
		}
	}
	if ( Math.abs( v ) >= 1e4 ) {
		return ( v / 1e3 ).toFixed( 0 ) + 'K';
	}
	return String( Number( v.toPrecision( 4 ) ) );
}

/**
* Returns a marker path for a shape centred at (x, y).
*
* @private
*/
function markerPath( shape, x, y, s ) {
	if ( shape === 'diamond' ) {
		return 'M' + r2( x ) + ',' + r2( y-s-1 ) + 'L' + r2( x+s+1 ) + ',' + r2( y ) + 'L' + r2( x ) + ',' + r2( y+s+1 ) + 'L' + r2( x-s-1 ) + ',' + r2( y ) + 'Z';
	}
	if ( shape === 'down' ) {
		return 'M' + r2( x-s-1 ) + ',' + r2( y-s ) + 'L' + r2( x+s+1 ) + ',' + r2( y-s ) + 'L' + r2( x ) + ',' + r2( y+s+1 ) + 'Z';
	}
	if ( shape === 'square' ) {
		return 'M' + r2( x-s ) + ',' + r2( y-s ) + 'h' + r2( 2*s ) + 'v' + r2( 2*s ) + 'h' + r2( -2*s ) + 'Z';
	}
	return 'M' + r2( x-s ) + ',' + r2( y ) + 'a' + s + ',' + s + ' 0 1,0 ' + r2( 2*s ) + ',0a' + s + ',' + s + ' 0 1,0 ' + r2( -2*s ) + ',0Z';
}

/**
* Draws one marker with a hover target.
*
* @private
*/
function marker( p, slot, x, y ) {
	var cls = ( p.open ) ? 'open l' + slot : 'mk f' + slot;
	var tip = ( p.tip ) ? '<title>' + esc( p.tip ) + '</title>' : '';
	return '<g><path class="' + cls + '" d="' + markerPath( p.shape || 'circle', x, y, 4.5 ) + '"/><circle class="hit" cx="' + r2( x ) + '" cy="' + r2( y ) + '" r="12">' + tip + '</circle></g>';
}

/**
* Draws axes, gridlines and ticks of a panel.
*
* @private
*/
function axes( o, xs, ys, w, h ) {
	var out = '';
	ys.ticks().forEach( function each( v ) {
		var y = ys.map( v );
		out += '<line class="grid" x1="' + M.l + '" x2="' + ( w - M.r ) + '" y1="' + r2( y ) + '" y2="' + r2( y ) + '"/>';
		out += '<text class="tick" x="' + ( M.l - 6 ) + '" y="' + r2( y + 3 ) + '" text-anchor="end">' + tickLabel( v, ys.type ) + '</text>';
	});
	( o.x.ticks || xs.ticks() ).forEach( function each( v ) {
		var x = xs.map( v );
		out += '<line class="axis" x1="' + r2( x ) + '" x2="' + r2( x ) + '" y1="' + ( h - M.b ) + '" y2="' + ( h - M.b + 4 ) + '"/>';
		out += '<text class="tick" x="' + r2( x ) + '" y="' + ( h - M.b + 15 ) + '" text-anchor="middle">' + tickLabel( v, xs.type ) + '</text>';
	});
	out += '<line class="axis" x1="' + M.l + '" x2="' + ( w - M.r ) + '" y1="' + ( h - M.b ) + '" y2="' + ( h - M.b ) + '"/>';
	out += '<text x="' + r2( ( M.l + w - M.r ) / 2 ) + '" y="' + ( h - 8 ) + '" text-anchor="middle">' + esc( o.x.label || '' ) + '</text>';
	out += '<text transform="translate(13,' + r2( ( M.t + h - M.b ) / 2 ) + ') rotate(-90)" text-anchor="middle">' + esc( o.y.label || '' ) + '</text>';
	if ( o.title ) {
		out += '<text class="ptitle" x="' + M.l + '" y="16">' + esc( o.title ) + '</text>';
	}
	return out;
}

/**
* Draws reference lines.
*
* @private
*/
function refs( list, xs, ys, w, h ) {
	var nx = 0;
	return ( list || [] ).map( function each( r ) {
		var cls = 'ref' + ( ( r.dashed ) ? ' dash' : '' );
		var v;
		if ( r.axis === 'x' ) {
			v = xs.map( r.value );
			if ( !( v >= M.l && v <= w - M.r ) ) {
				return '';
			}
			nx += 1;
			return '<line class="' + cls + '" x1="' + r2( v ) + '" x2="' + r2( v ) + '" y1="' + M.t + '" y2="' + ( h - M.b ) + '"/>' + ( ( r.label ) ? '<text class="note" x="' + r2( v + 3 ) + '" y="' + ( M.t + ( 12 * nx ) ) + '">' + esc( r.label ) + '</text>' : '' );
		}
		v = ys.map( r.value );
		if ( !( v >= M.t && v <= h - M.b ) ) {
			return '';
		}
		return '<line class="' + cls + '" x1="' + M.l + '" x2="' + ( w - M.r ) + '" y1="' + r2( v ) + '" y2="' + r2( v ) + '"/>' + ( ( r.label ) ? '<text class="note" x="' + ( w - M.r - 2 ) + '" y="' + r2( ( r.below ) ? v + 11 : v - 3 ) + '" text-anchor="end">' + esc( r.label ) + '</text>' : '' );
	}).join( '' );
}

/**
* Renders an x–y panel.
*
* @param {Object} o - `{ width, height, title, x: {type, domain, label, ticks}, y: {...}, series, refs }`; a series is
*   `{ name, slot, line, band, whisker, endLabel, points: [{ x, y, lo, hi, shape, open, tip }] }`
* @returns {Object} `{ svg, width, height }`
*/
function panel( o ) {
	var w = o.width || 360;
	var h = o.height || 250;
	var xs = scale( o.x.type, o.x.domain, [ M.l, w - M.r ] );
	var ys = scale( o.y.type, o.y.domain, [ h - M.b, M.t ] );
	var ends = [];
	var body = '';
	var out = '<rect class="bg" width="' + w + '" height="' + h + '"/>' + axes( o, xs, ys, w, h ) + refs( o.refs, xs, ys, w, h );

	( o.series || [] ).forEach( function each( s ) {
		var pts = s.points.filter( function f( p ) {
			return Number.isFinite( p.x ) && Number.isFinite( p.y ) && ( o.y.type === 'linear' || p.y > 0 );
		}).sort( function c( a, b ) {
			return a.x - b.x;
		});
		var band = pts.filter( function f( p ) {
			return Number.isFinite( p.lo ) && Number.isFinite( p.hi );
		});
		if ( s.band && band.length > 1 ) {
			body += '<path class="band f' + s.slot + '" d="M' + band.map( function f( p ) {
				return r2( xs.map( p.x ) ) + ',' + r2( ys.map( p.hi ) );
			}).join( 'L' ) + 'L' + band.slice().reverse().map( function f( p ) {
				return r2( xs.map( p.x ) ) + ',' + r2( ys.map( p.lo ) );
			}).join( 'L' ) + 'Z"/>';
		}
		if ( s.whisker ) {
			band.forEach( function f( p ) {
				body += '<line class="wh l' + s.slot + '" x1="' + r2( xs.map( p.x ) ) + '" x2="' + r2( xs.map( p.x ) ) + '" y1="' + r2( ys.map( p.lo ) ) + '" y2="' + r2( ys.map( p.hi ) ) + '"/>';
			});
		}
		if ( s.line && pts.length > 1 ) {
			body += '<path class="line l' + s.slot + ( ( s.dashed ) ? ' dash' : '' ) + '" d="M' + pts.map( function f( p ) {
				return r2( xs.map( p.x ) ) + ',' + r2( ys.map( p.y ) );
			}).join( 'L' ) + '"/>';
		}
		if ( s.markers !== false ) {
			pts.forEach( function f( p ) {
				body += marker( p, s.slot, xs.map( p.x ), ys.map( p.y ) );
			});
		}
		if ( s.endLabel && pts.length ) {
			ends.push( { 'x': xs.map( pts[ pts.length-1 ].x ), 'y': ys.map( pts[ pts.length-1 ].y ), 'text': s.name } );
		}
	});
	out += body;
	if ( ends.length && ends.length <= 4 && !collide( ends ) ) {
		ends.forEach( function each( e ) {
			out += '<text class="lbl" x="' + r2( Math.min( e.x + 7, w - M.r ) ) + '" y="' + r2( e.y - 7 ) + '" text-anchor="end">' + esc( e.text ) + '</text>';
		});
	}
	( o.labels || [] ).forEach( function each( l ) {
		out += '<text class="lbl" x="' + r2( xs.map( l.x ) + 6 ) + '" y="' + r2( ys.map( l.y ) - 6 ) + '">' + esc( l.text ) + '</text>';
	});
	return { 'svg': out, 'width': w, 'height': h };
}

/**
* Returns whether end labels would collide (closer than 12 px vertically).
*
* @private
*/
function collide( ends ) {
	var i;
	var j;
	for ( i = 0; i < ends.length; i++ ) {
		for ( j = i+1; j < ends.length; j++ ) {
			if ( Math.abs( ends[ i ].y - ends[ j ].y ) < 12 ) {
				return true;
			}
		}
	}
	return false;
}

/**
* Renders a grouped bar panel; bars grow from `base` (e.g., ratio 1) with a 4 px rounded data end.
*
* @param {Object} o - `{ width, height, title, categories, groups: [{name, slot}], values: [[{est, lo, hi, tip}]], y, base, refs }`
* @returns {Object} `{ svg, width, height }`
*/
function barPanel( o ) {
	var w = o.width || 360;
	var h = o.height || 250;
	var ys = scale( o.y.type, o.y.domain, [ h - M.b, M.t ] );
	var band = ( w - M.l - M.r ) / o.categories.length;
	var bw = Math.min( 24, ( band - 12 - ( 2 * ( o.groups.length - 1 ) ) ) / o.groups.length );
	var base = ys.map( o.base );
	var out = '<rect class="bg" width="' + w + '" height="' + h + '"/>';
	var xs = { 'map': function m( i ) {
		return M.l + ( ( i + 0.5 ) * band );
	}, 'ticks': function t() {
		return [];
	}, 'type': 'linear' };
	out += axes( { 'x': { 'label': o.x && o.x.label, 'ticks': [] }, 'y': o.y, 'title': o.title }, xs, ys, w, h );
	o.categories.forEach( function each( c, i ) {
		out += '<text class="tick" x="' + r2( xs.map( i ) ) + '" y="' + ( h - M.b + 15 ) + '" text-anchor="middle">' + esc( c ) + '</text>';
	});
	out += '<line class="axis" x1="' + M.l + '" x2="' + ( w - M.r ) + '" y1="' + r2( base ) + '" y2="' + r2( base ) + '"/>';
	o.values.forEach( function each( vals, i ) {
		var x0 = xs.map( i ) - ( ( o.groups.length * bw + ( 2 * ( o.groups.length-1 ) ) ) / 2 );
		vals.forEach( function f( v, j ) {
			var x;
			var y;
			if ( !v || !Number.isFinite( v.est ) ) {
				return;
			}
			x = x0 + ( j * ( bw + 2 ) );
			y = ys.map( v.est );
			out += '<g><path class="f' + o.groups[ j ].slot + '" d="' + barPath( x, base, y, bw ) + '"><title>' + esc( v.tip || '' ) + '</title></path>';
			if ( Number.isFinite( v.lo ) && Number.isFinite( v.hi ) ) {
				out += '<line class="ref" x1="' + r2( x + ( bw/2 ) ) + '" x2="' + r2( x + ( bw/2 ) ) + '" y1="' + r2( ys.map( v.lo ) ) + '" y2="' + r2( ys.map( v.hi ) ) + '" style="stroke:var(--ink2);stroke-width:1.5"/>';
			}
			if ( v.note ) {
				out += '<text class="lbl" x="' + r2( x + ( bw/2 ) ) + '" y="' + r2( Math.min( y, ys.map( v.hi || v.est ) ) - 5 ) + '" text-anchor="middle">' + esc( v.note ) + '</text>';
			}
			out += '</g>';
		});
	});
	out += refs( o.refs, xs, ys, w, h );
	return { 'svg': out, 'width': w, 'height': h };
}

/**
* Returns the path of a bar from `y0` (baseline, square) to `y1` (data end, 4 px rounded).
*
* @private
*/
function barPath( x, y0, y1, bw ) {
	var r = Math.min( 4, bw / 2, Math.abs( y1 - y0 ) );
	var up = y1 < y0;
	var s = ( up ) ? 1 : -1;
	return 'M' + r2( x ) + ',' + r2( y0 ) + 'V' + r2( y1 + ( s*r ) ) + 'Q' + r2( x ) + ',' + r2( y1 ) + ' ' + r2( x + r ) + ',' + r2( y1 ) + 'H' + r2( x + bw - r ) + 'Q' + r2( x + bw ) + ',' + r2( y1 ) + ' ' + r2( x + bw ) + ',' + r2( y1 + ( s*r ) ) + 'V' + r2( y0 ) + 'Z';
}

// EXPORTS //

module.exports = {
	'LIGHT': LIGHT,
	'DARK': DARK,
	'esc': esc,
	'css': css,
	'markerPath': markerPath,
	'scale': scale,
	'domainOf': domainOf,
	'panel': panel,
	'barPanel': barPanel
};
