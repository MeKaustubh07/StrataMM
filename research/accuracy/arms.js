'use strict';

// E6 accuracy arms: A0 = dgemm.ndarray; SW(L) = base(..., cutoff=1, levels=L); V1(L) = classic Strassen-18;
// V2(L) = SW with outside+inside power-of-two diagonal scaling. All run row-major, NN, α = 1, β = 0, LD = n
// (dgemm's blocked path for every leaf), into a NaN-prefilled C (β = 0 must overwrite every entry).

// MODULES //

var dgemm = require( '@stdlib/blas/base/dgemm' ).ndarray;
var paths = require( './paths.js' );
var base = require( paths.BASE );
var depth = require( paths.DEPTH );
var strassen18 = require( './strassen18.js' );
var scaledSW = require( './scaling.js' );


// VARIABLES //

var NT = 'no-transpose';
var CUTOFF = 1;
var V2_FAMILIES = [ 'F4', 'F5', 'F6', 'F7' ];


// FUNCTIONS //

/**
* Returns the arms evaluated for a family: A0, SW and V1 at L = 1..Lmax, and V2 at L = 1..Lmax on F4–F7.
*
* @param {string} family - family identifier
* @param {PositiveInteger} Lmax - maximum levels
* @returns {Array<Object>} arms `{ alg, levels }`
*/
function armsFor( family, Lmax ) {
	var out = [ { 'alg': 'A0', 'levels': 0 } ];
	var algs = [ 'SW', 'V1' ];
	var a;
	var L;
	if ( V2_FAMILIES.indexOf( family ) >= 0 ) {
		algs.push( 'V2' );
	}
	for ( a = 0; a < algs.length; a++ ) {
		for ( L = 1; L <= Lmax; L++ ) {
			out.push({
				'alg': algs[ a ],
				'levels': L
			});
		}
	}
	return out;
}

/**
* Returns the number of recursion levels an arm actually performs on an M×N×K problem (0 for A0).
*
* @param {Object} arm - arm
* @param {NonNegativeInteger} M - rows
* @param {NonNegativeInteger} N - columns
* @param {NonNegativeInteger} K - inner dimension
* @returns {NonNegativeInteger} levels performed
*/
function levelsPerformed( arm, M, N, K ) {
	return ( arm.alg === 'A0' ) ? 0 : depth( M, N, K, CUTOFF, arm.levels );
}

/**
* Computes C = A·B with an arm (row-major operands; C overwritten).
*
* @param {Object} arm - arm `{ alg, levels }`
* @param {NonNegativeInteger} M - rows of A
* @param {NonNegativeInteger} N - columns of B
* @param {NonNegativeInteger} K - inner dimension
* @param {Float64Array} A - row-major M×K
* @param {Float64Array} B - row-major K×N
* @param {Float64Array} C - row-major M×N output
* @param {Object} [stats] - receives V2 scaling exactness counts
* @throws {Error} unknown algorithm
* @returns {Float64Array} C
*/
function run( arm, M, N, K, A, B, C, stats ) {
	switch ( arm.alg ) {
	case 'A0':
		return dgemm( NT, NT, M, N, K, 1.0, A, K, 1, 0, B, N, 1, 0, 0.0, C, N, 1, 0 );
	case 'SW':
		return base( NT, NT, M, N, K, 1.0, A, K, 1, 0, B, N, 1, 0, 0.0, C, N, 1, 0, CUTOFF, arm.levels );
	case 'V1':
		return strassen18( NT, NT, M, N, K, 1.0, A, K, 1, 0, B, N, 1, 0, 0.0, C, N, 1, 0, CUTOFF, arm.levels );
	case 'V2':
		return scaledSW( NT, NT, M, N, K, 1.0, A, K, 1, 0, B, N, 1, 0, 0.0, C, N, 1, 0, CUTOFF, arm.levels, stats );
	default:
		throw new Error( 'arms: unknown algorithm ' + arm.alg );
	}
}

/**
* Computes |A||B| in plain double with dgemm (blocked path; only a normalizer, relative error <= gamma_K).
*
* @param {NonNegativeInteger} M - rows of A
* @param {NonNegativeInteger} N - columns of B
* @param {NonNegativeInteger} K - inner dimension
* @param {Float64Array} A - row-major M×K
* @param {Float64Array} B - row-major K×N
* @returns {Float64Array} |A||B| (row-major M×N)
*/
function absProduct( M, N, K, A, B ) {
	var AB = new Float64Array( M*N );
	var aa = A.map( Math.abs );
	var bb = B.map( Math.abs );
	return dgemm( NT, NT, M, N, K, 1.0, aa, K, 1, 0, bb, N, 1, 0, 0.0, AB, N, 1, 0 );
}


// EXPORTS //

module.exports = {
	'CUTOFF': CUTOFF,
	'V2_FAMILIES': V2_FAMILIES,
	'armsFor': armsFor,
	'levelsPerformed': levelsPerformed,
	'run': run,
	'absProduct': absProduct
};
