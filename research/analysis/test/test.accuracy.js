'use strict';

/**
* Tests for the §8 accuracy aggregation, bounds, hard gates and warnings.
*/

var tape = require( 'tape' );
var acc = require( '../lib/accuracy.js' );
var checks = require( '../lib/acc_checks.js' );
var harness = require( '../../accuracy/gates.js' );


/**
* Returns an accuracy record.
*
* @private
*/
function rec( family, n, alg, L, seed, m ) {
	return {
		'type': 'accuracy', 'family': family, 'params': null, 'seed': seed, 'M': n, 'N': n, 'K': n, 'alg': alg, 'L': L,
		'k0': n / Math.pow( 2, L ),
		'metrics': Object.assign( { 'eta_N': 1, 'rho_N': 1e-6, 'eta_C': { 'max': 2, 'p999': 1, 'median': 0.5 }, 'eta_R': 1, 'eta_F': 1, 'eta_M': 1, 'rel': { 'frac_ge1': 0, 'frac_ge1e8': 0, 'max': 1e-15, 'p999': 1e-15 } }, m )
	};
}

tape( 'f_W bound: K² at L = 0 and the published n = 1024 values', function t( q ) {
	var want = [ 1.05e6, 4.8e6, 2.2e7, 1.0e8, 4.7e8, 2.3e9, 1.17e10 ];
	var L;
	q.equal( acc.fW( 0, 512, 512 ), 512*512, 'f_W(0) = K²' );
	for ( L = 0; L <= 6; L++ ) {
		q.ok( Math.abs( acc.fW( L, 1024 / Math.pow( 2, L ), 1024 ) / want[ L ] - 1 ) < 0.05, 'n = 1024, L = ' + L + ': ' + acc.fW( L, 1024 / Math.pow( 2, L ), 1024 ).toExponential( 2 ) );
	}
	q.ok( acc.fStrassen( 3, 128, 1024 ) < acc.fW( 3, 128, 1024 ), 'Strassen bound below Winograd bound' );
	q.end();
});

tape( 'hard gates: classic η_N ≥ K², classic η_C > K, SW/V1 ρ_N ≥ 1, F11 inexact', function t( q ) {
	var res = acc.aggregate( [
		rec( 'F2', 64, 'A0', 0, 1, { 'eta_N': 64*64 } ),
		rec( 'F2', 64, 'A0', 0, 2, { 'eta_C': { 'max': 65, 'p999': 1, 'median': 1 } } ),
		rec( 'F2', 64, 'SW', 2, 1, { 'rho_N': 1.0 } ),
		rec( 'F2', 64, 'V1', 2, 1, { 'rho_N': 0.99 } ),
		rec( 'F2', 64, 'V2', 2, 1, { 'rho_N': 5 } ),
		rec( 'F11', 64, 'SW', 1, 1, { 'eta_N': 0, 'eta_C': { 'max': 1e-3, 'p999': 0, 'median': 0 }, 'exact': false } ),
		rec( 'F11', 64, 'A0', 0, 1, { 'eta_N': 0, 'eta_C': { 'max': 0, 'p999': 0, 'median': 0 }, 'exact': true } )
	]);
	var rules = res.gates.map( function f( g ) {
		return g.rule;
	}).sort();
	q.deepEqual( rules, [ 'F11 inexact', 'SW rho_N >= 1', 'classic eta_C > K', 'classic eta_N >= K^2' ], 'exactly the four violations (V1 below 1 and V2 are not gated)' );
	q.ok( res.gates.every( function f( g ) {
		return g.src.file === 'accuracy.jsonl';
	}), 'every violation cites its record' );
	q.end();
});

tape( 'R_N, growth g (F2/F3, η_F) and the F1 warning', function t( q ) {
	var recs = [];
	var res;
	var g;
	[ 1, 2, 3 ].forEach( function each( seed ) {
		recs.push( rec( 'F2', 256, 'A0', 0, seed, { 'eta_N': 2, 'eta_F': 1 } ) );
		recs.push( rec( 'F2', 256, 'SW', 2, seed, { 'eta_N': 6, 'eta_F': Math.pow( 2.2, 2 ) } ) );
		recs.push( rec( 'F3', 256, 'A0', 0, seed, { 'eta_F': 1 } ) );
		recs.push( rec( 'F3', 256, 'SW', 1, seed, { 'eta_F': 3.5 } ) );
		recs.push( rec( 'F1', 256, 'A0', 0, seed, { 'eta_N': 2 } ) );
		recs.push( rec( 'F1', 256, 'SW', 2, seed, { 'eta_N': 4.2 } ) );
		recs.push( rec( 'F1', 256, 'SW', 3, seed, { 'eta_N': 3.8 } ) );
	});
	res = acc.aggregate( recs );
	g = res.groups.filter( function f( x ) {
		return x.family === 'F2' && x.alg === 'SW';
	})[ 0 ];
	q.equal( g.R_N.median, 3, 'R_N = η_N(SW)/η_N(A0) on the same seed' );
	q.equal( g.seeds, 3 );
	q.equal( g.src.lines.length, 3, 'group cites its records' );
	q.ok( Math.abs( res.growth.filter( function f( x ) {
		return x.family === 'F2';
	})[ 0 ].g - 2.2 ) < 1e-12, 'g = (η_F(L)/η_F(0))^(1/L)' );
	q.deepEqual( res.warnings.map( function f( w ) {
		return w.family + ':' + w.L;
	}).sort(), [ 'F1:2', 'F1:2', 'F1:2', 'F3:1' ], 'g = 3.5 (F3) warns; F1 at k₀ = 64, L = 2 is 2.1× worse in each of the 3 seeds (per-seed rule of the harness); L = 3 is 1.9× (no warning)' );
	q.equal( acc.lookupWorst( res, 'F2', 256, 'SW', 2, 'R_N' ), g, 'lookup by (family, n, arm, L)' );
	q.equal( acc.lookupWorst( res, 'F2', 512, 'SW', 2, 'R_N' ), null, 'no run at that n' );
	q.end();
});

tape( 'hard gates as the E6 harness evaluates them: non-finite output, NaN-safe (metrics stored as null), F11 exactness, persisted gate_violations', function t( q ) {
	var res = acc.aggregate( [
		rec( 'F2', 64, 'SW', 1, 1, { 'n_nonfinite': 2 } ),
		rec( 'F2', 64, 'A0', 0, 2, { 'eta_N': null } ),
		rec( 'F2', 64, 'SW', 2, 2, { 'rho_N': null } ),
		rec( 'F2', 64, 'V1', 1, 2, { 'rho_N': NaN } ),
		Object.assign( rec( 'F2', 64, 'A0', 0, 3, {} ), { 'gate_violations': [ 'classic eta_N >= K^2 (5e9 >= 4096)' ] } ),
		Object.assign( rec( 'F2', 64, 'SW', 1, 3, { 'n_nonfinite': 1 } ), { 'gate_violations': [ 'non-finite output entries: 1' ] } ),
		rec( 'F11', 64, 'SW', 1, 1, { 'eta_N': 0, 'max_E': 0, 'exact': false, 'eta_C': { 'max': 0, 'p999': 0, 'median': 0 } } ),
		rec( 'F11', 64, 'SW', 2, 1, { 'eta_N': 0, 'max_E': 0, 'exact': true, 'eta_C': { 'max': 0, 'p999': 0, 'median': 0 } } ),
		rec( 'F11', 64, 'SW', 3, 1, { 'eta_N': 0, 'max_E': 0, 'eta_C': { 'max': 0, 'p999': 0, 'median': 0 } } ),
		rec( 'F2', 64, 'A0', 0, 4, { 'eta_C': { 'max': null, 'p999': 0, 'median': 0 } } )
	]);
	var by = res.gates.map( function f( g ) {
		return g.family + ' ' + g.alg + ' L' + g.L + ' s' + g.seed + ': ' + g.rule + ' / ' + g.origin;
	}).sort();
	q.deepEqual( by, [
		'F11 SW L1 s1: F11 inexact / recomputed',
		'F11 SW L3 s1: F11 inexact / recomputed',
		'F2 A0 L0 s2: classic eta_N >= K^2 / recomputed',
		'F2 A0 L0 s3: classic eta_N >= K^2 / recorded',
		'F2 A0 L0 s4: classic eta_C > K / recomputed',
		'F2 SW L1 s1: non-finite output entries / recomputed',
		'F2 SW L1 s3: non-finite output entries / recomputed+recorded',
		'F2 SW L2 s2: SW rho_N >= 1 / recomputed',
		'F2 V1 L1 s2: V1 rho_N >= 1 / recomputed'
	], 'non-finite output gated; null/NaN metrics fail NaN-safe gates (η_N, η_C, ρ_N); F11 fails unless `exact` is true (also when it is missing); a persisted violation is kept even when the stored metrics pass, and counted once when both agree' );
	q.equal( res.groups.filter( function f( g ) {
		return g.family === 'F2' && g.alg === 'SW' && g.L === 1;
	})[ 0 ].gate_violations, 2, 'per-group gate counts use the union' );
	q.end();
});

tape( 'warnings as the E6 harness evaluates them: F1 per seed on η_N or η_C(max), V1 f_S, V2 scaling; persisted warnings and accuracy_warning records', function t( q ) {
	var res = acc.aggregate( [
		rec( 'F1', 256, 'A0', 0, 1, { 'eta_N': 2, 'eta_C': { 'max': 2, 'p999': 1, 'median': 0.5 } } ),
		rec( 'F1', 256, 'SW', 2, 1, { 'eta_N': 3, 'eta_C': { 'max': 5, 'p999': 1, 'median': 0.5 } } ),
		rec( 'F1', 256, 'SW', 5, 1, { 'eta_N': 9 } ),
		rec( 'F1', 64, 'A0', 0, 1, { 'eta_N': 2 } ),
		rec( 'F1', 64, 'SW', 2, 1, { 'eta_N': 9 } ),
		rec( 'F2', 64, 'V1', 1, 1, { 'eta_N': 13888, 'rho_N': 0.1 } ),
		rec( 'F4', 64, 'V2', 1, 1, { 'scale_inexact': 1, 'unscale_inexact': 0 } ),
		Object.assign( rec( 'F2', 64, 'SW', 1, 2, {} ), { 'warnings': [ 'some future harness warning' ] } ),
		rec( 'F3', 64, 'A0', 0, 1, { 'eta_F': 1 } ),
		rec( 'F3', 64, 'SW', 1, 1, { 'eta_F': 3.5 } )
	], { 'warnings': [
		{ 'type': 'accuracy_warning', 'rule': 'g = median over seeds of (eta_F(L)/eta_F(0))^(1/L) in [1.7, 3] (F2/F3)', 'family': 'F3', 'params': null, 'n': 64, 'L': 1, 'g': 3.5, 'seeds': 1 },
		{ 'type': 'accuracy_warning', 'rule': 'g = median over seeds of (eta_F(L)/eta_F(0))^(1/L) in [1.7, 3] (F2/F3)', 'family': 'F2', 'params': null, 'n': 128, 'L': 2, 'g': 3.9, 'seeds': 10 }
	] } );
	var by = res.warnings.map( function f( w ) {
		return w.family + ' n' + w.M + ' ' + w.alg + ' L' + w.L + ': ' + w.rule + ' / ' + w.origin;
	}).sort();
	q.deepEqual( by, [
		'F1 n256 SW L2: F1 k0>=32, L<=4: SW more than 2x worse than A0 / recomputed',
		'F2 n128 SW L2: g outside [1.7, 3] (F2/F3, eta_F) / recorded',
		'F2 n64 SW L1: some future harness warning / recorded',
		'F2 n64 V1 L1: V1 eta_N >= Strassen bound f_S / recomputed',
		'F3 n64 SW L1: g outside [1.7, 3] (F2/F3, eta_F) / recomputed+recorded',
		'F4 n64 V2 L1: V2 scaling not exact / recomputed'
	], 'F1 on η_C(max) alone (2.5×) warns, L > 4 and k₀ < 32 do not; V1 at f_S; V2 scaling; unknown persisted warnings kept verbatim; accuracy_warning records unioned with the recomputed g' );
	q.equal( res.n_warning_records, 2 );
	q.end();
});

tape( 'κ-binned relative error (F9): entries summed, median over seeds of the bin median, max over seeds of the bin max', function t( q ) {
	var k1 = { 'bins': [ { 'log10_kappa': 4, 'n': 10, 'rel_max': 1e-10, 'rel_median': 1e-12 }, { 'log10_kappa': 9, 'n': 5, 'rel_max': 1e-5, 'rel_median': 1e-7 } ], 'czero': { 'n': 2, 'n_err': 1 } };
	var k2 = { 'bins': [ { 'log10_kappa': 4, 'n': 12, 'rel_max': 3e-10, 'rel_median': 3e-12 } ], 'czero': { 'n': 1, 'n_err': 0 } };
	var res = acc.aggregate( [ rec( 'F9a', 64, 'SW', 1, 1, { 'kappa': k1 } ), rec( 'F9a', 64, 'SW', 1, 2, { 'kappa': k2 } ), rec( 'F9a', 64, 'SW', 1, 3, { 'kappa': k1 } ), rec( 'F2', 64, 'SW', 1, 1, {} ) ] );
	var g = res.groups.filter( function f( x ) {
		return x.family === 'F9a';
	})[ 0 ];
	q.equal( g.kappa.seeds, 3 );
	q.deepEqual( g.kappa.bins, [ { 'log10_kappa': 4, 'n': 32, 'seeds': 3, 'rel_median': 1e-12, 'rel_max': 3e-10 }, { 'log10_kappa': 9, 'n': 10, 'seeds': 2, 'rel_median': 1e-7, 'rel_max': 1e-5 } ] );
	q.deepEqual( g.kappa.czero, { 'n': 5, 'n_err': 2 } );
	q.equal( res.groups.filter( function f( x ) {
		return x.family === 'F2';
	})[ 0 ].kappa, null, 'no κ bins outside F9' );
	q.end();
});

tape( 'consistency with research/accuracy/gates.js on harness-shaped records, before and after the JSON round trip', function t( q ) {
	var shard = [
		hrec( 'A0', 0, { 'eta_N': 2, 'eta_C': { 'max': 2, 'p999': 1, 'median': 0.5 } } ),
		hrec( 'SW', 1, { 'eta_N': 4.5, 'eta_C': { 'max': 2, 'p999': 1, 'median': 0.5 } } ),
		hrec( 'SW', 2, { 'eta_N': 3, 'eta_C': { 'max': 4.4, 'p999': 1, 'median': 0.5 } } ),
		hrec( 'SW', 3, { 'eta_N': NaN, 'rho_N': NaN, 'n_nonfinite': 3, 'exact': false } ),
		hrec( 'V1', 1, { 'eta_N': 1e9, 'rho_N': 2 } ),
		hrec( 'V1', 2, { 'eta_N': 1 } )
	];
	var a0 = hrec( 'A0', 0, { 'eta_N': 300 * 300, 'eta_C': { 'max': 301, 'p999': 1, 'median': 0.5 } } );
	var mismatches = [];
	var flagged = 0;
	harness.shardWarnings( shard );
	shard.concat( [ a0 ] ).forEach( function each( r ) {
		var want = keys( harness.violations( r ), checks.GATE_RULES ) + ' | ' + keys( harness.recordWarnings( r ).concat( r.warnings ), checks.WARNING_RULES );
		flagged += ( want !== ' | ' ) ? 1 : 0;
		var x = acc.aggregate( ( r === a0 ) ? [ JSON.parse( JSON.stringify( a0 ) ) ] : JSON.parse( JSON.stringify( shard ) ) ).gates;
		var y = acc.aggregate( ( r === a0 ) ? [ JSON.parse( JSON.stringify( a0 ) ) ] : JSON.parse( JSON.stringify( shard.map( function f( z ) {
			return Object.assign( {}, z, { 'warnings': [] } );
		}) ) ) ).warnings;
		var got = keys( pick( x, r ).map( rule ), checks.GATE_RULES ) + ' | ' + keys( pick( y, r ).map( rule ), checks.WARNING_RULES );
		if ( got !== want ) {
			mismatches.push( r.alg + ' L' + r.L + ': harness ' + want + ' vs analysis ' + got );
		}
	});
	q.ok( flagged >= 5, flagged + ' of 7 records flagged by the harness (the comparison is not vacuous)' );
	q.deepEqual( mismatches, [], 'recomputed gates and warnings equal the harness verdicts (NaN metrics stored as null still fail)' );
	q.end();

	function hrec( alg, L, m ) {
		var K = ( m.eta_N === 300 * 300 ) ? 300 : 256;
		var k0 = K / Math.pow( 2, L );
		var fw = ( L ) ? ( Math.pow( 18, L ) * ( ( k0*k0 ) + ( 5.5625*k0 ) ) ) - ( 5.5625*K ) : K*K;
		var met = Object.assign( { 'eta_N': 1, 'eta_C': { 'max': 1, 'p999': 1, 'median': 0.5 }, 'f_W': fw, 'eta_R': 1, 'eta_F': 1, 'eta_M': 1, 'rel': { 'frac_ge1': 0, 'frac_ge1e8': 0, 'max': 0, 'p999': 0 }, 'max_E': 1, 'exact': false, 'n_nonfinite': 0 }, m );
		if ( m.rho_N === void 0 ) {
			met.rho_N = met.eta_N / fw;
		}
		return { 'type': 'accuracy', 'family': 'F1', 'params': null, 'seed': 7, 'M': K, 'N': K, 'K': K, 'alg': alg, 'L': L, 'k0': k0, 'metrics': met, 'warnings': [] };
	}

	function keys( list, rules ) {
		return list.map( function f( s ) {
			var i;
			for ( i = 0; i < rules.length; i++ ) {
				if ( String( s ).indexOf( rules[ i ] ) === 0 ) {
					return rules[ i ];
				}
			}
			return String( s );
		}).filter( function f( v, i, all ) {
			return all.indexOf( v ) === i;
		}).sort().join( ', ' );
	}

	function pick( list, r ) {
		return list.filter( function f( e ) {
			return e.alg === r.alg && e.L === r.L && e.K === r.K;
		});
	}

	function rule( e ) {
		return e.rule;
	}
});
