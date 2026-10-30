'use strict';

/*
* Campaign state from the append-only JSONL (`research/data/<id>/campaign.jsonl`, schema sw-bench/2) and the pilot
* freeze (research-protocol.md §5.1).
*
* -   A configuration is complete when a non-excluded `proc` (timing) or `mem` (E7) record carries its key (stage,
*     experiment, block, algorithm, params, shape, order, transposes, ld_pad, α, β). It is settled when complete or
*     excluded after 1 + max_retries attempts (its in-block retry is spent, §4: replication stays fixed). A resume
*     re-runs only unsettled configurations (missing, or excluded before their retry), so at most the block that was
*     interrupted runs again, split across sessions (its new records carry `block_resumed: true`). A pilot that
*     produced frozen.json is never re-run. An `e6_stop` record (E6 exit 2) blocks resuming until it is cleared.
* -   Freeze: τ* = the largest τ whose cell median is ≤ 1.02·t_best(n) at every select size (cell = median of the
*     non-excluded process medians); b(shape) = max(1, ceil(0.020 s / T_A0)) with T_A0 from the pilot A0 cells.
*/

// MODULES //

var fs = require( 'fs' );
var path = require( 'path' );
var design = require( './design.js' );
var budget = require( './budget.js' );


// FUNCTIONS //

function nul( x ) {
	return ( x === void 0 ) ? null : x;
}

/**
* Reads a JSONL file; malformed lines (e.g. one truncated by a crash) are counted and skipped.
*
* @param {string} file - path
* @returns {Object} `{ records, bad }`
*/
function readJsonl( file ) {
	var records = [];
	var bad = 0;
	if ( fs.existsSync( file ) ) {
		fs.readFileSync( file, 'utf8' ).split( '\n' ).forEach( function each( line ) {
			if ( line.trim() === '' ) {
				return;
			}
			try {
				records.push( JSON.parse( line ) );
			} catch ( err ) { // eslint-disable-line no-unused-vars
				bad += 1;
			}
		});
	}
	return { 'records': records, 'bad': bad };
}

/**
* Terminates a partial last line so that appended records start on a fresh line.
*
* @param {string} file - path
* @returns {boolean} whether a newline was added
*/
function ensureTrailingNewline( file ) {
	var buf = Buffer.alloc( 1 );
	var size;
	var fd;
	if ( !fs.existsSync( file ) || ( size = fs.statSync( file ).size ) === 0 ) {
		return false;
	}
	fd = fs.openSync( file, 'r' );
	fs.readSync( fd, buf, 0, 1, size - 1 );
	fs.closeSync( fd );
	if ( buf[ 0 ] === 10 ) {
		return false;
	}
	fs.appendFileSync( file, '\n' );
	return true;
}

/**
* Appends records (one JSON object per line) with a single write.
*
* @param {string} file - path
* @param {Array<Object>} records - records
*/
function append( file, records ) {
	fs.appendFileSync( file, records.map( function line( r ) {
		return JSON.stringify( r ) + '\n';
	}).join( '' ) );
}

/**
* Builds a sw-bench/2 record (`schema`, `type`, `campaign` and `t_wall` always win over `fields`).
*
* @param {string} campaign - campaign id
* @param {string} type - record type
* @param {Object} fields - fields
* @returns {Object} record
*/
function record( campaign, type, fields ) {
	var b = { 'schema': 'sw-bench/2', 'type': type, 'campaign': campaign, 't_wall': new Date().toISOString() };
	return Object.assign( {}, b, fields, b );
}

/**
* Builds an `env_check` record from an environment snapshot.
*
* @param {string} campaign - campaign id
* @param {Object} block - `{ block_id, stage }`
* @param {Object} snap - preflight snapshot
* @param {(Object|null)} sentinel - `{ proc_id, median_ns, iqr_ns, drift, baseline_ns }` or null
* @param {Array<string>} reasons - failing pre-flight reasons (empty: pass)
* @param {boolean} skip - whether --skip-preflight was given
* @param {Object} [extra] - additional fields (e.g. `start_index`)
* @returns {Object} record
*/
function envCheckRecord( campaign, block, snap, sentinel, reasons, skip, extra ) {
	return record( campaign, 'env_check', Object.assign( {
		'block_id': block.block_id, 'stage': block.stage, 'power': snap.power, 'low_power_mode': snap.low_power_mode, // eslint-disable-line object-property-newline
		'thermal_state': snap.thermal_state, 'load_avg': snap.load_avg, 'swap_used_mb': snap.swap_used_mb, 'pressure_level': snap.pressure_level, // eslint-disable-line object-property-newline, max-len
		'swapouts': snap.swapouts, 'top_cpu': snap.top_cpu, 'sentinel': sentinel, 'pass': reasons.length === 0, 'reasons': reasons, 'skip_preflight': skip, // eslint-disable-line object-property-newline, max-len
		'display_asleep': nul( snap.display_asleep ), 'screensaver_running': nul( snap.screensaver_running ), 'blocked': snap.blocked || null, // eslint-disable-line object-property-newline, max-len
		'blocked_ignored': snap.blocked_ignored || null, 'harness_procs': snap.harness_procs || null // eslint-disable-line object-property-newline
	}, extra || {} ) );
}

/**
* Returns the resume key of a process specification or record.
*
* @param {Object} p - spec, proc record or mem record
* @returns {string} key
*/
function procKey( p ) {
	var q = p.params || {};
	return JSON.stringify( [ p.stage, p.experiment, p.block_id, p.alg, nul( q.cutoff ), nul( q.levels ), p.M, p.N, p.K, p.order, p.transA, p.transB, p.ld_pad, p.alpha, p.beta ] ); // eslint-disable-line max-len
}

/**
* Returns the median of the first `count` sentinel medians (null until `count` exist).
*
* @param {Array<number>} medians - sentinel per-call medians in campaign order
* @param {PositiveInteger} count - baseline size
* @returns {(number|null)} baseline
*/
function sentinelBaseline( medians, count ) {
	return ( medians.length < count ) ? null : design.median( medians.slice( 0, count ) );
}

/**
* Returns whether a configuration is settled: recorded non-excluded, or excluded after 1 + `maxRetries` attempts.
*
* @param {Object} st - state (`loadState`, updated during the session)
* @param {string} key - `procKey`
* @param {NonNegativeInteger} maxRetries - protocol `exclusion.max_retries`
* @returns {boolean} whether a resume skips it
*/
function settled( st, key, maxRetries ) {
	return st.done.has( key ) || ( st.attempts[ key ] || 0 ) >= 1 + maxRetries;
}

/**
* Loads a campaign directory's state.
*
* @param {string} dir - campaign directory
* @returns {Object} state (`records`, `done`, `attempts`, `sentinelMedians`, `sentinelCount`, `campaigns`, `protocolSha`,
*   `mode`, `frozen`, `lastEnd`, `stagesComplete`, `blocks` (block ids with proc/mem records), `e6Stop`, `bad`)
*/
function loadState( dir ) {
	var data = readJsonl( path.join( dir, 'campaign.jsonl' ) );
	var frozenFile = path.join( dir, 'frozen.json' );
	var logFile = path.join( dir, 'campaign.log' );
	var st = {
		'records': data.records,
		'bad': data.bad,
		'done': new Set(),
		'attempts': {},
		'sentinelMedians': [],
		'sentinelCount': {},
		'campaigns': [],
		'protocolSha': null,
		'mode': null,
		'frozen': null,
		'lastEnd': null,
		'stagesComplete': new Set(),
		'blocks': new Set(),
		'e6Stop': null
	};
	data.records.forEach( function each( r ) {
		var k;
		if ( r.type === 'campaign' ) {
			st.campaigns.push( r );
			st.protocolSha = st.protocolSha || r.protocol_sha256;
			st.mode = st.mode || ( r.design && r.design.mode ) || null;
		} else if ( r.type === 'campaign_end' ) {
			st.lastEnd = r;
		} else if ( r.type === 'frozen' ) {
			st.frozen = r;
		} else if ( r.type === 'e6_stop' ) {
			st.e6Stop = r; // the last one wins: `cleared: true` lifts a stop
		} else if ( r.type === 'proc' && r.experiment === 'sentinel' ) {
			st.sentinelCount[ r.block_id ] = ( st.sentinelCount[ r.block_id ] || 0 ) + 1;
			if ( !r.excluded && r.per_call_median_ns > 0 ) {
				st.sentinelMedians.push( r.per_call_median_ns );
			}
		} else if ( r.type === 'proc' || r.type === 'mem' ) {
			k = procKey( r );
			st.blocks.add( r.block_id );
			st.attempts[ k ] = ( st.attempts[ k ] || 0 ) + 1;
			if ( !r.excluded ) {
				st.done.add( k );
			}
		}
	});
	if ( fs.existsSync( frozenFile ) ) {
		st.frozen = JSON.parse( fs.readFileSync( frozenFile, 'utf8' ) );
	}
	if ( fs.existsSync( logFile ) ) {
		fs.readFileSync( logFile, 'utf8' ).split( '\n' ).forEach( function each( line ) {
			var m = / STAGE (\S+) COMPLETE(?:\s|$)/.exec( line );
			if ( m ) {
				st.stagesComplete.add( m[ 1 ] );
			}
		});
	}
	return st;
}

/**
* Writes frozen.json atomically (temporary file + rename).
*
* @param {string} dir - campaign directory
* @param {Object} frozen - frozen record
*/
function writeFrozen( dir, frozen ) {
	var f = path.join( dir, 'frozen.json' );
	fs.writeFileSync( f + '.tmp', JSON.stringify( frozen, null, 2 ) + '\n' );
	fs.renameSync( f + '.tmp', f );
}

/**
* Finds the most recent campaign of a mode whose last `campaign_end` is not `complete` (or that never ended).
*
* @param {string} dataDir - research/data
* @param {string} mode - 'campaign' or 'tiny'
* @returns {(string|null)} campaign id
*/
function findResumable( dataDir, mode ) {
	var best = null;
	if ( !fs.existsSync( dataDir ) ) {
		return null;
	}
	fs.readdirSync( dataDir ).forEach( function each( id ) {
		var f = path.join( dataDir, id, 'campaign.jsonl' );
		var st;
		var t;
		if ( !fs.existsSync( f ) ) {
			return;
		}
		st = loadState( path.join( dataDir, id ) );
		if ( st.mode !== mode || ( st.lastEnd && st.lastEnd.status === 'complete' ) ) {
			return;
		}
		t = fs.statSync( f ).mtimeMs;
		if ( best === null || t > best.t ) {
			best = { 'id': id, 't': t };
		}
	});
	return ( best ) ? best.id : null;
}

/**
* Returns a new campaign id such as `campaign-20261030-230000` (UTC).
*
* @param {string} mode - prefix ('campaign', 'tiny', ...)
* @param {Date} [date] - timestamp
* @returns {string} id
*/
function newId( mode, date ) {
	var d = ( date || new Date() ).toISOString();
	return mode + '-' + d.slice( 0, 10 ).replace( /-/g, '' ) + '-' + d.slice( 11, 19 ).replace( /:/g, '' );
}

/**
* Applies the §5.1 selection rule: τ* = the largest τ whose cell median is ≤ band·t_best(n) at every select size.
*
* ## Notes
* -   A τ with a missing cell at any select size is ineligible; t_best(n) is the minimum over the available cells.
* -   Only if no τ is eligible: the pre-registered fallback (protocol.json `pilot.fallback`) picks, among the τ with a
*     cell at every size, the one minimizing max_n median(τ, n)/t_best(n), ties to the larger τ (`fallback: true`).
*
* @param {Object} cells - `{ [n]: { [tau]: Array<number> } }` process medians (ns)
* @param {Array<number>} sizes - select sizes
* @param {Array<number>} taus - candidate cutoffs
* @param {number} band - band factor (1.02)
* @returns {Object} `{ tau_star, fallback, eligible, t_best, medians, worst_ratio }` (`tau_star` null if impossible)
*/
function selectTau( cells, sizes, taus, band ) {
	var ts = taus.slice().sort( function cmp( a, b ) {
		return a - b;
	});
	var out = { 'tau_star': null, 'fallback': false, 'eligible': [], 't_best': {}, 'medians': {}, 'worst_ratio': {} };
	var best = Infinity;
	sizes.forEach( function each( n ) {
		var vals = [];
		out.medians[ n ] = {};
		ts.forEach( function tau( t ) {
			var v = cells[ n ] && cells[ n ][ t ];
			if ( v && v.length ) {
				out.medians[ n ][ t ] = design.median( v );
				vals.push( out.medians[ n ][ t ] );
			}
		});
		out.t_best[ n ] = ( vals.length ) ? Math.min.apply( null, vals ) : null;
	});
	ts.forEach( function tau( t ) {
		var ok = true;
		var w = 0;
		sizes.forEach( function each( n ) {
			var m = out.medians[ n ][ t ];
			if ( m === void 0 || out.t_best[ n ] === null ) {
				ok = false;
				w = null;
				return;
			}
			w = ( w === null ) ? null : Math.max( w, m / out.t_best[ n ] );
			ok = ok && ( m <= band * out.t_best[ n ] * ( 1.0 + 1.0e-12 ) ); // relative 1e-12: floating-point slack only
		});
		out.worst_ratio[ t ] = w;
		if ( ok ) {
			out.eligible.push( t );
		}
	});
	if ( out.eligible.length ) {
		out.tau_star = out.eligible[ out.eligible.length - 1 ];
		return out;
	}
	ts.forEach( function tau( t ) {
		if ( out.worst_ratio[ t ] !== null && out.worst_ratio[ t ] <= best ) { // ascending τ: ties go to the larger τ
			best = out.worst_ratio[ t ];
			out.tau_star = t;
		}
	});
	out.fallback = ( out.tau_star !== null );
	return out;
}

/**
* Groups non-excluded pilot process medians: τ cells (A2 at the select sizes), A0 cells by shape, XL cells by algorithm.
*
* @param {Array<Object>} records - JSONL records
* @returns {Object} `{ tau, a0, xl }`
*/
function pilotCells( records ) {
	var out = { 'tau': {}, 'a0': {}, 'xl': {} };
	function push( o, k, v ) {
		( o[ k ] = o[ k ] || [] ).push( v );
	}
	records.forEach( function each( r ) {
		var m = r.per_call_median_ns;
		if ( r.type !== 'proc' || r.stage !== 'pilot' || r.excluded || r.experiment === 'sentinel' || !( m > 0 ) ) {
			return;
		}
		if ( r.alg === 'A0' ) {
			push( out.a0, design.shapeKey( r.M, r.N, r.K ), m );
		}
		if ( r.alg === 'A2' && r.experiment === 'pilot.tau' ) {
			out.tau[ r.M ] = out.tau[ r.M ] || {};
			push( out.tau[ r.M ], r.params.cutoff, m );
		}
		if ( r.experiment === 'pilot.xl' ) {
			push( out.xl, r.alg, m );
		}
	});
	return out;
}

/**
* Computes b(shape) = max(1, ceil(target / T_A0)); T_A0 is the pilot A0 cell median at the same square size, else the
* nearest measured size (in log n) scaled by 2MNK, else the time model.
*
* @param {Object} P - effective protocol
* @param {Object} a0 - `{ shapeKey: Array<number> }` A0 process medians (ns)
* @param {Array<Object>} shapes - `{ M, N, K }`
* @returns {Object} `{ shapeKey: batch }`
*/
function batchTable( P, a0, shapes ) {
	var meas = Object.keys( a0 ).filter( function square( k ) {
		return /^\d+$/.test( k ) && a0[ k ].length > 0;
	}).map( function each( k ) {
		return { 'n': Number( k ), 't': design.median( a0[ k ] ) / 1.0e9 };
	});
	var table = {};
	shapes.forEach( function each( s ) {
		var f = s.M * s.N * s.K;
		var t = budget.tA0( P.time_model, s.M, s.N, s.K );
		var best = null;
		meas.forEach( function near( m ) {
			var d = Math.abs( Math.log( m.n / Math.cbrt( f ) ) );
			if ( best === null || d < best.d ) {
				best = { 'd': d, 'm': m };
			}
		});
		if ( best ) {
			t = best.m.t * f / Math.pow( best.m.n, 3 );
		}
		table[ design.shapeKey( s.M, s.N, s.K ) ] = Math.max( 1, Math.ceil( P.timing.sample_target_s / t ) );
	});
	return table;
}

/**
* Runs the automatic freeze from the pilot records: τ*, L_max and b(shape) for every shape of the timing stages.
*
* @param {Object} P - effective protocol
* @param {Array<Object>} records - JSONL records
* @throws {Error} when no τ can be selected
* @returns {Object} `{ tau_star, levels, batch_by_n, pilot_summary }`
*/
function freeze( P, records ) {
	var cells = pilotCells( records );
	var sel = selectTau( cells.tau, P.pilot.select_sizes, P.pilot.taus, P.pilot.band );
	var shapes = {};
	var a0med = {};
	var fz;
	if ( sel.tau_star === null ) {
		throw new Error( 'pilot selection impossible: no tau has a valid cell at every select size ' + JSON.stringify( sel.medians ) );
	}
	fz = { 'tau_star': sel.tau_star, 'levels': P.algorithms.A2.levels, 'batch_by_n': {} };
	design.TIMING_STAGES.forEach( function each( s ) {
		design.buildStage( P, fz, s ).blocks.forEach( function blk( b ) {
			b.procs.forEach( function proc( p ) {
				shapes[ p.meta.shape ] = { 'M': p.M, 'N': p.N, 'K': p.K };
			});
		});
	});
	Object.keys( cells.a0 ).forEach( function each( k ) {
		a0med[ k ] = design.median( cells.a0[ k ] );
	});
	fz.batch_by_n = batchTable( P, cells.a0, Object.keys( shapes ).map( function each( k ) {
		return shapes[ k ];
	}) );
	fz.pilot_summary = {
		'rule': 'largest tau with cell median <= ' + P.pilot.band + ' * t_best(n) at every n in ' + JSON.stringify( P.pilot.select_sizes ), // eslint-disable-line max-len
		'select_sizes': P.pilot.select_sizes,
		'taus': P.pilot.taus,
		'medians_ns': sel.medians,
		't_best_ns': sel.t_best,
		'eligible': sel.eligible,
		'worst_ratio': sel.worst_ratio,
		'fallback': sel.fallback,
		'a0_median_ns': a0med,
		'xl': {
			'n': P.pilot.xl.n,
			'tau': P.pilot.xl.tau,
			'A0_median_ns': ( cells.xl.A0 ) ? design.median( cells.xl.A0 ) : null,
			'A2_median_ns': ( cells.xl.A2 ) ? design.median( cells.xl.A2 ) : null
		}
	};
	return fz;
}


// EXPORTS //

module.exports = {
	'readJsonl': readJsonl,
	'ensureTrailingNewline': ensureTrailingNewline,
	'append': append,
	'record': record,
	'envCheckRecord': envCheckRecord,
	'procKey': procKey,
	'sentinelBaseline': sentinelBaseline,
	'settled': settled,
	'loadState': loadState,
	'writeFrozen': writeFrozen,
	'findResumable': findResumable,
	'newId': newId,
	'selectTau': selectTau,
	'pilotCells': pilotCells,
	'batchTable': batchTable,
	'freeze': freeze
};
