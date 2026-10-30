'use strict';

/*
* Campaign runner (research-protocol.md §2, §4, §5, §9; campaign-runbook.md): runs one admitted, locked session `C`
* built by orchestrator.js. Children run strictly one at a time (spawnSync); this process idles meanwhile.
* Flow: campaign record → pre-flight → display-sleep wait (before the session's first block) → pilot → freeze → E2, E3,
* E5, E4, E0 (randomized complete blocks, sentinel + env_check before each) → E7 memory → E6 accuracy → campaign_end.
* -   STOP file (`research/data/<id>/STOP`): polled between children, before blocks and stage scripts, in every pause.
* -   Sentinel failures pause and re-check; stop after `max_consecutive_failures` once the first is 10 min old.
* -   A resume runs only unsettled configurations (resume.settled); records of a block begun in an earlier session carry
*     `block_resumed: true`; proc, mem, sample and env_check records carry the session's `start_index`.
* -   E6 exit 2 → stopped, 'investigate' (an `e6_stop` record blocks resuming); other E6/E1 failures → stopped,
*     resumable; an E7 abort still runs E6 and ends 'incomplete'. Stderr tails go to campaign.log and campaign_end.
*/

// MODULES //

var fs = require( 'fs' );
var path = require( 'path' );
var design = require( './design.js' );
var budget = require( './budget.js' );
var preflight = require( './preflight.js' );
var resume = require( './resume.js' );
var diagnostics = require( './diagnostics.js' );
var control = require( './control.js' );
var lock = require( './lock.js' );
var procs = require( './procs.js' );


// VARIABLES //

var REPO = path.resolve( __dirname, '..', '..' );


// FUNCTIONS //

function out( line ) {
	console.log( line ); // eslint-disable-line no-console
}

function StopError( message, kind ) {
	this.name = 'StopError';
	this.message = message;
	this.kind = kind || 'stop';
}
StopError.prototype = Object.create( Error.prototype );

function log( C, msg, raw ) {
	var line = ( raw ) ? msg : new Date().toISOString().replace( /\.\d+Z$/, 'Z' ) + ' ' + msg;
	out( line );
	if ( C && C.files ) {
		fs.appendFileSync( C.files.log, line + '\n' );
	}
}

function emit( C, records ) {
	resume.append( C.files.jsonl, records );
}

function rel( f ) {
	return path.relative( REPO, f );
}

// Throws a StopError when research/data/<id>/STOP exists (polled between children and during pauses).
function checkStop( C ) {
	if ( C.files && fs.existsSync( C.files.stop ) ) {
		throw new StopError( 'STOP file found (' + rel( C.files.stop ) + '); resumable: re-run the launch command', 'stop-file' ); // eslint-disable-line max-len
	}
}

// Sleeps in slices of at most 1 s, honouring the STOP file between slices.
function pause( C, ms ) {
	var left = ms;
	checkStop( C );
	while ( left > 0 ) {
		preflight.sleep( Math.min( 1000, left ) );
		left -= 1000;
		checkStop( C );
	}
}

// Post-process bookkeeping: failure counters, stop conditions, the pause, and the model-vs-actual time accounting.
function after( C, spec, ok, err, q, t0, tEnd ) {
	var max = C.P.exclusion.max_consecutive_child_failures;
	C.childFails = ( ok ) ? 0 : C.childFails + 1;
	C.algFails[ spec.alg ] = ( ok ) ? 0 : ( C.algFails[ spec.alg ] || 0 ) + 1;
	if ( C.powerSource && q.power_source && q.power_source !== C.powerSource ) {
		throw new StopError( 'power source changed: ' + C.powerSource + ' -> ' + q.power_source, 'power' );
	}
	if ( C.childFails >= max || C.algFails[ spec.alg ] >= max ) {
		throw new StopError( 'repeated child failures (' + spec.alg + '; last: ' + err + ')', 'child' );
	}
	checkStop( C );
	preflight.sleep( ( spec.meta.pause_s * 1000 ) - ( Date.now() - tEnd ) );
	C.acc.model += budget.procTime( C.P.time_model, spec );
	C.acc.actual += ( Date.now() - t0 ) / 1000;
}

// Runs one child (timing or memory) and appends its proc + samples (or mem) record with the exclusion decision.
function runChild( C, spec, attempt, sentinel ) {
	var ex = C.P.exclusion;
	var mem = ( spec.mode === 'memory' );
	var procId = spec.block_id + ( ( sentinel ) ? '.s' + attempt : '.p' + spec.pos_in_block + '.t' + attempt );
	var pad = design.deriveSeed( C.P.master_seed, 'pad', C.id, procId ) % ( C.P.timing.env_pad_max + 1 );
	var cfg = Object.assign( { 'campaign': C.id, 'stage': spec.stage, 'experiment': spec.experiment, 'block_id': spec.block_id, 'pos_in_block': spec.pos_in_block, 'proc_id': procId }, diagnostics.cfgFields( spec ), { 'mode': spec.mode, 'repoRoot': REPO } ); // eslint-disable-line max-len
	var opts = { 'pad': pad, 'timeoutS': Math.max( C.P.timing.child_timeout.min_s, C.P.timing.child_timeout.factor * budget.procTime( C.P.time_model, spec ) ) }; // eslint-disable-line max-len
	var t0 = Date.now();
	var sw0 = preflight.swapouts();
	var script = ( mem ) ? C.memScript : C.paths.child;
	var res = diagnostics.spawnChild( script, C.P.timing.child_flags, cfg, opts );
	var samples, body, why, tEnd, q, r; // eslint-disable-line one-var
	if ( mem && !res.result && script !== C.paths.child ) {
		log( C, 'WARN ' + rel( script ) + ' failed (' + res.error + '); E7 switches to child.js mode=memory' );
		C.memScript = script = C.paths.child;
		res = diagnostics.spawnChild( script, C.P.timing.child_flags, cfg, opts );
	}
	tEnd = Date.now();
	q = preflight.quick();
	body = ( mem ) ? ( res.result && ( res.result.mem || ( ( res.result.ab0 !== void 0 ) ? res.result : null ) ) ) : ( res.result && res.result.proc ); // eslint-disable-line max-len
	samples = ( !mem && res.result && Array.isArray( res.result.samples ) ) ? res.result.samples : [];
	why = ( body ) ? [] : [ 'child_failed: ' + ( res.error || 'no ' + ( ( mem ) ? 'mem' : 'proc' ) + ' in RESULT' ) ];
	why = why.concat( preflight.exclusionReasons( q, sw0, C.P.exclusion, C.powerSource ) );
	if ( diagnostics.flaggedFraction( samples, ex.flags ) > ex.flagged_fraction_max ) {
		why.push( 'flagged>' + Math.round( ex.flagged_fraction_max * 100 ) + '%' );
	}
	if ( body && body.excluded ) {
		why.push( 'child: ' + ( body.exclusion_reason || 'excluded' ) );
	}
	r = resume.record( C.id, ( mem ) ? 'mem' : 'proc', Object.assign( {}, body || {}, diagnostics.cfgFields( spec ), ( mem ) ? { 'n': spec.M, 'script': rel( script ) } : {}, { // eslint-disable-line max-len
		'proc_id': procId, 'stage': spec.stage, 'experiment': spec.experiment, 'block_id': spec.block_id, 'pos_in_block': spec.pos_in_block, // eslint-disable-line object-property-newline
		'env_pad_bytes': pad, 'attempt': attempt, 'wall_s': ( tEnd - t0 ) / 1000, 'excluded': why.length > 0, 'exclusion_reason': ( why.length ) ? why.join( '; ' ) : null, // eslint-disable-line object-property-newline
		'start_index': C.startIndex, 'block_resumed': C.resumedBlocks.has( spec.block_id ) // eslint-disable-line object-property-newline
	}) );
	emit( C, [ r ].concat( samples.map( function each( s ) {
		return resume.record( C.id, 'sample', Object.assign( {}, s, { 'proc_id': procId, 'start_index': C.startIndex } ) ); // eslint-disable-line max-len
	}) ) );
	C.ran += 1;
	C.excluded += ( r.excluded ) ? 1 : 0;
	after( C, spec, !!body, res.error, q, t0, tEnd );
	return { 'rec': r, 'samples': samples };
}

// Sentinel before a block: drift vs the median of the first `baseline_count` sentinels of the campaign.
function runSentinel( C, block, sspec ) {
	var cfg = C.P.sentinel;
	var attempt = ( C.state.sentinelCount[ block.block_id ] || 0 ) + 1;
	var o, r, info, base; // eslint-disable-line one-var
	C.state.sentinelCount[ block.block_id ] = attempt;
	o = runChild( C, Object.assign( {}, sspec, { 'stage': block.stage, 'block_id': block.block_id } ), attempt, true );
	r = o.rec;
	info = { 'proc_id': r.proc_id, 'median_ns': r.per_call_median_ns || null, 'iqr_ns': diagnostics.iqr( o.samples.map( function f( s ) { // eslint-disable-line max-len
		return s.per_call_ns;
	}) ), 'drift': null, 'baseline_ns': null };
	if ( r.excluded || !( r.per_call_median_ns > 0 ) ) {
		return { 'ok': false, 'why': 'sentinel excluded (' + r.exclusion_reason + ')', 'info': info };
	}
	C.sentinelMedians.push( r.per_call_median_ns );
	base = resume.sentinelBaseline( C.sentinelMedians, cfg.baseline_count );
	if ( base !== null && C.sentinelMedians.length > cfg.baseline_count ) {
		info.baseline_ns = base;
		info.drift = ( r.per_call_median_ns / base ) - 1.0;
		if ( Math.abs( info.drift ) > cfg.drift_threshold ) {
			return { 'ok': false, 'why': 'sentinel drift ' + ( info.drift * 100 ).toFixed( 2 ) + '% vs the median of the first ' + cfg.baseline_count + ' sentinels', 'info': info }; // eslint-disable-line max-len
		}
	}
	return { 'ok': true, 'info': info };
}

function envCheck( C, block, snap, sentinel, reasons ) {
	emit( C, [ resume.envCheckRecord( C.id, block, snap, sentinel, reasons, C.skip, { 'start_index': C.startIndex } ) ] ); // eslint-disable-line max-len
}

function envGate( C, block, windowS ) {
	var g = preflight.gate({
		'cfg': C.P.preflight,
		'prevSwapMb': C.prevSwapMb,
		'powerSource': C.powerSource,
		'windowS': windowS || 0,
		'skip': C.skip,
		'log': log.bind( null, C ),
		'sleep': pause.bind( null, C )
	});
	C.prevSwapMb = g.snap.swap_used_mb;
	if ( g.status === 'stop' || g.status === 'fail' ) {
		envCheck( C, block, g.snap, null, g.reasons );
		throw new StopError( ( ( g.status === 'fail' ) ? 'environment check failing for ' + Math.round( g.waited_s ) + ' s: ' : '' ) + g.reasons.join( '; ' ), ( g.status === 'stop' ) ? 'power' : 'env' ); // eslint-disable-line max-len
	}
	return g;
}

// Before every block: environment gate (pause/re-check up to max_wait_s) and the sentinel (on failure pause pause_s and
// re-check; stop after max_consecutive_failures failures once the first of them is sentinelBudgetS = 10 min old).
function preBlock( C, block, sentinel ) {
	var cfg = C.P.sentinel;
	var budgetS = control.sentinelBudgetS( C.P );
	var g, s, waited; // eslint-disable-line one-var
	for ( ;; ) {
		checkStop( C );
		g = envGate( C, block, 0 );
		if ( !sentinel ) {
			return envCheck( C, block, g.snap, null, g.reasons );
		}
		s = runSentinel( C, block, sentinel );
		envCheck( C, block, g.snap, s.info, g.reasons );
		if ( s.ok ) {
			C.sentinelFails = 0;
			C.sentinelSince = null;
			return null;
		}
		C.sentinelFails += 1;
		C.sentinelSince = C.sentinelSince || Date.now();
		waited = ( Date.now() - C.sentinelSince ) / 1000;
		log( C, 'SENTINEL FAIL ' + C.sentinelFails + ' (' + Math.round( waited ) + ' of ' + budgetS + ' s): ' + s.why );
		if ( C.skip ) {
			C.warnings.push( 'sentinel failures ignored (--skip-preflight)' );
			C.sentinelFails = 0;
			C.sentinelSince = null;
			return null;
		}
		if ( control.sentinelGivesUp( C.sentinelFails, waited, cfg, budgetS ) ) {
			throw new StopError( 'sentinel failed ' + C.sentinelFails + ' consecutive checks over ' + Math.round( waited ) + ' s (' + s.why + ')', 'sentinel' ); // eslint-disable-line max-len
		}
		log( C, 'PAUSE ' + cfg.pause_s + ' s (sentinel), then re-check' );
		pause( C, cfg.pause_s * 1000 );
	}
}

// Once per session, before its first block: wait (bounded) until the display sleeps and no screen saver runs.
function displayWait( C ) {
	var w;
	C.displayChecked = true;
	if ( C.skip ) {
		return log( C, 'DISPLAY wait skipped (--skip-preflight); the display state is recorded in every env_check' );
	}
	w = control.waitForDisplay( { 'budgetS': control.displayBudgetS( C.P ), 'probe': preflight.display, 'pause': pause.bind( null, C ), 'log': log.bind( null, C ) } ); // eslint-disable-line max-len
	emit( C, [ resume.record( C.id, 'display_wait', Object.assign( { 'start_index': C.startIndex }, w ) ) ] );
	if ( w.warning ) {
		C.warnings.push( w.warning );
	}
	log( C, ( w.warning ) ? 'WARN ' + w.warning : 'DISPLAY asleep, no screen saver (waited ' + Math.round( w.waited_s ) + ' s)' ); // eslint-disable-line max-len
}

function describeSpec( p ) {
	return p.alg + ( ( p.params.cutoff === null || p.alg === 'A1' ) ? '' : '(' + p.params.cutoff + ',' + p.params.levels + ')' ) + ' ' + p.meta.shape + ( ( p.ld_pad ) ? ' ld+' + p.ld_pad : '' ) + ( ( p.order !== 'row-major' || p.transA !== 'no-transpose' || p.transB !== 'no-transpose' ) ? ' ' + p.order + '/' + p.transA + '/' + p.transB : '' ) + ( ( p.beta !== 0 || p.alpha !== 1 ) ? ' alpha=' + p.alpha + ' beta=' + p.beta : '' ) + ( ( p.mode === 'memory' ) ? ' [memory]' : '' ); // eslint-disable-line max-len
}

function runSpec( C, p ) {
	var k = resume.procKey( p );
	var attempt = ( C.state.attempts[ k ] || 0 ) + 1;
	var r;
	C.state.attempts[ k ] = attempt;
	r = runChild( C, p, attempt, false ).rec;
	if ( !r.excluded ) {
		C.state.done.add( k );
	}
	log( C, '  ' + r.proc_id + ' ' + describeSpec( p ) + ( ( r.excluded ) ? ' EXCLUDED (' + r.exclusion_reason + ')' : ( ( r.per_call_median_ns ) ? ' ' + ( r.per_call_median_ns / 1e6 ).toFixed( 3 ) + ' ms/call' : ' ok' ) ) ); // eslint-disable-line max-len
	return r;
}

// Configurations still to run: not settled (complete, or excluded after its in-block retry).
function todoOf( C, list ) {
	return list.filter( function f( p ) {
		return !resume.settled( C.state, resume.procKey( p ), C.P.exclusion.max_retries );
	});
}

// Modeled seconds of every stage after `stage` (with the frozen τ*, or the assumed τ before the freeze) + E6.
function laterSeconds( C, stage ) {
	var P = C.P;
	var fr = C.frozen || { 'tau_star': P.pilot.assumed_tau_for_budget, 'levels': P.algorithms.A2.levels, 'batch_by_n': {} };
	var order = [ 'pilot' ].concat( design.TIMING_STAGES, [ 'E7' ] );
	return budget.campaignBudget( P, design.buildAll( P, fr ).slice( order.indexOf( stage ) + 1 ) ).total_s;
}

function runStage( C, d ) {
	var later = laterSeconds( C, d.stage );
	var todo = d.blocks.filter( function f( b ) {
		return todoOf( C, b.procs ).length > 0;
	});
	if ( !todo.length ) {
		return log( C, 'STAGE ' + d.stage + ' COMPLETE (already recorded)' );
	}
	log( C, 'STAGE ' + d.stage + ' START: ' + todo.length + ' of ' + d.blocks.length + ' blocks to run' );
	if ( !C.displayChecked ) {
		displayWait( C );
	}
	todo.forEach( function each( b, i ) {
		var f = ( C.acc.model > 30 ) ? C.acc.actual / C.acc.model : 1.0;
		var rem = todo.slice( i ).reduce( function s( acc, x ) {
			var t = todoOf( C, x.procs );
			return acc + ( ( t.length ) ? budget.blockTime( C.P.time_model, { 'procs': t }, d.sentinel || null ) : 0 );
		}, 0 );
		var retry = [];
		log( C, '[' + d.stage + '] block ' + ( i + 1 ) + '/' + todo.length + ' ' + b.block_id + ' (' + b.label + ', replicate ' + b.rep + '/' + b.r + ') | stage ETA ' + budget.fmt( rem * f ) + ' | campaign ETA ' + budget.fmt( ( rem + later ) * f ) + ' (model x' + f.toFixed( 2 ) + ')' ); // eslint-disable-line max-len
		if ( C.state.blocks.has( b.block_id ) ) { // begun in an earlier session: the rest runs now, unpaired in time
			C.resumedBlocks.add( b.block_id );
			log( C, 'RESUMED block ' + b.block_id + ': ' + todoOf( C, b.procs ).length + ' of ' + b.procs.length + ' configurations left; their records carry block_resumed: true (pairing split across sessions)' ); // eslint-disable-line max-len
		}
		preBlock( C, b, d.sentinel );
		todoOf( C, b.procs ).forEach( function proc( p ) {
			if ( runSpec( C, p ).excluded && C.state.attempts[ resume.procKey( p ) ] <= C.P.exclusion.max_retries ) {
				retry.push( p );
			}
		});
		retry.forEach( function again( p ) { // re-run an excluded configuration once, inside its block's time window
			log( C, 'RETRY ' + p.block_id + ' pos ' + p.pos_in_block + ' ' + describeSpec( p ) );
			envCheck( C, b, envGate( C, b, 0 ).snap, null, [] );
			runSpec( C, p );
		});
	});
	log( C, 'STAGE ' + d.stage + ' COMPLETE' );
}

// Runs E6/E1. A failure throws: E6 exit 2 → 'investigate' (an e6_stop record blocks resuming), else 'stage'.
function runScript( C, name, file ) {
	var conf = C.P[ name ];
	var t0 = Date.now();
	var args, r, o; // eslint-disable-line one-var
	if ( C.state.stagesComplete.has( name ) ) {
		return log( C, 'STAGE ' + name + ' COMPLETE (already recorded)' );
	}
	if ( !file ) {
		C.warnings.push( name + ' skipped (script not found)' );
		return log( C, 'WARN STAGE ' + name + ' skipped: script not found' );
	}
	checkStop( C );
	args = conf.args.map( function sub( x ) {
		return x.replace( '{campaign}', C.id );
	}).concat( ( C.P.mode === 'tiny' ) ? conf.tiny_args : [] );
	log( C, 'STAGE ' + name + ' START: node ' + rel( file ) + ' ' + args.join( ' ' ) );
	r = control.runStageScript( file, args, { 'timeoutS': conf.timeout_s, 'cwd': REPO, 'env': diagnostics.childEnv( null ), 'stderrFile': path.join( C.dir, name + '.stderr.log' ) } ); // eslint-disable-line max-len
	o = control.stageOutcome( name, r, { 'id': C.id, 'mode': C.P.mode } );
	if ( o.ok ) {
		return log( C, 'STAGE ' + name + ' COMPLETE (' + budget.fmt( ( Date.now() - t0 ) / 1000 ) + ')' );
	}
	log( C, 'STAGE ' + name + ' FAILED: ' + o.label + '; stderr in ' + rel( r.stderr_file ) + ( ( r.stderr_tail.length ) ? ', last lines:' : ' (empty)' ) ); // eslint-disable-line max-len
	r.stderr_tail.forEach( function each( l ) {
		log( C, '  ' + name + ' stderr| ' + l );
	});
	if ( o.kind === 'investigate' ) {
		emit( C, [ resume.record( C.id, 'e6_stop', { 'stage': name, 'exit_code': r.status, 'reason': o.reason, 'stderr_tail': r.stderr_tail, 'cleared': false, 'start_index': C.startIndex } ) ] ); // eslint-disable-line max-len
	}
	throw new StopError( o.reason, o.kind );
}

async function start( C, L ) {
	var stub = { 'tau_star': C.P.pilot.assumed_tau_for_budget, 'levels': C.P.algorithms.A2.levels, 'batch_by_n': {} };
	var designs = design.buildAll( C.P, C.state.frozen || stub );
	var bud = budget.campaignBudget( C.P, designs );
	var info, g, stale; // eslint-disable-line one-var
	try {
		info = await preflight.envRecord( REPO, C.P, false );
	} catch ( err ) {
		if ( C.P.mode !== 'tiny' ) {
			throw new StopError( C.P.paths.env + ' failed: ' + err.message, 'env' );
		}
		C.warnings.push( 'env.js failed: ' + err.message );
		log( C, 'WARN ' + C.P.paths.env + ' failed (' + err.message + '); tiny mode records a minimal env' );
		info = await preflight.envRecord( REPO, C.P, true );
	}
	if ( info.source === 'minimal' && C.warnings.length === 0 ) {
		C.warnings.push( 'minimal env (env.js not found)' );
		log( C, 'WARN ' + C.P.paths.env + ' not found; recording a minimal env' );
	}
	emit( C, [ resume.record( C.id, 'campaign', {
		'protocol_sha256': L.sha256,
		'design': {
			'mode': C.P.mode,
			'stage_order': C.P.stage_order,
			'protocol': C.P,
			'counts': budget.campaignBudget( C.P, designs ).stages.map( function each( b ) {
				return { 'stage': b.stage, 'blocks': b.blocks, 'procs': b.procs, 'model_s': Math.round( b.seconds ) };
			}),
			'budget_s': Math.round( bud.total_s ),
			'tau_for_counts': ( C.state.frozen || stub ).tau_star
		},
		'master_seed': C.P.master_seed,
		'env': info.env,
		'provenance': info.provenance,
		'resumed': C.state.campaigns.length > 0,
		'start_index': C.startIndex,
		'argv': process.argv.slice( 2 ),
		'ops': { 'lock': rel( C.lock.file ), 'stop_file': rel( C.files.stop ), 'sentinel_max_wait_s': control.sentinelBudgetS( C.P ), 'display_wait_s': control.displayBudgetS( C.P ), 'auto_resume_max_age_h': control.AUTO_RESUME_MAX_AGE_H, 'settled_after_attempts': 1 + C.P.exclusion.max_retries, 'blocked_process_rules': procs.rules( C.P.preflight ), 'override_e6_stop': C.override } // eslint-disable-line max-len
	}) ] );
	log( C, 'CAMPAIGN ' + C.id + ' (' + C.P.mode + ( ( C.state.campaigns.length ) ? ', resume #' + C.state.campaigns.length + ', ' + C.state.done.size + ' configurations already recorded' : '' ) + '); modeled total ' + budget.fmt( bud.total_s ) + '; data in ' + rel( C.dir ) + '; stop cleanly with: touch ' + rel( C.files.stop ) ); // eslint-disable-line max-len
	C.lock.removed.forEach( function each( x ) {
		log( C, 'removed a stale orchestrator lock (' + x.why + ')' );
	});
	stale = control.clearStaleStop( C.files.stop, C.t0 );
	if ( stale ) {
		log( C, ( stale === 'removed' ) ? 'removed a stale STOP file (older than this launch)' : 'a STOP file newer than this launch exists: stopping' ); // eslint-disable-line max-len
	}
	if ( C.state.e6Stop && !C.state.e6Stop.cleared ) { // admitted only with --override-e6-stop
		emit( C, [ resume.record( C.id, 'e6_stop', { 'stage': 'E6', 'cleared': true, 'reason': 'operator override (--override-e6-stop)', 'start_index': C.startIndex } ) ] ); // eslint-disable-line max-len
		C.warnings.push( 'E6 hard-gate stop overridden (--override-e6-stop)' );
		log( C, 'WARN E6 hard-gate stop overridden (--override-e6-stop): E6 runs again' );
	}
	log( C, 'PREFLIGHT ' + ( ( C.skip ) ? '(--skip-preflight: recorded, never enforced)' : '(' + C.P.preflight.swap_window_s + ' s swap window)' ) ); // eslint-disable-line max-len
	g = envGate( C, { 'block_id': 'preflight', 'stage': 'preflight' }, ( C.skip ) ? 0 : C.P.preflight.swap_window_s );
	C.powerSource = g.snap.power.source;
	envCheck( C, { 'block_id': 'preflight', 'stage': 'preflight' }, g.snap, null, g.reasons );
	log( C, ( g.status === 'pass' ) ? 'PREFLIGHT PASS' : 'PREFLIGHT SKIPPED: ' + g.reasons.join( '; ' ) );
}

function pilotAndFreeze( C ) {
	var fz, fr; // eslint-disable-line one-var
	if ( C.state.frozen ) {
		if ( C.state.frozen.protocol_sha256 !== C.sha ) {
			throw new StopError( 'frozen.json was produced under a different protocol.json', 'protocol' );
		}
		resume.writeFrozen( C.dir, C.state.frozen );
		log( C, 'PILOT already frozen: tau_star=' + C.state.frozen.tau_star + ' (reusing frozen.json; the pilot is never re-run)' );
		return C.state.frozen;
	}
	runStage( C, design.buildPilot( C.P ) );
	try {
		fz = resume.freeze( C.P, resume.readJsonl( C.files.jsonl ).records );
	} catch ( err ) {
		throw new StopError( err.message, 'pilot' );
	}
	fr = resume.record( C.id, 'frozen', Object.assign( { 'protocol_sha256': C.sha }, fz ) );
	resume.writeFrozen( C.dir, fr );
	emit( C, [ fr ] );
	log( C, 'FROZEN tau_star=' + fz.tau_star + ' L_max=' + fz.levels + ' eligible=' + JSON.stringify( fz.pilot_summary.eligible ) + ( ( fz.pilot_summary.fallback ) ? ' (FALLBACK: no tau within the band at every select size)' : '' ) + ' t_best_ns=' + JSON.stringify( fz.pilot_summary.t_best_ns ) + ' batch_by_n=' + JSON.stringify( fz.batch_by_n ) ); // eslint-disable-line max-len
	return fr;
}

// E7, then E6 (and E1 in tiny mode). An E7 abort still runs E6 and ends 'incomplete'; an E6/E1 failure throws.
function postTiming( C ) {
	var P = C.P;
	var e7 = null;
	C.memScript = diagnostics.firstExisting( [ P.paths.memory, P.paths.child ] );
	try {
		runStage( C, design.buildMemory( P, C.frozen ) );
	} catch ( err ) {
		if ( !( err instanceof StopError ) || err.kind !== 'child' ) {
			throw err;
		}
		e7 = 'E7 aborted: ' + err.message;
		C.warnings.push( e7 );
		log( C, 'WARN STAGE ' + e7 + ' (E6 still runs; the campaign ends INCOMPLETE)' );
		C.childFails = 0;
	}
	runScript( C, 'E6', diagnostics.firstExisting( P.paths.accuracy ) );
	if ( P.mode === 'tiny' || P.E1.in_campaign ) {
		runScript( C, 'E1', diagnostics.firstExisting( P.paths.e1 ) );
	}
	if ( e7 ) {
		return finish( C, 'incomplete', e7 + ' - every other stage completed; re-run the launch command to retry the missing E7 configurations', 'e7' ); // eslint-disable-line max-len
	}
	return finish( C, 'complete', null, null );
}

function finish( C, status, reason, kind ) {
	var code = control.exitCode( status, kind );
	var w = C.warnings.filter( function u( x, i, a ) {
		return a.indexOf( x ) === i;
	});
	try {
		emit( C, [ resume.record( C.id, 'campaign_end', { 'status': status, 'reason': reason, 'warnings': w, 'procs_run': C.ran, 'procs_excluded': C.excluded, 'wall_s': ( Date.now() - C.t0 ) / 1000, 'stop_kind': kind || null, 'exit_code': code, 'start_index': C.startIndex } ) ] ); // eslint-disable-line max-len
	} catch ( err ) {
		log( C, 'WARN could not write campaign_end: ' + err.message );
	}
	log( C, 'processes run: ' + C.ran + ', excluded: ' + C.excluded + ', wall ' + budget.fmt( ( Date.now() - C.t0 ) / 1000 ) + ( ( w.length ) ? '; warnings: ' + w.join( '; ' ) : '' ) ); // eslint-disable-line max-len
	log( C, control.endLine( status, reason ), true ); // the final line, verbatim
	process.exitCode = code;
	lock.release( C.lock );
}

// Runs an admitted, locked session `C` to its end (finish writes campaign_end, the final line and the exit code).
async function run( C, L ) {
	var P = C.P;
	process.on( 'SIGHUP', function onHup() {} ); // closing Terminal must not end the run (Node resets nohup's SIG_IGN)
	try {
		await start( C, L );
		C.frozen = pilotAndFreeze( C );
		design.TIMING_STAGES.forEach( function each( s ) {
			runStage( C, design.buildStage( P, C.frozen, s ) );
		});
		postTiming( C );
	} catch ( err ) {
		if ( !( err instanceof StopError ) ) {
			log( C, 'ERROR ' + ( err.stack || err ) );
		}
		finish( C, ( err instanceof StopError ) ? 'stopped' : 'error', ( ( err instanceof StopError ) ? '' : 'error: ' ) + err.message, ( err instanceof StopError ) ? err.kind : 'error' ); // eslint-disable-line max-len
	}
}


// EXPORTS //

module.exports = { 'StopError': StopError, 'run': run, 'checkStop': checkStop, 'pause': pause, 'todoOf': todoOf, 'preBlock': preBlock, 'runScript': runScript, 'postTiming': postTiming, 'finish': finish }; // eslint-disable-line max-len
