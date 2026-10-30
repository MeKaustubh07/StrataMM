'use strict';

/*
* Tests for research/harness/algorithms.js: layouts and leading dimensions, seeded problem construction, the Freivalds
* gate, the algorithm closures (every key, order, transpose, padding and α/β variant against dgemm), parameter
* resolution, the library loader and the analytic per-call allocation.
*/

// MODULES //

var tape = require( 'tape' );
var algorithms = require( './../algorithms.js' );


// VARIABLES //

var LIB = algorithms.library();
var ORDERS = [ 'row-major', 'column-major' ];
var TRANS = [ 'no-transpose', 'transpose' ];
var AB = [ [ 1.0, 0.0 ], [ 1.0, 1.0 ], [ 0.5, 2.0 ] ];
var PARAMS = {
	'A1': null,
	'A2': { 'cutoff': 2, 'levels': 4 },
	'C2': { 'cutoff': 2, 'levels': 4 }
};


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

function logicalA( prob ) {
	var out = [];
	var i;
	var k;
	for ( i = 0; i < prob.M; i++ ) {
		for ( k = 0; k < prob.K; k++ ) {
			out.push( prob.A[ ( i*prob.layout.oa1 ) + ( k*prob.layout.oa2 ) ] );
		}
	}
	return out;
}

function logicalB( prob ) {
	var out = [];
	var k;
	var j;
	for ( k = 0; k < prob.K; k++ ) {
		for ( j = 0; j < prob.N; j++ ) {
			out.push( prob.B[ ( k*prob.layout.ob1 ) + ( j*prob.layout.ob2 ) ] );
		}
	}
	return out;
}

// Freivalds-type distance between two results: ‖(C1 − C2)x‖∞ / (|α||A||B||x| + |β||C₀||x|)∞ (the gate's denominator).
function distance( prob, C1, C2 ) {
	var L = prob.layout;
	var num = 0.0;
	var den = 0.0;
	var abs;
	var w;
	var i;
	var j;
	var k;
	for ( i = 0; i < prob.M; i++ ) {
		w = 0.0;
		abs = 0.0;
		for ( j = 0; j < prob.N; j++ ) {
			w += ( C1[ ( i*L.sc1 ) + ( j*L.sc2 ) ] - C2[ ( i*L.sc1 ) + ( j*L.sc2 ) ] ) * prob.x[ j ];
			for ( k = 0; k < prob.K; k++ ) {
				abs += Math.abs( prob.alpha * prob.A[ ( i*L.oa1 ) + ( k*L.oa2 ) ] * prob.B[ ( k*L.ob1 ) + ( j*L.ob2 ) ] * prob.x[ j ] );
			}
			if ( prob.beta !== 0.0 ) {
				abs += Math.abs( prob.beta * prob.C0[ ( i*L.sc1 ) + ( j*L.sc2 ) ] * prob.x[ j ] );
			}
		}
		num = Math.max( num, Math.abs( w ) );
		den = Math.max( den, abs );
	}
	return ( num === num ) ? num / den : Infinity; // eslint-disable-line no-self-compare
}


// TESTS //

tape( 'layout: leading dimensions, strides and lengths for every order and transpose', function test( t ) {
	var L = algorithms.layout( config( 3, 4, 5, 'row-major', 'no-transpose', 'no-transpose', 8 ) );
	t.deepEqual( [ L.lda, L.sa1, L.sa2, L.A.len ], [ 13, 13, 1, 39 ], 'row-major A (3×5), LD = 5+8' );
	t.deepEqual( [ L.ldb, L.sb1, L.sb2, L.B.len ], [ 12, 12, 1, 60 ], 'row-major B (5×4), LD = 4+8' );
	t.deepEqual( [ L.ldc, L.sc1, L.sc2, L.C.len ], [ 12, 12, 1, 36 ], 'row-major C (3×4), LD = 4+8' );
	L = algorithms.layout( config( 3, 4, 5, 'column-major', 'transpose', 'transpose', 8 ) );
	t.deepEqual( [ L.lda, L.sa1, L.sa2, L.A.len, L.oa1, L.oa2 ], [ 13, 1, 13, 39, 13, 1 ], 'column-major Aᵀ stored 5×3, LD = 5+8; op(A)[i][k] = A[13i + k]' );
	t.deepEqual( [ L.ldb, L.sb1, L.sb2, L.B.len, L.ob1, L.ob2 ], [ 12, 1, 12, 60, 12, 1 ], 'column-major Bᵀ stored 4×5, LD = 4+8' );
	t.deepEqual( [ L.ldc, L.sc1, L.sc2, L.C.len ], [ 11, 1, 11, 44 ], 'column-major C (3×4), LD = 3+8' );
	L = algorithms.layout( config( 256, 256, 256, 'row-major', 'no-transpose', 'no-transpose', 768 ) );
	t.deepEqual( [ L.lda, L.ldb, L.ldc ], [ 1024, 1024, 1024 ], 'LD = 1024 at n = 256 (E0)' );
	t.end();
});

tape( 'createProblem: identical logical operands for every layout; NaN padding; NaN C when β = 0, C₀ copy otherwise', function test( t ) {
	var ref = algorithms.createProblem( config( 7, 6, 5, 'row-major', 'no-transpose', 'no-transpose', 0, 1.0, 0.0, 99 ) );
	var ok = true;
	ORDERS.forEach( function o( order ) {
		TRANS.forEach( function ta( transA ) {
			TRANS.forEach( function tb( transB ) {
				[ 0, 8 ].forEach( function p( pad ) {
					var prob = algorithms.createProblem( config( 7, 6, 5, order, transA, transB, pad, 1.0, 1.0, 99 ) );
					var nanA = 0;
					var i;
					ok = ok && ( JSON.stringify( logicalA( prob ) ) === JSON.stringify( logicalA( ref ) ) );
					ok = ok && ( JSON.stringify( logicalB( prob ) ) === JSON.stringify( logicalB( ref ) ) );
					for ( i = 0; i < prob.A.length; i++ ) {
						nanA += ( prob.A[ i ] === prob.A[ i ] ) ? 0 : 1; // eslint-disable-line no-self-compare
					}
					ok = ok && ( nanA === prob.A.length - 35 ) && prob.C0 !== null && prob.C0 !== prob.C;
					ok = ok && ( JSON.stringify( Array.from( prob.C0 ) ) === JSON.stringify( Array.from( prob.C ) ) );
				});
			});
		});
	});
	t.ok( ok, 'same seed ⇒ same op(A), op(B) for all 16 order/transpose/padding layouts; padding (only) is NaN; C₀ = C' );
	t.ok( Array.from( ref.C ).every( function nan( v ) {
		return v !== v; // eslint-disable-line no-self-compare
	}), 'C is NaN-filled when β = 0' );
	t.strictEqual( ref.C0, null, 'no C₀ when β = 0' );
	t.ok( logicalA( ref ).every( function inRange( v ) {
		return v >= -1.0 && v < 1.0;
	}), 'U(-1,1) entries' );
	t.notDeepEqual( logicalA( algorithms.createProblem( config( 7, 6, 5, 'row-major', 'no-transpose', 'no-transpose', 0, 1.0, 0.0, 100 ) ) ), logicalA( ref ), 'different seed ⇒ different operands' );
	t.end();
});

tape( 'check: passes a correct product and catches wrong values, NaN, padding writes and modified inputs', function test( t ) {
	var prob = algorithms.createProblem( config( 9, 7, 8, 'row-major', 'no-transpose', 'transpose', 8, 0.5, 2.0, 3 ) );
	var f = algorithms.create( 'A0', null, prob, LIB );
	var res;
	var v;
	f();
	res = algorithms.check( prob );
	t.ok( res.pass && res.intact && res.rel < 1e-14, 'correct product passes (rel = ' + res.rel.toExponential( 2 ) + ')' );
	v = prob.C[ prob.layout.sc1 * 3 ];
	prob.C[ prob.layout.sc1 * 3 ] = v + 1e-6;
	res = algorithms.check( prob );
	t.ok( !res.pass && res.rel > 1e-8, 'one entry off by 1e-6 fails (rel = ' + res.rel.toExponential( 2 ) + ')' );
	prob.C[ prob.layout.sc1 * 3 ] = NaN;
	t.ok( !algorithms.check( prob ).pass && algorithms.check( prob ).rel !== algorithms.check( prob ).rel, 'NaN entry fails with rel = NaN' ); // eslint-disable-line no-self-compare
	prob.C[ prob.layout.sc1 * 3 ] = v;
	prob.C[ 7 ] = 0.0; // first padding element of row 0 (LD = 7 + 8)
	res = algorithms.check( prob );
	t.ok( !res.pass && !res.intact && res.rel < 1e-14, 'write to the padding of C fails (intact = false)' );
	prob.C[ 7 ] = NaN;
	prob.A[ 0 ] += 1.0;
	res = algorithms.check( prob );
	t.ok( !res.pass && !res.intact, 'modified A fails (checksum)' );
	t.end();
});

tape( 'create: every algorithm key matches dgemm (A0) for all orders, transposes, paddings and α/β variants', function test( t ) {
	algorithms.ALGS.forEach( function each( alg ) {
		var params = algorithms.resolveParams( alg, PARAMS[ alg ] || null );
		var worst = 0.0;
		var fails = 0;
		var cases = 0;
		ORDERS.forEach( function o( order ) {
			TRANS.forEach( function ta( transA ) {
				TRANS.forEach( function tb( transB ) {
					[ 0, 8 ].forEach( function p( pad ) {
						AB.forEach( function ab( v ) {
							var cfg = config( 13, 11, 9, order, transA, transB, pad, v[ 0 ], v[ 1 ], 11 + cases );
							var ref = algorithms.createProblem( cfg );
							var prob = algorithms.createProblem( cfg );
							algorithms.create( 'A0', null, ref, LIB )();
							algorithms.create( alg, params, prob, LIB )();
							worst = Math.max( worst, distance( prob, prob.C, ref.C ) );
							fails += ( algorithms.check( prob ).pass ) ? 0 : 1;
							cases += 1;
						});
					});
				});
			});
		});
		t.ok( fails === 0 && worst < algorithms.FREIVALDS_TOL, alg + ': ' + cases + ' cases pass the gate; Freivalds distance to dgemm ≤ ' + worst.toExponential( 2 ) );
	});
	t.end();
});

tape( 'create: A1/A2 recurse through dgemmsw base.js (depth > 0) on the tiny shape', function test( t ) {
	t.strictEqual( algorithms.depthOf( 'A1', algorithms.resolveParams( 'A1' ), 13, 11, 9, LIB ), 1, 'A1: one level' );
	t.strictEqual( algorithms.depthOf( 'A2', PARAMS.A2, 13, 11, 9, LIB ), 2, 'A2 (cutoff 2): two levels' );
	t.strictEqual( algorithms.depthOf( 'C2', PARAMS.C2, 13, 11, 9, LIB ), 2, 'C2 (cutoff 2): two levels' );
	t.strictEqual( algorithms.depthOf( 'A0', null, 13, 11, 9, LIB ), null, 'A0: not recursive' );
	t.strictEqual( algorithms.depthOf( 'A2', { 'cutoff': 64, 'levels': 4 }, 1024, 1024, 1024, LIB ), 4, 'A2 at n = 1024, τ = 64: L_max = 4' );
	t.end();
});

tape( 'resolveParams', function test( t ) {
	t.deepEqual( algorithms.resolveParams( 'A1' ), { 'cutoff': 1, 'levels': 1 }, 'A1 fixed at (1, 1)' );
	t.deepEqual( algorithms.resolveParams( 'A1', { 'cutoff': null, 'levels': null } ), { 'cutoff': 1, 'levels': 1 }, 'A1 accepts null fields' );
	t.throws( function bad() {
		algorithms.resolveParams( 'A1', { 'cutoff': 64, 'levels': 1 } );
	}, /A1 is fixed/, 'A1 rejects conflicting values' );
	t.deepEqual( algorithms.resolveParams( 'A2', { 'cutoff': 64 } ), { 'cutoff': 64, 'levels': 4 }, 'A2 levels default to L_max = 4' );
	t.throws( function bad() {
		algorithms.resolveParams( 'C2', { 'cutoff': null, 'levels': 4 } );
	}, /requires params.cutoff/, 'C2 requires a cutoff' );
	t.throws( function bad() {
		algorithms.resolveParams( 'A2', { 'cutoff': 64, 'levels': -1 } );
	}, /levels/, 'negative levels rejected' );
	t.strictEqual( algorithms.resolveParams( 'A0', { 'cutoff': null, 'levels': null } ), null, 'A0 takes no parameters' );
	t.strictEqual( algorithms.resolveParams( 'SENTINEL' ), null, 'SENTINEL takes no parameters' );
	t.throws( function bad() {
		algorithms.resolveParams( 'A3' );
	}, /unknown algorithm/, 'unknown key rejected' );
	t.end();
});

tape( 'library: loads the package by path, one dgemm module, cached per root', function test( t ) {
	t.strictEqual( typeof LIB.base, 'function', 'base.js loaded' );
	t.ok( /lib[\\/]node_modules[\\/]@stdlib[\\/]blas[\\/]ext[\\/]base[\\/]dgemmsw[\\/]lib[\\/]base\.js$/.test( LIB.files.base ), 'path ends in the package lib/base.js' );
	t.strictEqual( LIB.dgemmPath, require.resolve( '@stdlib/blas/base/dgemm' ), 'same dgemm file as the harness' );
	t.ok( LIB.dgemmPath.indexOf( LIB.root ) === 0, 'dgemm resolved inside the repository' );
	t.strictEqual( algorithms.library( LIB.root ), LIB, 'cached' );
	t.throws( function bad() {
		algorithms.library( '/' );
	}, Error, 'a root without the package throws' );
	t.end();
});

tape( 'analyticBytes (protocol §9, H5)', function test( t ) {
	var sq = function sq( n, alpha, beta ) {
		return {
			'M': n,
			'N': n,
			'K': n,
			'alpha': alpha,
			'beta': beta
		};
	};
	var p32 = { 'cutoff': 32, 'levels': 4 };
	t.strictEqual( algorithms.analyticBytes( 'A2', p32, sq( 128, 1.0, 0.0 ), LIB ), 8*10240, 'SW 128³, τ = 32, β = 0: 8·E1 = 8·10240' );
	t.strictEqual( algorithms.analyticBytes( 'A2', p32, sq( 128, 1.0, 1.0 ), LIB ), 8*( 10240+16384 ), 'β ≠ 0 adds 8·M·N' );
	t.strictEqual( algorithms.analyticBytes( 'A2', { 'cutoff': 8, 'levels': 4 }, sq( 64, 1.0, 0.0 ), LIB ), 21504, 'SW 64³, τ = 8: 8·(2048 + 512 + 128)' );
	t.strictEqual( algorithms.analyticBytes( 'A2', { 'cutoff': 128, 'levels': 4 }, sq( 128, 1.0, 1.0 ), LIB ), 0, 'depth 0 ⇒ delegated, no allocation' );
	t.strictEqual( algorithms.analyticBytes( 'A1', algorithms.resolveParams( 'A1' ), sq( 64, 0.0, 2.0 ), LIB ), 0, 'α = 0 ⇒ delegated' );
	t.strictEqual( algorithms.analyticBytes( 'A1', algorithms.resolveParams( 'A1' ), sq( 64, 1.0, 0.0 ), LIB ), 8*( 1024+1024 ), 'A1 64³: one level, 8·(32·32 + 32·32)' );
	t.strictEqual( algorithms.analyticBytes( 'C1', null, { 'M': 10, 'N': 20, 'K': 30, 'alpha': 1.0, 'beta': 0.0 }, LIB ), 8*30*20, 'C1: 8·K·N' );
	t.strictEqual( algorithms.analyticBytes( 'C2', p32, sq( 128, 1.0, 1.0 ), LIB ), 0, 'C2: 0' );
	t.strictEqual( algorithms.analyticBytes( 'A0', null, sq( 128, 1.0, 1.0 ), LIB ), 0, 'A0: 0' );
	t.end();
});
