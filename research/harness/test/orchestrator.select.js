'use strict';

// Tests for the §5.1 selection rule and automatic freeze (research/harness/resume.js: selectTau, pilotCells,
// batchTable, freeze) on synthetic pilot data, including ties, the band boundary and missing cells.

var tape = require( 'tape' );
var resume = require( './../resume.js' );
var design = require( './../design.js' );

var P = design.effective( design.loadProtocol().protocol, false );
var SIZES = [ 512, 1024 ];
var TAUS = [ 16, 32, 64, 128, 256 ];

// Two processes per cell with the given cell median (r = 2 ⇒ the cell median is their mean).
function cells( m512, m1024 ) {
	var out = { '512': {}, '1024': {} };
	TAUS.forEach( function each( t, i ) {
		if ( m512[ i ] !== null ) {
			out[ '512' ][ t ] = [ m512[ i ] - 1, m512[ i ] + 1 ];
		}
		if ( m1024[ i ] !== null ) {
			out[ '1024' ][ t ] = [ m1024[ i ] - 1, m1024[ i ] + 1 ];
		}
	});
	return out;
}

tape( 'largest tau within 1.02 x best at both sizes', function test( t ) {
	var r = resume.selectTau( cells( [ 100, 98, 99, 105, 120 ], [ 800, 790, 795, 830, 900 ] ), SIZES, TAUS, 1.02 );
	t.equal( r.t_best[ 512 ], 98, 't_best(512)' );
	t.equal( r.t_best[ 1024 ], 790, 't_best(1024)' );
	t.deepEqual( r.eligible, [ 32, 64 ], 'band at both sizes' );
	t.equal( r.tau_star, 64, 'largest eligible tau' );
	t.equal( r.fallback, false, 'no fallback' );
	t.end();
});

tape( 'the band is inclusive (median = 1.02 x t_best qualifies)', function test( t ) {
	var r = resume.selectTau( cells( [ 100, 100, 102, 103, 120 ], [ 1000, 1000, 1020, 1021, 1100 ] ), SIZES, TAUS, 1.02 );
	t.deepEqual( r.eligible, [ 16, 32, 64 ], 'boundary included, just above excluded' );
	t.equal( r.tau_star, 64, 'tau_star' );
	t.end();
});

tape( 'ties: equal medians resolve to the larger tau (fewest levels)', function test( t ) {
	var r = resume.selectTau( cells( [ 120, 110, 100, 100, 130 ], [ 900, 850, 800, 800, 990 ] ), SIZES, TAUS, 1.02 );
	t.deepEqual( r.eligible, [ 64, 128 ], 'both tied cells eligible' );
	t.equal( r.tau_star, 128, 'larger tau wins' );
	t.end();
});

tape( 'missing cells: a tau without a cell at either size is ineligible', function test( t ) {
	var r = resume.selectTau( cells( [ 100, 99, 98, 98.5, 120 ], [ 800, 790, 792, null, 900 ] ), SIZES, TAUS, 1.02 );
	t.equal( r.medians[ 1024 ][ 128 ], void 0, 'no 1024 cell for tau=128' );
	t.deepEqual( r.eligible, [ 32, 64 ], 'tau=128 ineligible despite its 512 cell (tau=16: 100 > 1.02 x 98)' );
	t.equal( r.tau_star, 64, 'tau_star' );
	t.end();
});

tape( 'missing cells: t_best is the minimum over the available cells', function test( t ) {
	var r = resume.selectTau( cells( [ null, 110, 100, 101, 120 ], [ null, 850, 800, 805, 990 ] ), SIZES, TAUS, 1.02 );
	t.equal( r.t_best[ 512 ], 100, 't_best(512) without tau=16' );
	t.deepEqual( r.eligible, [ 64, 128 ], 'eligible' );
	t.equal( r.tau_star, 128, 'tau_star' );
	t.end();
});

tape( 'disjoint bands: pre-registered minimax fallback, flagged', function test( t ) {
	var r = resume.selectTau( cells( [ 100, 101, 108, 130, 150 ], [ 900, 880, 850, 800, 815 ] ), SIZES, TAUS, 1.02 );
	t.deepEqual( r.eligible, [], 'no tau within the band at both sizes' );
	t.equal( r.fallback, true, 'fallback flagged' );
	t.equal( r.tau_star, 64, 'minimax of the worst ratio (64: max(1.08, 1.0625))' );
	t.end();
});

tape( 'fallback ties go to the larger tau', function test( t ) {
	var r = resume.selectTau( cells( [ 100, 105, 105, 130, 150 ], [ 1050, 1050, 1050, 1000, 1000 ] ), SIZES, TAUS, 1.02 );
	t.equal( r.fallback, true, 'fallback' );
	t.ok( r.worst_ratio[ 16 ] === r.worst_ratio[ 32 ] && r.worst_ratio[ 32 ] === r.worst_ratio[ 64 ], 'tied worst ratios (16, 32, 64)' );
	t.equal( r.tau_star, 64, 'largest of the tied taus' );
	t.end();
});

tape( 'no data at a select size: no selection', function test( t ) {
	var r = resume.selectTau( cells( [ 100, 99, 98, 98, 120 ], [ null, null, null, null, null ] ), SIZES, TAUS, 1.02 );
	t.equal( r.tau_star, null, 'tau_star null' );
	t.equal( r.t_best[ 1024 ], null, 't_best null' );
	t.end();
});

function proc( stage, experiment, alg, n, cutoff, median, excluded ) {
	return { 'type': 'proc', 'stage': stage, 'experiment': experiment, 'alg': alg, 'M': n, 'N': n, 'K': n, 'params': { 'cutoff': cutoff, 'levels': ( cutoff ) ? 4 : null }, 'per_call_median_ns': median, 'excluded': !!excluded }; // eslint-disable-line max-len
}

function pilotRecords() {
	var recs = [];
	[ 1, 2 ].forEach( function rep( k ) {
		[ 512, 1024 ].forEach( function each( n ) {
			var base = ( n === 512 ) ? 200e6 : 1600e6;
			recs.push( proc( 'pilot', 'pilot.tau', 'A0', n, null, base * ( 1 + ( k / 1000 ) ) ) );
			[ [ 16, 0.64 ], [ 32, 0.63 ], [ 64, 0.635 ], [ 128, 0.70 ], [ 256, 0.80 ] ].forEach( function tau( x ) {
				recs.push( proc( 'pilot', 'pilot.tau', 'A2', n, x[ 0 ], base * x[ 1 ] * ( 1 + ( k / 1000 ) ) ) );
			});
		});
		recs.push( proc( 'pilot', 'pilot.xl', 'A0', 2048, null, 13e9 ) );
		recs.push( proc( 'pilot', 'pilot.xl', 'A2', 2048, 64, 8e9 ) );
		[ 32, 48, 64, 96, 128, 160, 192 ].forEach( function each( n ) {
			recs.push( proc( 'pilot', 'pilot.batch', 'A0', n, null, 1.5 * n * n * n ) ); // 1.5 ns per multiply-add
		});
	});
	recs.push( proc( 'pilot', 'pilot.tau', 'A2', 512, 256, 1, true ) ); // excluded: ignored
	recs.push( proc( 'pilot', 'sentinel', 'SENTINEL', 256, null, 1 ) ); // sentinel: ignored
	recs.push( proc( 'E2', 'E2', 'A2', 512, 256, 1 ) ); // other stage: ignored
	return recs;
}

tape( 'pilotCells groups non-excluded pilot process medians', function test( t ) {
	var c = resume.pilotCells( pilotRecords() );
	t.equal( c.tau[ 512 ][ 256 ].length, 2, 'excluded, sentinel and other-stage records ignored' );
	t.equal( c.a0[ '512' ].length, 2, 'A0 cells by shape' );
	t.equal( c.a0[ '2048' ].length, 2, 'A0 at the XL size' );
	t.equal( c.xl.A2.length, 2, 'XL A2 cell' );
	t.end();
});

tape( 'freeze: tau_star, L_max and b(n) for every timing shape', function test( t ) {
	var fz = resume.freeze( P, pilotRecords() );
	var T32 = 1.5 * 32 * 32 * 32 / 1e9;
	t.equal( fz.tau_star, 64, 'largest tau within the band (16, 32, 64 eligible)' );
	t.deepEqual( fz.pilot_summary.eligible, [ 16, 32, 64 ], 'eligible' );
	t.equal( fz.levels, 4, 'L_max' );
	t.equal( fz.batch_by_n[ '32' ], Math.ceil( 0.02 / T32 ), 'b(32) from the pilot A0 median' );
	t.equal( fz.batch_by_n[ '192' ], Math.ceil( 0.02 / ( 1.5 * 192 * 192 * 192 / 1e9 ) ), 'b(192)' );
	t.equal( fz.batch_by_n[ '255' ], 1, 'b(255) scaled from the nearest measured size' );
	t.equal( fz.batch_by_n[ '1008' ], 1, 'E3 size' );
	t.equal( fz.batch_by_n[ '160x1957x957' ], 1, 'rectangular shape' );
	[ 'E2', 'E3', 'E5', 'E4', 'E0' ].forEach( function each( s ) {
		design.buildStage( P, fz, s ).blocks.forEach( function blk( b ) {
			b.procs.forEach( function p( x ) {
				t.ok( fz.batch_by_n[ x.meta.shape ] >= 1, s + ' shape ' + x.meta.shape + ' has a batch' );
			});
		});
	});
	t.equal( fz.pilot_summary.xl.A0_median_ns, 13e9, 'XL A0 summary' );
	t.end();
});

tape( 'freeze throws when no tau can be selected', function test( t ) {
	var recs = pilotRecords().filter( function f( r ) {
		return !( r.alg === 'A2' && r.M === 1024 );
	});
	t.throws( function f() {
		resume.freeze( P, recs );
	}, /pilot selection impossible/, 'throws' );
	t.end();
});

tape( 'batchTable falls back to the time model without pilot A0 data', function test( t ) {
	var b = resume.batchTable( P, {}, [ { 'M': 32, 'N': 32, 'K': 32 } ] );
	t.equal( b[ '32' ], Math.ceil( 0.02 / ( 2 * 32 * 32 * 32 / 1.3e9 ) ), 'model batch' );
	t.end();
});
