'use strict';

/**
* Tests for the §7 crossover procedures on synthetic data with known ground truth.
*/

var tape = require( 'tape' );
var xo = require( '../crossover.js' );
var stats = require( '../stats.js' );
var prng = require( '../lib/prng.js' );

var P = xo.FAMILIES.P;


/**
* Returns crossover points for true speedups `S` (one per size) with paired blocks.
*
* @private
*/
function points( S, sizes, opts ) {
	var g = prng.createRng( opts.seed || 1 );
	return sizes.map( function each( n, i ) {
		var ref = new Map();
		var alg = new Map();
		var res;
		var b;
		var be;
		var id;
		for ( b = 0; b < ( opts.r || 8 ); b++ ) {
			be = 0.01 * g.normal();
			id = ( opts.shared ) ? 'b' + b : n + '/' + b;
			ref.set( id, 100 * Math.exp( be + ( opts.noise * g.normal() ) ) );
			alg.set( id, ( 100 / S[ i ] ) * Math.exp( be + ( opts.noise * g.normal() ) ) );
		}
		res = stats.pairedRatio( ref, alg, { 'B': 2000, 'seed': i+1 } );
		return { 'n': n, 'ref': ref, 'alg': alg, 'S': res.est, 'lo': res.lo, 'hi': res.hi, 'verdict': stats.verdict( res.est, res.lo, res.hi ), 'low_replication': res.low_replication };
	});
}

tape( 'fixed-sequence test on a non-monotone S(n) stops at the first failure from n_max down', function t( q ) {
	var pts = [ 0.8, 0.95, 1.05, 0.97, 1.10, 1.20, 1.30 ].map( function each( s, i ) {
		return { 'n': P[ i ], 'S': s, 'lo': s - 0.01, 'hi': s + 0.01, 'verdict': stats.verdict( s, s - 0.01, s + 0.01 ) };
	});
	var res = xo.fixedSequence( pts, P, 'ci_lower_gt_1' );
	q.equal( res.n_star, 256, 'n*₁ = 256 (§7: the smallest n such that every larger n passes): 2048, 1024, 512 pass; 256 fails' );
	q.equal( res.smallest_passing, 512, 'the smallest passing size is one family step above n*' );
	q.equal( res.status, 'partial' );
	q.equal( res.censored, null );
	q.equal( res.stopped_at, 256 );
	q.equal( res.label, '256 (every n ≥ 512 passes)' );
	q.equal( res.tested.length, 4, '128 (S = 1.05) is never tested: the sequence stopped above it' );
	res = xo.fixedSequence( pts, P, 'faster' );
	q.equal( res.n_star, 256, 'θ = 1.02 with "faster" verdicts' );
	pts[ 5 ] = { 'n': 1024, 'S': 1.015, 'lo': 1.005, 'hi': 1.025, 'verdict': stats.verdict( 1.015, 1.005, 1.025 ) };
	q.equal( pts[ 5 ].verdict, 'faster (<2% margin)' );
	res = xo.fixedSequence( pts, P, 'faster' );
	q.equal( res.n_star, 1024, '"faster (<2% margin)" fails the practical threshold: the sequence stops at 1024' );
	q.equal( res.smallest_passing, 2048 );
	q.equal( xo.fixedSequence( pts, P, 'ci_lower_gt_1' ).n_star, 256, 'but passes break-even (CI lower > 1)' );
	q.end();
});

tape( 'fixed-sequence edge cases: n_max not measured (censored, not a failure), n_max fails, a missing smaller size, all pass', function t( q ) {
	var all = P.map( function each( n ) {
		return { 'n': n, 'S': 1.3, 'lo': 1.2, 'hi': 1.4, 'verdict': 'faster' };
	});
	var res = xo.fixedSequence( all.slice( 0, 6 ), P, 'ci_lower_gt_1' );
	q.equal( res.status, 'not_measured', 'a missing n_max cell means no test' );
	q.equal( res.censored, 'not_measured' );
	q.equal( res.reason, 'missing cell' );
	q.equal( res.n_star, null );
	q.ok( /^not measured/.test( res.label ) && !/fails/.test( res.label ), res.label );
	res = xo.fixedSequence( all.slice( 0, 6 ).concat( [ { 'n': 2048, 'S': 1.3, 'lo': NaN, 'hi': NaN, 'verdict': 'inconclusive' } ] ), P, 'ci_lower_gt_1' );
	q.ok( res.status === 'not_measured' && res.reason === 'no CI', 'no CI at n_max: no test either' );
	res = xo.fixedSequence( all.slice( 0, 6 ).concat( [ { 'n': 2048, 'S': 0.9, 'lo': 0.85, 'hi': 0.95, 'verdict': 'slower' } ] ), P, 'ci_lower_gt_1' );
	q.ok( res.status === 'none' && res.censored === 'right' && res.n_star === null && /^> 2048 \(fails at n_max\)/.test( res.label ), 'n_max fails: > n_max, right-censored' );
	res = xo.fixedSequence( all.filter( function f( p ) {
		return p.n !== 256;
	}), P, 'ci_lower_gt_1' );
	q.ok( res.status === 'partial' && res.n_star === 256 && res.censored === 'stopped_at_missing' && res.reason === 'missing cell', 'a missing smaller size stops the test: n* = that size, censored (' + res.label + ')' );
	res = xo.fixedSequence( all, P, 'faster' );
	q.equal( res.status, 'all' );
	q.equal( res.censored, 'left' );
	q.equal( res.n_star, 32 );
	q.ok( /^≤ 32/.test( res.label ), res.label );
	q.ok( /smallest n of the family such that every larger n passes/.test( res.definition ), 'the definition travels with the result' );
	q.end();
});

tape( 'last upward crossing (log₂ n interpolation)', function t( q ) {
	var x = [ 5, 6, 7, 8, 9 ];
	q.deepEqual( xo.lastCrossing( [ 0, 1 ], [ -1, 1 ] ), { 'status': 'crossed', 'x': 0.5 } );
	q.equal( xo.lastCrossing( x, [ -0.2, 0.05, -0.03, 0.1, 0.2 ] ).x, 7 + ( 0.03 / 0.13 ), 'non-monotone: the crossing after the last size below θ' );
	q.equal( xo.lastCrossing( x, [ 0.1, 0.2, 0.3, 0.1, 0.0 ] ).status, 'left', 'at or above θ everywhere → < n_min' );
	q.equal( xo.lastCrossing( x, [ 0.1, 0.2, 0.3, 0.1, -0.01 ] ).status, 'right', 'below θ at n_max → > n_max' );
	q.end();
});

tape( 'interpolated crossover inside bootstrap replicates recovers the known crossing of a non-monotone S(n)', function t( q ) {
	var S = [ 0.8, 0.95, 1.05, 0.97, 1.10, 1.20, 1.30 ];
	var truth = Math.pow( 2, 8 + ( -Math.log( 0.97 ) / ( Math.log( 1.10 ) - Math.log( 0.97 ) ) ) );
	var res = xo.interpolate( points( S, P, { 'noise': 0.003, 'seed': 3 } ), 1.0, { 'B': 4000, 'seed': 9 } );
	q.ok( Math.abs( res.median / truth - 1 ) < 0.03, 'median ' + res.median.toFixed( 1 ) + ' ≈ truth ' + truth.toFixed( 1 ) + ' (between 256 and 512, not the earlier 64–128 crossing)' );
	q.ok( res.lo <= truth && truth <= res.hi, 'interval [' + res.lo.toFixed( 1 ) + ', ' + res.hi.toFixed( 1 ) + '] covers the truth' );
	q.equal( res.frac_left + res.frac_right, 0, 'no censored replicates' );
	q.equal( res.resampling, 'independent', 'different block ids per size → independent resampling' );
	q.equal( xo.interpolate( points( S, P, { 'noise': 0.003, 'seed': 3, 'shared': true } ), 1.0, { 'B': 200 } ).resampling, 'joint', 'one block spanning all sizes → joint resampling' );
	q.end();
});

tape( 'censoring: below θ at n_max (right) and above θ everywhere (left)', function t( q ) {
	var below = xo.interpolate( points( P.map( function f() {
		return 0.9;
	}), P, { 'noise': 0.003 } ), 1.0, { 'B': 1000 } );
	var above = xo.interpolate( points( P.map( function f() {
		return 1.2;
	}), P, { 'noise': 0.003 } ), 1.02, { 'B': 1000 } );
	q.equal( below.frac_right, 1, 'all replicates right-censored' );
	q.equal( below.median, Infinity );
	q.equal( below.labels.median, '> 2048' );
	q.equal( below.labels.interval, '[> 2048, > 2048]' );
	q.equal( above.frac_left, 1, 'all replicates left-censored' );
	q.equal( above.median, -Infinity );
	q.equal( above.labels.median, '< 32' );
	q.deepEqual( JSON.parse( JSON.stringify( below.censoring ) ), { 'observed': 'right', 'median': 'right', 'lo': 'right', 'hi': 'right' }, 'right censoring survives JSON (±∞ → null)' );
	q.deepEqual( JSON.parse( JSON.stringify( above.censoring ) ), { 'observed': 'left', 'median': 'left', 'lo': 'left', 'hi': 'left' }, 'left censoring survives JSON' );
	q.equal( xo.interpolate( [], 1.0 ).censoring.median, 'none', 'no points: no estimate' );
	q.end();
});

tape( 'A2 uses only sizes above τ* (identical code path to A0 below)', function t( q ) {
	var S = [ 0.5, 0.5, 1.01, 1.10, 1.25, 1.45, 1.60 ];
	var pts = points( S, P, { 'noise': 0.003, 'seed': 5 } );
	var res = xo.crossover( { 'family': 'P', 'sizes': P, 'alg': 'A2', 'theta': 1.02, 'rule': 'faster', 'name': 'practical', 'primary': true, 'minExclusive': 64 }, function get( alg, n ) {
		return pts.filter( function f( p ) {
			return p.n === n;
		})[ 0 ] || null;
	}, { 'B': 2000, 'seed': 4 } );
	var truth = Math.pow( 2, 7 + ( ( Math.log( 1.02 ) - Math.log( 1.01 ) ) / ( Math.log( 1.10 ) - Math.log( 1.01 ) ) ) );
	q.deepEqual( res.sizes, [ 128, 256, 512, 1024, 2048 ], 'sizes ≤ τ* = 64 dropped' );
	q.equal( res.fixed_sequence.n_star, 128, 'n*₁.₀₂ = 128 (§7: every larger n is "faster"; 128 has S = 1.01)' );
	q.equal( res.fixed_sequence.smallest_passing, 256 );
	q.ok( Math.abs( res.interpolation.median / truth - 1 ) < 0.05, 'interpolated ' + res.interpolation.median.toFixed( 1 ) + ' ≈ ' + truth.toFixed( 1 ) );
	q.ok( res.primary && res.pre_registered, 'P family with the pre-registered pairing is primary' );
	q.end();
});
