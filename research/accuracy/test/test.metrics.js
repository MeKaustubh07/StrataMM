'use strict';

// Metrics on hand-built inputs with known errors, bound constants, order statistics, and κ bins.

// MODULES //

var tape = require( 'tape' );
var metrics = require( './../metrics.js' );
var rng = require( './../rng.js' );


// VARIABLES //

var U = Math.pow( 2.0, -53 );


// FUNCTIONS //

/**
* Returns the hand-built 2×2 case (K = 4, ‖A‖_M = 2, ‖B‖_M = 4):
*   entry 0: C = 8,            Ĉ = 8 + 2^-48   => E = 2^-48 = 32u, AB = 8  => η_c = 4,    rel = 2^-51
*   entry 1: C = -4,           Ĉ = -4          => E = 0,           AB = 16 => η_c = 0,    rel = 0
*   entry 2: C = 0,            Ĉ = 2^-50       => E = 2^-50 = 8u,  AB = 4  => η_c = 2,    rel = Inf
*   entry 3: C = 2 + 2^-60,    Ĉ = 2           => E = 2^-60,       AB = 2  => η_c = 2^-8, rel = 2^-61
*
* @private
* @returns {Object} inputs for `metrics.compute`
*/
function handBuilt() {
	return {
		'M': 2,
		'N': 2,
		'K': 4,
		'L': 0,
		'C': new Float64Array( [ 8.0 + Math.pow( 2, -48 ), -4.0, Math.pow( 2, -50 ), 2.0 ] ),
		'hi': new Float64Array( [ 8.0, -4.0, 0.0, 2.0 ] ),
		'lo': new Float64Array( [ 0.0, 0.0, 0.0, Math.pow( 2, -60 ) ] ),
		'AB': new Float64Array( [ 8.0, 16.0, 4.0, 2.0 ] ),
		'maxA': 2.0,
		'maxB': 4.0,
		'kappa': true
	};
}


// TESTS //

tape( 'metrics: normwise, componentwise, relative-to-C, Frobenius and POC metrics on a hand-built case', function test( t ) {
	var r = metrics.compute( handBuilt() );
	var m = r.metrics;
	var eF = Math.sqrt( Math.pow( 2, -96 ) + Math.pow( 2, -100 ) + Math.pow( 2, -120 ) ) / ( U * Math.sqrt( 64 + 256 + 16 + 4 ) );
	t.strictEqual( m.max_E, Math.pow( 2, -48 ), 'max E' );
	t.strictEqual( m.eta_N, 4, 'eta_N = 2^-48 / (u*2*4) = 4' );
	t.strictEqual( m.f_W, 16, 'f_W(K=4, L=0) = K^2' );
	t.strictEqual( m.rho_N, 0.25, 'rho_N = 4/16' );
	t.strictEqual( m.eta_C.max, 4, 'eta_C max' );
	t.strictEqual( m.eta_C.median, Math.pow( 2, -8 ), 'eta_C median (nearest rank 2 of {0, 2^-8, 2, 4})' );
	t.strictEqual( m.eta_C.p999, 4, 'eta_C p99.9' );
	t.strictEqual( m.eta_R, 4, 'eta_R = 2^-48/(u*8)' );
	t.strictEqual( m.eta_M, 2, 'eta_M = 2^-48/(u*16)' );
	t.ok( Math.abs( m.eta_F - eF ) <= 1e-15 * eF, 'eta_F = ||E||_F / (u ||AB||_F) (' + m.eta_F + ' vs ' + eF + ')' );
	t.strictEqual( m.exact, false, 'not exact' );
	t.strictEqual( m.n_nonfinite, 0, 'no non-finite entries' );
	t.end();
});

tape( 'metrics: per-entry relative errors and histograms (zero C, infinite relative error, bins)', function test( t ) {
	var m = metrics.compute( handBuilt() ).metrics;
	t.strictEqual( m.rel.frac_ge1, 0.25, 'only the C = 0 entry with E > 0 has no correct digit' );
	t.strictEqual( m.rel.frac_ge1e8, 0.25, 'frac E >= 1e-8|C|' );
	t.strictEqual( m.rel.max, Math.pow( 2, -51 ), 'max relative error over C != 0' );
	t.strictEqual( m.rel.p999, Math.pow( 2, -51 ), 'p99.9 relative error over C != 0' );
	t.strictEqual( m.rel.n_czero, 1, 'one zero entry' );
	t.strictEqual( m.rel.n_inf, 1, 'one infinite relative error' );
	t.strictEqual( m.hist_rel.counts[ Math.floor( ( -51 + 120 ) / 3 ) ], 1, 'log2 rel = -51 binned' );
	t.strictEqual( m.hist_rel.counts[ Math.floor( ( -61 + 120 ) / 3 ) ], 1, 'log2 rel = -61 binned' );
	t.strictEqual( m.hist_rel.zero, 1, 'one exact entry' );
	t.strictEqual( m.hist_rel.inf, 1, 'one infinite entry' );
	t.strictEqual( m.hist_c.counts[ Math.floor( ( 2 + 64 ) / 3 ) ], 1, 'eta_c = 4 binned' );
	t.strictEqual( m.hist_c.counts[ Math.floor( ( 1 + 64 ) / 3 ) ], 1, 'eta_c = 2 binned' );
	t.strictEqual( m.hist_c.counts[ Math.floor( ( -8 + 64 ) / 3 ) ], 1, 'eta_c = 2^-8 binned' );
	t.strictEqual( m.hist_c.zero, 1, 'eta_c = 0 counted as zero' );
	t.strictEqual( m.hist_c.counts.length, 64, '64 bins' );
	t.end();
});

tape( 'metrics: worst entries are ordered by componentwise error and argmax indices are reported', function test( t ) {
	var r = metrics.compute( handBuilt() );
	t.deepEqual( r.worst.map( function ij( w ) {
		return [ w.i, w.j ];
	}), [ [ 0, 0 ], [ 1, 0 ], [ 1, 1 ], [ 0, 1 ] ], 'order by eta_c: 4, 2, 2^-8, 0' );
	t.strictEqual( r.worst[ 0 ].eta_c, 4, 'worst eta_c' );
	t.strictEqual( r.worst[ 1 ].rel, null, 'relative error of a zero entry is null' );
	t.deepEqual( r.argmax.N, [ 0, 0 ], 'argmax E' );
	t.deepEqual( r.argmax.rel, [ 0, 0 ], 'argmax relative error (C != 0)' );
	t.end();
});

tape( 'metrics: κ bins (one per decade of (|A||B|)_ij/|C_ij|) for F9', function test( t ) {
	var k = metrics.compute( handBuilt() ).metrics.kappa;
	t.deepEqual( k.bins, [ {
		'log10_kappa': 0,
		'n': 3,
		'rel_max': Math.pow( 2, -51 ),
		'rel_median': Math.pow( 2, -61 )
	} ], 'kappa in {1, 4, 1} share decade 0' );
	t.deepEqual( k.czero, { 'n': 1, 'n_err': 1 }, 'zero entries reported separately' );
	t.end();
});

tape( 'metrics: exact results and non-finite outputs', function test( t ) {
	var o = handBuilt();
	var m;
	o.C = Float64Array.from( o.hi );
	o.lo = new Float64Array( 4 );
	m = metrics.compute( o ).metrics;
	t.strictEqual( m.exact, true, 'exact when Ĉ = hi and lo = 0' );
	t.strictEqual( m.eta_N, 0, 'zero error' );
	o.C[ 1 ] = NaN;
	m = metrics.compute( o ).metrics;
	t.strictEqual( m.n_nonfinite, 1, 'NaN counted' );
	t.strictEqual( m.exact, false, 'non-finite output is not exact' );
	t.end();
});

tape( 'bound constants: f_W and f_S satisfy their recurrences f(2h) = 18 f(h) + 89 h and f(2h) = 12 f(h) + 50 h', function test( t ) {
	var n0;
	var L;
	var h;
	for ( n0 = 1; n0 <= 64; n0 *= 2 ) {
		t.strictEqual( metrics.fW( n0, 0 ), n0*n0, 'f_W(n0, 0) = n0^2' );
		for ( L = 1; L <= 6; L++ ) {
			h = n0 * Math.pow( 2, L-1 );
			t.ok( Math.abs( metrics.fW( 2*h, L ) - ( ( 18*metrics.fW( h, L-1 ) ) + ( 89*h ) ) ) <= 1e-12 * metrics.fW( 2*h, L ), 'f_W recurrence n0=' + n0 + ' L=' + L );
			t.ok( Math.abs( metrics.fS( 2*h, L ) - ( ( 12*metrics.fS( h, L-1 ) ) + ( 50*h ) ) ) <= 1e-12 * metrics.fS( 2*h, L ), 'f_S recurrence n0=' + n0 + ' L=' + L );
		}
	}
	t.ok( Math.abs( metrics.fW( 1024, 6 ) - 1.17e10 ) < 0.01e10, 'f_W(1024, 6) ≈ 1.17e10 (protocol §8)' );
	t.end();
});

tape( 'order statistics: quickselect matches sorting (nearest-rank quantiles)', function test( t ) {
	var u = rng.uniform( 99 );
	var ns = [ 1, 2, 3, 10, 101, 1000, 4097 ];
	var ps = [ 0.5, 0.999, 1.0, 0.001 ];
	var ok = true;
	var x;
	var s;
	var i;
	var j;
	var k;
	for ( i = 0; i < ns.length; i++ ) {
		x = new Float64Array( ns[ i ] );
		for ( j = 0; j < x.length; j++ ) {
			x[ j ] = ( j % 7 === 0 ) ? 0.5 : u(); // with ties
		}
		s = Float64Array.from( x ).sort();
		for ( k = 0; k < ps.length; k++ ) {
			if ( metrics.quantile( Float64Array.from( x ), x.length, ps[ k ] ) !== s[ Math.max( 0, Math.ceil( ps[ k ]*x.length ) - 1 ) ] ) {
				ok = false;
			}
		}
	}
	t.ok( ok, 'all quantiles equal the sorted nearest-rank values' );
	t.strictEqual( metrics.quantile( new Float64Array( 0 ), 0, 0.5 ), null, 'empty => null' );
	t.end();
});
