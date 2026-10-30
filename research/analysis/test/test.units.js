'use strict';

/**
* Unit tests on small synthetic record sets: speedup pairing (§6; §12 amendment 2026-10-30b item 4), the τ*
* re-derivation with its fallback (§5.1; amendment item 3), campaign runs (§10, §11 rule 1) and E7 memory rows
* (§9; amendment item 2).
*/

var tape = require( 'tape' );
var cellsLib = require( '../lib/cells.js' );
var pilotLib = require( '../lib/pilot.js' );
var runsLib = require( '../lib/runs.js' );
var derive = require( '../lib/derive.js' );

var LINE = 0;


/**
* Returns a proc record (with `_line`) for a square row-major NN configuration.
*
* @private
*/
function proc( exp, alg, n, block, med, extra ) {
	var p = Object.assign( {
		'type': 'proc', 'proc_id': exp + '.' + alg + '.' + n + '.' + block + '.' + LINE, 'experiment': exp, 'stage': String( exp ).split( '.' )[ 0 ],
		'block_id': exp + '.n' + n + '.b' + block, 'pos_in_block': 0, 'alg': alg,
		'params': ( alg === 'A1' ) ? { 'cutoff': 1, 'levels': 1 } : ( ( alg === 'A2' ) ? { 'cutoff': 16, 'levels': 4 } : { 'cutoff': null, 'levels': null } ),
		'M': n, 'N': n, 'K': n, 'order': 'row-major', 'transA': 'no-transpose', 'transB': 'no-transpose', 'ld_pad': 0, 'alpha': 1, 'beta': 0,
		'per_call_median_ns': med, 'excluded': false, 'exclusion_reason': null
	}, extra || {} );
	Object.defineProperty( p, '_line', { 'value': ++LINE, 'enumerable': false, 'writable': true } );
	return p;
}

/**
* Builds cells (with speedups) from proc records.
*
* @private
*/
function build( procs ) {
	var built = cellsLib.buildCells( { 'procs': procs, 'samples': new Map() } );
	cellsLib.attachSpeedups( built, { 'B': 200, 'seed': 1 } );
	return built;
}

/**
* Returns the cell of an experiment, algorithm and size.
*
* @private
*/
function cell( built, exp, alg, n ) {
	return built.cells.filter( function f( c ) {
		return c.desc.experiment === exp && c.desc.alg === alg && c.desc.M === n;
	})[ 0 ];
}

tape( 'speedups are paired within the cell\'s experiment; only E4 may use E2\'s A0 (unpaired); otherwise missing', function t( q ) {
	var procs = [];
	var built;
	var c;
	var b;
	for ( b = 1; b <= 3; b++ ) {
		procs.push( proc( 'E2', 'A0', 64, b, 100, { 'excluded': true, 'exclusion_reason': 'pressure' } ) );
		procs.push( proc( 'E2', 'A1', 64, b, 110 ) );
		procs.push( proc( 'E3', 'A0', 64, b, 100 ) );
		procs.push( proc( 'E0', 'A0', 64, b, 100 ) );
		procs.push( proc( 'E2', 'A0', 128, b, 800 ) );
		procs.push( proc( 'E2', 'A2', 128, b, 700 ) );
		procs.push( proc( 'E3', 'A0', 128, b, 800, { 'excluded': true, 'exclusion_reason': 'gate' } ) );
		procs.push( proc( 'E3', 'A2', 128, b, 700 ) );
		procs.push( proc( 'E4', 'A2', 128, b, 650, { 'params': { 'cutoff': 32, 'levels': 99 } } ) );
		procs.push( proc( 'E4', 'A2', 64, b, 90, { 'params': { 'cutoff': 32, 'levels': 99 } } ) );
	}
	built = build( procs );
	c = cell( built, 'E2', 'A1', 64 );
	q.ok( !c.speedup && /has no non-excluded process/.test( c.speedup_missing.reason ), 'E2 A1 without a usable E2 A0: missing (' + c.speedup_missing.reason + '), never paired with E3 or E0' );
	q.equal( c.speedup_missing.ref, cell( built, 'E2', 'A0', 64 ).id, 'the empty reference is named' );
	c = cell( built, 'E2', 'A2', 128 );
	q.ok( c.speedup && c.speedup.pairing === 'paired' && c.speedup.ref === cell( built, 'E2', 'A0', 128 ).id, 'E2 A2 paired with E2 A0' );
	c = cell( built, 'E3', 'A2', 128 );
	q.ok( !c.speedup && c.speedup_missing, 'E3 A2 without a usable E3 A0: missing, not unpaired against E2' );
	c = cell( built, 'E4', 'A2', 128 );
	q.ok( c.speedup && c.speedup.pairing === 'unpaired' && c.speedup.ref === cell( built, 'E2', 'A0', 128 ).id, 'E4 (SW arms only): unpaired against E2\'s A0 (amendment item 4)' );
	c = cell( built, 'E4', 'A2', 64 );
	q.ok( !c.speedup && /E2 A0 reference .* has no non-excluded process/.test( c.speedup_missing.reason ), 'E4 never falls back to E3/E0 when E2\'s A0 is unusable' );
	q.end();
});

tape( 'τ* re-derivation: §5.1 rule, the amendment-3 fallback (ties to the larger τ), SENTINEL not a pilot row', function t( q ) {
	var med = function med( a, b, c, d ) {
		return { '512': { '32': a, '64': b }, '1024': { '32': c, '64': d } };
	};
	var run = function run( m, frozen ) {
		var procs = [ proc( 'sentinel', 'SENTINEL', 256, 0, 5, { 'stage': 'pilot' } ) ];
		[ 512, 1024 ].forEach( function each( n ) {
			[ 32, 64 ].forEach( function f( tau ) {
				procs.push( proc( 'pilot.tau', 'A2', n, 1, m[ n ][ tau ], { 'stage': 'pilot', 'params': { 'cutoff': tau, 'levels': 4 } } ) );
			});
		});
		procs.push( proc( 'sentinel', 'SENTINEL', 256, 1, 5, { 'stage': 'E2' } ) );
		return pilotLib.pilot( cellsLib.buildCells( { 'procs': procs, 'samples': new Map() } ).cells, { 'frozen': frozen, 'tauStar': frozen.tau_star, 'levels': 4 } );
	};
	var p = run( med( 100, 101, 1000, 1005 ), { 'tau_star': 64, 'pilot_summary': { 'select_sizes': [ 512, 1024 ], 'fallback': false } } );
	q.ok( p.tau_star_recomputed === 64 && !p.fallback && p.match, '§5.1: largest τ within 1.02× at both sizes' );
	q.ok( p.rows.every( function f( r ) {
		return r.desc.alg !== 'SENTINEL';
	}) && p.rows.length === 4, 'the SENTINEL cell (first sentinel in the pilot stage) is not listed' );
	p = run( med( 100, 110, 1000, 950 ), { 'tau_star': 32, 'pilot_summary': { 'select_sizes': [ 512, 1024 ], 'fallback': true } } );
	q.ok( p.tau_star_recomputed === 32 && p.fallback && p.match && p.eligible.length === 0, 'fallback: smallest worst-case ratio (τ = 32: 1.053 < τ = 64: 1.1)' );
	q.ok( /\*\*fallback\*\* rule/.test( pilotLib.sentence( p ) ) && / — match\.$/.test( pilotLib.sentence( p ) ), pilotLib.sentence( p ) );
	p = run( med( 100, 105, 1050, 1000 ), { 'tau_star': 64, 'pilot_summary': { 'select_sizes': [ 512, 1024 ], 'fallback': true } } );
	q.ok( p.tau_star_recomputed === 64 && p.fallback, 'equal worst-case ratios (1.05): the larger τ' );
	p = run( med( 100, 105, 1050, 1000 ), { 'tau_star': 64, 'pilot_summary': { 'select_sizes': [ 512, 1024 ], 'fallback': false } } );
	q.ok( /\*\*MISMATCH\*\*/.test( pilotLib.sentence( p ) ), 'a fallback choice not flagged in frozen.json is a mismatch' );
	q.end();
});

tape( 'campaign runs: every campaign/campaign_end record, the last run\'s own end, blocks spanning runs', function t( q ) {
	var rec = function rec( o, line ) {
		Object.defineProperty( o, '_line', { 'value': line, 'enumerable': false } );
		return o;
	};
	var data = {
		'campaigns': [ rec( { 'type': 'campaign', 't_wall': 'T1', 'provenance': { 'git': { 'commit': 'aaa', 'dirty': false } }, 'resumed': false, 'start_index': 0 }, 1 ), rec( { 'type': 'campaign', 't_wall': 'T2', 'provenance': { 'git': { 'commit': 'aaa', 'dirty': false } }, 'resumed': true, 'start_index': 1 }, 50 ) ],
		'ends': [ rec( { 'type': 'campaign_end', 'status': 'stopped', 'reason': 'STOP file' }, 40 ) ],
		'procs': [ proc( 'E2', 'A0', 64, 1, 1 ), proc( 'E2', 'A1', 64, 1, 1 ), proc( 'sentinel', 'SENTINEL', 256, 2, 1 ), proc( 'sentinel', 'SENTINEL', 256, 2, 1 ), proc( 'E2', 'A0', 64, 3, 1 ) ]
	};
	var lines = [ 30, 60, 35, 55, 70 ];
	var r;
	data.procs.forEach( function each( p, i ) {
		p._line = lines[ i ];
	});
	data.procs[ 2 ].block_id = 'E2.n64.b2';
	data.procs[ 3 ].block_id = 'E2.n64.b2';
	r = runsLib.runs( data );
	q.equal( r.n_runs, 2 );
	q.ok( r.runs[ 0 ].end.status === 'stopped' && r.runs[ 1 ].preceded_by.status === 'stopped' && r.runs[ 1 ].end === null, 'the stop belongs to run 1 and precedes run 2' );
	q.equal( r.final_end, null, 'the last run has no campaign_end: the campaign status is not the earlier stop' );
	q.ok( !r.provenance_changed && r.dirty_any === false && r.commits.length === 1, 'same commit, clean tree' );
	q.deepEqual( r.blocks_across_runs.map( function f( b ) {
		return b.block_id + ':' + b.runs.join( '+' );
	}), [ 'E2.n64.b1:1+2' ], 'block b1 spans runs 1 and 2; the sentinel re-check of b2 does not count' );
	data.campaigns[ 1 ].env = { 'runtime': { 'node': 'v22.15.0' } };
	data.campaigns[ 0 ].env = { 'runtime': { 'node': 'v22.14.0' } };
	r = runsLib.runs( data );
	q.ok( r.provenance_changed && /node changed between run 1 \(v22\.14\.0\) and run 2 \(v22\.15\.0\)/.test( r.changes.join( '; ' ) ), 'a Node change between runs is flagged: ' + r.changes.join( '; ' ) );
	q.equal( runsLib.runs( { 'campaign': null, 'procs': [] } ).n_runs, 0, 'no campaign record: no runs' );
	q.end();
});

tape( 'memory rows: ΔarrayBuffers only for single-allocation arms; an all-excluded configuration keeps its row', function t( q ) {
	var mem = function mem( alg, excluded ) {
		var m = { 'type': 'mem', 'alg': alg, 'n': 64, 'beta': 0, 'ab0': 1000, 'ab1': 1000 + 512, 'ab2': 1000, 'gc_during_call': 2, 'gc_us': 100, 'maxrss0_kib': 10, 'maxrss1_kib': 11, 'analytic_bytes': 512, 'excluded': excluded };
		Object.defineProperty( m, '_line', { 'value': ++LINE } );
		return m;
	};
	var rows = derive.memory( [ mem( 'SENTINEL', false ), mem( 'C1', true ), mem( 'C1', true ), mem( 'A2', false ) ], 16, 4 );
	var by = {};
	rows.forEach( function each( r ) {
		by[ r.alg ] = r;
	});
	q.ok( by.SENTINEL.d_ab_n === 0 && by.SENTINEL.d_ab_equals_analytic === null && /not valid/.test( by.SENTINEL.d_ab_rule ), 'an arm outside the single-allocation list gets no ΔarrayBuffers' );
	q.ok( by.C1.reps === 0 && by.C1.excluded === 2 && by.C1.src.excluded_lines.length === 2, 'all replicates excluded: the row stays, with its exclusions counted and cited' );
	q.ok( by.A2.d_ab_equals_analytic && by.A2.d_ab_eq_count === 1 && by.A2.gc_events.max === 2 && by.A2.reps_with_gc === 1, 'GC events are reported, not used to drop the replicate' );
	q.end();
});
