'use strict';

// Accuracy input families F1–F11 (research protocol §8), all seeded and square (M = N = K = n, row-major), plus the
// reference preconditions |a|,|b| < 2^996, nonzero |a*b| >= 2^-969, and |A||B| finite.

// MODULES //

var rng = require( './rng.js' );
var genDot = require( './gendot.js' );
var inverse = require( './inverse.js' );


// VARIABLES //

var FAMILIES = [ 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9a', 'F9b', 'F10', 'F11' ];
var PARAMS = {
	'F1': [ {} ],
	'F2': [ {} ],
	'F3': [ {} ],
	'F4': [ { 's': 10 }, { 's': 20 }, { 's': 40 } ],
	'F5': [ { 's': 20 } ],
	'F6': [ { 'dist': 2 }, { 'dist': 3 } ],
	'F7': [ {} ],
	'F8': [ { 'range': 30 } ],
	'F9a': [ { 'kmin': 1e4, 'kmax': 1e16 } ],
	'F9b': [ {} ],
	'F10': [ { 'delta': 0.5 } ],
	'F11': [ { 'kind': 'int' }, { 'kind': 'dyadic' } ]
};
var MAX_N = {
	'F7': 128 // Pascal entries reach C(2n-2, n-1) (2^249.6 at n = 128)
};
var DESCRIPTIONS = {
	'F1': 'U[0,1)',
	'F2': 'U[-1,1)',
	'F3': 'N(0,1)',
	'F4': 'outside-scaled: A = Dr*A0, B = B0*Dc, A0,B0 ~ U[-1,1), d = 2^round(U(-s,s))',
	'F5': 'inside-scaled: A = A0*D, B = inv(D)*B0, A0,B0 ~ U[-1,1), d = 2^round(U(-s,s))',
	'F6': 'Ballard et al. 2016 §6.5 distribution 2 or 3 (blocks scaled by 1/n^2 or n^2), entries U[0,1)',
	'F7': 'A = Pascal (floating-point recurrence), B ~ U[0,1); n <= 128',
	'F8': 'A = I, B = ±2^U(-range,range)',
	'F9a': 'row t of A and column t of B are a GenDot pair with condition 10^(log-spaced kmin..kmax)',
	'F9b': 'A ~ N(0,1), B = fl(inv(A)) (Gauss-Jordan, partial pivoting)',
	'F10': 'Kronecker signs aligned with the recursion: A = s^(x)L, B = t^(x)L, s = [[-1,-1],[1,1]], t = [[1,-1],[-1,1]], magnitudes 1 + U[0,delta)',
	'F11': 'integers (kind=int) or dyadic rationals p*2^-t (kind=dyadic) within the exact bound 3K*4.5^6*max|a|*max|b| <= 2^53'
};
var MAX_ABS = Math.pow( 2.0, 996 );
var MIN_PROD = Math.pow( 2.0, -969 );
var KRON_S = [ [ -1.0, -1.0 ], [ 1.0, 1.0 ] ];
var KRON_T = [ [ 1.0, -1.0 ], [ -1.0, 1.0 ] ];
var F11_LEVELS = 6;


// FUNCTIONS //

/**
* Returns a stable short key for a parameter object (used in cache names and record keys).
*
* @param {Object} params - parameters
* @returns {string} key (e.g. `s10`, `dist2`, `int`, `base`)
*/
function paramsKey( params ) {
	var keys = Object.keys( params ).sort();
	if ( keys.length === 0 ) {
		return 'base';
	}
	if ( params.kind ) {
		return params.kind;
	}
	return keys.map( function fmt( k ) {
		var v = params[ k ];
		if ( typeof v === 'number' && Math.abs( v ) >= 1e6 ) {
			v = v.toExponential().replace( '+', '' ); // e.g. 1e16
		}
		return k + String( v ).replace( /[^0-9a-zA-Z.-]/g, '' );
	}).join( '_' );
}

/**
* Returns the number of value bits b such that integers in [-2^b, 2^b] are exact under SW/Strassen with up to
* `levels` levels: 3K * 4.5^levels * 2^(2b) <= 2^53.
*
* @param {PositiveInteger} K - inner dimension
* @param {NonNegativeInteger} levels - recursion levels
* @returns {NonNegativeInteger} bits
*/
function exactBits( K, levels ) {
	return Math.max( 0, Math.floor( ( 53 - Math.log2( 3 * K * Math.pow( 4.5, levels ) ) ) / 2 ) );
}

/**
* Returns the sign (±1) of entry (i, j) of the Kronecker sign pattern p^(x)L aligned with the recursion's quadrant split
* (rows/columns peeled by an odd dimension keep the sign accumulated so far).
*
* @param {NonNegativeInteger} i - row index
* @param {NonNegativeInteger} j - column index
* @param {PositiveInteger} R - rows
* @param {PositiveInteger} C - columns
* @param {NonNegativeInteger} levels - pattern depth
* @param {Array<Array<number>>} p - 2×2 sign pattern
* @returns {number} sign
*/
function kronSign( i, j, R, C, levels, p ) {
	var sign = 1.0;
	var qi;
	var qj;
	var r;
	var c;
	var l;
	for ( l = 0; l < levels; l++ ) {
		r = Math.floor( R/2 );
		c = Math.floor( C/2 );
		if ( r === 0 || c === 0 || i >= 2*r || j >= 2*c ) {
			break;
		}
		qi = ( i >= r ) ? 1 : 0;
		qj = ( j >= c ) ? 1 : 0;
		sign *= p[ qi ][ qj ];
		i -= qi * r;
		j -= qj * c;
		R = r;
		C = c;
	}
	return sign;
}

/**
* Generates the input pair for a family.
*
* @param {string} family - family identifier (F1…F11)
* @param {Object} params - family parameters (see `paramSets`)
* @param {PositiveInteger} n - order
* @param {PositiveInteger} seed - PRNG seed
* @throws {Error} unknown family or invalid size
* @returns {Object} `{ A, B }` row-major n×n Float64Arrays
*/
function generate( family, params, n, seed ) {
	var A = new Float64Array( n*n );
	var B = new Float64Array( n*n );
	var ra = rng.uniform( rng.seed32( seed, 'A' ) );
	var rb = rng.uniform( rng.seed32( seed, 'B' ) );
	var rd = rng.uniform( rng.seed32( seed, 'D' ) );
	var nrm;
	var ri;
	var d;
	var b;
	var h;
	var i;
	var j;
	var k;
	var v;

	if ( MAX_N[ family ] && n > MAX_N[ family ] ) {
		throw new Error( 'families: ' + family + ' is only defined for n <= ' + MAX_N[ family ] );
	}
	switch ( family ) {
	case 'F1':
		fill( A, ra, 0.0, 1.0 );
		fill( B, rb, 0.0, 1.0 );
		break;
	case 'F2':
		fill( A, ra, -1.0, 1.0 );
		fill( B, rb, -1.0, 1.0 );
		break;
	case 'F3':
		nrm = rng.normal( rng.seed32( seed, 'A', 'normal' ) );
		for ( i = 0; i < n*n; i++ ) {
			A[ i ] = nrm();
		}
		nrm = rng.normal( rng.seed32( seed, 'B', 'normal' ) );
		for ( i = 0; i < n*n; i++ ) {
			B[ i ] = nrm();
		}
		break;
	case 'F4':
		fill( A, ra, -1.0, 1.0 );
		fill( B, rb, -1.0, 1.0 );
		for ( i = 0; i < n; i++ ) {
			d = pow2( rd, params.s );
			for ( j = 0; j < n; j++ ) {
				A[ ( i*n )+j ] *= d; // row i of A
			}
		}
		for ( j = 0; j < n; j++ ) {
			d = pow2( rd, params.s );
			for ( i = 0; i < n; i++ ) {
				B[ ( i*n )+j ] *= d; // column j of B
			}
		}
		break;
	case 'F5':
		fill( A, ra, -1.0, 1.0 );
		fill( B, rb, -1.0, 1.0 );
		for ( k = 0; k < n; k++ ) {
			d = pow2( rd, params.s );
			for ( i = 0; i < n; i++ ) {
				A[ ( i*n )+k ] *= d; // column k of A
			}
			for ( j = 0; j < n; j++ ) {
				B[ ( k*n )+j ] /= d; // row k of B (exact: d is a power of two)
			}
		}
		break;
	case 'F6':
		h = n / 2;
		for ( i = 0; i < n; i++ ) {
			for ( j = 0; j < n; j++ ) {
				if ( params.dist === 2 ) {
					A[ ( i*n )+j ] = ( j >= h ) ? ra() / ( n*n ) : ra();
					B[ ( i*n )+j ] = ( i < h ) ? rb() / ( n*n ) : rb();
				} else if ( params.dist === 3 ) {
					A[ ( i*n )+j ] = ( i < h && j >= h ) ? ra() * n * n : ra();
					B[ ( i*n )+j ] = ( j < h ) ? rb() / ( n*n ) : rb();
				} else {
					throw new Error( 'families: F6 dist must be 2 or 3' );
				}
			}
		}
		break;
	case 'F7':
		for ( i = 0; i < n; i++ ) {
			for ( j = 0; j < n; j++ ) {
				A[ ( i*n )+j ] = ( i === 0 || j === 0 ) ? 1.0 : A[ ( ( i-1 )*n )+j ] + A[ ( i*n )+j-1 ];
			}
		}
		fill( B, rb, 0.0, 1.0 );
		break;
	case 'F8':
		for ( i = 0; i < n; i++ ) {
			A[ ( i*n )+i ] = 1.0;
		}
		for ( i = 0; i < n*n; i++ ) {
			v = Math.pow( 2.0, ( ( 2.0*rb() ) - 1.0 ) * params.range );
			B[ i ] = ( rd() < 0.5 ) ? -v : v;
		}
		break;
	case 'F9a':
		for ( k = 0; k < n; k++ ) {
			// Condition numbers log-spaced over [kmin, kmax] along the diagonal pairs (row k of A, column k of B)...
			d = Math.log10( params.kmin ) + ( ( n > 1 ) ? ( k / ( n-1 ) ) : 0 ) * ( Math.log10( params.kmax ) - Math.log10( params.kmin ) );
			v = genDot( n, Math.pow( 10.0, d ), ra );
			for ( j = 0; j < n; j++ ) {
				A[ ( k*n )+j ] = v.x[ j ];
				B[ ( j*n )+k ] = v.y[ j ];
			}
		}
		break;
	case 'F9b':
		nrm = rng.normal( rng.seed32( seed, 'A', 'normal' ) );
		for ( i = 0; i < n*n; i++ ) {
			A[ i ] = nrm();
		}
		B = inverse( n, A );
		break;
	case 'F10':
		for ( i = 0; i < n; i++ ) {
			for ( j = 0; j < n; j++ ) {
				A[ ( i*n )+j ] = kronSign( i, j, n, n, 64, KRON_S ) * ( 1.0 + ( params.delta * ra() ) );
				B[ ( i*n )+j ] = kronSign( i, j, n, n, 64, KRON_T ) * ( 1.0 + ( params.delta * rb() ) );
			}
		}
		break;
	case 'F11':
		b = exactBits( n, F11_LEVELS );
		ri = rng.int( rng.seed32( seed, 'F11' ) );
		if ( params.kind === 'int' ) {
			for ( i = 0; i < n*n; i++ ) {
				A[ i ] = ri( -Math.pow( 2, b ), Math.pow( 2, b ) );
				B[ i ] = ri( -Math.pow( 2, b ), Math.pow( 2, b ) );
			}
		} else if ( params.kind === 'dyadic' ) {
			// p*2^-t with t in [0, 8] and |p| <= 2^(b-8) (numerators <= 2^b on the 2^-8 grid), globally rescaled by
			// exact powers of two (A by 2^-20, B by 2^12)...
			h = Math.pow( 2, Math.max( b-8, 0 ) );
			for ( i = 0; i < n*n; i++ ) {
				A[ i ] = ri( -h, h ) * Math.pow( 2.0, -ri( 0, 8 ) ) * Math.pow( 2.0, -20 );
				B[ i ] = ri( -h, h ) * Math.pow( 2.0, -ri( 0, 8 ) ) * Math.pow( 2.0, 12 );
			}
		} else {
			throw new Error( 'families: F11 kind must be int or dyadic' );
		}
		break;
	default:
		throw new Error( 'families: unknown family ' + family );
	}
	return {
		'A': A,
		'B': B
	};
}

/**
* Fills an array with uniform variates on [a, b).
*
* @private
* @param {Float64Array} x - output array
* @param {Function} rand - uniform PRNG on [0,1)
* @param {number} a - lower bound
* @param {number} b - upper bound
*/
function fill( x, rand, a, b ) {
	var i;
	for ( i = 0; i < x.length; i++ ) {
		x[ i ] = a + ( ( b-a ) * rand() );
	}
}

/**
* Returns 2^round(U(-s, s)).
*
* @private
* @param {Function} rand - uniform PRNG on [0,1)
* @param {number} s - log2 half-range
* @returns {number} power of two
*/
function pow2( rand, s ) {
	return Math.pow( 2.0, Math.round( ( ( 2.0*rand() ) - 1.0 ) * s ) );
}

/**
* Checks the reference preconditions; throws a descriptive error on violation.
*
* ## Notes
*
* -   Nonzero products: for every k, (min nonzero |a_ik|)·(min nonzero |b_kj|) >= 2^-969, which covers every pair.
* -   `|A||B|` finite: checked exactly when `AB` is provided; otherwise via the sufficient bound K·max|a|·max|b| < ∞.
*
* @param {PositiveInteger} n - order
* @param {Float64Array} A - row-major n×n matrix
* @param {Float64Array} B - row-major n×n matrix
* @param {(Float64Array|null)} AB - |A||B| (or null)
* @throws {Error} precondition violated
*/
function checkPreconditions( n, A, B, AB ) {
	var minA = new Float64Array( n ).fill( Infinity );
	var minB = new Float64Array( n ).fill( Infinity );
	var maxA = 0.0;
	var maxB = 0.0;
	var a;
	var i;
	var k;
	for ( i = 0; i < n; i++ ) {
		for ( k = 0; k < n; k++ ) {
			a = Math.abs( A[ ( i*n )+k ] );
			if ( !( a < MAX_ABS ) ) {
				throw new Error( 'precondition violated: |a| < 2^996 (A[' + i + ',' + k + '] = ' + A[ ( i*n )+k ] + ')' );
			}
			maxA = Math.max( maxA, a );
			if ( a > 0.0 && a < minA[ k ] ) {
				minA[ k ] = a; // column k of A
			}
			a = Math.abs( B[ ( k*n )+i ] );
			if ( !( a < MAX_ABS ) ) {
				throw new Error( 'precondition violated: |b| < 2^996 (B[' + k + ',' + i + '] = ' + B[ ( k*n )+i ] + ')' );
			}
			maxB = Math.max( maxB, a );
			if ( a > 0.0 && a < minB[ k ] ) {
				minB[ k ] = a; // row k of B
			}
		}
	}
	for ( k = 0; k < n; k++ ) {
		if ( minA[ k ] < Infinity && minB[ k ] < Infinity && !( minA[ k ] * minB[ k ] >= MIN_PROD ) ) {
			throw new Error( 'precondition violated: nonzero |a*b| >= 2^-969 (inner index ' + k + ': ' + minA[ k ] + ' * ' + minB[ k ] + ')' );
		}
	}
	if ( AB ) {
		for ( i = 0; i < AB.length; i++ ) {
			if ( !isFinite( AB[ i ] ) ) {
				throw new Error( 'precondition violated: |A||B| finite (entry ' + i + ')' );
			}
		}
	} else if ( !isFinite( n * maxA * maxB ) ) {
		throw new Error( 'precondition violated: |A||B| finite (bound K*max|a|*max|b| overflows; recheck exactly)' );
	}
}

/**
* Returns the parameter sets of a family.
*
* @param {string} family - family identifier
* @returns {Array<Object>} parameter objects
*/
function paramSets( family ) {
	if ( !PARAMS[ family ] ) {
		throw new Error( 'families: unknown family ' + family );
	}
	return PARAMS[ family ].map( function copy( p ) {
		return Object.assign( {}, p );
	});
}

/**
* Returns the largest order for which a family is defined.
*
* @param {string} family - family identifier
* @returns {number} maximum order (Infinity if unrestricted)
*/
function maxN( family ) {
	return MAX_N[ family ] || Infinity;
}


// EXPORTS //

module.exports = {
	'FAMILIES': FAMILIES,
	'DESCRIPTIONS': DESCRIPTIONS,
	'paramSets': paramSets,
	'paramsKey': paramsKey,
	'maxN': maxN,
	'exactBits': exactBits,
	'kronSign': kronSign,
	'generate': generate,
	'checkPreconditions': checkPreconditions
};
