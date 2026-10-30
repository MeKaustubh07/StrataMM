'use strict';

/**
* End-to-end test: generate the synthetic campaign (known ground truth) into a temporary directory, then run
* summarize → plots → report and check the results against the truth. Set STRATAMM_KEEP=1 to keep the outputs.
*/

var tape = require( 'tape' );
var fs = require( 'fs' );
var os = require( 'os' );
var path = require( 'path' );
var fixture = require( './fixtures/make_fixture.js' );
var io = require( '../lib/io.js' );
var summarize = require( '../summarize.js' );
var plots = require( '../plots.js' );
var report = require( '../report.js' );

var TMP = fs.mkdtempSync( path.join( os.tmpdir(), 'stratamm-analysis-' ) );
var DIR = path.join( TMP, fixture.ID );
var OUT = path.join( TMP, 'REPORT.md' );
var D;


/**
* Returns the crossover result for a family, algorithm and threshold.
*
* @private
*/
function xover( fam, alg, theta ) {
	return D.crossover.results.filter( function f( r ) {
		return r.family === fam && r.alg === alg && r.theta === theta;
	})[ 0 ];
}

/**
* Returns the E2 cell of an algorithm at size n.
*
* @private
*/
function e2( alg, n ) {
	return D.cells.filter( function f( c ) {
		return c.desc.experiment === 'E2' && c.desc.alg === alg && c.desc.M === n && c.desc.N === n;
	})[ 0 ];
}

tape( 'setup: generate the synthetic campaign and run summarize, plots and report', function t( q ) {
	var counts = fixture.generate( DIR );
	q.ok( counts.campaign > 900 && counts.accuracy === 108 && counts.accuracy_warning === 1, 'fixture generated: ' + JSON.stringify( counts ) );
	summarize.main( [ '--dir', DIR ] );
	D = summarize.loadDerived( path.join( DIR, 'derived' ) );
	q.ok( fs.existsSync( path.join( DIR, 'derived', 'tables.md' ) ), 'derived/tables.md written' );
	q.ok( plots.main( [ '--dir', DIR ] ).length >= 12, 'figures written' );
	q.equal( report.main( [ '--dir', DIR, '--out', OUT ] ), OUT, 'report written' );
	q.end();
});

tape( 'summary, provenance and exclusions', function t( q ) {
	q.equal( D.summary.commit, '0123456789abcdef0123456789abcdef01234567', 'commit of the first run' );
	q.equal( D.summary.status.status, 'complete', 'status = the last run\'s own campaign_end' );
	q.equal( D.summary.counts.parse_errors, 0 );
	q.equal( D.exclusions.length, 1, 'one gate failure, kept with excluded: true' );
	q.equal( D.exclusions[ 0 ].reason, 'gate' );
	q.equal( e2( 'A2', 512 ).r, 5, 'the re-run replaces the excluded process in its block' );
	q.equal( D.pilot.tau_star_recomputed, 64, 'τ* re-derived from the pilot by the §5.1 rule' );
	q.ok( D.pilot.match && D.pilot.fallback === false && D.pilot.fallback_frozen === false, 'match; not a fallback choice (frozen.json agrees)' );
	q.ok( D.pilot.rows.length > 0 && D.pilot.rows.every( function f( r ) {
		return r.desc.alg !== 'SENTINEL';
	}), 'the campaign-wide SENTINEL cell is not a pilot row' );
	q.equal( D.summary.frozen.fallback, false, 'frozen.json pilot_summary carried into the summary' );
	q.end();
});

tape( 'resumed campaign: every run, commit, dirty flag and stop is reported; blocks spanning runs are listed', function t( q ) {
	var s = D.summary;
	q.equal( s.runs.length, 2, 'two campaign records = two runs' );
	q.deepEqual( s.commits, [ '0123456789abcdef0123456789abcdef01234567', 'fedcba9876543210fedcba9876543210fedcba98' ] );
	q.ok( s.runs[ 1 ].resumed && s.runs[ 1 ].dirty === true && s.dirty_any === true, 'second run resumed from a dirty tree' );
	q.equal( s.runs[ 1 ].preceded_by.status, 'stopped', 'the stop between the runs is reported' );
	q.ok( s.provenance_changed && s.provenance_changes.length === 2, 'commit and dirty-flag changes flagged: ' + s.provenance_changes.join( '; ' ) );
	q.equal( s.ends.length, 2, 'both campaign_end records kept' );
	q.equal( s.blocks_across_runs.length, 1, 'the interrupted E3 block spans the two runs' );
	q.deepEqual( s.blocks_across_runs[ 0 ].runs, [ 1, 2 ] );
	q.end();
});

tape( 'E2 verdicts and crossovers match the ground truth', function t( q ) {
	var a1 = xover( 'P', 'A1', 1.0 );
	var a2 = xover( 'P', 'A2', 1.02 );
	var t1 = Math.pow( 2, 7 + ( -Math.log( 0.97 ) / ( Math.log( 1.04 ) - Math.log( 0.97 ) ) ) );
	var t2 = Math.pow( 2, 7 + ( ( Math.log( 1.02 ) - Math.log( 1.01 ) ) / ( Math.log( 1.10 ) - Math.log( 1.01 ) ) ) );
	q.equal( e2( 'A1', 128 ).speedup.verdict, 'slower', 'A1 at 128 (true S = 0.97)' );
	q.equal( e2( 'A2', 64 ).speedup.verdict, 'equivalent', 'A2 at 64 ≤ τ* (delegates to dgemm)' );
	q.ok( e2( 'A2', 2048 ).speedup.low_replication && e2( 'A2', 2048 ).speedup.verdict === 'faster', 'XL: t-interval, labelled low replication' );
	q.equal( a1.fixed_sequence.n_star, 128, 'n*₁ (A1, θ = 1) = 128 (§7: every larger n passes; 128 fails)' );
	q.equal( a1.fixed_sequence.smallest_passing, 256, 'smallest passing size 256' );
	q.ok( a1.interpolation.lo <= t1 && t1 <= a1.interpolation.hi, 'A1 interval ' + a1.interpolation.labels.interval + ' covers the true crossing ' + t1.toFixed( 1 ) );
	q.equal( a2.fixed_sequence.n_star, 128, 'n*₁.₀₂ (A2, θ = 1.02) = 128 (A2 at 128 is not "faster")' );
	q.deepEqual( a2.sizes, [ 128, 256, 512, 1024, 2048 ], 'A2 restricted to n > τ*' );
	q.ok( a2.interpolation.lo <= t2 && t2 <= a2.interpolation.hi, 'A2 interval ' + a2.interpolation.labels.interval + ' covers the true crossing ' + t2.toFixed( 1 ) );
	q.ok( a1.primary && a2.primary, 'P family pairings are primary' );
	q.equal( xover( 'O', 'A1', 1.0 ).fixed_sequence.reason, 'missing cell', 'unmeasured O sizes stop the fixed sequence' );
	q.equal( xover( 'O', 'A1', 1.0 ).fixed_sequence.status, 'not_measured', 'a missing n_max is censored (no test), not a failure' );
	q.ok( /^not measured/.test( xover( 'O', 'A1', 1.0 ).fixed_sequence.label ), xover( 'O', 'A1', 1.0 ).fixed_sequence.label );
	q.equal( xover( 'R', 'A1', 1.0 ).interpolation.frac_right, 1, 'R family (S < 1 at its largest measured size): right-censored' );
	q.equal( xover( 'R', 'A1', 1.0 ).interpolation.censoring.median, 'right', 'censoring direction written explicitly (JSON has no ±∞)' );
	q.equal( a1.interpolation.censoring.median, 'finite' );
	q.end();
});

tape( 'ladder, E4, E5, E0, memory, accuracy, pairing, sentinel, position', function t( q ) {
	var terms = {};
	D.ladder[ 0 ].terms.forEach( function each( x ) {
		terms[ x.name ] = x;
	});
	q.equal( D.ladder[ 0 ].n, 512 );
	q.equal( D.ladder[ 0 ].L, 3, 'depth(512, τ* = 64, 4) = 3' );
	q.ok( terms.arith_n.confounded && !terms.arith_pad.confounded, 'C2/A2 = 1.55 confounded; 1.40 not' );
	q.ok( Math.abs( terms.layout.est / 2.0 - 1 ) < 0.03, 'packing B: ≈2×' );
	q.deepEqual( D.depth.map( function f( r ) {
		return r.L;
	}), [ 4, 2 ], 'E4 depths for cutoffs 32 and 128' );
	q.ok( D.depth.every( function f( r ) {
		return r.speedup.low_replication;
	}), 'E4 at r = 3 is low replication' );
	q.deepEqual( D.e5.map( function f( r ) {
		return r.kind;
	}).sort(), [ 'layout', 'rectangular' ] );
	q.ok( Math.abs( D.e0.filter( function f( r ) {
		return r.desc.transB === 'transpose';
	})[ 0 ].rel_to_rm_nn / 1.9 - 1 ) < 0.05, 'E0: NT path ≈ 1.9× slower than NN' );
	q.ok( D.memory.filter( function f( m ) {
		return m.alg === 'A2';
	}).every( function f( m ) {
		return m.analytic_check && m.d_ab_equals_analytic && m.d_ab_n === m.reps && m.gc_events.min >= 1;
	}), 'analytic = 8·E1(+8MN) and ΔarrayBuffers read on return matches it in every replicate, with 1–5 GCs during the call' );
	q.ok( D.memory.filter( function f( m ) {
		return m.alg === 'A2' && m.n === 512 && m.beta === 0;
	}).every( function f( m ) {
		return m.reps === 3 && m.excluded === 1 && m.src.excluded_lines.length === 1;
	}), 'the excluded record is not used but counted and cited' );
	q.ok( D.memory.filter( function f( m ) {
		return m.alg === 'C1';
	}).every( function f( m ) {
		return m.d_ab_equals_analytic === false && m.d_ab_eq_count === 2 && m.d_ab_n === 3;
	}), 'the injected mismatch (C1, one replicate) is flagged' );
	q.ok( /\*\*no\*\* \(2\/3\)/.test( fs.readFileSync( path.join( DIR, 'derived', 'tables.md' ), 'utf8' ) ), 'tables.md renders the mismatch as **no** (2/3)' );
	q.deepEqual( D.accuracy.gates.map( function f( g ) {
		return g.rule + ' / ' + g.origin;
	}).sort(), [ 'F11 inexact / recomputed+recorded', 'non-finite output entries / recomputed+recorded' ], 'the injected F11 inexactness and non-finite output are the hard-gate violations (recomputed and recorded)' );
	q.ok( D.accuracy.warnings.some( function f( w ) {
		return w.family === 'F2' && w.M === 512 && w.L === 3 && w.origin === 'recomputed+recorded';
	}), 'g = 3.4 growth warning, also recorded as an accuracy_warning' );
	q.equal( D.accuracy.warnings.filter( function f( w ) {
		return w.family === 'F1';
	}).length, 8, 'F1 warnings per seed as the harness evaluates them (L = 2, 3 at n = 256, 512; 2 seeds)' );
	q.ok( D.accuracy.groups.filter( function f( g ) {
		return g.family === 'F9a' && g.alg === 'SW' && g.L === 1;
	}).every( function f( g ) {
		return g.kappa.seeds === 2 && g.kappa.bins.length === 3 && g.kappa.bins[ 0 ].n === 40000 && g.kappa.czero.n === 6;
	}), 'F9a κ bins aggregated over seeds' );
	q.ok( D.pairing.some( function f( r ) {
		return r.alg === 'A2' && r.n === 512 && r.L === 3 && Math.abs( r.acc.F2.R_N - Math.pow( 1.5, 3 ) ) < 1e-9 && r.acc.F4.frac_ge1 > 0;
	}), 'A2 at 512 paired with R_N and the F4 no-correct-digit fraction at L = 3' );
	q.equal( D.sentinel.series.length, D.summary.counts.env_checks );
	q.deepEqual( D.position.map( function f( p ) {
		return p.experiment;
	}), [ 'E2', 'E3', 'E4', 'E5', 'all' ] );
	q.ok( D.position.every( function f( p ) {
		return p.p > 0 && p.p <= 1;
	}) );
	q.end();
});

tape( 'figures are well-formed dependency-free SVG', function t( q ) {
	var dir = path.join( DIR, 'figures' );
	[ 'speedup', 'gflops', 'ladder', 'depth', 'memory', 'sentinel', 'accuracy_F2', 'pareto_F2' ].forEach( function each( name ) {
		var s = fs.readFileSync( path.join( dir, name + '.svg' ), 'utf8' );
		q.ok( s.indexOf( '<svg xmlns="http://www.w3.org/2000/svg"' ) === 0 && /<\/svg>\n$/.test( s ), name + ': complete document' );
		q.ok( !/NaN|undefined|Infinity/.test( s ), name + ': no NaN/undefined/Infinity' );
		q.equal( ( s.match( /<g[ >]/g ) || [] ).length, ( s.match( /<\/g>/g ) || [] ).length, name + ': balanced groups' );
		q.ok( /<title id="t">/.test( s ) && /prefers-color-scheme: dark/.test( s ), name + ': accessible title and dark-mode tokens' );
	});
	q.end();
});

tape( 'REPORT.md: every table row cites records, appendix complete, limitations verbatim, TODO slots', function t( q ) {
	var md = fs.readFileSync( OUT, 'utf8' );
	var body = md.split( '## Appendix A' )[ 0 ];
	var rows = body.split( '\n' ).filter( function f( l ) {
		return /^\| /.test( l ) && !/^\| ---/.test( l ) && /\d/.test( l ) && !/TODO\(interpretation\)/.test( l );
	});
	var headers = body.split( '\n' ).filter( function f( l, i, all ) {
		return /^\| /.test( l ) && /^\| ---/.test( all[ i+1 ] || '' );
	});
	var missing = rows.filter( function f( l ) {
		return headers.indexOf( l ) < 0 && !/\]\(#s\d+\)/.test( l );
	});
	var keys = ( body.match( /\]\(#(s\d+)\)/g ) || [] ).map( function f( m ) {
		return m.slice( 3, -1 );
	});
	q.deepEqual( missing, [], 'every data row links to a source entry (' + rows.length + ' rows)' );
	q.ok( keys.length > 50 && keys.every( function f( k ) {
		return md.indexOf( '<a id="' + k + '"></a>' ) >= 0;
	}), 'every cited key has an appendix entry' );
	q.ok( md.indexOf( report.LIMITATIONS ) >= 0, 'limitations quoted verbatim' );
	q.equal( report.limitations( path.join( io.REPO_ROOT, 'docs', 'research-protocol.md' ) ).text, report.LIMITATIONS, 'protocol §11 text unchanged since rev. 2' );
	q.ok( ( md.match( /TODO\(interpretation\)/g ) || [] ).length >= 12, 'interpretation slots present' );
	q.ok( md.indexOf( '0123456789abcdef0123456789abcdef01234567' ) >= 0 && md.indexOf( 'fedcba9876543210fedcba9876543210fedcba98' ) >= 0, 'every run\'s commit stated' );
	q.ok( /provenance differs between runs/.test( md ) && /1 block\(s\) span two runs/.test( md ), 'the resume, provenance change and split block are reported' );
	q.ok( /!\[speedup\]\(sw-synth-001\/figures\/speedup\.svg\)/.test( md ), 'figures embedded by relative path' );
	q.ok( md.indexOf( 'ΔarrayBuffers is read immediately on return and is valid for these single-allocation arms' ) >= 0 && md.indexOf( 'zero GCs' ) < 0, 'memory note follows amendment 2026-10-30b item 2' );
	q.ok( /time\(C2\)\/time\(A2\) ≥ \(8\/7\)\^L/.test( md ), 'confounded formula stated' );
	q.ok( /κ-binned relative error/.test( md ), 'F9 κ table reported' );
	q.end();
});

tape( 'campaign cut after E2 and without E6/E7: only generated figures are linked; empty sets phrased as not run', function t( q ) {
	var dir = path.join( TMP, 'cut', fixture.ID );
	var out = path.join( TMP, 'cut', 'REPORT.md' );
	var keep = [];
	var md;
	fs.mkdirSync( dir, { 'recursive': true } );
	fs.readFileSync( path.join( DIR, 'campaign.jsonl' ), 'utf8' ).split( '\n' ).some( function each( l ) {
		var r = ( l ) ? JSON.parse( l ) : null;
		if ( r && r.type === 'proc' && r.stage === 'E3' ) {
			return true;
		}
		if ( r && r.type !== 'campaign_end' ) {
			keep.push( l );
		}
		return false;
	});
	fs.writeFileSync( path.join( dir, 'campaign.jsonl' ), keep.join( '\n' ) + '\n' );
	fs.copyFileSync( path.join( DIR, 'frozen.json' ), path.join( dir, 'frozen.json' ) );
	summarize.main( [ '--dir', dir, '--B', '500' ] );
	plots.main( [ '--dir', dir ] );
	report.main( [ '--dir', dir, '--out', out ] );
	md = fs.readFileSync( out, 'utf8' );
	q.ok( !/\]\([^)]*(ladder|depth|memory|accuracy_\w+|pareto_\w+)\.svg\)/.test( md ), 'no link to a figure that was not generated' );
	q.ok( /!\[speedup\]\(/.test( md ) && /!\[sentinel\]\(/.test( md ), 'generated figures are linked' );
	q.ok( /Not generated \(no data for them\): ladder, depth, memory/.test( md ), 'missing figures named' );
	q.ok( /E6 not run/.test( md ) && !/none violated over 0 records/.test( md ), 'no gate verdict over 0 records' );
	q.ok( /E7 not run/.test( md ) && /E3 not run/.test( md ), 'E3 and E7 phrased as not run' );
	q.ok( /missing campaign_end record/.test( md ), 'status of a run without campaign_end' );
	q.end();
});

tape( 'determinism: the analysis is reproducible from the recorded seeds', function t( q ) {
	var again = summarize.analyze( io.loadCampaign( DIR ), {} );
	q.deepEqual( JSON.parse( JSON.stringify( again.crossover ) ), D.crossover, 'crossover results identical' );
	q.deepEqual( JSON.parse( JSON.stringify( again.ladder ) ), D.ladder, 'ladder results identical' );
	q.end();
});

tape( 'the fixture under test/fixtures/ is exactly what the generator produces', function t( q ) {
	var committed = path.join( __dirname, 'fixtures', fixture.ID );
	if ( !fs.existsSync( committed ) ) {
		q.skip( 'no generated fixture directory (run: node research/analysis/test/fixtures/make_fixture.js)' );
		q.end();
		return;
	}
	[ 'campaign.jsonl', 'accuracy.jsonl', 'e1.jsonl', 'frozen.json', 'campaign.log' ].forEach( function each( f ) {
		q.ok( fs.readFileSync( path.join( committed, f ), 'utf8' ) === fs.readFileSync( path.join( DIR, f ), 'utf8' ), f + ' matches the generator (else regenerate with make_fixture.js)' );
	});
	q.end();
});

tape( 'teardown', function t( q ) {
	if ( process.env.STRATAMM_KEEP ) {
		q.comment( 'outputs kept in ' + TMP );
	} else {
		fs.rmSync( TMP, { 'recursive': true, 'force': true } );
	}
	q.pass( 'done' );
	q.end();
});
