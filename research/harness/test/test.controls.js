'use strict';

/*
* Tests for the research controls: C2 (controls/classic.js, eight-product recursion) and C1 (controls/packed.js).
* Both are compared with dgemm componentwise: |C − C_dgemm| ≤ 2(K+4)·eps·(|α|(|op(A)||op(B)|) + |β||C₀|) entrywise.
*/

// MODULES //

var tape = require( 'tape' );
var proxyquire = require( 'proxyquire' );
var dgemm = require( '@stdlib/blas/base/dgemm' ).ndarray;
var algorithms = require( './../algorithms.js' );
var classic = require( './../controls/classic.js' );
var packed = require( './../controls/packed.js' );


// VARIABLES //

var LIB = algorithms.library();
var EPS = 2.220446049250313e-16;
var ORDERS = [ 'row-major', 'column-major' ];
var TRANS = [ 'no-transpose', 'transpose' ];
var AB = [ [ 1.0, 0.0 ], [ 1.0, 1.0 ], [ 0.5, 2.0 ], [ -1.5, 0.25 ], [ 0.0, 0.5 ] ];
var SHAPES = [ [ 1, 1, 1 ], [ 2, 3, 4 ], [ 13, 11, 9 ], [ 16, 16, 16 ], [ 17, 5, 33 ], [ 32, 32, 32 ], [ 31, 64, 17 ] ];


// FUNCTIONS //

function config( M, N, K, order, transA, transB, pad, alpha, beta, seed ) {
	return {
		'M': M,
		'N': N,
		'K': K,
		'order': order,
		'transA': transA,
		'transB': transB,
		'ld_pad': pad,
		'alpha': alpha,
		'beta': beta,
		'seed': seed
	};
}

// Calls `fcn( problem )` for every order × transpose × padding × (α, β) combination of a shape.
function forEachCase( shape, fcn ) {
	var seed = 1;
	ORDERS.forEach( function o( order ) {
		TRANS.forEach( function ta( transA ) {
			TRANS.forEach( function tb( transB ) {
				[ 0, 3 ].forEach( function p( pad ) {
					AB.forEach( function ab( v ) {
						seed += 1;
						fcn( algorithms.createProblem( config( shape[ 0 ], shape[ 1 ], shape[ 2 ], order, transA, transB, pad, v[ 0 ], v[ 1 ], seed ) ) );
					});
				});
			});
		});
	});
}

// Runs dgemm on a copy of the problem's C (restored from C₀) and returns the copy.
function reference( prob ) {
	var L = prob.layout;
	var C = ( prob.C0 ) ? prob.C0.slice() : prob.C.slice();
	dgemm( prob.transA, prob.transB, prob.M, prob.N, prob.K, prob.alpha, prob.A, L.sa1, L.sa2, 0, prob.B, L.sb1, L.sb2, 0, prob.beta, C, L.sc1, L.sc2, 0 );
	return C;
}

// Returns the largest entrywise |C − R| / (2(K+4)·eps·(|α|(|A||B|) + |β||C₀|)); ≤ 1 passes (0/0 counts as 0).
function worstRatio( prob, C, R ) {
	var worst = 0.0;
	var L = prob.layout;
	var den;
	var abs;
	var off;
	var d;
	var i;
	var j;
	var k;
	for ( i = 0; i < prob.M; i++ ) {
		for ( j = 0; j < prob.N; j++ ) {
			abs = 0.0;
			for ( k = 0; k < prob.K; k++ ) {
				abs += Math.abs( prob.A[ ( i*L.oa1 ) + ( k*L.oa2 ) ] ) * Math.abs( prob.B[ ( k*L.ob1 ) + ( j*L.ob2 ) ] );
			}
			off = ( i*L.sc1 ) + ( j*L.sc2 );
			den = Math.abs( prob.alpha ) * abs;
			if ( prob.beta !== 0.0 ) {
				den += Math.abs( prob.beta ) * Math.abs( prob.C0[ off ] );
			}
			d = Math.abs( C[ off ] - R[ off ] );
			if ( d !== d ) { // eslint-disable-line no-self-compare
				return Infinity;
			}
			if ( d > 0.0 ) {
				worst = Math.max( worst, d / ( 2.0 * ( prob.K + 4 ) * EPS * den ) );
			}
		}
	}
	return worst;
}

function runClassic( prob, cutoff, levels ) {
	var L = prob.layout;
	if ( prob.C0 ) {
		prob.C.set( prob.C0 );
	}
	classic( prob.transA, prob.transB, prob.M, prob.N, prob.K, prob.alpha, prob.A, L.sa1, L.sa2, 0, prob.B, L.sb1, L.sb2, 0, prob.beta, prob.C, L.sc1, L.sc2, 0, cutoff, levels );
	return prob.C;
}

function runPacked( prob ) {
	var L = prob.layout;
	if ( prob.C0 ) {
		prob.C.set( prob.C0 );
	}
	packed( prob.transA, prob.transB, prob.M, prob.N, prob.K, prob.alpha, prob.A, L.sa1, L.sa2, 0, prob.B, L.sb1, L.sb2, 0, prob.beta, prob.C, L.sc1, L.sc2, 0 );
	return prob.C;
}


// TESTS //

tape( 'C2 (classic) matches dgemm componentwise for all shapes, layouts, transposes, paddings, α/β, cutoffs and level caps', function test( t ) {
	SHAPES.forEach( function each( shape ) {
		var worst = 0.0;
		var cases = 0;
		[ 1, 2, 4 ].forEach( function c( cutoff ) {
			[ 0, 1, 2, 99 ].forEach( function l( levels ) {
				forEachCase( shape, function run( prob ) {
					var R = reference( prob );
					var C = runClassic( prob, cutoff, levels );
					worst = Math.max( worst, worstRatio( prob, C, R ) );
					worst = Math.max( worst, ( algorithms.check( prob ).pass ) ? 0.0 : Infinity );
					cases += 1;
				});
			});
		});
		t.ok( worst <= 1.0, 'shape ' + shape.join( 'x' ) + ': ' + cases + ' cases, worst ratio ' + worst.toExponential( 2 ) );
	});
	t.end();
});

tape( 'C2 delegates to dgemm (bitwise) when it would not recurse', function test( t ) {
	var mismatches = 0;
	forEachCase( [ 13, 11, 9 ], function run( prob ) {
		var R = reference( prob );
		var C = runClassic( prob, 9, 4 ); // K = 9 ≤ cutoff ⇒ depth 0
		var i;
		for ( i = 0; i < C.length; i++ ) {
			if ( !Object.is( C[ i ], R[ i ] ) ) {
				mismatches += 1;
			}
		}
		C = runClassic( prob, 1, 0 ); // levels = 0
		for ( i = 0; i < C.length; i++ ) {
			if ( !Object.is( C[ i ], R[ i ] ) ) {
				mismatches += 1;
			}
		}
	});
	t.strictEqual( mismatches, 0, 'bitwise identical to dgemm' );
	t.end();
});

tape( 'C2 depth rule equals the library depth.js (split, cutoff and level cap)', function test( t ) {
	var mismatches = 0;
	var count = 0;
	[ 1, 7, 31, 32, 33, 64, 100, 255, 256, 257, 1008, 1023, 1024, 1025, 2048 ].forEach( function m( M ) {
		[ 1, 9, 64, 512, 1025 ].forEach( function n( N ) {
			[ 1, 16, 32, 64, 128, 256 ].forEach( function c( cutoff ) {
				[ 0, 1, 2, 4, 99 ].forEach( function l( levels ) {
					count += 1;
					if ( classic.depth( M, N, M, cutoff, levels ) !== LIB.depth( M, N, M, cutoff, levels ) ) {
						mismatches += 1;
					}
				});
			});
		});
	});
	t.strictEqual( mismatches, 0, count + ' (M, N, K, cutoff, levels) combinations agree' );
	t.end();
});

tape( 'C2 makes 8^L leaf calls plus the peeling calls (proxyquire-counted dgemm)', function test( t ) {
	var calls = 0;
	var stub = {
		'ndarray': function counted() {
			calls += 1;
			return dgemm.apply( null, arguments );
		}
	};
	var ctl = proxyquire( './../controls/classic.js', {
		'@stdlib/blas/base/dgemm': stub
	});
	var cases = [
		// [ n, cutoff, levels, expected dgemm calls ]
		[ 32, 4, 2, 64 ], // 8^2 leaves, even sizes: no peeling
		[ 32, 4, 99, 512 ], // depth 3 (32→16→8→4): 8^3 leaves
		[ 33, 4, 1, 11 ], // 8 leaves + 3 peels (K, N, M odd)
		[ 32, 32, 4, 1 ] // depth 0: one delegated call
	];
	cases.forEach( function each( c ) {
		var prob = algorithms.createProblem( config( c[ 0 ], c[ 0 ], c[ 0 ], 'row-major', 'no-transpose', 'no-transpose', 0, 1.0, 0.0, 5 ) );
		var L = prob.layout;
		calls = 0;
		ctl( 'no-transpose', 'no-transpose', c[ 0 ], c[ 0 ], c[ 0 ], 1.0, prob.A, L.sa1, L.sa2, 0, prob.B, L.sb1, L.sb2, 0, 0.0, prob.C, L.sc1, L.sc2, 0, c[ 1 ], c[ 2 ] );
		t.strictEqual( calls, c[ 3 ], 'n=' + c[ 0 ] + ', cutoff=' + c[ 1 ] + ', levels=' + c[ 2 ] + ': ' + c[ 3 ] + ' dgemm calls' );
		t.ok( algorithms.check( prob ).pass, 'result passes the Freivalds gate' );
	});
	t.end();
});

tape( 'C1 (packed) matches dgemm componentwise and leaves A and B unchanged', function test( t ) {
	SHAPES.forEach( function each( shape ) {
		var worst = 0.0;
		var cases = 0;
		forEachCase( shape, function run( prob ) {
			var R = reference( prob );
			var C = runPacked( prob );
			var res = algorithms.check( prob ); // includes A/B checksums and C padding
			worst = Math.max( worst, worstRatio( prob, C, R ), ( res.pass ) ? 0.0 : Infinity );
			cases += 1;
		});
		t.ok( worst <= 1.0, 'shape ' + shape.join( 'x' ) + ': ' + cases + ' cases, worst ratio ' + worst.toExponential( 2 ) );
	});
	t.end();
});

tape( 'C1 packs op(B) into a fresh column-major buffer per call and selects dgemm\'s naive path for row-major NN', function test( t ) {
	var seen = [];
	var stub = {
		'ndarray': function spy( ta, tb, M, N, K, alpha, A, sa1, sa2, oa, B, sb1, sb2 ) {
			seen.push({
				'transB': tb,
				'B': B,
				'sb1': sb1,
				'sb2': sb2
			});
			return dgemm.apply( null, arguments );
		}
	};
	var ctl = proxyquire( './../controls/packed.js', {
		'@stdlib/blas/base/dgemm': stub
	});
	var prob = algorithms.createProblem( config( 6, 5, 7, 'row-major', 'no-transpose', 'transpose', 2, 1.0, 0.0, 9 ) );
	var L = prob.layout;
	ctl( 'no-transpose', 'transpose', 6, 5, 7, 1.0, prob.A, L.sa1, L.sa2, 0, prob.B, L.sb1, L.sb2, 0, 0.0, prob.C, L.sc1, L.sc2, 0 );
	ctl( 'no-transpose', 'transpose', 6, 5, 7, 1.0, prob.A, L.sa1, L.sa2, 0, prob.B, L.sb1, L.sb2, 0, 0.0, prob.C, L.sc1, L.sc2, 0 );
	t.strictEqual( seen.length, 2, 'one dgemm call per packed call' );
	t.strictEqual( seen[ 0 ].transB, 'no-transpose', 'packed operand is passed untransposed' );
	t.deepEqual( [ seen[ 0 ].sb1, seen[ 0 ].sb2, seen[ 0 ].B.length ], [ 1, 7, 35 ], 'column-major K×N buffer with LD = K' );
	t.notEqual( seen[ 0 ].B, seen[ 1 ].B, 'a new buffer is allocated on every call' );
	t.ok( algorithms.check( prob ).pass, 'result passes the Freivalds gate' );
	t.end();
});
