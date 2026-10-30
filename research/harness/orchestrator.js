'use strict';

/*
* StrataMM campaign orchestrator (command line): research-protocol.md §2 (pre-flight), §4 (timing), §5 (stages), §9
* (E7); docs/campaign-runbook.md. The campaign session itself runs in runner.js.
*
* Launch: single-instance lock (research/data/.orchestrator.lock, before the campaign id is chosen; also for --tiny and
* --diagnostics) → campaign id (--id, --new, or the latest unfinished campaign of the mode) → resume admission (refused,
* before anything is written, for another mode, a different protocol.json, an auto-selected campaign older than 12 h, or
* an E6 hard-gate stop without --override-e6-stop) → runner.run. --preflight-only also reports what the launch would do.
*
* Stopping: the design is synchronous, so no JS signal listener could ever run. SIGINT/SIGTERM keep Node's default
* (exit at once; the JSONL is append-only and resumable); SIGHUP is ignored through a no-op listener (Node resets the
* SIG_IGN that nohup sets). A clean stop is `touch research/data/<id>/STOP`, polled between children and during pauses.
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
var runner = require( './runner.js' );

// VARIABLES //

var REPO = path.resolve( __dirname, '..', '..' );
var FLAGS = [ 'dry-run', 'preflight-only', 'campaign', 'tiny', 'diagnostics', 'skip-preflight', 'new', 'override-e6-stop', 'verbose', 'help' ]; // eslint-disable-line max-len
var OPTS = [ 'id', 'tau', 'diag-n' ];
var USAGE = [
	'usage: node research/harness/orchestrator.js <mode>',
	'  --dry-run [--tiny] [--tau N] [--verbose]     print the design and the modeled budget per stage and in total',
	'  --preflight-only [--id ID | --new]           print PREFLIGHT PASS or the failing reasons (incl. what the launch would do)', // eslint-disable-line max-len
	'  --campaign [--id ID | --new]                 full campaign (resumes the latest unfinished campaign by default)',
	'  --tiny [--skip-preflight] [--id ID | --new]  tiny end-to-end grid (< 5 min)',
	'  --diagnostics [--diag-n 512,2048] [--tau N]  JIT trace check of A0 and A2 (default n = 512 and 2048)',
	'  --override-e6-stop (with --id)               re-run E6 of a campaign stopped by an E6 hard gate, after investigating', // eslint-disable-line max-len
	'stop cleanly: touch research/data/<id>/STOP. exit: 0 complete, 2 stopped (resumable), 3 incomplete (E7 aborted),',
	'  4 stopped, investigate (E6 hard gate), 64 usage error or launch refused, 75 another instance is running'
].join( '\n' );

// FUNCTIONS //

function out( line ) {
	console.log( line ); // eslint-disable-line no-console
}

function rel( f ) {
	return path.relative( REPO, f );
}

function parseArgs( argv ) {
	var a = { 'flags': {}, 'opts': {} };
	var t;
	var i;
	for ( i = 0; i < argv.length; i++ ) {
		t = argv[ i ].replace( /^--/, '' );
		if ( argv[ i ].indexOf( '--' ) === 0 && OPTS.indexOf( t ) >= 0 && i + 1 < argv.length ) {
			i += 1;
			a.opts[ t ] = argv[ i ];
		} else if ( argv[ i ].indexOf( '--' ) === 0 && FLAGS.indexOf( t ) >= 0 ) {
			a.flags[ t ] = true;
		} else {
			throw new Error( 'unknown or incomplete argument: ' + argv[ i ] );
		}
	}
	return a;
}

// Acquires research/data/.orchestrator.lock (released on exit); null (REFUSED printed) when a live instance holds it.
function takeLock( dataDir, mode ) {
	var file = lock.lockFile( dataDir );
	var me = lock.procInfo( process.pid );
	var r;
	fs.mkdirSync( dataDir, { 'recursive': true } );
	r = lock.acquire( file, { 'pid': process.pid, 'lstart': me.lstart, 'argv': process.argv.slice( 2 ), 'mode': mode, 'id': null, 't_wall': new Date().toISOString() } ); // eslint-disable-line max-len
	if ( !r.ok ) {
		out( 'REFUSED: ' + lock.describeHolder( r, rel( file ) ) );
		process.exitCode = control.EXIT.locked;
		return null;
	}
	process.on( 'exit', function onExit() {
		lock.release( r.lock );
	});
	r.removed.forEach( function each( x ) {
		out( 'WARN removed a stale orchestrator lock (' + x.why + ')' );
	});
	return Object.assign( r.lock, { 'removed': r.removed } );
}

// Resume admission of campaign `id` (null: may run). `auto`: the id came from findResumable.
function admission( P, L, a, id, st ) {
	var auto = !a.opts.id && !a.flags.new;
	var f = path.join( REPO, P.paths.data, id, 'campaign.jsonl' );
	return control.admit( st, { 'id': id, 'mode': P.mode, 'sha': L.sha256, 'auto': auto, 'override': !!a.flags[ 'override-e6-stop' ], 'ageH': ( auto && fs.existsSync( f ) ) ? ( Date.now() - fs.statSync( f ).mtimeMs ) / 3.6e6 : null } ); // eslint-disable-line max-len
}

async function campaign( a ) {
	var L = design.loadProtocol();
	var P = design.effective( L.protocol, !!a.flags.tiny );
	var dataDir = path.join( REPO, P.paths.data );
	var id, C, lk, st, why; // eslint-disable-line one-var
	if ( !fs.existsSync( path.join( REPO, P.paths.child ) ) ) {
		out( 'CAMPAIGN STOPPED: ' + P.paths.child + ' not found (integration pending)' );
		process.exitCode = 2;
		return;
	}
	lk = takeLock( dataDir, P.mode ); // before the campaign id is chosen: a second instance never picks a campaign
	if ( !lk ) {
		return;
	}
	id = a.opts.id || ( ( a.flags.new ) ? null : resume.findResumable( dataDir, P.mode ) ) || resume.newId( P.mode );
	if ( !/^[\w.-]+$/.test( id ) ) {
		out( 'CAMPAIGN STOPPED: invalid campaign id ' + JSON.stringify( id ) );
		process.exitCode = 64;
		return;
	}
	st = resume.loadState( path.join( dataDir, id ) );
	why = admission( P, L, a, id, st );
	if ( why ) { // refused before anything is written into the campaign directory
		out( 'REFUSED: ' + why );
		process.exitCode = control.EXIT.refused;
		return;
	}
	lock.update( lk, { 'id': id } );
	C = { 'id': id, 'P': P, 'sha': L.sha256, 'dir': path.join( dataDir, id ), 'skip': !!a.flags[ 'skip-preflight' ], 'acc': { 'model': 0, 'actual': 0 }, 'algFails': {}, 'childFails': 0, 'sentinelFails': 0, 'sentinelSince': null, 'warnings': [], 'ran': 0, 'excluded': 0, 't0': Date.now(), 'lock': lk, 'state': st, 'startIndex': st.campaigns.length, 'resumedBlocks': new Set(), 'displayChecked': false, 'override': !!a.flags[ 'override-e6-stop' ] }; // eslint-disable-line max-len
	C.paths = { 'child': path.join( REPO, P.paths.child ) };
	C.files = { 'jsonl': path.join( C.dir, 'campaign.jsonl' ), 'log': path.join( C.dir, 'campaign.log' ), 'stop': path.join( C.dir, 'STOP' ) }; // eslint-disable-line max-len
	fs.mkdirSync( C.dir, { 'recursive': true } );
	resume.ensureTrailingNewline( C.files.jsonl );
	C.sentinelMedians = C.state.sentinelMedians.slice();
	await runner.run( C, L );
}

// What the same launch would do (--preflight-only): `{ line }` or `{ refusal }`.
function launchPlan( P, L, a ) {
	var dataDir = path.join( REPO, P.paths.data );
	var held = lock.inspect( lock.lockFile( dataDir ) );
	var id = a.opts.id || ( ( a.flags.new ) ? null : resume.findResumable( dataDir, P.mode ) );
	var st, why; // eslint-disable-line one-var
	if ( held.held ) {
		return { 'refusal': lock.describeHolder( held, rel( lock.lockFile( dataDir ) ) ) };
	}
	if ( !id ) {
		return { 'line': 'start a new ' + ( ( P.mode === 'tiny' ) ? 'tiny ' : '' ) + 'campaign' };
	}
	st = resume.loadState( path.join( dataDir, id ) );
	why = admission( P, L, a, id, st );
	return ( why ) ? { 'refusal': why } : { 'line': ( ( st.campaigns.length ) ? 'resume ' : 'start ' ) + 'campaign ' + id + ( ( st.campaigns.length ) ? ' (' + st.done.size + ' configurations recorded)' : '' ) }; // eslint-disable-line max-len
}

function main() {
	var tau, res, a, L, P, lk, plan, reasons; // eslint-disable-line one-var
	try {
		a = parseArgs( process.argv.slice( 2 ) );
	} catch ( err ) {
		out( err.message + '\n' + USAGE );
		process.exitCode = 64;
		return;
	}
	if ( a.flags[ 'skip-preflight' ] && !( a.flags.tiny && !a.flags.campaign ) ) {
		out( 'REFUSED: --skip-preflight is only accepted with --tiny, never in --campaign mode' );
		process.exitCode = 64;
		return;
	}
	if ( a.flags[ 'override-e6-stop' ] && !a.opts.id ) {
		out( 'REFUSED: --override-e6-stop needs --id <campaign> (name the campaign you investigated)' );
		process.exitCode = 64;
		return;
	}
	L = design.loadProtocol();
	P = design.effective( L.protocol, !!a.flags.tiny );
	tau = ( a.opts.tau ) ? Number( a.opts.tau ) : P.pilot.assumed_tau_for_budget;
	if ( a.flags[ 'dry-run' ] ) {
		out( budget.dryRunLines( P, design.buildAll( P, { 'tau_star': tau, 'levels': P.algorithms.A2.levels, 'batch_by_n': {} } ), { 'tau': tau, 'sha256': L.sha256, 'file': rel( L.path ), 'verbose': !!a.flags.verbose } ).join( '\n' ) ); // eslint-disable-line max-len
	} else if ( a.flags[ 'preflight-only' ] ) {
		out( 'PREFLIGHT checking (' + P.preflight.swap_window_s + ' s swap window) ...' );
		res = preflight.check( P.preflight );
		plan = launchPlan( P, L, a );
		reasons = res.reasons.concat( ( plan.refusal ) ? [ 'the launch would be refused: ' + plan.refusal ] : [] );
		out( preflight.describe( res.snap ) );
		out( 'LAUNCH: ' + ( plan.line || 'REFUSED' ) );
		out( ( !reasons.length ) ? 'PREFLIGHT PASS' : 'PREFLIGHT FAIL\n' + reasons.map( function f( r ) {
			return '  - ' + r;
		}).join( '\n' ) );
		process.exitCode = ( !reasons.length ) ? 0 : 1;
	} else if ( a.flags.diagnostics ) {
		lk = takeLock( path.join( REPO, P.paths.data ), 'diagnostics' );
		if ( lk ) {
			process.exitCode = ( diagnostics.run( P, { 'sizes': ( a.opts[ 'diag-n' ] ) ? a.opts[ 'diag-n' ].split( ',' ).map( Number ) : P.diagnostics.default_sizes, 'tau': tau, 'outDir': path.join( REPO, P.paths.data, 'diagnostics', resume.newId( 'diag' ) ) } ) ) ? 0 : 1; // eslint-disable-line max-len
			lock.release( lk );
		}
	} else if ( ( a.flags.campaign ? 1 : 0 ) + ( a.flags.tiny ? 1 : 0 ) === 1 ) {
		campaign( a ).catch( function onError( err ) {
			out( 'CAMPAIGN STOPPED: error: ' + ( err.stack || err ) );
			process.exitCode = 1;
		});
	} else {
		out( USAGE );
		process.exitCode = ( a.flags.help ) ? 0 : 64;
	}
}

if ( require.main === module ) {
	main();
}

module.exports = { 'parseArgs': parseArgs, 'StopError': runner.StopError, 'admission': admission, 'launchPlan': launchPlan, 'takeLock': takeLock }; // eslint-disable-line max-len
