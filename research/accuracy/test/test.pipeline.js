'use strict';

// Integration: reference pass + cache + evaluateShard on a small shard produce complete, gated, certified records.

// MODULES //

var tape = require( 'tape' );
var path = require( 'path' );
var fs = require( 'fs' );
var os = require( 'os' );
var design = require( './../design.js' );
var families = require( './../families.js' );
var reference = require( './../reference.js' );
var records = require( './../records.js' );
var evaluateShard = require( './../evaluate.js' );


// TESTS //

tape( 'evaluateShard: every arm yields a certified accuracy record; a missing or stale cache is a hard error', function test( t ) {
	var dir = fs.mkdtempSync( path.join( os.tmpdir(), 'stratamm-e6-' ) );
	var shards = design.shards( { 'masterSeed': 1, 'sizes': [ 32 ], 'families': [ 'F4' ], 'seeds': 1, 'Lmax': 2 } );
	var opts = { 'campaign': 'test', 'cacheDir': dir, 'masterSeed': 1, 'pkgSha': 'x' };
	var s = shards[ 0 ];
	var gen;
	var res;
	try {
		t.strictEqual( shards.length, 3, 'F4 has three parameter sets (s = 10, 20, 40)' );
		t.deepEqual( s.arms.map( function f( a ) {
			return a.alg + a.levels;
		}), [ 'A00', 'SW1', 'SW2', 'V11', 'V12', 'V21', 'V22' ], 'arms: A0 (levels 0), SW, V1 and V2 (F4) at L = 1..2' );
		t.throws( function missing() {
			evaluateShard( s, opts );
		}, /missing/, 'missing cache entry' );
		gen = families.generate( s.family, s.params, s.n, s.seed );
		reference.saveReference( dir, s.name, reference.computeSerial( s.n, s.n, s.n, gen.A, gen.B ), {
			'M': s.n,
			'N': s.n,
			'K': s.n,
			'inputs_sha256': records.sha256Arrays( [ gen.A, gen.B ] )
		});
		res = evaluateShard( s, opts );
		t.strictEqual( res.records.length, 7, 'one record per arm' );
		t.deepEqual( res.violations, [], 'no gate violations' );
		t.ok( res.records.every( function f( r ) {
			return r.schema === 'sw-bench/2' && r.type === 'accuracy' && r.campaign === 'test' && typeof r.t_wall === 'string' && r.cert.bigint_n === 32 && r.worst.length === 20 && r.metrics.hist_c.counts.length === 64;
		}), 'records carry the schema fields, certification summary, 20 worst entries and histograms' );
		t.strictEqual( res.records[ 1 ].L, 1, 'SW L recorded' );
		t.strictEqual( res.records[ 1 ].k0, 16, 'k0 = n/2^L' );
		t.strictEqual( res.records[ 1 ].metrics.identical_to_A0, false, 'SW differs from A0' );
		s = Object.assign( {}, s, { 'seed': s.seed + 1 } );
		t.throws( function stale() {
			evaluateShard( s, opts );
		}, /missing|different inputs/, 'another seed has no (valid) cache entry' );
	} finally {
		fs.rmSync( dir, { 'recursive': true, 'force': true } );
	}
	t.end();
});
