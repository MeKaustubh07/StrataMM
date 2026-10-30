'use strict';

/*
* Problem construction (seeded inputs, layouts, leading dimensions) and the algorithm registry of the timing harness
* (protocol §3–§4): A0 = dgemm.ndarray, A1 = SW one level, A2 = SW (cutoff, levels), C1 = packed dgemm, C2 = eight-product
* recursion control, SENTINEL = A0. Also the Freivalds gate and the analytic per-call allocation (protocol §9).
*/

/* eslint-disable max-len, max-params */

// MODULES //

var Module = require( 'module' );
var path = require( 'path' );
var fs = require( 'fs' );
var uniform = require( '@stdlib/random/base/uniform' );
var dgemm = require( '@stdlib/blas/base/dgemm' ).ndarray;
var classic = require( './controls/classic.js' );
var packed = require( './controls/packed.js' );


// VARIABLES //

var PKG_LIB = path.join( 'lib', 'node_modules', '@stdlib', 'blas', 'ext', 'base', 'dgemmsw', 'lib' );
var DEFAULT_REPO_ROOT = path.resolve( __dirname, '..', '..' );
var ALGS = [ 'A0', 'A1', 'A2', 'C1', 'C2', 'SENTINEL' ];
var DEFAULT_LEVELS = 4; // L_max (protocol §3, §5.1)
var FREIVALDS_TOL = 1.0e-8; // protocol §4
var LIBS = {};


// FUNCTIONS //

// Tests whether `p` lies strictly inside directory `root`.
function isInside( root, p ) {
	return ( p.indexOf( root + path.sep ) === 0 );
}

// Tests whether a value is an integer within [lo, hi].
function isIntIn( v, lo, hi ) {
	return ( typeof v === 'number' && Math.floor( v ) === v && v >= lo && v <= hi );
}

/**
* Loads the library under test by absolute path (never by package name, never via `NODE_PATH`).
*
* ## Notes
*
* -   Asserts that the harness and `dgemmsw/lib/base.js` resolve the same `@stdlib/blas/base/dgemm` file, so A0, C1, C2 and the SW leaves call one module instance, and that every resolved path lies inside the repository.
*
* @param {string} [repoRoot] - repository root (default: two levels above this file)
* @throws {Error} resolution mismatch or path outside the repository
* @returns {Object} library handle: `{root, dir, files, dgemmPath, base, workspaceLength, depth}`
*/
function library( repoRoot ) {
	var dgemmHarness, dgemmLib, files, root, dir, lib; // eslint-disable-line one-var

	root = fs.realpathSync( path.resolve( repoRoot || DEFAULT_REPO_ROOT ) );
	if ( LIBS[ root ] ) {
		return LIBS[ root ];
	}
	dir = path.join( root, PKG_LIB );
	files = {
		'base': path.join( dir, 'base.js' ),
		'workspaceLength': path.join( dir, 'workspace_length.js' ),
		'depth': path.join( dir, 'depth.js' )
	};
	dgemmLib = Module.createRequire( files.base ).resolve( '@stdlib/blas/base/dgemm' );
	dgemmHarness = require.resolve( '@stdlib/blas/base/dgemm' );
	if ( dgemmLib !== dgemmHarness ) {
		throw new Error( 'harness and dgemmsw resolve different dgemm modules: ' + dgemmHarness + ' vs ' + dgemmLib );
	}
	if ( !isInside( root, dgemmLib ) || !isInside( root, files.base ) ) {
		throw new Error( 'resolved module outside the repository root ' + root + ': ' + dgemmLib );
	}
	lib = {
		'root': root,
		'dir': dir,
		'files': files,
		'dgemmPath': dgemmLib,
		'base': require( files.base ),
		'workspaceLength': require( files.workspaceLength ),
		'depth': require( files.depth )
	};
	LIBS[ root ] = lib;
	return lib;
}

/**
* Resolves the algorithm parameters `{cutoff, levels}` for an algorithm key.
*
* ## Notes
*
* -   A1 is fixed at `{cutoff: 1, levels: 1}`; explicit conflicting values throw. A2 and C2 require `params.cutoff`; `params.levels` defaults to 4 (L_max). A0, C1 and SENTINEL take no parameters (`null`).
*
* @param {string} alg - algorithm key
* @param {(Object|null)} [params] - requested parameters
* @throws {Error} invalid key or parameters
* @returns {(Object|null)} resolved parameters
*/
function resolveParams( alg, params ) {
	var levels;
	if ( ALGS.indexOf( alg ) < 0 ) {
		throw new Error( 'unknown algorithm key: ' + alg + ' (expected one of ' + ALGS.join( ', ' ) + ')' );
	}
	params = params || {};
	if ( alg === 'A1' ) {
		if ( ( params.cutoff !== void 0 && params.cutoff !== null && params.cutoff !== 1 ) || ( params.levels !== void 0 && params.levels !== null && params.levels !== 1 ) ) {
			throw new Error( 'A1 is fixed at cutoff=1, levels=1; got ' + JSON.stringify( params ) );
		}
		return { 'cutoff': 1, 'levels': 1 };
	}
	if ( alg === 'A2' || alg === 'C2' ) {
		if ( !isIntIn( params.cutoff, 1, 1e9 ) ) {
			throw new Error( alg + ' requires params.cutoff (positive integer); got ' + JSON.stringify( params ) );
		}
		levels = ( params.levels === void 0 || params.levels === null ) ? DEFAULT_LEVELS : params.levels;
		if ( !isIntIn( levels, 0, 64 ) ) {
			throw new Error( alg + ' requires params.levels in [0, 64]; got ' + JSON.stringify( params ) );
		}
		return { 'cutoff': params.cutoff, 'levels': levels };
	}
	return null;
}

// Storage descriptor of a rows×cols matrix in the given order, leading dimension = contiguous extent + pad.
function storage( rowMajor, rows, cols, pad ) {
	var ld = ( ( rowMajor ) ? cols : rows ) + pad;
	var outer = ( rowMajor ) ? rows : cols;
	return { // `outer` contiguous runs of `inner` elements, each followed by `pad` padding elements
		'rows': rows,
		'cols': cols,
		'ld': ld,
		's1': ( rowMajor ) ? ld : 1,
		's2': ( rowMajor ) ? 1 : ld,
		'outer': outer,
		'inner': ( rowMajor ) ? cols : rows,
		'len': outer * ld
	};
}

/**
* Computes leading dimensions, strides and buffer lengths for a configuration.
*
* ## Notes
*
* -   `A` is stored `M×K` (or `K×M` when `transA` is 'transpose'), `B` `K×N` (or `N×K`), `C` `M×N`, all in `cfg.order`, each with leading dimension equal to its contiguous extent plus `cfg.ld_pad` (i.e., `n + ld_pad` for square problems).
* -   `op(A)[i][k] = A[i*oa1 + k*oa2]` and `op(B)[k][j] = B[k*ob1 + j*ob2]`.
*
* @param {Object} cfg - configuration (`order`, `transA`, `transB`, `M`, `N`, `K`, `ld_pad`)
* @returns {Object} layout
*/
function layout( cfg ) {
	var rowMajor = ( cfg.order === 'row-major' );
	var ta = ( cfg.transA !== 'no-transpose' );
	var tb = ( cfg.transB !== 'no-transpose' );
	var A = storage( rowMajor, ( ta ) ? cfg.K : cfg.M, ( ta ) ? cfg.M : cfg.K, cfg.ld_pad );
	var B = storage( rowMajor, ( tb ) ? cfg.N : cfg.K, ( tb ) ? cfg.K : cfg.N, cfg.ld_pad );
	var C = storage( rowMajor, cfg.M, cfg.N, cfg.ld_pad );
	return {
		'lda': A.ld,
		'ldb': B.ld,
		'ldc': C.ld,
		'sa1': A.s1,
		'sa2': A.s2,
		'sb1': B.s1,
		'sb2': B.s2,
		'sc1': C.s1,
		'sc2': C.s2,
		'oa1': ( ta ) ? A.s2 : A.s1,
		'oa2': ( ta ) ? A.s1 : A.s2,
		'ob1': ( tb ) ? B.s2 : B.s1,
		'ob2': ( tb ) ? B.s1 : B.s2,
		'A': A,
		'B': B,
		'C': C
	};
}

// Fills the logical rows×cols matrix at strides (s1, s2) in canonical logical row-major order.
function fill( rand, rows, cols, X, s1, s2 ) {
	var i;
	var j;
	for ( i = 0; i < rows; i++ ) {
		for ( j = 0; j < cols; j++ ) {
			X[ ( i*s1 ) + ( j*s2 ) ] = rand();
		}
	}
}

/**
* Returns a 32-bit FNV-1a checksum of the bit patterns of a `Float64Array` (input-integrity check).
*
* @param {Float64Array} X - array
* @returns {NonNegativeInteger} checksum
*/
function checksum( X ) {
	var w = new Int32Array( X.buffer, X.byteOffset, X.length*2 );
	var h = 0x811c9dc5|0;
	var i;
	for ( i = 0; i < w.length; i++ ) {
		h = Math.imul( h ^ w[ i ], 0x01000193 );
	}
	return h >>> 0;
}

/**
* Creates the seeded problem of a configuration (protocol §4).
*
* ## Notes
*
* -   Logical `op(A)` (M×K), `op(B)` (K×N), then, when `β ≠ 0`, `C₀` (M×N), then the Freivalds vector `x` (N) are drawn from one U(-1,1) stream (`@stdlib/random/base/uniform`, seeded) in logical row-major order, so the operands are identical for every order, transpose and padding. Values are written straight into storage (no temporaries; allocate-and-touch for E7).
* -   Padding elements are NaN: a read of padding poisons the result (gate fails), and a write to the padding of `C` is detected by `check`.
* -   `C` is NaN-filled when `β = 0`; otherwise it holds `C₀` and `C0` is a pristine copy used for restores.
*
* @param {Object} cfg - validated configuration
* @returns {Object} problem
*/
function createProblem( cfg ) {
	var rand, C0, L, A, B, C, x, j; // eslint-disable-line one-var

	L = layout( cfg );
	rand = uniform.factory( -1.0, 1.0, { 'seed': cfg.seed } );
	A = new Float64Array( L.A.len );
	B = new Float64Array( L.B.len );
	C = new Float64Array( L.C.len );
	A.fill( NaN );
	B.fill( NaN );
	C.fill( NaN );
	fill( rand, cfg.M, cfg.K, A, L.oa1, L.oa2 );
	fill( rand, cfg.K, cfg.N, B, L.ob1, L.ob2 );
	C0 = null;
	if ( cfg.beta !== 0.0 ) {
		fill( rand, cfg.M, cfg.N, C, L.sc1, L.sc2 );
		C0 = C.slice();
	}
	x = new Float64Array( cfg.N );
	for ( j = 0; j < cfg.N; j++ ) {
		x[ j ] = rand();
	}
	return {
		'transA': cfg.transA,
		'transB': cfg.transB,
		'M': cfg.M,
		'N': cfg.N,
		'K': cfg.K,
		'alpha': cfg.alpha,
		'beta': cfg.beta,
		'layout': L,
		'A': A,
		'B': B,
		'C': C,
		'C0': C0,
		'x': x,
		'rand': rand, // kept reachable: V8 may otherwise free the PRNG state (2524 B) mid-measurement and skew E7's ΔarrayBuffers
		'sums': { 'A': checksum( A ), 'B': checksum( B ) }
	};
}

/**
* Returns the Freivalds relative residual of `C` (protocol §4).
*
* ## Notes
*
* -   `rel = ‖Cx − (α·op(A)(op(B)x) + β·C₀x)‖∞ / (|α||op(A)||op(B)||x| + |β||C₀||x|)∞`, the `β` terms omitted when `β = 0`. NaN anywhere in `Cx` yields `NaN`.
*
* @param {Object} prob - problem
* @param {Float64Array} [C] - result to check (default: `prob.C`)
* @returns {number} relative residual
*/
function freivalds( prob, C ) {
	var alpha = prob.alpha;
	var beta = prob.beta;
	var L = prob.layout;
	var A = prob.A;
	var B = prob.B;
	var x = prob.x;
	var bad, num, den, ya, za, va, y, z, w, v, r, a, i, j, k; // eslint-disable-line one-var

	C = C || prob.C;
	y = new Float64Array( prob.K );
	ya = new Float64Array( prob.K );
	for ( k = 0; k < prob.K; k++ ) {
		z = 0.0;
		za = 0.0;
		for ( j = 0; j < prob.N; j++ ) {
			a = B[ ( k*L.ob1 ) + ( j*L.ob2 ) ];
			z += a * x[ j ];
			za += Math.abs( a ) * Math.abs( x[ j ] );
		}
		y[ k ] = z;
		ya[ k ] = za;
	}
	bad = false;
	num = 0.0;
	den = 0.0;
	for ( i = 0; i < prob.M; i++ ) {
		z = 0.0;
		za = 0.0;
		for ( k = 0; k < prob.K; k++ ) {
			a = A[ ( i*L.oa1 ) + ( k*L.oa2 ) ];
			z += a * y[ k ];
			za += Math.abs( a ) * ya[ k ];
		}
		w = 0.0;
		for ( j = 0; j < prob.N; j++ ) {
			w += C[ ( i*L.sc1 ) + ( j*L.sc2 ) ] * x[ j ];
		}
		z *= alpha;
		za *= Math.abs( alpha );
		if ( beta !== 0.0 ) {
			v = 0.0;
			va = 0.0;
			for ( j = 0; j < prob.N; j++ ) {
				a = prob.C0[ ( i*L.sc1 ) + ( j*L.sc2 ) ];
				v += a * x[ j ];
				va += Math.abs( a ) * Math.abs( x[ j ] );
			}
			z += beta * v;
			za += Math.abs( beta ) * va;
		}
		r = Math.abs( w - z );
		if ( r !== r ) { // eslint-disable-line no-self-compare
			bad = true;
		} else if ( r > num ) {
			num = r;
		}
		if ( za > den ) {
			den = za;
		}
	}
	if ( bad ) {
		return NaN;
	}
	if ( den === 0.0 ) {
		return ( num === 0.0 ) ? 0.0 : Infinity;
	}
	return num / den;
}

// Tests whether every padding element of a stored matrix is still NaN.
function paddingIntact( X, st ) {
	var o;
	var i;
	for ( o = 0; o < st.outer; o++ ) {
		for ( i = ( o*st.ld ) + st.inner; i < ( o+1 )*st.ld; i++ ) {
			if ( X[ i ] === X[ i ] ) { // eslint-disable-line no-self-compare
				return false;
			}
		}
	}
	return true;
}

/**
* Runs the gate check on the current `C`: Freivalds residual plus input integrity (A and B unchanged, padding of C untouched).
*
* @param {Object} prob - problem
* @returns {Object} `{rel, intact, pass}`
*/
function check( prob ) {
	var rel = freivalds( prob );
	var intact = ( checksum( prob.A ) === prob.sums.A && checksum( prob.B ) === prob.sums.B && paddingIntact( prob.C, prob.layout.C ) );
	return {
		'rel': rel,
		'intact': intact,
		'pass': ( rel < FREIVALDS_TOL && intact )
	};
}

/**
* Returns a closure performing one full call of an algorithm on a problem (returns `C`).
*
* @param {string} alg - algorithm key
* @param {(Object|null)} params - resolved parameters (see `resolveParams`)
* @param {Object} prob - problem
* @param {Object} lib - library handle (see `library`)
* @throws {Error} unknown algorithm key
* @returns {Function} closure
*/
function create( alg, params, prob, lib ) {
	// Captured locals (monomorphic closures; strides from `layout`, offsets 0):
	var transA = prob.transA, transB = prob.transB, alpha = prob.alpha, beta = prob.beta; // eslint-disable-line one-var
	var sa1 = prob.layout.sa1, sa2 = prob.layout.sa2, sb1 = prob.layout.sb1, sb2 = prob.layout.sb2; // eslint-disable-line one-var
	var sc1 = prob.layout.sc1, sc2 = prob.layout.sc2, M = prob.M, N = prob.N, K = prob.K; // eslint-disable-line one-var
	var A = prob.A, B = prob.B, C = prob.C; // eslint-disable-line one-var
	var cutoff, levels, base; // eslint-disable-line one-var

	if ( alg === 'A0' || alg === 'SENTINEL' ) {
		return function a0() {
			return dgemm( transA, transB, M, N, K, alpha, A, sa1, sa2, 0, B, sb1, sb2, 0, beta, C, sc1, sc2, 0 );
		};
	}
	if ( alg === 'A1' || alg === 'A2' ) {
		base = lib.base;
		cutoff = params.cutoff;
		levels = params.levels;
		return function sw() {
			return base( transA, transB, M, N, K, alpha, A, sa1, sa2, 0, B, sb1, sb2, 0, beta, C, sc1, sc2, 0, cutoff, levels );
		};
	}
	if ( alg === 'C1' ) {
		return function c1() {
			return packed( transA, transB, M, N, K, alpha, A, sa1, sa2, 0, B, sb1, sb2, 0, beta, C, sc1, sc2, 0 );
		};
	}
	if ( alg === 'C2' ) {
		cutoff = params.cutoff;
		levels = params.levels;
		return function c2() {
			return classic( transA, transB, M, N, K, alpha, A, sa1, sa2, 0, B, sb1, sb2, 0, beta, C, sc1, sc2, 0, cutoff, levels );
		};
	}
	throw new Error( 'unknown algorithm key: ' + alg );
}

/**
* Returns the number of recursion levels an algorithm performs (`null` for non-recursive algorithms).
*
* @param {string} alg - algorithm key
* @param {(Object|null)} params - resolved parameters
* @param {PositiveInteger} M - rows
* @param {PositiveInteger} N - columns
* @param {PositiveInteger} K - inner dimension
* @param {Object} lib - library handle
* @returns {(NonNegativeInteger|null)} levels
*/
function depthOf( alg, params, M, N, K, lib ) {
	if ( alg === 'A1' || alg === 'A2' ) {
		return lib.depth( M, N, K, params.cutoff, params.levels );
	}
	if ( alg === 'C2' ) {
		return classic.depth( M, N, K, params.cutoff, params.levels );
	}
	return null;
}

/**
* Returns the analytic number of bytes an algorithm allocates per call (protocol §9, H5).
*
* ## Notes
*
* -   SW (A1, A2): `8·workspaceLength(M,N,K,cutoff,levels)`, plus `8·M·N` for the product temporary when `β ≠ 0`; 0 when `base.js` delegates to `dgemm` (quick returns, depth 0, `α = 0`, `K = 0`, non-finite `α`/`β`; data-dependent delegations do not occur for U(-1,1) inputs). C1: `8·K·N` (packed buffer). A0, SENTINEL, C2: 0.
*
* @param {string} alg - algorithm key
* @param {(Object|null)} params - resolved parameters
* @param {Object} prob - problem (or any object with `M`, `N`, `K`, `alpha`, `beta`)
* @param {Object} lib - library handle
* @returns {NonNegativeInteger} bytes
*/
function analyticBytes( alg, params, prob, lib ) {
	var alpha = prob.alpha;
	var beta = prob.beta;
	var M = prob.M;
	var N = prob.N;
	var K = prob.K;
	if ( alg === 'A1' || alg === 'A2' ) {
		if ( M === 0 || N === 0 || ( beta === 1.0 && ( alpha === 0.0 || K === 0 ) ) ) {
			return 0;
		}
		if ( lib.depth( M, N, K, params.cutoff, params.levels ) === 0 || alpha === 0.0 || K === 0 || !isFinite( alpha ) || !isFinite( beta ) ) {
			return 0;
		}
		return 8 * ( lib.workspaceLength( M, N, K, params.cutoff, params.levels ) + ( ( beta === 0.0 ) ? 0 : M*N ) );
	}
	if ( alg === 'C1' ) {
		return ( M === 0 || N === 0 || K === 0 || alpha === 0.0 ) ? 0 : 8*K*N;
	}
	return 0;
}


// EXPORTS //

module.exports = {
	'ALGS': ALGS,
	'DEFAULT_LEVELS': DEFAULT_LEVELS,
	'DEFAULT_REPO_ROOT': DEFAULT_REPO_ROOT,
	'FREIVALDS_TOL': FREIVALDS_TOL,
	'PKG_LIB': PKG_LIB,
	'analyticBytes': analyticBytes,
	'check': check,
	'checksum': checksum,
	'create': create,
	'createProblem': createProblem,
	'depthOf': depthOf,
	'freivalds': freivalds,
	'layout': layout,
	'library': library,
	'resolveParams': resolveParams
};
