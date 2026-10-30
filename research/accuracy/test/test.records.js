'use strict';

// JSONL helpers: a partial last line (interrupted write) is newline-terminated before appending, never rewritten;
// readers skip malformed lines and report their numbers (the arms they held count as missing).

// MODULES //

var tape = require( 'tape' );
var path = require( 'path' );
var fs = require( 'fs' );
var os = require( 'os' );
var records = require( './../records.js' );


// FUNCTIONS //

function tmpFile() {
	return path.join( fs.mkdtempSync( path.join( os.tmpdir(), 'stratamm-jsonl-' ) ), 'x.jsonl' );
}

function line( id ) {
	return JSON.stringify( { 'type': 'accuracy', 'id': id } );
}

function ids( recs ) {
	return recs.map( function f( r ) {
		return r.id;
	});
}


// TESTS //

tape( 'repairTail leaves missing, empty and newline-terminated files alone', function test( t ) {
	var f = tmpFile();
	t.strictEqual( records.repairTail( f ), null, 'missing file' );
	t.ok( !fs.existsSync( f ), 'not created' );
	fs.writeFileSync( f, '' );
	t.strictEqual( records.repairTail( f ), null, 'empty file' );
	fs.writeFileSync( f, line( 1 ) + '\n' + line( 2 ) + '\n' );
	t.strictEqual( records.repairTail( f ), null, 'newline-terminated file' );
	t.strictEqual( fs.readFileSync( f, 'utf8' ), line( 1 ) + '\n' + line( 2 ) + '\n', 'unchanged' );
	fs.rmSync( path.dirname( f ), { 'recursive': true, 'force': true } );
	t.end();
});

tape( 'repairTail newline-terminates a torn record (bytes kept); the next append parses and the torn line is skipped', function test( t ) {
	var f = tmpFile();
	var torn = line( 3 ).slice( 0, 17 );
	var bad = [];
	var info;
	var recs;
	fs.writeFileSync( f, line( 1 ) + '\n' + line( 2 ) + '\n' + torn );
	info = records.repairTail( f );
	t.deepEqual( info, { 'line': 3, 'bytes': torn.length, 'kept': false }, 'reports line, length and that the record is torn' );
	t.strictEqual( fs.readFileSync( f, 'utf8' ), line( 1 ) + '\n' + line( 2 ) + '\n' + torn + '\n', 'only a newline was appended' );
	t.strictEqual( records.repairTail( f ), null, 'idempotent' );
	records.appendLine( f, { 'type': 'accuracy', 'id': 4 } );
	recs = records.readJsonl( f, bad );
	t.deepEqual( ids( recs ), [ 1, 2, 4 ], 'the appended record starts on its own line and parses' );
	t.deepEqual( bad, [ 3 ], 'the torn line is reported' );
	fs.rmSync( path.dirname( f ), { 'recursive': true, 'force': true } );
	t.end();
});

tape( 'repairTail keeps a complete record that only lacks its newline', function test( t ) {
	var f = tmpFile();
	var bad = [];
	fs.writeFileSync( f, line( 1 ) + '\n' + line( 2 ) );
	t.deepEqual( records.repairTail( f ), { 'line': 2, 'bytes': line( 2 ).length, 'kept': true }, 'complete record' );
	records.appendLine( f, { 'type': 'accuracy', 'id': 3 } );
	t.deepEqual( ids( records.readJsonl( f, bad ) ), [ 1, 2, 3 ], 'all three records parse' );
	t.deepEqual( bad, [], 'no malformed line' );
	fs.rmSync( path.dirname( f ), { 'recursive': true, 'force': true } );
	t.end();
});

tape( 'readJsonl skips blank and malformed lines anywhere (no throw) and reports the malformed ones', function test( t ) {
	var f = tmpFile();
	var bad = [];
	fs.writeFileSync( f, line( 1 ) + '\n{"type":"acc\n\n[1,2]\n42\n' + line( 2 ) + '\n' );
	t.deepEqual( ids( records.readJsonl( f, bad ) ), [ 1, 2 ], 'valid records' );
	t.deepEqual( bad, [ 2, 4, 5 ], 'a torn line and non-object JSON lines are malformed; the blank line is not' );
	t.deepEqual( ids( records.readJsonl( f ) ), [ 1, 2 ], 'the report array is optional' );
	t.deepEqual( records.readJsonl( f + '.missing' ), [], 'missing file' );
	fs.rmSync( path.dirname( f ), { 'recursive': true, 'force': true } );
	t.end();
});
