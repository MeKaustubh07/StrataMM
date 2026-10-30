'use strict';

// Reference product: exact (BigInt) validation of the Dot2 double-double against the a-priori bound
// |hi + lo - x'y| <= gamma_K^2 |x|'|y| (ORO 2005), worker/single-thread bitwise parity, and the verified cache.

// MODULES //

var tape = require( 'tape' );
var path = require( 'path' );
var fs = require( 'fs' );
var os = require( 'os' );
var reference = require( './../reference.js' );
var exact = require( './../exact.js' );
var eft = require( './../eft.js' );
var rng = require( './../rng.js' );
var records = require( './../records.js' );


// FUNCTIONS //

/**
* Returns the maximum over all entries of |hi + lo - x'y| / (gamma_K^2 |x|'|y|), all quantities exact.
*
* @private
* @param {NonNegativeInteger} M - rows
* @param {NonNegativeInteger} N - columns
* @param {NonNegativeInteger} K - inner dimension
* @param {Float64Array} A - row-major M×K
* @param {Float64Array} B - row-major K×N
* @param {Object} ref - `{ hi, lo }`
* @returns {number} maximum ratio
*/
function maxRatio( M, N, K, A, B, ref ) {
	var g2 = eft.gamma( K ) * eft.gamma( K );
	var worst = 0.0;
	var err;
	var ex;
	var ab;
	var i;
	var j;
	var r;
	for ( i = 0; i < M; i++ ) {
		for ( j = 0; j < N; j++ ) {
			ex = exact.dot( K, A, 1, i*K, B, N, j, false );
			ab = exact.dot( K, A, 1, i*K, B, N, j, true );
			err = exact.sum( [ ref.hi[ ( i*N )+j ], ref.lo[ ( i*N )+j ], exact.neg( ex ) ] );
			r = exact.ratio( err, ab ) / g2;
			worst = Math.max( worst, r );
		}
	}
	return worst;
}

function randomMatrix( len, seed, gen ) {
	var u = rng.uniform( seed );
	var x = new Float64Array( len );
	var i;
	for ( i = 0; i < len; i++ ) {
		x[ i ] = gen( u );
	}
	return x;
}

function uniform11( u ) {
	return ( 2.0*u() ) - 1.0;
}

function wide( u ) {
	// Random sign, magnitude 2^U(-200,200) (continuous exponent): products span 2^-400..2^400...
	var v = Math.pow( 2.0, ( 400.0*u() ) - 200.0 );
	return ( u() < 0.5 ) ? -v : v;
}

function bitwiseEqual( x, y ) {
	var i;
	if ( x.length !== y.length ) {
		return false;
	}
	for ( i = 0; i < x.length; i++ ) {
		if ( !Object.is( x[ i ], y[ i ] ) ) {
			return false;
		}
	}
	return true;
}


// TESTS //

tape( 'reference vs exact BigInt arithmetic: random U[-1,1] inputs (rectangular, odd K) are within gamma_K^2 |x|\'|y|', function test( t ) {
	var M = 20;
	var N = 24;
	var K = 33;
	var A = randomMatrix( M*K, 11, uniform11 );
	var B = randomMatrix( K*N, 12, uniform11 );
	var r = maxRatio( M, N, K, A, B, reference.computeSerial( M, N, K, A, B ) );
	t.ok( r <= 1.0, 'max error/bound = ' + r.toExponential( 3 ) );
	t.end();
});

tape( 'reference vs exact BigInt arithmetic: wide dynamic range (entries ±2^U(-200,200)) is within gamma_K^2 |x|\'|y|', function test( t ) {
	var n = 32;
	var A = randomMatrix( n*n, 21, wide );
	var B = randomMatrix( n*n, 22, wide );
	var ref = reference.computeSerial( n, n, n, A, B );
	var r = maxRatio( n, n, n, A, B, ref );
	var rel = 0.0;
	var ex;
	var i;
	t.ok( r <= 1.0, 'max error/bound = ' + r.toExponential( 3 ) );
	for ( i = 0; i < n; i++ ) {
		// Diagonal entries: the double-double is far more accurate than one rounding...
		ex = exact.dot( n, A, 1, i*n, B, n, i, false );
		rel = Math.max( rel, exact.ratio( exact.sum( [ ref.hi[ ( i*n )+i ], ref.lo[ ( i*n )+i ], exact.neg( ex ) ] ), ex ) );
	}
	t.ok( rel < Math.pow( 2.0, -80 ), 'diagonal relative error ' + rel.toExponential( 3 ) + ' < 2^-80' );
	t.end();
});

tape( 'reference vs exact BigInt arithmetic: severe cancellation (each inner product nearly cancels) stays within the bound', function test( t ) {
	var n = 24;
	var A = randomMatrix( n*n, 31, uniform11 );
	var B = randomMatrix( n*n, 32, uniform11 );
	var i;
	var j;
	for ( i = 0; i < n; i++ ) {
		A[ ( i*n )+n-1 ] = 0.0;
		for ( j = 0; j < n-1; j++ ) {
			A[ ( i*n )+n-1 ] -= A[ ( i*n )+j ] * B[ ( j*n )+n-1 ];
		}
	}
	B[ ( ( n-1 )*n )+n-1 ] = 1.0;
	t.ok( maxRatio( n, n, n, A, B, reference.computeSerial( n, n, n, A, B ) ) <= 1.0, 'within bound' );
	t.end();
});

tape( 'the 4-worker reference is bitwise identical to the single-thread reference (odd/rectangular shapes, fewer rows than workers)', async function test( t ) {
	var shapes = [ [ 37, 53, 129 ], [ 3, 17, 9 ], [ 64, 64, 64 ] ];
	var pool = reference.createPool( 4 );
	var par;
	var ser;
	var A;
	var B;
	var s;
	var i;
	try {
		for ( i = 0; i < shapes.length; i++ ) {
			s = shapes[ i ];
			A = randomMatrix( s[ 0 ]*s[ 2 ], 41+i, wide );
			B = randomMatrix( s[ 2 ]*s[ 1 ], 51+i, uniform11 );
			ser = reference.computeSerial( s[ 0 ], s[ 1 ], s[ 2 ], A, B );
			par = await pool.run( s[ 0 ], s[ 1 ], s[ 2 ], A, B );
			t.ok( bitwiseEqual( ser.hi, par.hi ) && bitwiseEqual( ser.lo, par.lo ), 'identical for ' + s.join( '×' ) );
		}
		// Concurrent jobs on one pool...
		A = randomMatrix( 40*40, 61, uniform11 );
		B = randomMatrix( 40*40, 62, uniform11 );
		par = await Promise.all( [ pool.run( 40, 40, 40, A, B ), pool.run( 40, 40, 40, B, A ) ] );
		t.ok( bitwiseEqual( par[ 0 ].hi, reference.computeSerial( 40, 40, 40, A, B ).hi ), 'concurrent job 1 identical' );
		t.ok( bitwiseEqual( par[ 1 ].hi, reference.computeSerial( 40, 40, 40, B, A ).hi ), 'concurrent job 2 identical' );
	} finally {
		await pool.close();
	}
	t.end();
});

tape( 'the reference cache round-trips and rejects corrupt or stale entries', function test( t ) {
	var dir = fs.mkdtempSync( path.join( os.tmpdir(), 'stratamm-ref-' ) );
	var n = 16;
	var A = randomMatrix( n*n, 71, uniform11 );
	var B = randomMatrix( n*n, 72, uniform11 );
	var ref = reference.computeSerial( n, n, n, A, B );
	var inputs = records.sha256Arrays( [ A, B ] );
	var expect = { 'M': n, 'N': n, 'inputs_sha256': inputs };
	var digests;
	var p;
	var loaded;
	var buf;
	try {
		t.strictEqual( reference.loadReference( dir, 'X-base-1-16', expect ), null, 'missing entry => null' );
		digests = reference.saveReference( dir, 'X-base-1-16', ref, { 'M': n, 'N': n, 'K': n, 'inputs_sha256': inputs } );
		loaded = reference.loadReference( dir, 'X-base-1-16', expect );
		t.ok( bitwiseEqual( loaded.hi, ref.hi ) && bitwiseEqual( loaded.lo, ref.lo ), 'round trip is bitwise exact' );
		t.strictEqual( loaded.ref_sha256, digests.ref_sha256, 'ref_sha256 matches' );
		t.throws( function stale() {
			reference.loadReference( dir, 'X-base-1-16', { 'M': n, 'N': n, 'inputs_sha256': 'deadbeef' } );
		}, /different inputs/, 'stale inputs are rejected' );
		p = reference.cachePaths( dir, 'X-base-1-16' );
		buf = fs.readFileSync( p.lo );
		buf[ 9 ] ^= 1;
		fs.writeFileSync( p.lo, buf );
		t.throws( function corrupt() {
			reference.loadReference( dir, 'X-base-1-16', expect );
		}, /SHA-256/, 'a flipped bit is detected' );
	} finally {
		fs.rmSync( dir, { 'recursive': true, 'force': true } );
	}
	t.end();
});
