'use strict';

/**
* Tests for the §6 statistics on synthetic data with known ground truth.
*/

var tape = require( 'tape' );
var stats = require( '../stats.js' );
var prng = require( '../lib/prng.js' );

var V = stats.VERDICTS;


/**
* Returns block → value maps for a paired design with known true ratio S (A0 time / alg time).
*
* @private
*/
function pairedMaps( g, r, S, sBlock, sProc ) {
	var num = new Map();
	var den = new Map();
	var b;
	var be;
	for ( b = 0; b < r; b++ ) {
		be = sBlock * g.normal();
		num.set( b, 100.0 * Math.exp( be + ( sProc * g.normal() ) ) );
		den.set( b, ( 100.0 / S ) * Math.exp( be + ( sProc * g.normal() ) ) );
	}
	return [ num, den ];
}

tape( 'descriptive statistics (type-7 quantiles, non-numbers ignored)', function t( q ) {
	var d = stats.describe( [ 1, 2, 3, 4 ] );
	q.equal( stats.median( [ 3, 1, 2 ] ), 2, 'odd median' );
	q.equal( stats.median( [ 4, 1, 3, 2 ] ), 2.5, 'even median' );
	q.equal( stats.quantile( [ 1, 2, 3, 4, 5 ], 0.25 ), 2, 'type-7 quartile' );
	q.equal( d.iqr, 1.5, 'IQR' );
	q.equal( d.p90, 3.7, 'p90' );
	q.equal( stats.median( [ 1, null, 3, NaN, void 0, '7' ] ), 2, 'null, NaN, undefined and strings ignored' );
	q.ok( Number.isNaN( stats.median( [] ) ), 'empty → NaN' );
	q.end();
});

tape( 'steady-state classes', function t( q ) {
	q.equal( stats.steadyClass( [ 100, 100, 100, 100 ] ).class, 'flat' );
	q.equal( stats.steadyClass( [ 110, 105, 100, 100, 100 ] ).class, 'warmup' );
	q.equal( stats.steadyClass( [ 100, 100, 100, 104, 108 ] ).class, 'slowdown' );
	q.equal( stats.steadyClass( [ 100, 130, 70, 100, 140, 60 ] ).class, 'no_steady_state' );
	q.equal( stats.steadyClass( [ 1, 2 ] ).class, 'short' );
	q.end();
});

tape( 'verdict boundaries (§6, evaluated in protocol order)', function t( q ) {
	var cases = [
		[ 1.011, 1.004, 1.018, V.FASTER_MARGIN, 'review example: CI [1.004, 1.018] is faster (<2% margin), not equivalent' ],
		[ 1.03, 1.01, 1.05, V.FASTER, 'clear win' ],
		[ 1.02, 1.001, 1.04, V.FASTER, 'S = 1.02 is inclusive' ],
		[ 1.0199, 1.001, 1.04, V.FASTER_MARGIN, 'S just below 1.02' ],
		[ 1.0, 0.985, 1.015, V.EQUIVALENT, 'inside the band' ],
		[ 1.0, 0.98, 1.02, V.EQUIVALENT, 'band is closed' ],
		[ 1.01, 1.0, 1.019, V.EQUIVALENT, 'CI lower exactly 1 is not > 1' ],
		[ 0.97, 0.95, 0.99, V.SLOWER, 'clear loss' ],
		[ 0.98, 0.97, 0.99, V.SLOWER, 'S = 0.98 is inclusive' ],
		[ 0.985, 0.97, 0.995, V.INCONCLUSIVE, 'upper < 1 but S > 0.98 and CI leaves the band' ],
		[ 1.01, 0.99, 1.03, V.INCONCLUSIVE, 'straddles 1 and leaves the band' ],
		[ 1.0, 0.979, 1.0201, V.INCONCLUSIVE, 'just outside the band on both sides' ],
		[ NaN, NaN, NaN, V.INCONCLUSIVE, 'no estimate' ],
		[ 1.1, NaN, NaN, V.INCONCLUSIVE, 'no CI (r = 1)' ]
	];
	cases.forEach( function each( c ) {
		q.equal( stats.verdict( c[ 0 ], c[ 1 ], c[ 2 ] ), c[ 3 ], c[ 4 ] );
	});
	q.end();
});

tape( 'paired ratio: estimate = ratio of cell medians over paired blocks; seeded and reproducible', function t( q ) {
	var num = new Map( [ [ 1, 10 ], [ 2, 12 ], [ 3, 11 ], [ 4, 13 ], [ 5, 9 ], [ 6, 10.5 ] ] );
	var den = new Map( [ [ 2, 6 ], [ 3, 5.5 ], [ 4, 6.5 ], [ 5, 4.5 ], [ 6, 5 ], [ 7, 99 ] ] );
	var a = stats.pairedRatio( num, den, { 'B': 2000, 'seed': 7 } );
	var b = stats.pairedRatio( num, den, { 'B': 2000, 'seed': 7 } );
	q.deepEqual( a.blocks, [ 2, 3, 4, 5, 6 ], 'only blocks present in both cells are paired' );
	q.equal( a.r, 5 );
	q.equal( a.est, 11 / 5.5, 'median(12,11,13,9,10.5) / median(6,5.5,6.5,4.5,5)' );
	q.equal( a.method, 'block-bootstrap' );
	q.equal( a.seed, 7, 'seed recorded' );
	q.ok( a.lo <= a.est && a.est <= a.hi, 'CI brackets the estimate' );
	q.deepEqual( [ a.lo, a.hi ], [ b.lo, b.hi ], 'same seed, same CI' );
	q.end();
});

tape( 'paired ratio: r ≤ 4 uses the t-interval on log ratios (low replication)', function t( q ) {
	var ratios = [ 1.10, 1.12, 1.08, 1.11 ];
	var num = new Map();
	var den = new Map();
	var logs = ratios.map( Math.log );
	var m = stats.mean( logs );
	var half = 3.182446305283708 * stats.sd( logs ) / 2.0;
	var res;
	ratios.forEach( function each( x, i ) {
		num.set( 'b' + i, x * 50 );
		den.set( 'b' + i, 50 );
	});
	res = stats.pairedRatio( num, den );
	q.ok( res.low_replication, 'labelled low replication' );
	q.ok( /t-log \(df=3\)/.test( res.method ), 'method names df = r − 1' );
	q.ok( Math.abs( res.lo - Math.exp( m - half ) ) < 1e-12 && Math.abs( res.hi - Math.exp( m + half ) ) < 1e-12, 't_{0.975,3} interval on log ratios' );
	q.equal( res.block_ratios.length, 4, 'per-block ratios reported' );
	num.delete( 'b1' );
	num.delete( 'b2' );
	num.delete( 'b3' );
	res = stats.pairedRatio( num, den );
	q.equal( res.r, 1 );
	q.ok( Number.isNaN( res.lo ) && stats.verdict( res.est, res.lo, res.hi ) === V.INCONCLUSIVE, 'r = 1: no interval, inconclusive' );
	q.end();
});

tape( 'block bootstrap CI coverage sanity (r = 10, true S = 1.25)', function t( q ) {
	var g = prng.createRng( 4242 );
	var hits = 0;
	var width = 0;
	var N = 400;
	var res;
	var m;
	var i;
	for ( i = 0; i < N; i++ ) {
		m = pairedMaps( g, 10, 1.25, 0.02, 0.01 );
		res = stats.pairedRatio( m[ 0 ], m[ 1 ], { 'B': 2000, 'seed': i+1 } );
		if ( res.lo <= 1.25 && 1.25 <= res.hi ) {
			hits += 1;
		}
		width += ( res.hi - res.lo ) / N;
	}
	q.ok( hits / N >= 0.85 && hits / N <= 0.99, 'coverage ' + ( hits / N ).toFixed( 3 ) + ' within [0.85, 0.99] (percentile bootstrap of medians, r = 10)' );
	q.ok( width > 0.005 && width < 0.06, 'mean CI width ' + width.toFixed( 4 ) + ' plausible for 1% process noise' );
	q.end();
});

tape( 't-interval coverage sanity (r = 4, lognormal block ratios)', function t( q ) {
	var g = prng.createRng( 99 );
	var hits = 0;
	var N = 2000;
	var num;
	var den;
	var res;
	var i;
	var b;
	for ( i = 0; i < N; i++ ) {
		num = new Map();
		den = new Map();
		for ( b = 0; b < 4; b++ ) {
			num.set( b, 1.3 * Math.exp( 0.01 * g.normal() ) );
			den.set( b, 1.0 );
		}
		res = stats.pairedRatio( num, den );
		if ( res.lo <= 1.3 && 1.3 <= res.hi ) {
			hits += 1;
		}
	}
	q.ok( Math.abs( ( hits / N ) - 0.95 ) < 0.02, 'coverage ' + ( hits / N ).toFixed( 3 ) + ' ≈ 0.95 (exact for lognormal ratios)' );
	q.end();
});

tape( 'unpaired ratio fallback (independent bootstrap; Welch t when small)', function t( q ) {
	var res = stats.unpairedRatio( [ 10, 11, 12, 10.5, 11.5 ], [ 5, 5.5, 6, 5.2, 5.8 ], { 'B': 1000, 'seed': 3 } );
	q.equal( res.pairing, 'unpaired' );
	q.equal( res.est, 11 / 5.5 );
	q.ok( res.lo < res.est && res.est < res.hi, 'bootstrap CI brackets the estimate' );
	res = stats.unpairedRatio( [ 10, 11, 12 ], [ 5, 5.5, 6 ] );
	q.ok( res.low_replication && res.method === 'welch-t-log' && res.lo < 2 && res.hi > 2, 'Welch t-interval on logs when r ≤ 4' );
	q.end();
});

tape( 'ladder: ratios of cell medians, product identity, confounded flag at (8/7)^L', function t( q ) {
	var g = prng.createRng( 5 );
	var c = Math.pow( 8/7, 3 );
	var cells = {};
	var res;
	var terms = {};
	var mk = function mk( scale, noise ) {
		var m = new Map();
		var b;
		for ( b = 0; b < 6; b++ ) {
			m.set( b, scale * Math.exp( noise * g.normal() ) );
		}
		return m;
	};
	cells[ 'A0@0' ] = mk( 100, 0.003 );
	cells[ 'A0@8' ] = mk( 100 / 1.07, 0.003 );
	cells[ 'C2@0' ] = mk( 100 / 0.99, 0.003 );
	cells[ 'C2@8' ] = mk( 100 / 1.07, 0.003 );
	cells[ 'A2@0' ] = mk( 100 / ( 0.99 * 1.6 ), 0.003 );
	cells[ 'A2@8' ] = mk( 100 / ( 1.07 * 1.3 ), 0.003 );
	res = stats.ladder( function get( alg, pad ) {
		var m = cells[ alg + '@' + pad ];
		return ( m ) ? { 'id': alg + '@' + pad, 'byBlock': m } : null;
	}, 3, { 'B': 1000 } );
	res.terms.forEach( function each( x ) {
		terms[ x.name ] = x;
	});
	q.equal( res.ceiling, c, 'ceiling (8/7)^3' );
	q.ok( !terms.layout && !terms.packed_vs_sw, 'terms needing C1 are skipped when C1 was not run' );
	q.ok( terms.arith_n.confounded && terms.arith_n.est > c, 'C2/A2 ≈ 1.6 ≥ (8/7)^3 → confounded' );
	q.ok( !terms.arith_pad.confounded, 'C2/A2 ≈ 1.3 < (8/7)^3 → not confounded' );
	q.ok( Math.abs( terms.total_n.est - ( terms.recursion_n.est * terms.arith_n.est ) ) < 1e-12, 'total = recursion × arithmetic (same blocks)' );
	q.ok( Math.abs( terms.ld_A0.est / 1.07 - 1 ) < 0.01, 'LD penalty of A0 ≈ 7%' );
	q.ok( terms.recursion_pad.lo < 1.0 && terms.recursion_pad.hi > 1.0, 'C2 ≈ A0 at LD n+8: CI contains 1' );
	res = stats.ladder( function get( alg, pad ) {
		var m = new Map();
		var b;
		for ( b = 0; b < 5; b++ ) {
			m.set( b, ( alg === 'C2' ) ? c : 1.0 );
		}
		return ( pad === 0 && ( alg === 'C2' || alg === 'A2' ) ) ? { 'id': alg, 'byBlock': m } : null;
	}, 3, { 'B': 200 } );
	q.equal( res.terms[ 0 ].name, 'arith_n' );
	q.ok( res.terms[ 0 ].est === c && res.terms[ 0 ].confounded, 'exactly at the ceiling counts as confounded (≥)' );
	q.end();
});

tape( 'confounded rule direction: time(C2)/time(A2) ≥ (8/7)^L (§6 "A2/C2" = speedup of A2 over C2)', function t( q ) {
	var c = Math.pow( 8/7, 2 );
	var res;
	res = stats.ladder( getter( 1.4, 1.0 ), 2, { 'B': 200 } );
	q.equal( res.terms[ 0 ].name, 'arith_n', 'only the LD-n arithmetic term is computable' );
	q.ok( res.terms[ 0 ].est === 1.4 && res.terms[ 0 ].confounded, 'A2 1.4× faster than C2 (more than (8/7)^2 = ' + c.toFixed( 4 ) + '): confounded' );
	res = stats.ladder( getter( 1.0, 1.4 ), 2, { 'B': 200 } );
	q.ok( !res.terms[ 0 ].confounded && 1.0/res.terms[ 0 ].est >= c, 'A2 slower than C2: not confounded (the reversed time ratio A2/C2 would have flagged it)' );
	res = stats.ladder( getter( 1.2, 1.0 ), 2, { 'B': 200 } );
	q.ok( !res.terms[ 0 ].confounded, 'A2 1.2× faster than C2 (within the arithmetic saving): not confounded' );
	q.ok( /cell\(C2\)\/cell\(A2\) ≥ \(8\/7\)\^L/.test( res.rule ) && res.terms[ 0 ].rule === stats.CONFOUNDED_RULE, 'the formula is carried into the output' );
	q.end();

	function getter( c2, a2 ) {
		return function get( alg, pad ) {
			var m = new Map();
			var b;
			if ( pad !== 0 || ( alg !== 'C2' && alg !== 'A2' ) ) {
				return null;
			}
			for ( b = 0; b < 5; b++ ) {
				m.set( b, ( alg === 'C2' ) ? c2 : a2 );
			}
			return { 'id': alg, 'byBlock': m };
		};
	}
});

tape( 'position-in-block effect: detects an injected first-position penalty; calibrated under H0', function t( q ) {
	var g = prng.createRng( 11 );
	var make = function make( effect ) {
		var procs = [];
		var perm;
		var b;
		var j;
		for ( b = 0; b < 30; b++ ) {
			perm = [ 0, 1, 2 ].sort( function c() {
				return g.uniform() - 0.5;
			});
			for ( j = 0; j < 3; j++ ) {
				procs.push( { 'cell': 'c' + j, 'block_id': 'b' + b, 'pos_in_block': perm[ j ], 'median_ns': ( 100 * ( j+1 ) ) * Math.exp( ( 0.01 * ( b % 5 ) ) + ( 0.003 * g.normal() ) ) * ( ( perm[ j ] === 0 ) ? 1.0 + effect : 1.0 ) } );
			}
		}
		return procs;
	};
	var res = stats.positionEffect( make( 0.03 ), { 'B': 2000, 'seed': 1 } );
	var rejections = 0;
	var i;
	q.ok( res.p < 0.01, 'p = ' + res.p.toFixed( 4 ) + ' with a +3% first-position effect' );
	q.ok( res.positions[ 0 ].pos === 0 && res.positions[ 0 ].mean_pct > 1.5, 'position 0 effect ≈ +2% after block centring' );
	for ( i = 0; i < 20; i++ ) {
		if ( stats.positionEffect( make( 0 ), { 'B': 499, 'seed': i+1 } ).p < 0.05 ) {
			rejections += 1;
		}
	}
	q.ok( rejections <= 4, rejections + ' of 20 null datasets rejected at 5%' );
	q.end();
});
