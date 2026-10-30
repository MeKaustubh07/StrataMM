'use strict';

// Tests for research/harness/design.js: the grid of research-protocol.md §4–§5 and §9 (counts per stage, tiers,
// algorithms, randomized complete blocks, determinism) and the tiny grid.

var tape = require( 'tape' );
var design = require( './../design.js' );

var L = design.loadProtocol();
var P = design.effective( L.protocol, false );
var T = design.effective( L.protocol, true );
var STUB = { 'tau_star': 64, 'levels': 4, 'batch_by_n': {} };

function procs( d ) {
	return d.blocks.reduce( function f( a, b ) {
		return a.concat( b.procs );
	}, [] );
}

function byStage( P0 ) {
	var out = {};
	design.buildAll( P0, STUB ).forEach( function each( d ) {
		out[ d.stage ] = d;
	});
	return out;
}

tape( 'protocol.json loads and hashes', function test( t ) {
	t.ok( /^[0-9a-f]{64}$/.test( L.sha256 ), 'sha256' );
	t.equal( P.schema, 'sw-bench/2', 'schema' );
	t.equal( P.mode, 'campaign', 'mode' );
	t.equal( T.mode, 'tiny', 'tiny mode' );
	t.equal( P.tiny, void 0, 'tiny section removed' );
	t.end();
});

tape( 'stage counts match the protocol (blocks, processes)', function test( t ) {
	var S = byStage( P );
	var want = { 'pilot': [ 8, 42 ], 'E2': [ 170, 510 ], 'E3': [ 22, 154 ], 'E5': [ 42, 156 ], 'E4': [ 16, 64 ], 'E0': [ 3, 40 ], 'E7': [ 3, 120 ] }; // eslint-disable-line max-len
	Object.keys( want ).forEach( function each( s ) {
		t.equal( S[ s ].blocks.length, want[ s ][ 0 ], s + ' blocks' );
		t.equal( procs( S[ s ] ).length, want[ s ][ 1 ], s + ' processes' );
		t.equal( !!S[ s ].sentinel, s !== 'E7', s + ' sentinel before every block' );
	});
	t.end();
});

tape( 'E2: P/O/R families, tiers (k, r), A0/A1/A2 in every block', function test( t ) {
	var d = byStage( P ).E2;
	var sizes = {};
	var tiers = { 'S': [ 30, 10 ], 'M': [ 20, 10 ], 'L': [ 10, 6 ], 'XL': [ 3, 4 ] };
	d.blocks.forEach( function each( b ) {
		var n = b.procs[ 0 ].M;
		sizes[ n ] = ( sizes[ n ] || 0 ) + 1;
		t.deepEqual( b.procs.map( function f( p ) {
			return p.alg;
		}).sort(), [ 'A0', 'A1', 'A2' ], 'algorithms of ' + b.block_id );
		b.procs.forEach( function f( p ) {
			var tier = tiers[ p.meta.tier ];
			t.equal( p.k, tier[ 0 ], 'k of ' + p.meta.tier );
			t.equal( b.r, tier[ 1 ], 'r of ' + p.meta.tier );
			t.ok( p.order === 'row-major' && p.transA === 'no-transpose' && p.transB === 'no-transpose' && p.alpha === 1 && p.beta === 0 && p.ld_pad === 0, 'row-major NN, alpha=1, beta=0, LD=n' ); // eslint-disable-line max-len
			if ( p.alg === 'A1' ) {
				t.deepEqual( p.params, { 'cutoff': 1, 'levels': 1 }, 'A1 params' );
			}
			if ( p.alg === 'A2' ) {
				t.deepEqual( p.params, { 'cutoff': 64, 'levels': 4 }, 'A2 params' );
			}
		});
	});
	t.deepEqual( Object.keys( sizes ).map( Number ).sort( function c( a, b ) {
		return a - b;
	}), [ 32, 48, 64, 96, 128, 160, 192, 255, 256, 257, 320, 384, 511, 512, 513, 768, 1023, 1024, 1025, 1536, 2048 ], '21 sizes' );
	t.equal( sizes[ 32 ], 10, 'r=10 at n<=128' );
	t.equal( sizes[ 384 ], 10, 'r=10 at n<=384' );
	t.equal( sizes[ 1025 ], 6, 'r=6 at n<=1025' );
	t.equal( sizes[ 2048 ], 4, 'r=4 at XL' );
	t.end();
});

tape( 'E3: attribution ladder (A0, C2, A2 x LD {n, n+8} + C1 at LD=n; r=10 at 512, 6 otherwise)', function test( t ) {
	var d = byStage( P ).E3;
	var reps = {};
	d.blocks.forEach( function each( b ) {
		reps[ b.procs[ 0 ].M ] = ( reps[ b.procs[ 0 ].M ] || 0 ) + 1;
		t.deepEqual( b.procs.map( function f( p ) {
			return p.alg + '+' + p.ld_pad;
		}).sort(), [ 'A0+0', 'A0+8', 'A2+0', 'A2+8', 'C1+0', 'C2+0', 'C2+8' ], 'configurations of ' + b.block_id );
		b.procs.forEach( function f( p ) {
			if ( p.alg === 'C2' ) {
				t.deepEqual( p.params, { 'cutoff': 64, 'levels': 4 }, 'C2 matches the SW cutoff and level cap' );
			}
		});
	});
	t.deepEqual( reps, { '512': 10, '1008': 6, '1024': 6 }, 'replicates' );
	t.end();
});

tape( 'E5: layouts, alpha/beta and rectangular panels (r=6)', function test( t ) {
	var d = byStage( P ).E5;
	var lay = d.blocks.filter( function f( b ) {
		return b.experiment === 'E5.layout';
	});
	var ab = d.blocks.filter( function f( b ) {
		return b.experiment === 'E5.alphabeta';
	});
	var rect = d.blocks.filter( function f( b ) {
		return b.experiment === 'E5.rect';
	});
	t.equal( lay.length, 6, 'layout blocks' );
	t.equal( lay[ 0 ].procs.length, 10, '5 layouts x {A0, A2}' );
	t.equal( lay[ 0 ].procs.filter( function f( p ) {
		return p.order === 'column-major';
	}).length, 2, 'column-major NN for A0 and A2' );
	t.equal( ab.length, 12, 'alpha/beta blocks (2 sizes x 6)' );
	t.deepEqual( ab[ 0 ].procs.map( function f( p ) {
		return p.alg + ':' + p.alpha + ':' + p.beta;
	}).sort(), [ 'A0:0.5:2', 'A0:1:1', 'A2:0.5:2', 'A2:1:1' ], 'beta=1 and (alpha=0.5, beta=2)' );
	t.equal( rect.length, 24, 'rectangular blocks (4 shapes x 6)' );
	t.deepEqual( rect.map( function f( b ) {
		return b.procs[ 0 ].meta.shape;
	}).filter( function u( x, i, a ) {
		return a.indexOf( x ) === i;
	}).sort(), [ '1024x1024x256', '160x1957x957', '2048x512x512', '256x1024x1024' ], 'shapes' );
	t.end();
});

tape( 'E4: leaf sizes {32,64,128,256} at {512,1024,2048}, levels uncapped', function test( t ) {
	var d = byStage( P ).E4;
	var reps = {};
	d.blocks.forEach( function each( b ) {
		var n = b.procs[ 0 ].M;
		reps[ n ] = ( reps[ n ] || 0 ) + 1;
		t.deepEqual( b.procs.map( function f( p ) {
			return p.params.cutoff;
		}).sort( function c( x, y ) {
			return x - y;
		}), [ 32, 64, 128, 256 ], 'leaf sizes' );
		b.procs.forEach( function f( p ) {
			t.equal( p.params.levels, Math.log2( n / p.params.cutoff ), 'full depth at n=' + n + ', leaf ' + p.params.cutoff );
		});
	});
	t.deepEqual( reps, { '512': 6, '1024': 6, '2048': 4 }, 'tier replication' );
	t.end();
});

tape( 'E0: A0, 8 (order, trans) combos x {64, 256, 1024}; LD in {n, n+8, 1024} at n=256; unreplicated', function test( t ) {
	var d = byStage( P ).E0;
	var at256 = d.blocks.filter( function f( b ) {
		return b.procs[ 0 ].M === 256;
	})[ 0 ];
	t.equal( d.blocks.length, 3, 'one block per size' );
	t.equal( at256.procs.length, 24, '8 combos x 3 LDs at n=256' );
	t.deepEqual( at256.procs.map( function f( p ) {
		return p.ld_pad + 256;
	}).filter( function u( x, i, a ) {
		return a.indexOf( x ) === i;
	}).sort( function c( x, y ) {
		return x - y;
	}), [ 256, 264, 1024 ], 'LDs at n=256' );
	procs( d ).forEach( function f( p ) {
		t.equal( p.alg, 'A0', 'A0 only' );
	});
	t.end();
});

tape( 'pilot: A0 + A2(tau) at 512/1024, XL check at 2048, A0 at 32..192, r=2', function test( t ) {
	var d = byStage( P ).pilot;
	var tau = d.blocks.filter( function f( b ) {
		return b.experiment === 'pilot.tau';
	});
	var xl = d.blocks.filter( function f( b ) {
		return b.experiment === 'pilot.xl';
	});
	var batch = d.blocks.filter( function f( b ) {
		return b.experiment === 'pilot.batch';
	});
	t.equal( tau.length, 4, 'two sizes x r=2' );
	t.deepEqual( tau[ 0 ].procs.map( function f( p ) {
		return p.alg + ( ( p.params.cutoff ) ? p.params.cutoff : '' );
	}).sort(), [ 'A0', 'A2128', 'A216', 'A2256', 'A232', 'A264' ], 'A0 + A2 at every tau' );
	t.equal( xl.length, 2, 'XL check r=2' );
	t.deepEqual( xl[ 0 ].procs.map( function f( p ) {
		return p.alg + '@' + p.M + ':' + p.params.cutoff;
	}).sort(), [ 'A0@2048:null', 'A2@2048:64' ], 'A0 and A2(64) at 2048' );
	t.deepEqual( batch[ 0 ].procs.map( function f( p ) {
		return p.M;
	}).sort( function c( x, y ) {
		return x - y;
	}), [ 32, 48, 64, 96, 128, 160, 192 ], 'A0 at the batch sizes' );
	t.end();
});

tape( 'randomized complete blocks: positions, paired seeds, rounds, determinism', function test( t ) {
	var a = design.buildStage( P, STUB, 'E2' );
	var b = design.buildStage( P, STUB, 'E2' );
	var Q = JSON.parse( JSON.stringify( P ) );
	var c;
	var lastRep = 0;
	var seeds = {};
	Q.master_seed = P.master_seed + 1;
	c = design.buildStage( Q, STUB, 'E2' );
	t.deepEqual( a, b, 'deterministic for a fixed master seed' );
	t.notDeepEqual( a.blocks.map( function f( x ) {
		return x.block_id;
	}), c.blocks.map( function f( x ) {
		return x.block_id;
	}), 'the order depends on the seed' );
	a.blocks.forEach( function each( blk ) {
		t.deepEqual( blk.procs.map( function f( p ) {
			return p.pos_in_block;
		}), [ 0, 1, 2 ], 'pos_in_block 0..m-1' );
		t.equal( blk.procs.filter( function f( p ) {
			return p.seed === blk.procs[ 0 ].seed;
		}).length, 3, 'paired inputs within ' + blk.block_id );
		t.ok( blk.rep >= lastRep, 'rounds in replicate order' );
		lastRep = blk.rep;
		seeds[ blk.procs[ 0 ].seed ] = true;
	});
	t.equal( Object.keys( seeds ).length, a.blocks.length, 'one input seed per block' );
	t.end();
});

tape( 'frozen batch table and tau are used after the freeze', function test( t ) {
	var fz = { 'tau_star': 128, 'levels': 4, 'batch_by_n': { '32': 401, '48': 120 } };
	var d = design.buildStage( P, fz, 'E2' );
	procs( d ).forEach( function f( p ) {
		if ( p.M === 32 ) {
			t.equal( p.batch, 401, 'batch from frozen.json' );
		}
		if ( p.alg === 'A2' && p.M === 32 ) {
			t.equal( p.params.cutoff, 128, 'tau_star' );
		}
	});
	t.end();
});

tape( 'tiny grid: sizes {48,64,96}, pilot tau {16,32} at {64,96}, XL check at 128, r=2, k=3', function test( t ) {
	var S = byStage( T );
	t.deepEqual( S.pilot.blocks.length, 8, 'pilot blocks' );
	procs( S.pilot ).concat( procs( S.E2 ), procs( S.E3 ) ).forEach( function f( p ) {
		t.equal( p.k, 3, 'k=3' );
		t.ok( p.M <= 128 && p.N <= 128 && p.K <= 128, 'tiny sizes' );
	});
	t.deepEqual( procs( S.E2 ).map( function f( p ) {
		return p.M;
	}).filter( function u( x, i, a ) {
		return a.indexOf( x ) === i;
	}).sort( function c( x, y ) {
		return x - y;
	}), [ 48, 64, 96 ], 'E2 sizes' );
	t.equal( S.E2.blocks.length, 6, 'E2 r=2' );
	t.equal( S.E3.blocks[ 0 ].procs[ 0 ].M, 96, 'E3 at n=96' );
	t.deepEqual( procs( S.E7 ).map( function f( p ) {
		return p.M;
	}).filter( function u( x, i, a ) {
		return a.indexOf( x ) === i;
	}), [ 64 ], 'memory at n=64' );
	t.end();
});
