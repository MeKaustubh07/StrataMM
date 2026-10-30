'use strict';

// One E1 trial: a seeded exact differential test of base() vs dgemm.ndarray on integer-valued inputs within the safe
// bound |num(α)|·3K·4.5^L·max|a|·max|b|·2^(g-qα) + |num(β)|·max|c|·2^(g-qβ) <= 2^53 (α = num(α)·2^-qα, etc.,
// g = max(qα, qβ)), so both are exact and must agree bitwise on the WHOLE C buffer (padding included). Inputs use
// random layouts, transposes, LD padding, offsets and negative strides; non-logical elements hold NaN sentinels.

// MODULES //

var dgemm = require( '@stdlib/blas/base/dgemm' ).ndarray;
var paths = require( './../accuracy/paths.js' );
var rng = require( './../accuracy/rng.js' );
var kronSign = require( './../accuracy/families.js' ).kronSign;
var base = require( paths.BASE );
var depth = require( paths.DEPTH );


// VARIABLES //

var CUTOFFS = [ 1, 2, 3, 5, 8, 16 ];
var LEVELS = [ 1, 2, 3, 100 ];
var PADS = [ 0, 0, 0, 1, 2, 3, 8 ];
var MODES = [ 'random', 'random', 'random', 'ternary', 'binary', 'kron' ];
var ALPHAS = [ [ 1, 0 ], [ -1, 0 ], [ 2, 0 ], [ 1, 1 ], [ -3, 0 ], [ 3, 2 ], [ 1, 3 ], [ -5, 2 ], [ 0, 0 ] ]; // [num, q]: num*2^-q
var BETAS = [ [ 0, 0 ], [ 0, 0 ], [ 1, 0 ], [ -1, 0 ], [ 1, 4 ], [ 5, 3 ], [ 2, 0 ], [ 1, 1 ], [ -1, 2 ] ];
var KRON_S = [ [ -1, -1 ], [ 1, 1 ] ];
var KRON_T = [ [ 1, -1 ], [ -1, 1 ] ];
var TRANS = [ 'no-transpose', 'transpose' ];


// FUNCTIONS //

/**
* Creates a strided matrix (stored rows×cols) with a random layout, padding, offset and stride signs; every buffer
* element starts as NaN (sentinel for never-read/never-written elements).
*
* @private
* @param {Function} ri - integer PRNG
* @param {NonNegativeInteger} rows - stored rows
* @param {NonNegativeInteger} cols - stored columns
* @returns {Object} `{ buf, s1, s2, o, rowMajor, pad }`
*/
function createMatrix( ri, rows, cols ) {
	var rowMajor = ( ri( 0, 1 ) === 0 );
	var pad = PADS[ ri( 0, PADS.length-1 ) ];
	var o = ri( 0, 5 );
	var len;
	var s1;
	var s2;
	if ( rowMajor ) {
		s1 = Math.max( cols, 1 ) + pad;
		s2 = 1;
	} else {
		s1 = 1;
		s2 = Math.max( rows, 1 ) + pad;
	}
	len = o + ( Math.max( rows-1, 0 )*s1 ) + ( Math.max( cols-1, 0 )*s2 ) + 1 + ri( 0, 3 );
	if ( ri( 0, 3 ) === 0 ) {
		o += Math.max( rows-1, 0 ) * s1;
		s1 = -s1;
	}
	if ( ri( 0, 3 ) === 0 ) {
		o += Math.max( cols-1, 0 ) * s2;
		s2 = -s2;
	}
	return {
		'buf': new Float64Array( len ).fill( NaN ),
		's1': s1,
		's2': s2,
		'o': o,
		'rowMajor': rowMajor,
		'pad': pad
	};
}

/**
* Sets the logical elements op(X)(r, c), r < R, c < C, from `f( r, c )`.
*
* @private
* @param {Object} X - strided matrix
* @param {boolean} trans - whether X stores op(X)^T
* @param {NonNegativeInteger} R - logical rows
* @param {NonNegativeInteger} C - logical columns
* @param {Function} f - value function
*/
function fillLogical( X, trans, R, C, f ) {
	var r;
	var c;
	for ( r = 0; r < R; r++ ) {
		for ( c = 0; c < C; c++ ) {
			if ( trans ) {
				X.buf[ X.o + ( c*X.s1 ) + ( r*X.s2 ) ] = f( r, c );
			} else {
				X.buf[ X.o + ( r*X.s1 ) + ( c*X.s2 ) ] = f( r, c );
			}
		}
	}
}

/**
* Returns the value generator for op(A) or op(B) under a value mode.
*
* @private
* @param {string} mode - value mode
* @param {Function} ri - integer PRNG
* @param {NonNegativeInteger} b - magnitude bits (entries in [-2^b, 2^b])
* @param {Array} sp - Kronecker sign pattern
* @param {NonNegativeInteger} R - logical rows
* @param {NonNegativeInteger} C - logical columns
* @param {NonNegativeInteger} L - recursion depth
* @returns {Function} `( r, c ) => value`
*/
function values( mode, ri, b, sp, R, C, L ) {
	var hi = Math.pow( 2, b );
	return function value( r, c ) {
		if ( mode === 'ternary' ) {
			return ri( -1, 1 );
		}
		if ( mode === 'binary' ) {
			return ri( 0, 1 );
		}
		if ( mode === 'kron' ) {
			return kronSign( r, c, R, C, L, sp ) * ri( 1, Math.max( hi, 1 ) );
		}
		return ri( -hi, hi );
	};
}

/**
* Generates trial `t` (deterministic in (master seed, t), independent of sharding).
*
* @param {NonNegativeInteger} t - trial index
* @param {PositiveInteger} master - master seed
* @returns {Object} trial
*/
function makeTrial( t, master ) {
	var ri = rng.int( rng.seed32( master, 'E1', t ) );
	var cls = ri( 0, 99 );
	var cutoff = CUTOFFS[ ri( 0, CUTOFFS.length-1 ) ];
	var tr = {
		'index': t,
		'transA': TRANS[ ri( 0, 1 ) ],
		'transB': TRANS[ ri( 0, 1 ) ],
		'cutoff': cutoff,
		'levels': LEVELS[ ri( 0, LEVELS.length-1 ) ],
		'alpha': ALPHAS[ ri( 0, ALPHAS.length-1 ) ],
		'beta': BETAS[ ri( 0, BETAS.length-1 ) ],
		'mode': MODES[ ri( 0, MODES.length-1 ) ]
	};
	// Dimensions: mostly small and relative to the cutoff (so most trials recurse), some degenerate, a few up to 300...
	tr.M = dim();
	tr.N = dim();
	tr.K = dim();
	var nA = tr.transA !== TRANS[ 0 ];
	var nB = tr.transB !== TRANS[ 0 ];
	var qa = tr.alpha[ 1 ];
	var qb = tr.beta[ 1 ];
	var g = Math.max( qa, qb );
	var L = depth( tr.M, tr.N, tr.K, tr.cutoff, tr.levels );
	var t1 = Math.abs( tr.alpha[ 0 ] ) * 3 * Math.max( tr.K, 1 ) * Math.pow( 4.5, L ) * Math.pow( 2, g-qa );
	var bAB = Math.max( 0, Math.floor( ( 52 - Math.log2( Math.max( t1, 1 ) ) ) / 2 ) );
	var bC = Math.min( 20, Math.max( 0, Math.floor( 52 - Math.log2( Math.max( Math.abs( tr.beta[ 0 ] ) * Math.pow( 2, g-qb ), 1 ) ) ) ) );
	var b = ( ri( 0, 1 ) === 0 ) ? bAB : ri( 0, bAB );
	tr.L = L;
	tr.bits = b;
	tr.A = ( nA ) ? createMatrix( ri, tr.K, tr.M ) : createMatrix( ri, tr.M, tr.K );
	tr.B = ( nB ) ? createMatrix( ri, tr.N, tr.K ) : createMatrix( ri, tr.K, tr.N );
	tr.C = createMatrix( ri, tr.M, tr.N );
	fillLogical( tr.A, nA, tr.M, tr.K, values( tr.mode, ri, b, KRON_S, tr.M, tr.K, L ) );
	fillLogical( tr.B, nB, tr.K, tr.N, values( tr.mode, ri, b, KRON_T, tr.K, tr.N, L ) );
	if ( tr.beta[ 0 ] !== 0 ) {
		fillLogical( tr.C, false, tr.M, tr.N, values( 'random', ri, bC, null, tr.M, tr.N, 0 ) );
	}
	return tr;

	function dim() {
		if ( cls < 8 ) {
			return ri( 0, 3 ); // degenerate: quick returns, K = 0, no recursion
		}
		if ( cls < 75 ) {
			return Math.max( 0, cutoff + ri( -1, 20 ) );
		}
		if ( cls < 95 ) {
			return Math.max( 0, cutoff + ri( -2, 64 ) );
		}
		return ri( 0, 300 );
	}
}

/**
* Runs a trial: dgemm and base() on copies of the same C buffer; whole-buffer comparison with Object.is when β = 0
* (NaN-filled C must be fully overwritten; signed zeros must match) and NaN-aware `===` otherwise; inputs must be
* unchanged (Object.is).
*
* @param {Object} tr - trial from `makeTrial`
* @param {Function} [impl=base] - implementation under test (same signature as `base`; a seam for mutation tests)
* @returns {Object} `{ ok, mutated, index, expected, actual, recursive }`
*/
function runTrial( tr, impl ) {
	var alpha = tr.alpha[ 0 ] * Math.pow( 2, -tr.alpha[ 1 ] );
	var beta = tr.beta[ 0 ] * Math.pow( 2, -tr.beta[ 1 ] );
	var C1 = Float64Array.from( tr.C.buf );
	var C2 = Float64Array.from( tr.C.buf );
	var A0 = Float64Array.from( tr.A.buf );
	var B0 = Float64Array.from( tr.B.buf );
	var eq = ( beta === 0.0 ) ? Object.is : sameNaN;
	var res = {
		'ok': true,
		'mutated': false,
		'index': -1,
		'expected': null,
		'actual': null,
		'recursive': ( tr.M > 0 && tr.N > 0 && tr.K > 0 && alpha !== 0.0 && tr.L > 0 )
	};
	var i;
	dgemm( tr.transA, tr.transB, tr.M, tr.N, tr.K, alpha, tr.A.buf, tr.A.s1, tr.A.s2, tr.A.o, tr.B.buf, tr.B.s1, tr.B.s2, tr.B.o, beta, C1, tr.C.s1, tr.C.s2, tr.C.o );
	( impl || base )( tr.transA, tr.transB, tr.M, tr.N, tr.K, alpha, tr.A.buf, tr.A.s1, tr.A.s2, tr.A.o, tr.B.buf, tr.B.s1, tr.B.s2, tr.B.o, beta, C2, tr.C.s1, tr.C.s2, tr.C.o, tr.cutoff, tr.levels );
	for ( i = 0; i < C1.length; i++ ) {
		if ( !eq( C1[ i ], C2[ i ] ) ) {
			res.ok = false;
			res.index = i;
			res.expected = C1[ i ];
			res.actual = C2[ i ];
			break;
		}
	}
	for ( i = 0; i < A0.length; i++ ) {
		if ( !Object.is( A0[ i ], tr.A.buf[ i ] ) ) {
			res.mutated = true;
		}
	}
	for ( i = 0; i < B0.length; i++ ) {
		if ( !Object.is( B0[ i ], tr.B.buf[ i ] ) ) {
			res.mutated = true;
		}
	}
	return res;
}

/**
* Tests two numbers for equality, treating NaN as equal to NaN and +0 as equal to -0.
*
* @private
* @param {number} x - first number
* @param {number} y - second number
* @returns {boolean} boolean
*/
function sameNaN( x, y ) {
	return ( x === y ) || ( x !== x && y !== y ); // eslint-disable-line no-self-compare
}

/**
* Returns a JSON-safe description of a trial (for mismatch examples).
*
* @param {Object} tr - trial
* @returns {Object} description
*/
function describe( tr ) {
	return {
		'trial': tr.index,
		'M': tr.M,
		'N': tr.N,
		'K': tr.K,
		'transA': tr.transA,
		'transB': tr.transB,
		'alpha': tr.alpha[ 0 ] * Math.pow( 2, -tr.alpha[ 1 ] ),
		'beta': tr.beta[ 0 ] * Math.pow( 2, -tr.beta[ 1 ] ),
		'cutoff': tr.cutoff,
		'levels': tr.levels,
		'L': tr.L,
		'mode': tr.mode,
		'bits': tr.bits,
		'layouts': [ tr.A.rowMajor, tr.B.rowMajor, tr.C.rowMajor ].map( function f( r ) {
			return ( r ) ? 'row' : 'col';
		}),
		'strides': [ [ tr.A.s1, tr.A.s2, tr.A.o ], [ tr.B.s1, tr.B.s2, tr.B.o ], [ tr.C.s1, tr.C.s2, tr.C.o ] ]
	};
}


// EXPORTS //

module.exports = {
	'makeTrial': makeTrial,
	'runTrial': runTrial,
	'describe': describe,
	'createMatrix': createMatrix,
	'fillLogical': fillLogical,
	'sameNaN': sameNaN
};
