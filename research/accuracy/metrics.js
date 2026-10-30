'use strict';

// Accuracy metrics (research protocol §8) for a computed product Ĉ against a double-double reference (hi, lo):
// E_ij = |(Ĉ_ij - hi_ij) - lo_ij|, normalized normwise, componentwise, relative to ‖C‖, Frobenius and per entry.

// MODULES //

var U = require( './eft.js' ).U;


// VARIABLES //

var NWORST = 20;
var HIST_BINS = 64;
var HIST_REL = { 'lo': -120, 'width': 3 }; // log2(E/|C|) in [-120, 72)
var HIST_C = { 'lo': -64, 'width': 3 };    // log2(E/(u(|A||B|)_ij)) in [-64, 128)


// FUNCTIONS //

/**
* Winograd-variant normwise bound constant f_W = 18^L (k0^2 + 5.5625 k0) - 5.5625 K with k0 = K/2^L (f_W(K,0) = K^2).
*
* @param {number} K - inner dimension
* @param {NonNegativeInteger} L - recursion levels
* @returns {number} bound constant
*/
function fW( K, L ) {
	var k0 = K / Math.pow( 2.0, L );
	return ( Math.pow( 18.0, L ) * ( ( k0*k0 ) + ( 5.5625*k0 ) ) ) - ( 5.5625*K );
}

/**
* Strassen (18-addition) normwise bound constant f_S = 12^L (k0^2 + 5 k0) - 5 K (Higham 1990; f_S(K,0) = K^2).
*
* @param {number} K - inner dimension
* @param {NonNegativeInteger} L - recursion levels
* @returns {number} bound constant
*/
function fS( K, L ) {
	var k0 = K / Math.pow( 2.0, L );
	return ( Math.pow( 12.0, L ) * ( ( k0*k0 ) + ( 5.0*k0 ) ) ) - ( 5.0*K );
}

/**
* Returns the k-th smallest element (0-based) of `x[0..n)` by in-place quickselect (median-of-three Hoare scheme).
*
* @param {Float64Array} x - data (reordered)
* @param {NonNegativeInteger} n - number of elements
* @param {NonNegativeInteger} k - rank
* @returns {number} order statistic
*/
function select( x, n, k ) {
	var lo = 0;
	var hi = n - 1;
	var piv;
	var mid;
	var t;
	var i;
	var j;
	while ( hi > lo ) {
		mid = ( lo + hi ) >>> 1;
		if ( x[ mid ] < x[ lo ] ) {
			t = x[ mid ]; x[ mid ] = x[ lo ]; x[ lo ] = t;
		}
		if ( x[ hi ] < x[ lo ] ) {
			t = x[ hi ]; x[ hi ] = x[ lo ]; x[ lo ] = t;
		}
		if ( x[ hi ] < x[ mid ] ) {
			t = x[ hi ]; x[ hi ] = x[ mid ]; x[ mid ] = t;
		}
		piv = x[ mid ];
		i = lo;
		j = hi;
		while ( i <= j ) {
			while ( x[ i ] < piv ) {
				i += 1;
			}
			while ( x[ j ] > piv ) {
				j -= 1;
			}
			if ( i <= j ) {
				t = x[ i ]; x[ i ] = x[ j ]; x[ j ] = t;
				i += 1;
				j -= 1;
			}
		}
		if ( k <= j ) {
			hi = j;
		} else if ( k >= i ) {
			lo = i;
		} else {
			return x[ k ];
		}
	}
	return x[ k ];
}

/**
* Returns the nearest-rank p-quantile (rank ceil(p·n)) of `x[0..n)`, or null if n = 0. Reorders `x`.
*
* @param {Float64Array} x - data
* @param {NonNegativeInteger} n - number of elements
* @param {number} p - probability in (0, 1]
* @returns {(number|null)} quantile
*/
function quantile( x, n, p ) {
	if ( n === 0 ) {
		return null;
	}
	return select( x, n, Math.max( 0, Math.ceil( p*n ) - 1 ) );
}

/**
* Creates a log2 histogram accumulator.
*
* @private
* @param {Object} spec - `{ lo, width }`
* @returns {Object} histogram
*/
function histogram( spec ) {
	return {
		'log2_lo': spec.lo,
		'bin_width': spec.width,
		'counts': new Array( HIST_BINS ).fill( 0 ),
		'zero': 0,
		'under': 0,
		'over': 0,
		'inf': 0
	};
}

/**
* Adds a nonnegative value to a log2 histogram.
*
* @private
* @param {Object} h - histogram
* @param {number} v - value
*/
function hadd( h, v ) {
	var b;
	if ( v === 0.0 ) {
		h.zero += 1;
		return;
	}
	if ( v === Infinity ) {
		h.inf += 1;
		return;
	}
	b = Math.floor( ( Math.log2( v ) - h.log2_lo ) / h.bin_width );
	if ( b < 0 ) {
		h.under += 1;
	} else if ( b >= HIST_BINS ) {
		h.over += 1;
	} else {
		h.counts[ b ] += 1;
	}
}

/**
* Creates reusable scratch storage for `compute` (avoids reallocating per arm).
*
* @param {NonNegativeInteger} len - number of matrix entries (M·N)
* @returns {Object} workspace
*/
function workspace( len ) {
	return {
		'c': new Float64Array( len ),
		'r': new Float64Array( len )
	};
}

/**
* Computes all accuracy metrics of a computed product.
*
* @param {Object} o - inputs
* @param {NonNegativeInteger} o.M - rows
* @param {NonNegativeInteger} o.N - columns
* @param {number} o.K - inner dimension
* @param {NonNegativeInteger} o.L - recursion levels actually performed (0 for classic)
* @param {Float64Array} o.C - computed product (row-major)
* @param {Float64Array} o.hi - reference high parts
* @param {Float64Array} o.lo - reference low parts
* @param {Float64Array} o.AB - |A||B| (plain double)
* @param {number} o.maxA - ‖A‖_M
* @param {number} o.maxB - ‖B‖_M
* @param {boolean} [o.kappa=false] - whether to compute κ-binned relative errors (F9)
* @param {Object} [ws] - workspace from `workspace( M*N )`
* @returns {Object} `{ metrics, worst, argmax, worstIdx }`
*/
function compute( o, ws ) {
	var nonfinite = 0;
	var abZeroErr = 0;
	var hrel = histogram( HIST_REL );
	var hc = histogram( HIST_C );
	var wv = new Float64Array( NWORST ).fill( -1.0 );
	var wi = new Int32Array( NWORST ).fill( -1 );
	var wmin = 0;
	var kb = {};
	var nczero = 0;
	var ninf = 0;
	var nge1 = 0;
	var nge8 = 0;
	var maxE = 0.0;
	var argN = -1;
	var maxR = 0.0;
	var argR = -1;
	var maxC = 0.0;
	var maxAB = 0.0;
	var maxCt = 0.0;
	var sE = 0.0;
	var qE = 1.0;
	var sA = 0.0;
	var qA = 1.0;
	var len = o.M * o.N;
	var nc = 0;
	var nr = 0;
	var exactAll = true;
	var ab;
	var hc0;
	var x;
	var e;
	var c;
	var r;
	var d;
	var i;
	var j;

	ws = ws || workspace( len );
	for ( i = 0; i < len; i++ ) {
		x = o.C[ i ];
		if ( !isFinite( x ) ) {
			nonfinite += 1;
			exactAll = false;
			continue;
		}
		e = Math.abs( ( x - o.hi[ i ] ) - o.lo[ i ] );
		ab = o.AB[ i ];
		hc0 = Math.abs( o.hi[ i ] );
		if ( e !== 0.0 || x !== o.hi[ i ] ) {
			exactAll = false;
		}
		if ( e > maxE ) {
			maxE = e;
			argN = i;
		}
		if ( hc0 > maxCt ) {
			maxCt = hc0;
		}
		if ( ab > maxAB ) {
			maxAB = ab;
		}
		// Scaled sums of squares (dlassq-style) for the Frobenius norms...
		if ( e > 0.0 ) {
			if ( sE < e ) {
				qE = 1.0 + ( qE * ( sE/e ) * ( sE/e ) );
				sE = e;
			} else {
				qE += ( e/sE ) * ( e/sE );
			}
		}
		if ( ab > 0.0 ) {
			if ( sA < ab ) {
				qA = 1.0 + ( qA * ( sA/ab ) * ( sA/ab ) );
				sA = ab;
			} else {
				qA += ( ab/sA ) * ( ab/sA );
			}
			// Componentwise ratio E/(u(|A||B|)_ij)...
			c = e / ( U*ab );
			ws.c[ nc ] = c;
			nc += 1;
			hadd( hc, c );
			if ( c > maxC ) {
				maxC = c;
			}
			if ( c > wv[ wmin ] ) {
				wv[ wmin ] = c;
				wi[ wmin ] = i;
				wmin = 0;
				for ( j = 1; j < NWORST; j++ ) {
					if ( wv[ j ] < wv[ wmin ] ) {
						wmin = j;
					}
				}
			}
		} else if ( e > 0.0 ) {
			abZeroErr += 1;
		}
		// Per-entry relative error E/|C| (C = hi + lo; hi = fl(C) is zero iff C is zero)...
		if ( hc0 === 0.0 ) {
			nczero += 1;
			if ( e > 0.0 ) {
				ninf += 1;
				nge1 += 1;
				nge8 += 1;
				hadd( hrel, Infinity );
			} else {
				hadd( hrel, 0.0 );
			}
			r = ( e > 0.0 ) ? Infinity : 0.0;
		} else {
			r = e / hc0;
			ws.r[ nr ] = r;
			nr += 1;
			hadd( hrel, r );
			if ( r >= 1.0 ) {
				nge1 += 1;
			}
			if ( r >= 1e-8 ) {
				nge8 += 1;
			}
			if ( r > maxR ) {
				maxR = r;
				argR = i;
			}
		}
		if ( o.kappa ) {
			kbin( kb, ab, hc0, r );
		}
	}
	return finish();

	function finish() {
		var worst = [];
		var idx = [];
		var met;
		var fw;
		for ( j = 0; j < NWORST; j++ ) {
			if ( wi[ j ] >= 0 ) {
				idx.push( j );
			}
		}
		idx.sort( function cmp( a, b ) {
			return ( wv[ b ] - wv[ a ] ) || ( wi[ a ] - wi[ b ] );
		});
		for ( j = 0; j < idx.length; j++ ) {
			d = wi[ idx[ j ] ];
			e = Math.abs( ( o.C[ d ] - o.hi[ d ] ) - o.lo[ d ] );
			worst.push({
				'i': Math.floor( d / o.N ),
				'j': d % o.N,
				'E': e,
				'C': o.hi[ d ] + o.lo[ d ],
				'AB': o.AB[ d ],
				'eta_c': wv[ idx[ j ] ],
				'rel': ( o.hi[ d ] === 0.0 ) ? null : e / Math.abs( o.hi[ d ] )
			});
		}
		fw = fW( o.K, o.L );
		met = {
			'eta_N': maxE / ( U * o.maxA * o.maxB ),
			'f_W': fw,
			'rho_N': ( maxE / ( U * o.maxA * o.maxB ) ) / fw,
			'eta_C': {
				'max': maxC,
				'p999': quantile( ws.c, nc, 0.999 ),
				'median': quantile( ws.c, nc, 0.5 )
			},
			'eta_R': ( maxCt > 0.0 ) ? maxE / ( U * maxCt ) : null,
			'eta_F': ( sA > 0.0 ) ? ( sE * Math.sqrt( qE ) ) / ( U * sA * Math.sqrt( qA ) ) : null,
			'eta_M': ( maxAB > 0.0 ) ? maxE / ( U * maxAB ) : null,
			'rel': {
				'frac_ge1': nge1 / len,
				'frac_ge1e8': nge8 / len,
				'max': maxR,
				'p999': quantile( ws.r, nr, 0.999 ),
				'n_czero': nczero,
				'n_inf': ninf
			},
			'hist_rel': hrel,
			'hist_c': hc,
			'max_E': maxE,
			'exact': exactAll && nonfinite === 0,
			'n_nonfinite': nonfinite,
			'n_ab_zero_err': abZeroErr
		};
		if ( o.kappa ) {
			met.kappa = kfinish( kb );
		}
		return {
			'metrics': met,
			'worst': worst,
			'argmax': {
				'N': ( argN < 0 ) ? null : [ Math.floor( argN / o.N ), argN % o.N ],
				'rel': ( argR < 0 ) ? null : [ Math.floor( argR / o.N ), argR % o.N ]
			},
			'worstIdx': idx.map( function get( k ) {
				return wi[ k ];
			}).concat( ( argN >= 0 ) ? [ argN ] : [], ( argR >= 0 ) ? [ argR ] : [] )
		};
	}
}

/**
* Adds an entry to the κ bins (one bin per decade of κ = (|A||B|)_ij/|C_ij|; C = 0 goes to the `czero` bin).
*
* @private
* @param {Object} kb - bins
* @param {number} ab - (|A||B|)_ij
* @param {number} cabs - |C_ij|
* @param {number} r - relative error
*/
function kbin( kb, ab, cabs, r ) {
	var key = ( cabs === 0.0 ) ? 'czero' : String( Math.floor( Math.log10( ab / cabs ) ) );
	if ( !kb[ key ] ) {
		kb[ key ] = [];
	}
	kb[ key ].push( r );
}

/**
* Summarizes κ bins: per decade, count, max and median relative error.
*
* @private
* @param {Object} kb - bins
* @returns {Object} `{ bins: [...], czero: {...} }`
*/
function kfinish( kb ) {
	var out = {
		'bins': [],
		'czero': null
	};
	var keys = Object.keys( kb );
	var v;
	var i;
	var k;
	for ( i = 0; i < keys.length; i++ ) {
		k = keys[ i ];
		v = Float64Array.from( kb[ k ] );
		if ( k === 'czero' ) {
			out.czero = {
				'n': v.length,
				'n_err': kb[ k ].filter( function pos( x ) {
					return x > 0.0;
				}).length
			};
			continue;
		}
		out.bins.push({
			'log10_kappa': Number( k ),
			'n': v.length,
			'rel_max': quantile( v, v.length, 1.0 ),
			'rel_median': quantile( v, v.length, 0.5 )
		});
	}
	out.bins.sort( function cmp( a, b ) {
		return a.log10_kappa - b.log10_kappa;
	});
	return out;
}


// EXPORTS //

module.exports = {
	'NWORST': NWORST,
	'HIST_BINS': HIST_BINS,
	'HIST_REL': HIST_REL,
	'HIST_C': HIST_C,
	'fW': fW,
	'fS': fS,
	'select': select,
	'quantile': quantile,
	'workspace': workspace,
	'compute': compute
};
