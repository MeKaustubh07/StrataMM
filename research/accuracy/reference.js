'use strict';

// Double-double reference product C = A*B (Dot2 on pre-split operands; Ogita, Rump, Oishi 2005), computed in
// parallel over rows with worker_threads (bitwise identical to the single-thread result, since every entry's
// operation sequence is independent of the row partition), plus the on-disk cache (.hi/.lo .f64 + .sha256).

// MODULES //

var Worker = require( 'worker_threads' ).Worker;
var path = require( 'path' );
var fs = require( 'fs' );
var eft = require( './eft.js' );
var records = require( './records.js' );


// VARIABLES //

var WORKER = path.join( __dirname, 'reference_worker.js' );
var METHOD = 'Dot2 on pre-split operands, unevaluated double-double (hi, lo); ORO 2005';


// FUNCTIONS //

/**
* Default allocator: a fresh Float64Array.
*
* @private
* @param {string} name - buffer name (unused)
* @param {NonNegativeInteger} n - length
* @returns {Float64Array} array
*/
function fresh( name, n ) {
	return new Float64Array( n );
}

/**
* Prepares operands: copies `A` (M×K, row-major), transposes `B` (K×N, row-major) into `Bt` (N×K), and splits both.
*
* @param {NonNegativeInteger} M - rows of A
* @param {NonNegativeInteger} N - columns of B
* @param {NonNegativeInteger} K - inner dimension
* @param {Float64Array} A - row-major M×K matrix
* @param {Float64Array} B - row-major K×N matrix
* @param {Function} [alloc] - allocator `( name, length ) => Float64Array` (default: fresh arrays)
* @returns {Object} prepared operands `{ M, N, K, A, Ah, Al, Bt, Bh, Bl }`
*/
function prepare( M, N, K, A, B, alloc ) {
	var P;
	alloc = alloc || fresh;
	P = {
		'M': M,
		'N': N,
		'K': K,
		'A': alloc( 'A', M*K ),
		'Ah': alloc( 'Ah', M*K ),
		'Al': alloc( 'Al', M*K ),
		'Bt': alloc( 'Bt', N*K ),
		'Bh': alloc( 'Bh', N*K ),
		'Bl': alloc( 'Bl', N*K )
	};
	var i;
	var j;
	P.A.set( A.subarray( 0, M*K ) );
	for ( i = 0; i < K; i++ ) {
		for ( j = 0; j < N; j++ ) {
			P.Bt[ ( j*K )+i ] = B[ ( i*N )+j ];
		}
	}
	eft.splitInto( P.A, P.Ah, P.Al );
	eft.splitInto( P.Bt, P.Bh, P.Bl );
	return P;
}

/**
* Computes rows `[r0, r1)` of the reference product into `hi`/`lo` (row-major M×N).
*
* @param {Object} P - prepared operands
* @param {NonNegativeInteger} r0 - first row
* @param {NonNegativeInteger} r1 - end row (exclusive)
* @param {Float64Array} hi - output high parts
* @param {Float64Array} lo - output low parts
*/
function rows( P, r0, r1, hi, lo ) {
	var N = P.N;
	var K = P.K;
	var A = P.A;
	var Ah = P.Ah;
	var Al = P.Al;
	var Bt = P.Bt;
	var Bh = P.Bh;
	var Bl = P.Bl;
	var ia;
	var ib;
	var i;
	var j;
	var k;
	var p;
	var s;
	var h;
	var r;
	var t;
	var z;
	for ( i = r0; i < r1; i++ ) {
		for ( j = 0; j < N; j++ ) {
			p = 0.0;
			s = 0.0;
			ia = i * K;
			ib = j * K;
			for ( k = 0; k < K; k++ ) {
				// TwoProduct on pre-split operands: h + r = a*b exactly...
				h = A[ ia ] * Bt[ ib ];
				r = ( Al[ ia ]*Bl[ ib ] ) - ( ( ( h - ( Ah[ ia ]*Bh[ ib ] ) ) - ( Al[ ia ]*Bh[ ib ] ) ) - ( Ah[ ia ]*Bl[ ib ] ) );

				// TwoSum(p, h), accumulating both error terms in working precision...
				t = p + h;
				z = t - p;
				s += ( ( p - ( t - z ) ) + ( h - z ) ) + r;
				p = t;
				ia += 1;
				ib += 1;
			}
			// Normalize (p, s) into an unevaluated double-double (hi + lo = p + s exactly)...
			t = p + s;
			z = t - p;
			hi[ ( i*N )+j ] = t;
			lo[ ( i*N )+j ] = ( p - ( t - z ) ) + ( s - z );
		}
	}
}

/**
* Computes the reference product in the calling thread.
*
* @param {NonNegativeInteger} M - rows of A
* @param {NonNegativeInteger} N - columns of B
* @param {NonNegativeInteger} K - inner dimension
* @param {Float64Array} A - row-major M×K matrix
* @param {Float64Array} B - row-major K×N matrix
* @returns {Object} `{ hi, lo }` (row-major M×N)
*/
function computeSerial( M, N, K, A, B ) {
	var P = prepare( M, N, K, A, B );
	var hi = new Float64Array( M*N );
	var lo = new Float64Array( M*N );
	rows( P, 0, M, hi, lo );
	return {
		'hi': hi,
		'lo': lo
	};
}

/**
* Creates a persistent pool of worker threads computing reference products in parallel over contiguous row blocks.
*
* ## Notes
*
* -   Jobs run one at a time (calls to `run` are queued). The pool owns one set of SharedArrayBuffers that is reused by
*     every job and grown only when a larger job arrives: fresh shared buffers per job would stay alive as long as the
*     (rarely collecting) worker isolates hold stale views, which V8 accounts as hundreds of MiB after a few dozen jobs.
*
* @param {PositiveInteger} size - number of workers
* @returns {Object} pool with `run( M, N, K, A, B ) => Promise<{hi, lo}>` and `close() => Promise`
*/
function createPool( size ) {
	var workers = [];
	var pending = {};
	var queue = Promise.resolve();
	var shared = {};
	var nextId = 0;
	var failure = null;
	var i;
	for ( i = 0; i < size; i++ ) {
		workers.push( spawn() );
	}
	return {
		'size': size,
		'run': run,
		'close': close
	};

	function spawn() {
		var w = new Worker( WORKER );
		w.on( 'message', onMessage );
		w.on( 'error', onError );
		return w;
	}

	function onMessage( msg ) {
		var job = pending[ msg.id ];
		if ( !job ) {
			return;
		}
		if ( msg.error ) {
			job.reject( new Error( 'reference worker failed: ' + msg.error ) );
			delete pending[ msg.id ];
			return;
		}
		job.remaining -= 1;
		if ( job.remaining === 0 ) {
			delete pending[ msg.id ];
			job.resolve();
		}
	}

	function onError( err ) {
		var id;
		failure = err;
		for ( id in pending ) {
			if ( Object.prototype.hasOwnProperty.call( pending, id ) ) {
				pending[ id ].reject( err );
				delete pending[ id ];
			}
		}
	}

	function view( name, n ) {
		// Reuse (or grow) the pool-owned shared buffer for `name`...
		if ( !shared[ name ] || shared[ name ].byteLength < n*8 ) {
			shared[ name ] = new SharedArrayBuffer( Math.max( n, 1 ) * 8 );
		}
		return new Float64Array( shared[ name ], 0, n );
	}

	function run( M, N, K, A, B ) {
		var p = queue.then( function next() {
			return runOne( M, N, K, A, B );
		});
		queue = p.catch( function ignore() {} );
		return p;
	}

	function runOne( M, N, K, A, B ) {
		return new Promise( function exec( resolve, reject ) {
			var bufs;
			var job;
			var hi;
			var lo;
			var r0;
			var r1;
			var P;
			var w;
			if ( failure ) {
				return reject( failure );
			}
			P = prepare( M, N, K, A, B, view );
			hi = view( 'hi', M*N );
			lo = view( 'lo', M*N );
			job = {
				'id': nextId,
				'remaining': workers.length,
				'resolve': done,
				'reject': reject
			};
			nextId += 1;
			pending[ job.id ] = job;
			bufs = {
				'A': P.A.buffer,
				'Ah': P.Ah.buffer,
				'Al': P.Al.buffer,
				'Bt': P.Bt.buffer,
				'Bh': P.Bh.buffer,
				'Bl': P.Bl.buffer,
				'hi': hi.buffer,
				'lo': lo.buffer
			};
			for ( w = 0; w < workers.length; w++ ) {
				r0 = Math.floor( ( w*M ) / workers.length );
				r1 = Math.floor( ( ( w+1 )*M ) / workers.length );
				workers[ w ].postMessage({
					'id': job.id,
					'M': M,
					'N': N,
					'K': K,
					'r0': r0,
					'r1': r1,
					'bufs': bufs
				});
			}

			function done() {
				// Copy out of shared memory so callers get ordinary (transferable, hashable) arrays...
				resolve({
					'hi': Float64Array.from( hi ),
					'lo': Float64Array.from( lo )
				});
			}
		});
	}

	function close() {
		return Promise.all( workers.map( function term( w ) {
			return w.terminate();
		}) );
	}
}

/**
* Computes the reference product with a temporary pool of `nworkers` worker threads.
*
* @param {NonNegativeInteger} M - rows of A
* @param {NonNegativeInteger} N - columns of B
* @param {NonNegativeInteger} K - inner dimension
* @param {Float64Array} A - row-major M×K matrix
* @param {Float64Array} B - row-major K×N matrix
* @param {PositiveInteger} nworkers - number of workers
* @returns {Promise<Object>} `{ hi, lo }`
*/
async function computeParallel( M, N, K, A, B, nworkers ) {
	var pool = createPool( nworkers );
	try {
		return await pool.run( M, N, K, A, B );
	} finally {
		await pool.close();
	}
}


// CACHE //

/**
* Returns the cache file paths for a reference name (`<family>-<params>-<seed>-<n>`).
*
* @param {string} dir - cache directory
* @param {string} name - reference name
* @returns {Object} paths `{ hi, lo, sha, meta }`
*/
function cachePaths( dir, name ) {
	return {
		'hi': path.join( dir, name + '.hi.f64' ),
		'lo': path.join( dir, name + '.lo.f64' ),
		'sha': path.join( dir, name + '.sha256' ),
		'meta': path.join( dir, name + '.meta.json' )
	};
}

/**
* Writes a file atomically (temporary file + rename).
*
* @private
* @param {string} file - destination
* @param {(Buffer|string)} data - contents
*/
function writeAtomic( file, data ) {
	var tmp = file + '.tmp-' + process.pid;
	fs.writeFileSync( tmp, data );
	fs.renameSync( tmp, file );
}

/**
* Returns a Buffer view of a typed array.
*
* @private
* @param {TypedArray} x - array
* @returns {Buffer} view
*/
function bytes( x ) {
	return Buffer.from( x.buffer, x.byteOffset, x.byteLength );
}

/**
* Saves a reference product to the cache and returns its digests.
*
* @param {string} dir - cache directory
* @param {string} name - reference name
* @param {Object} ref - `{ hi, lo }`
* @param {Object} meta - metadata (must include `inputs_sha256`, `M`, `N`, `K`)
* @returns {Object} digests `{ hi_sha256, lo_sha256, ref_sha256 }`
*/
function saveReference( dir, name, ref, meta ) {
	var p = cachePaths( dir, name );
	var d = {
		'hi_sha256': records.sha256Arrays( [ ref.hi ] ),
		'lo_sha256': records.sha256Arrays( [ ref.lo ] ),
		'ref_sha256': records.sha256Arrays( [ ref.hi, ref.lo ] )
	};
	fs.mkdirSync( dir, {
		'recursive': true
	});
	writeAtomic( p.hi, bytes( ref.hi ) );
	writeAtomic( p.lo, bytes( ref.lo ) );
	writeAtomic( p.sha, d.hi_sha256 + '  ' + name + '.hi.f64\n' + d.lo_sha256 + '  ' + name + '.lo.f64\n' );
	writeAtomic( p.meta, JSON.stringify( Object.assign( {}, meta, d, {
		'name': name,
		'method': METHOD,
		'endianness': require( 'os' ).endianness(),
		'node': process.version,
		'created': new Date().toISOString()
	}), null, 2 ) + '\n' );
	return d;
}

/**
* Reads a `.f64` file into a new (aligned) Float64Array.
*
* @private
* @param {string} file - file path
* @returns {Float64Array} array
*/
function readF64( file ) {
	var buf = fs.readFileSync( file );
	var out = new Float64Array( buf.length / 8 );
	new Uint8Array( out.buffer ).set( buf );
	return out;
}

/**
* Loads a cached reference product, verifying its SHA-256 digests and that it was computed from the expected inputs.
*
* @param {string} dir - cache directory
* @param {string} name - reference name
* @param {Object} expect - expected `{ M, N, inputs_sha256 }`
* @throws {Error} on a digest/input/shape mismatch (a corrupt or stale cache entry)
* @returns {(Object|null)} `{ hi, lo, meta, ref_sha256 }` or `null` if absent
*/
function loadReference( dir, name, expect ) {
	var lines;
	var meta;
	var hi;
	var lo;
	var p;
	var d;
	p = cachePaths( dir, name );
	if ( !fs.existsSync( p.hi ) || !fs.existsSync( p.lo ) || !fs.existsSync( p.sha ) || !fs.existsSync( p.meta ) ) {
		return null;
	}
	meta = JSON.parse( fs.readFileSync( p.meta, 'utf8' ) );
	if ( meta.inputs_sha256 !== expect.inputs_sha256 || meta.M !== expect.M || meta.N !== expect.N ) {
		throw new Error( 'reference cache ' + name + ' was computed from different inputs (inputs_sha256 ' + meta.inputs_sha256 + ' != ' + expect.inputs_sha256 + ')' );
	}
	hi = readF64( p.hi );
	lo = readF64( p.lo );
	if ( hi.length !== expect.M*expect.N || lo.length !== expect.M*expect.N ) {
		throw new Error( 'reference cache ' + name + ' has the wrong length' );
	}
	d = {
		'hi': records.sha256Arrays( [ hi ] ),
		'lo': records.sha256Arrays( [ lo ] )
	};
	lines = fs.readFileSync( p.sha, 'utf8' ).trim().split( '\n' );
	if ( lines.length !== 2 || lines[ 0 ].split( /\s+/ )[ 0 ] !== d.hi || lines[ 1 ].split( /\s+/ )[ 0 ] !== d.lo || meta.hi_sha256 !== d.hi || meta.lo_sha256 !== d.lo ) {
		throw new Error( 'reference cache ' + name + ' failed SHA-256 verification (corrupt file)' );
	}
	return {
		'hi': hi,
		'lo': lo,
		'meta': meta,
		'ref_sha256': records.sha256Arrays( [ hi, lo ] )
	};
}


// EXPORTS //

module.exports = {
	'METHOD': METHOD,
	'prepare': prepare,
	'rows': rows,
	'computeSerial': computeSerial,
	'computeParallel': computeParallel,
	'createPool': createPool,
	'cachePaths': cachePaths,
	'saveReference': saveReference,
	'loadReference': loadReference
};
