'use strict';

// Tests for the single-instance lock (research/harness/lock.js): exclusive create, refusal of a live holder, stale locks
// (dead pid, pid reused after a reboot, a non-orchestrator process, an old unreadable lock) taken over, ownership on
// update/release, and the `ps -o lstart=,command=` parser. Probes are injected (fake pids); one test probes itself.

var tape = require( 'tape' );
var fs = require( 'fs' );
var os = require( 'os' );
var path = require( 'path' );
var lock = require( './../lock.js' );

var LSTART = 'Fri Oct 30 22:31:05 2026';

function tmp() {
	return fs.mkdtempSync( path.join( os.tmpdir(), 'stratamm-lock-' ) );
}

function probe( map ) { // pid -> { alive, lstart, command }
	return function info( pid ) {
		return map[ pid ] || { 'alive': false, 'lstart': null, 'command': null };
	};
}

function holder( pid, lstart ) {
	return { 'pid': pid, 'lstart': lstart, 'argv': [ '--campaign' ], 'mode': 'campaign', 'id': 'campaign-20261030-223105' };
}

tape( 'parseProcInfo: C-locale lstart (space-padded day) and the command line', function test( t ) {
	t.deepEqual( lock.parseProcInfo( 'Fri Oct 30 22:31:05 2026     node research/harness/orchestrator.js --campaign\n' ), { 'lstart': LSTART, 'command': 'node research/harness/orchestrator.js --campaign' }, 'two-digit day' ); // eslint-disable-line max-len
	t.deepEqual( lock.parseProcInfo( 'Sun Nov  1 01:02:03 2026 /sbin/launchd' ), { 'lstart': 'Sun Nov 1 01:02:03 2026', 'command': '/sbin/launchd' }, 'padded day normalized' ); // eslint-disable-line max-len
	t.equal( lock.parseProcInfo( '' ), null, 'no process' );
	t.equal( lock.parseProcInfo( null ), null, 'ps failed' );
	t.end();
});

tape( 'procInfo on this process and on a pid that does not exist', function test( t ) {
	var me = lock.procInfo( process.pid );
	t.equal( me.alive, true, 'alive' );
	t.ok( /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test( me.lstart ), 'start time ' + me.lstart );
	t.ok( /node|tape/.test( me.command ), 'command line' );
	t.deepEqual( lock.procInfo( 99999999 ), { 'alive': false, 'lstart': null, 'command': null }, 'fake pid is not running' );
	t.end();
});

tape( 'acquire creates the lock exclusively; a live orchestrator holder refuses the second launch', function test( t ) {
	var f = path.join( tmp(), lock.NAME );
	var live = probe( { '4242': { 'alive': true, 'lstart': LSTART, 'command': 'node research/harness/orchestrator.js --campaign' } } ); // eslint-disable-line max-len
	var a = lock.acquire( f, holder( 4242, LSTART ), { 'probe': live } );
	var b;
	t.equal( a.ok, true, 'first launch acquires' );
	t.deepEqual( a.lock, { 'file': f, 'pid': 4242, 'lstart': LSTART }, 'lock handle' );
	t.equal( JSON.parse( fs.readFileSync( f, 'utf8' ) ).id, 'campaign-20261030-223105', 'contents written' );
	b = lock.acquire( f, holder( 5151, 'Fri Oct 30 22:40:00 2026' ), { 'probe': live } );
	t.equal( b.ok, false, 'second launch refused' );
	t.equal( b.holder.pid, 4242, 'names the live pid' );
	t.ok( /running since Fri Oct 30 22:31:05 2026/.test( b.why ), b.why );
	t.ok( /another orchestrator instance is running .*campaign campaign-20261030-223105.*pgrep -fl/.test( lock.describeHolder( b, 'research/data/.orchestrator.lock' ) ), 'refusal message names the campaign and the check' ); // eslint-disable-line max-len
	t.equal( JSON.parse( fs.readFileSync( f, 'utf8' ) ).pid, 4242, 'the live lock is untouched' );
	t.end();
});

tape( 'stale locks are removed and the create retried', function test( t ) {
	var dir = tmp();
	var f = path.join( dir, lock.NAME );
	var cases = [
		[ 'dead pid', probe( {} ), /pid 4242 is not running/ ],
		[ 'pid reused after a reboot', probe( { '4242': { 'alive': true, 'lstart': 'Sat Oct 31 07:00:00 2026', 'command': 'node research/harness/orchestrator.js --campaign' } } ), /now belongs to another process/ ], // eslint-disable-line max-len
		[ 'pid reused by another program', probe( { '4242': { 'alive': true, 'lstart': LSTART, 'command': '/usr/libexec/trustd' } } ), /is not an orchestrator/ ] // eslint-disable-line max-len
	];
	cases.forEach( function each( c ) {
		var r;
		fs.writeFileSync( f, JSON.stringify( holder( 4242, LSTART ) ) );
		r = lock.acquire( f, holder( 777, 'Sat Oct 31 08:00:00 2026' ), { 'probe': c[ 1 ] } );
		t.equal( r.ok, true, c[ 0 ] + ': acquired' );
		t.equal( r.removed.length, 1, c[ 0 ] + ': one stale lock removed' );
		t.ok( c[ 2 ].test( r.removed[ 0 ].why ), c[ 0 ] + ': ' + r.removed[ 0 ].why );
		t.equal( JSON.parse( fs.readFileSync( f, 'utf8' ) ).pid, 777, c[ 0 ] + ': new owner' );
		fs.unlinkSync( f );
	});
	t.end();
});

tape( 'missing information counts as live; malformed locks', function test( t ) {
	var f = path.join( tmp(), lock.NAME );
	var r;
	fs.writeFileSync( f, JSON.stringify( holder( 4242, LSTART ) ) );
	r = lock.acquire( f, holder( 777, null ), { 'probe': probe( { '4242': { 'alive': true, 'lstart': null, 'command': null } } ) } ); // eslint-disable-line max-len
	t.equal( r.ok, false, 'alive pid without ps details is treated as live' );
	fs.writeFileSync( f, '' ); // a launch that crashed between create and write, or is writing right now
	r = lock.acquire( f, holder( 777, null ), { 'probe': probe( {} ), 'now': function now() {
		return fs.statSync( f ).mtimeMs + 1000;
	} } );
	t.equal( r.ok, false, 'a fresh unreadable lock is respected' );
	r = lock.acquire( f, holder( 777, null ), { 'probe': probe( {} ), 'now': function now() {
		return fs.statSync( f ).mtimeMs + 60000;
	} } );
	t.equal( r.ok, true, 'an old unreadable lock is stale' );
	t.equal( r.removed[ 0 ].why, 'unreadable lock', 'reason' );
	fs.writeFileSync( f, JSON.stringify( { 'pid': -1 } ) );
	t.equal( lock.holderState( { 'pid': -1 } ).live, false, 'no valid pid' );
	t.equal( lock.acquire( f, holder( 777, null ), { 'probe': probe( {} ) } ).ok, true, 'malformed pid is stale' );
	t.end();
});

tape( 'update and release touch only an owned lock', function test( t ) {
	var f = path.join( tmp(), lock.NAME );
	var a = lock.acquire( f, holder( 4242, LSTART ), { 'probe': probe( {} ) } );
	var other = { 'file': f, 'pid': 4242, 'lstart': 'Sat Oct 31 07:00:00 2026' };
	t.equal( lock.update( a.lock, { 'id': 'campaign-x' } ), true, 'owner updates' );
	t.equal( JSON.parse( fs.readFileSync( f, 'utf8' ) ).id, 'campaign-x', 'id recorded' );
	t.notOk( fs.existsSync( f + '.tmp' ), 'atomic rename' );
	t.equal( lock.update( other, { 'id': 'y' } ), false, 'same pid, other start time: not the owner' );
	t.equal( lock.release( other ), false, 'release by a non-owner is a no-op' );
	t.ok( fs.existsSync( f ), 'lock kept' );
	t.equal( lock.release( a.lock ), true, 'owner releases' );
	t.notOk( fs.existsSync( f ), 'lock removed' );
	t.equal( lock.release( a.lock ), false, 'second release is a no-op' );
	t.equal( lock.release( null ), false, 'no lock' );
	t.end();
});

tape( 'inspect reports a live holder without taking the lock', function test( t ) {
	var f = path.join( tmp(), lock.NAME );
	t.equal( lock.inspect( f ).held, false, 'no lock' );
	fs.writeFileSync( f, JSON.stringify( holder( process.pid, lock.procInfo( process.pid ).lstart ) ) );
	t.equal( lock.inspect( f ).held, false, 'this test process is not an orchestrator' );
	t.equal( lock.inspect( f, { 'probe': probe( { '4242': { 'alive': true, 'lstart': LSTART, 'command': 'node research/harness/orchestrator.js --tiny' } } ) } ).held, false, 'probe: that pid is not running' ); // eslint-disable-line max-len
	fs.writeFileSync( f, JSON.stringify( holder( 4242, LSTART ) ) );
	t.equal( lock.inspect( f, { 'probe': probe( { '4242': { 'alive': true, 'lstart': LSTART, 'command': 'node research/harness/orchestrator.js --tiny' } } ) } ).held, true, 'live holder' ); // eslint-disable-line max-len
	t.ok( fs.existsSync( f ), 'inspect never removes' );
	t.end();
});
