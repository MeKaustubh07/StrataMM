'use strict';

// Matrix inverse by Gauss–Jordan elimination with partial pivoting (used only to generate F9b, B = fl(inv(A))).

// FUNCTIONS //

/**
* Returns `fl(inv(A))` for a row-major n×n matrix (deterministic; the accuracy of the inverse is irrelevant because
* the computed B is itself the test input).
*
* @param {PositiveInteger} n - order
* @param {Float64Array} A - row-major n×n matrix (not modified)
* @throws {Error} matrix must be numerically nonsingular
* @returns {Float64Array} row-major inverse
*/
function inverse( n, A ) {
	var w = 2 * n;
	var X = new Float64Array( n * w );
	var out;
	var piv;
	var ik;
	var pk;
	var f;
	var t;
	var i;
	var j;
	var k;
	var p;

	// Augmented matrix [A | I]...
	for ( i = 0; i < n; i++ ) {
		for ( j = 0; j < n; j++ ) {
			X[ ( i*w )+j ] = A[ ( i*n )+j ];
		}
		X[ ( i*w )+n+i ] = 1.0;
	}
	for ( k = 0; k < n; k++ ) {
		// Partial pivoting...
		p = k;
		for ( i = k+1; i < n; i++ ) {
			if ( Math.abs( X[ ( i*w )+k ] ) > Math.abs( X[ ( p*w )+k ] ) ) {
				p = i;
			}
		}
		piv = X[ ( p*w )+k ];
		if ( piv === 0.0 || !isFinite( piv ) ) {
			throw new Error( 'inverse: singular matrix' );
		}
		if ( p !== k ) {
			for ( j = 0; j < w; j++ ) {
				t = X[ ( k*w )+j ];
				X[ ( k*w )+j ] = X[ ( p*w )+j ];
				X[ ( p*w )+j ] = t;
			}
		}
		pk = k * w;
		for ( j = k; j < w; j++ ) {
			X[ pk+j ] /= piv;
		}
		// Eliminate column k from every other row...
		for ( i = 0; i < n; i++ ) {
			if ( i === k ) {
				continue;
			}
			ik = i * w;
			f = X[ ik+k ];
			if ( f === 0.0 ) {
				continue;
			}
			for ( j = k; j < w; j++ ) {
				X[ ik+j ] -= f * X[ pk+j ];
			}
		}
	}
	out = new Float64Array( n * n );
	for ( i = 0; i < n; i++ ) {
		for ( j = 0; j < n; j++ ) {
			out[ ( i*n )+j ] = X[ ( i*w )+n+j ];
		}
	}
	return out;
}


// EXPORTS //

module.exports = inverse;
