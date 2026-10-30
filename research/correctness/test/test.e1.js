'use strict';

// E1 trials are deterministic, pass on the library, and detect planted mutations of the library (compiled in memory
// from the package sources; nothing on disk is modified).

// MODULES //

var tape = require( 'tape' );
var Module = require( 'module' );
var spawnSync = require( 'child_process' ).spawnSync;
var path = require( 'path' );
var fs = require( 'fs' );
var os = require( 'os' );
var paths = require( './../../accuracy/paths.js' );
var records = require( './../../accuracy/records.js' );
var trial = require( './../e1_trial.js' );


// VARIABLES //

var MASTER = 20261030;
var WINOGRAD = path.join( paths.PKG_LIB, 'winograd.js' );


// FUNCTIONS //

/**
* Compiles `src` as if it were the module at `file` (so its relative and package requires resolve normally).
*
* @private
* @param {string} file - module path
* @param {string} src - source text
* @returns {Module} module
*/
function compile( file, src ) {
	var m = new Module( file, null );
	m.filename = file;
	m.paths = Module._nodeModulePaths( path.dirname( file ) );
	m._compile( src, file );
	m.loaded = true;
	return m;
}

/**
* Returns `base()` built with one textual mutation applied to `file` (base.js or winograd.js).
*
* @private
* @param {string} file - file to mutate
* @param {string} from - original text (must occur exactly once)
* @param {string} to - replacement text
* @returns {Function} mutant `base()`
*/
function mutant( file, from, to ) {
	var src = fs.readFileSync( file, 'utf8' );
	var saved;
	var out;
	if ( src.split( from ).length !== 2 ) {
		throw new Error( 'mutation anchor not found exactly once in ' + file + ': ' + from );
	}
	src = src.replace( from, to );
	if ( file === paths.BASE ) {
		return compile( paths.BASE, src ).exports;
	}
	saved = require.cache[ file ];
	require.cache[ file ] = compile( file, src );
	try {
		out = compile( paths.BASE, fs.readFileSync( paths.BASE, 'utf8' ) ).exports;
	} finally {
		if ( saved ) {
			require.cache[ file ] = saved;
		} else {
			delete require.cache[ file ];
		}
	}
	return out;
}

function mismatches( impl, n ) {
	var bad = 0;
	var r;
	var t;
	for ( t = 0; t < n; t++ ) {
		r = trial.runTrial( trial.makeTrial( t, MASTER ), impl );
		if ( !r.ok || r.mutated ) {
			bad += 1;
		}
	}
	return bad;
}


// TESTS //

tape( 'E1 trials are deterministic in (master seed, trial index)', function test( t ) {
	var a = trial.makeTrial( 123, MASTER );
	var b = trial.makeTrial( 123, MASTER );
	t.deepEqual( trial.describe( a ), trial.describe( b ), 'same configuration' );
	t.ok( a.A.buf.every( function same( x, i ) {
		return Object.is( x, b.A.buf[ i ] );
	}), 'same A buffer' );
	t.notDeepEqual( trial.describe( a ), trial.describe( trial.makeTrial( 124, MASTER ) ), 'different trial differs' );
	t.end();
});

tape( 'E1: the library agrees with dgemm bitwise on 3000 trials (and a plain copy compiled in memory does too)', function test( t ) {
	t.strictEqual( mismatches( null, 3000 ), 0, 'library: 0 mismatches' );
	t.strictEqual( mismatches( mutant( WINOGRAD, '// 1. X = S3', '// 1. X = S3' ), 1000 ), 0, 'identity "mutant" (harness control): 0 mismatches' );
	t.end();
});

tape( 'E1 detects planted mutations of the library', function test( t ) {
	var cases = [
		[ WINOGRAD, 'sub( m, n, C, strideC1, strideC2, c21, C, strideC1, strideC2, offsetC,', 'add( m, n, C, strideC1, strideC2, c21, C, strideC1, strideC2, offsetC,', 'U6 = U3 + P4 (wrong sign)' ],
		[ WINOGRAD, 'if ( 2*k < K ) {', 'if ( 2*k < K-1 ) {', 'odd-K peel skipped' ],
		[ WINOGRAD, 'offsetB+( (N-1)*strideB2 ), 0.0, C,', 'offsetB+( (N-1)*strideB2 ), 1.0, C,', 'odd-N peel accumulates into stale C' ],
		[ paths.BASE, 'sa1 = strideA2;\n\t\tsa2 = strideA1;', 'sa1 = strideA1;\n\t\tsa2 = strideA2;', 'transA ignored' ],
		[ paths.BASE, 'if ( beta === 0.0 ) {\n\t\t// Form: C = α*op(A)*op(B)', 'if ( beta === 0.5 ) {\n\t\t// Form: C = α*op(A)*op(B)', 'beta = 0.5 treated as zero' ]
	];
	var n;
	var i;
	for ( i = 0; i < cases.length; i++ ) {
		n = mismatches( mutant( cases[ i ][ 0 ], cases[ i ][ 1 ], cases[ i ][ 2 ] ), 1500 );
		t.ok( n > 0, cases[ i ][ 3 ] + ': detected in ' + n + ' of 1500 trials' );
	}
	t.end();
});

tape( 'e1.js newline-terminates a torn last line of e1.jsonl before appending its record', function test( t ) {
	var dir = fs.mkdtempSync( path.join( os.tmpdir(), 'stratamm-e1-' ) );
	var file = path.join( dir, 'c', 'e1.jsonl' );
	var torn = '{"schema":"sw-bench/2","type":"e1","tri';
	var bad = [];
	var recs;
	var r;
	fs.mkdirSync( path.dirname( file ) );
	fs.writeFileSync( file, torn );
	r = spawnSync( process.execPath, [ path.join( __dirname, '..', 'e1.js' ), '--campaign', 'c', '--trials', '8', '--procs', '1', '--data-root', dir ], { 'encoding': 'utf8', 'timeout': 60000 } );
	t.strictEqual( r.status, 0, 'exit 0' );
	t.ok( /line 1 was cut short by an interrupted write/.test( r.stdout ), 'the repair is logged' );
	t.ok( fs.readFileSync( file, 'utf8' ).indexOf( torn + '\n{' ) === 0, 'torn bytes kept, the new record starts on its own line' );
	recs = records.readJsonl( file, bad );
	t.ok( recs.length === 1 && recs[ 0 ].type === 'e1' && recs[ 0 ].trials === 8 && recs[ 0 ].mismatches === 0, 'the appended e1 record parses' );
	t.deepEqual( bad, [ 1 ], 'the torn line is skipped by readers' );
	fs.rmSync( dir, { 'recursive': true, 'force': true } );
	t.end();
});
