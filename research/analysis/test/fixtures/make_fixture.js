#!/usr/bin/env node
'use strict';

/**
* Generates the small synthetic campaign `sw-synth-001` (schema `sw-bench/2`) with known ground truth.
*
* Ground truth (TRUTH below): true speedups per (alg, n); lognormal noise with a block effect (σ = 1%, shared by the
* processes of a block), a process effect (σ = 0.4%) and a sample effect (σ = 0.2%). One block is run per
* (experiment, shape, replicate). Usage: `node make_fixture.js [outDir]` (default: ./sw-synth-001).
*
* Like real data: a SENTINEL proc before every block; the campaign is stopped inside the first E3 block and resumed
* (second `campaign` record with another commit and a dirty tree); E7 replicates see 1–5 GCs during the call; E6
* records carry the harness's `exact`, `n_nonfinite`, `warnings` and `gate_violations`, plus an `accuracy_warning`.
*/

var path = require( 'path' );
var fs = require( 'fs' );
var prng = require( '../../lib/prng.js' );

var ID = 'sw-synth-001';
var TAU = 64;
var LEVELS = 4;
var T0 = Date.parse( '2026-10-30T23:00:00.000Z' );
var TRUTH = {
	'A1': { '32': 0.80, '64': 0.90, '128': 0.97, '256': 1.04, '512': 1.08, '1024': 1.10, '2048': 1.12, '255': 1.03, '511': 1.07, '48': 0.85, '96': 0.93, '160': 0.99 },
	'A2': { '32': 1.0, '64': 1.0, '128': 1.01, '256': 1.10, '512': 1.25, '1024': 1.45, '2048': 1.60, '255': 1.09, '511': 1.24, '48': 1.0, '96': 1.01, '160': 1.005 }
};
var E3 = { 'A0@0': 1.0, 'A0@8': 1.07, 'C2@0': 0.99, 'C2@8': 1.07, 'A2@0': 0.99*1.55, 'A2@8': 1.07*1.40, 'C1@0': 2.0 };
var COMMIT = '0123456789abcdef0123456789abcdef01234567';
var COMMIT2 = 'fedcba9876543210fedcba9876543210fedcba98';
var PILOT_MED = { '512': { '32': 150e6, '64': 150e6, '128': 160e6 }, '1024': { '32': 1.20e9, '64': 1.19e9, '128': 1.25e9 } };


/**
* Generates the fixture files.
*
* @param {string} outDir - output directory
* @returns {Object} counts of generated records
*/
function generate( outDir ) {
	var g = prng.createRng( 20261030 );
	var lines = [];
	var acc = [];
	var nacc = 0;
	var clock = 0;
	var pid = 0;
	var blk = 0;
	var n;

	emit( campaign( COMMIT, false, 0 ) );
	pilot();
	[ 32, 64, 128, 256, 512, 1024, 2048, 255, 511, 96, 160 ].forEach( function each( size ) {
		var r = ( size >= 1536 ) ? 4 : 5;
		var b;
		for ( b = 0; b < r; b++ ) {
			block( 'E2', [ cfg( 'A0', size ), cfg( 'A1', size ), cfg( 'A2', size ) ], function t( c ) {
				return base( size ) / ( ( c.alg === 'A0' ) ? 1.0 : TRUTH[ c.alg ][ size ] );
			}, ( size === 512 && b === 1 ) ? 'A2' : null );
		}
	});
	for ( n = 0; n < 5; n++ ) {
		// The first E3 block is interrupted after 3 processes (STOP file) and finished by the resumed run:
		block( 'E3', [ cfg( 'A0', 512, 0 ), cfg( 'A0', 512, 8 ), cfg( 'C2', 512, 0 ), cfg( 'C2', 512, 8 ), cfg( 'A2', 512, 0 ), cfg( 'A2', 512, 8 ), cfg( 'C1', 512, 0 ) ], function t( c ) {
			return base( 512 ) / E3[ c.alg + '@' + c.ld_pad ];
		}, null, null, ( n === 0 ) ? 3 : -1 );
	}
	for ( n = 0; n < 3; n++ ) {
		block( 'E4', [ cfg( 'A0', 512 ), cfg( 'A2', 512, 0, { 'cutoff': 32, 'levels': 99 } ), cfg( 'A2', 512, 0, { 'cutoff': 128, 'levels': 99 } ) ], function t( c ) {
			return base( 512 ) / ( ( c.alg === 'A0' ) ? 1.0 : ( ( c.params.cutoff === 32 ) ? 1.20 : 1.18 ) );
		});
		block( 'E5.layout', [ Object.assign( cfg( 'A0', 512 ), { 'transA': 'transpose' } ), Object.assign( cfg( 'A2', 512 ), { 'transA': 'transpose' } ) ], function t( c ) {
			return base( 512 ) * 1.05 / ( ( c.alg === 'A0' ) ? 1.0 : 1.22 );
		});
		block( 'E5.rect', [ Object.assign( cfg( 'A0', 1024 ), { 'K': 256 } ), Object.assign( cfg( 'A2', 1024 ), { 'K': 256 } ) ], function t( c ) {
			return base( 1024 ) / 4.0 / ( ( c.alg === 'A0' ) ? 1.0 : 1.15 );
		});
	}
	block( 'E0', [ cfg( 'A0', 64 ), Object.assign( cfg( 'A0', 64 ), { 'transB': 'transpose' } ), Object.assign( cfg( 'A0', 64 ), { 'order': 'column-major' } ) ], function t( c ) {
		return base( 64 ) * ( ( c.transB === 'transpose' ) ? 1.9 : 1.0 );
	});
	memory();
	accuracy();
	emit( { 'type': 'campaign_end', 'status': 'complete', 'reason': null } );

	fs.mkdirSync( outDir, { 'recursive': true } );
	fs.writeFileSync( path.join( outDir, 'campaign.jsonl' ), lines.join( '\n' ) + '\n' );
	fs.writeFileSync( path.join( outDir, 'accuracy.jsonl' ), acc.join( '\n' ) + '\n' );
	fs.writeFileSync( path.join( outDir, 'e1.jsonl' ), JSON.stringify( rec( { 'type': 'e1', 'trials': 100000, 'mismatches': 0, 'recursive_fraction': 0.62, 'shapes_max': 300 } ) ) + '\n' );
	fs.writeFileSync( path.join( outDir, 'frozen.json' ), JSON.stringify( rec( { 'type': 'frozen', 'tau_star': TAU, 'levels': LEVELS, 'batch_by_n': { '32': 263, '64': 33, '128': 5 }, 'pilot_summary': pilotSummary() } ), null, 1 ) + '\n' );
	fs.writeFileSync( path.join( outDir, 'campaign.log' ), 'synthetic fixture\nCAMPAIGN COMPLETE\n' );
	return { 'campaign': lines.length, 'accuracy': nacc, 'accuracy_warning': acc.length - nacc };

	function campaign( commit, dirty, index ) {
		return { 'type': 'campaign', 'protocol_sha256': 'synthetic-protocol-sha256', 'design': { 'fixture': true }, 'master_seed': 12345, 'env': { 'machine': { 'model': 'Mac14,2', 'os_name': 'macOS', 'os_version': '26.4.1' }, 'runtime': { 'node': 'v22.14.0', 'v8': '12.4.254.21-node.22' } }, 'provenance': { 'git': { 'commit': commit, 'dirty': dirty } }, 'resumed': index > 0, 'start_index': index };
	}

	function pilotSummary() {
		var worst = {};
		var best = {};
		[ '512', '1024' ].forEach( function each( size ) {
			best[ size ] = Math.min.apply( null, Object.keys( PILOT_MED[ size ] ).map( function f( t ) {
				return PILOT_MED[ size ][ t ];
			}) );
		});
		[ 32, 64, 128 ].forEach( function each( t ) {
			worst[ t ] = Math.max( PILOT_MED[ '512' ][ t ] / best[ '512' ], PILOT_MED[ '1024' ][ t ] / best[ '1024' ] );
		});
		return { 'rule': '§5.1', 'select_sizes': [ 512, 1024 ], 'taus': [ 32, 64, 128 ], 'eligible': [ 32, 64 ], 'worst_ratio': worst, 'fallback': false };
	}

	function rec( o ) {
		return Object.assign( { 'schema': 'sw-bench/2', 'type': o.type, 'campaign': ID, 't_wall': new Date( T0 + ( 1000*clock ) ).toISOString() }, o );
	}

	function emit( o ) {
		clock += 1;
		lines.push( JSON.stringify( rec( o ) ) );
	}

	function base( size ) {
		return 2.0 * size * size * size / 1.4;
	}

	function cfg( alg, size, ldPad, params ) {
		var p = params || ( ( alg === 'A1' ) ? { 'cutoff': 1, 'levels': 1 } : ( ( alg === 'A2' || alg === 'C2' ) ? { 'cutoff': TAU, 'levels': LEVELS } : { 'cutoff': null, 'levels': null } ) );
		return { 'alg': alg, 'params': p, 'M': size, 'N': size, 'K': size, 'order': 'row-major', 'transA': 'no-transpose', 'transB': 'no-transpose', 'ld_pad': ldPad || 0, 'alpha': 1, 'beta': 0 };
	}

	function block( exp, cfgs, truth, failAlg, stage, resumeAfter ) {
		var order = cfgs.map( function f( c, i ) {
			return [ g.uniform(), i ];
		}).sort( function cmp( a, b ) {
			return a[ 0 ] - b[ 0 ];
		});
		var beff = 0.01 * g.normal();
		var id = 'b' + String( ++blk ).padStart( 3, '0' );
		var st = stage || exp.split( '.' )[ 0 ];
		sentinel( id, st, Math.round( 11.98e6 * Math.exp( beff + ( 0.003*g.normal() ) ) ), 1 );
		order.forEach( function each( o, pos ) {
			var c = cfgs[ o[ 1 ] ];
			if ( pos === resumeAfter ) {
				emit( { 'type': 'campaign_end', 'status': 'stopped', 'reason': 'STOP file', 'warnings': [], 'procs_run': pid, 'procs_excluded': 1, 'wall_s': 1800 } );
				emit( campaign( COMMIT2, true, 1 ) );
				sentinel( id, st, 11.98e6, 2 ); // the resumed run re-checks the sentinel before finishing the block
			}
			if ( c.alg === failAlg ) {
				proc( exp, id, pos, c, truth( c ), beff, 'gate', stage );
			}
			proc( exp, id, pos, c, truth( c ), beff, null, stage );
		});
	}

	function sentinel( id, stage, med, k ) {
		emit( { 'type': 'env_check', 'block_id': id, 'stage': stage, 'power': { 'source': 'AC Power', 'ac': true }, 'thermal_state': 0, 'pressure_level': 1, 'swapouts': 0, 'sentinel': { 'median_ns': med, 'iqr_ns': 4e4, 'drift': null } } );
		emit( { 'type': 'proc', 'proc_id': id + '.s' + k, 'stage': stage, 'experiment': 'sentinel', 'block_id': id, 'pos_in_block': -1, 'alg': 'SENTINEL', 'params': { 'cutoff': null, 'levels': null }, 'M': 256, 'N': 256, 'K': 256, 'order': 'row-major', 'transA': 'no-transpose', 'transB': 'no-transpose', 'ld_pad': 0, 'alpha': 1, 'beta': 0, 'lda': 256, 'batch': 1, 'k': 15, 'first_call_ns': Math.round( med * 1.3 ), 'gate': { 'rel': 1e-16, 'pass': true }, 'per_call_median_ns': med, 'excluded': false, 'exclusion_reason': null } );
	}

	function proc( exp, id, pos, c, t, beff, fail, stage ) {
		var pe = 0.004 * g.normal();
		var batch = Math.max( 1, Math.ceil( 20e6 / t ) );
		var procId = 'p' + String( ++pid ).padStart( 4, '0' );
		var samples = [];
		var i;
		var v;
		for ( i = 0; i < 3 && !fail; i++ ) {
			v = t * Math.exp( beff + pe + ( 0.002*g.normal() ) );
			samples.push( { 'type': 'sample', 'proc_id': procId, 'i': i, 'batch': batch, 't_ns': Math.round( v*batch ), 'per_call_ns': Math.round( v ), 'flags': ( i === 2 && pid % 37 === 0 ) ? [ 'preempt' ] : [] } );
		}
		emit( Object.assign( { 'type': 'proc', 'proc_id': procId, 'stage': stage || exp.split( '.' )[ 0 ], 'experiment': exp, 'block_id': id, 'pos_in_block': pos }, c, {
			'lda': c.K + c.ld_pad, 'batch': batch, 'k': 3,
			'first_call_ns': Math.round( t * 1.3 ), 'gate': { 'rel': ( fail ) ? 1 : 1e-16, 'pass': !fail },
			'per_call_median_ns': ( fail ) ? null : samples.map( function f( s ) {
				return s.per_call_ns;
			}).sort( function cmp( a, b ) {
				return a - b;
			})[ 1 ], 'excluded': !!fail, 'exclusion_reason': fail
		}) );
		samples.forEach( emit );
	}

	function pilot() {
		var med = PILOT_MED;
		[ 512, 1024 ].forEach( function each( size ) {
			var b;
			for ( b = 0; b < 1; b++ ) {
				block( 'pilot.tau', [ cfg( 'A0', size ) ].concat( [ 32, 64, 128 ].map( function f( tau ) {
					return cfg( 'A2', size, 0, { 'cutoff': tau, 'levels': LEVELS } );
				}) ), function t( c ) {
					return ( c.alg === 'A0' ) ? base( size ) : med[ size ][ c.params.cutoff ];
				}, null, 'pilot' );
			}
		});
	}

	function memory() {
		var i;
		[ 256, 512 ].forEach( function each( size ) {
			[ 0, 1 ].forEach( function f( beta ) {
				var analytic = 8 * ( workspace( size ) + ( ( beta ) ? size*size : 0 ) );
				var j;
				for ( j = 0; j < 3; j++ ) {
					// Real E7 calls see 1–5 GCs; ΔarrayBuffers read on return still equals the analytic bytes exactly:
					emit( mem( 'A2', size, beta, analytic, analytic, 1 + ( ( j + ( size/256 ) + beta ) % 5 ) ) );
				}
				if ( size === 512 && beta === 0 ) {
					emit( Object.assign( mem( 'A2', size, beta, analytic, analytic + 999424, 2 ), { 'excluded': true, 'exclusion_reason': 'gate' } ) );
				}
			});
		});
		// C1 (one packed copy of B, 8·K·N): the third replicate is deliberately inconsistent with the analytic bytes.
		for ( i = 0; i < 3; i++ ) {
			emit( mem( 'C1', 256, 0, 8*256*256, ( 8*256*256 ) + ( ( i === 2 ) ? 4096 : 0 ), 1 ) );
		}
		emit( mem( 'A0', 256, 0, 0, 0, 1 ) );
	}

	function mem( alg, size, beta, analytic, dab, gcs ) {
		var ab0 = ( 3*8*size*size ) + ( ( beta ) ? 8*size*size : 0 );
		return { 'type': 'mem', 'alg': alg, 'params': ( alg === 'A2' ) ? { 'cutoff': TAU, 'levels': LEVELS } : { 'cutoff': null, 'levels': null }, 'n': size, 'M': size, 'N': size, 'K': size, 'beta': beta, 'ab0': ab0, 'ab1': ab0 + dab, 'ab2': ab0, 'gc_during_call': gcs, 'gc_us': 85 * gcs, 'maxrss0_kib': 60000, 'maxrss1_kib': 60000 + ( 16 * Math.ceil( dab / 16384 ) ), 'analytic_bytes': analytic, 'excluded': false, 'exclusion_reason': null };
	}

	function workspace( size ) {
		var len = 0;
		var d = 0;
		var m = size;
		while ( d < LEVELS && m > TAU ) {
			m = Math.floor( m/2 );
			len += ( m*m ) + ( m*m );
			d += 1;
		}
		return len;
	}

	function accuracy() {
		var specs = [ [ 'F1', null ], [ 'F2', null ], [ 'F4', { 's': 10 } ], [ 'F5', null ] ];
		specs.forEach( function each( sp ) {
			[ 256, 512 ].forEach( function f( size ) {
				var seed;
				for ( seed = 1; seed <= 2; seed++ ) {
					arms( sp[ 0 ], sp[ 1 ], size, seed );
				}
			});
		});
		arms( 'F11', null, 64, 1 );
		arms( 'F9a', null, 256, 1 );
		arms( 'F9a', null, 256, 2 );
		// The harness's growth-factor warning (g = 3.4 for F2, n = 512, L = 3; see `gF` below):
		acc.push( JSON.stringify( rec( { 'type': 'accuracy_warning', 'rule': 'g = median over seeds of (eta_F(L)/eta_F(0))^(1/L) in [1.7, 3] (F2/F3)', 'family': 'F2', 'params': null, 'n': 512, 'L': 3, 'g': 3.4, 'seeds': 2 } ) ) );
	}

	function arms( fam, params, size, seed ) {
		var list = [ [ 'A0', 0 ], [ 'SW', 1 ], [ 'SW', 2 ], [ 'SW', 3 ] ];
		var eta0 = ( fam === 'F11' ) ? 0 : 2.0 + ( 0.5*seed ) + ( size/256 );
		if ( fam === 'F1' || fam === 'F2' ) {
			list.push( [ 'V1', 1 ], [ 'V1', 2 ] );
		}
		if ( fam === 'F4' || fam === 'F5' ) {
			list.push( [ 'V2', 1 ], [ 'V2', 2 ] );
		}
		list.forEach( function each( a ) {
			var L = a[ 1 ];
			var k0 = size / Math.pow( 2, L );
			var gF = ( fam === 'F2' && size === 512 && L === 3 ) ? 3.4 : 2.2;
			var rn = ( fam === 'F1' && size === 256 && L === 3 ) ? 2.5 : Math.pow( ( a[ 0 ] === 'V2' ) ? 1.1 : 1.5, L );
			var etaN = ( fam === 'F11' ) ? ( ( a[ 0 ] === 'SW' && L === 2 ) ? 0.5 : 0 ) : eta0 * rn;
			var fw = ( L ) ? ( Math.pow( 18, L ) * ( ( k0*k0 ) + ( 5.5625*k0 ) ) ) - ( 5.5625*size ) : size*size;
			var nodigit = ( ( fam === 'F4' || fam === 'F5' ) && a[ 0 ] === 'SW' ) ? 0.0009 * L * ( ( fam === 'F5' ) ? 3 : 1 ) : 0;
			var nonfinite = ( fam === 'F2' && size === 256 && seed === 2 && a[ 0 ] === 'SW' && L === 1 ) ? 1 : 0; // injected
			var r = { 'type': 'accuracy', 'family': fam, 'params': params, 'seed': seed, 'M': size, 'N': size, 'K': size, 'alg': a[ 0 ], 'L': L, 'k0': k0,
				'metrics': { 'eta_N': etaN, 'f_W': fw, 'rho_N': etaN / fw, 'eta_C': { 'max': ( fam === 'F11' ) ? etaN : ( ( fam === 'F4' && L ) ? 1e10 : 3 * rn ), 'p999': 2 * rn, 'median': 0.5 * rn },
					'eta_R': etaN * ( ( fam === 'F5' && L ) ? 1e6 : 1 ), 'eta_F': ( fam === 'F11' ) ? 0 : eta0 * 0.3 * Math.pow( ( a[ 0 ] === 'SW' ) ? gF : 1.3, L ), 'eta_M': etaN * 0.1,
					'rel': { 'frac_ge1': nodigit, 'frac_ge1e8': 2 * nodigit, 'max': ( nodigit ) ? 50 : 1e-14, 'p999': 1e-14 }, 'hist_rel': [], 'hist_c': [],
					'max_E': etaN, 'exact': ( fam === 'F11' ) ? etaN === 0 : false, 'n_nonfinite': nonfinite },
				'worst': [], 'ref_sha256': 'synthetic', 'wall_ms': 12, 'warnings': [] };
			if ( fam === 'F9a' ) {
				r.metrics.kappa = { 'bins': [ 4, 8, 12 ].map( function f( d ) {
					return { 'log10_kappa': d, 'n': 40000 >> ( d/4 ), 'rel_max': 50e-16 * Math.pow( 10, d ) * rn * seed, 'rel_median': 1e-16 * Math.pow( 10, d ) * rn * seed };
				}), 'czero': { 'n': 3, 'n_err': ( L ) ? 1 : 0 } };
			}
			// As the harness records them (research/accuracy/gates.js): F1 per seed (η_N and η_C ratios to A0 = rn) ...
			if ( fam === 'F1' && a[ 0 ] === 'SW' && k0 >= 32 && L >= 1 && L <= 4 && rn > 2 ) {
				r.warnings.push( 'F1 k0>=32, L<=4: SW more than 2x worse than A0 (eta_N ratio ' + rn.toFixed( 3 ) + ', eta_C ratio ' + rn.toFixed( 3 ) + ')' );
			}
			// ... and the hard-gate violations (the injected F11 inexactness and non-finite output):
			if ( nonfinite ) {
				r.gate_violations = [ 'non-finite output entries: 1' ];
			}
			if ( fam === 'F11' && etaN > 0 ) {
				r.gate_violations = [ 'F11 inexact (SW L=' + L + ': max E = ' + etaN + ')' ];
			}
			nacc += 1;
			acc.push( JSON.stringify( rec( r ) ) );
		});
	}
}


// EXPORTS //

module.exports = {
	'ID': ID,
	'TAU': TAU,
	'TRUTH': TRUTH,
	'E3': E3,
	'generate': generate
};

if ( require.main === module ) {
	console.log( generate( process.argv[ 2 ] || path.join( __dirname, ID ) ) );
}
