'use strict';

// Evaluates one E6 shard (family, params, seed, n): regenerate the inputs, load + verify the cached reference, run
// every arm, compute metrics, apply gates, certify the reference, and return `accuracy` records.

// MODULES //

var families = require( './families.js' );
var reference = require( './reference.js' );
var metrics = require( './metrics.js' );
var certify = require( './certify.js' );
var records = require( './records.js' );
var gates = require( './gates.js' );
var arms = require( './arms.js' );


// FUNCTIONS //

/**
* Returns the maximum absolute value of an array.
*
* @private
* @param {Float64Array} x - array
* @returns {number} maximum
*/
function maxAbs( x ) {
	var m = 0.0;
	var i;
	for ( i = 0; i < x.length; i++ ) {
		if ( Math.abs( x[ i ] ) > m ) {
			m = Math.abs( x[ i ] );
		}
	}
	return m;
}

/**
* Tests two arrays for bitwise-equal contents (Object.is per element).
*
* @private
* @param {Float64Array} x - first array
* @param {Float64Array} y - second array
* @returns {boolean} boolean
*/
function same( x, y ) {
	var i;
	for ( i = 0; i < x.length; i++ ) {
		if ( !Object.is( x[ i ], y[ i ] ) ) {
			return false;
		}
	}
	return true;
}

/**
* Evaluates a shard.
*
* @param {Object} shard - shard from `design.shards` (its `arms` may be a subset when resuming)
* @param {Object} opts - options
* @param {string} opts.campaign - campaign identifier
* @param {string} opts.cacheDir - reference cache directory
* @param {PositiveInteger} opts.masterSeed - master seed
* @param {string} opts.pkgSha - SHA-256 of the package sources
* @throws {Error} cache missing/corrupt, precondition violated, or certification failed
* @returns {Object} `{ records, cert, violations }`
*/
function evaluateShard( shard, opts ) {
	var violations = [];
	var entries = [];
	var inputsSha;
	var maxA;
	var maxB;
	var stats;
	var cert;
	var gen;
	var out;
	var ref;
	var AB;
	var C0;
	var ws;
	var t0;
	var t1;
	var n;
	var C;
	var a;
	var m;
	var r;
	var L;
	var v;
	var i;

	n = shard.n;
	gen = families.generate( shard.family, shard.params, n, shard.seed );
	inputsSha = records.sha256Arrays( [ gen.A, gen.B ] );
	ref = reference.loadReference( opts.cacheDir, shard.name, {
		'M': n,
		'N': n,
		'inputs_sha256': inputsSha
	});
	if ( ref === null ) {
		throw new Error( 'E6: reference cache entry missing for ' + shard.name + ' (run the reference pass first)' );
	}
	AB = arms.absProduct( n, n, n, gen.A, gen.B );
	families.checkPreconditions( n, gen.A, gen.B, AB );
	maxA = maxAbs( gen.A );
	maxB = maxAbs( gen.B );
	ws = metrics.workspace( n*n );
	C = new Float64Array( n*n );
	C0 = null;
	out = [];
	for ( i = 0; i < shard.arms.length; i++ ) {
		a = shard.arms[ i ];
		stats = {};
		C.fill( NaN );
		t0 = process.hrtime.bigint();
		arms.run( a, n, n, n, gen.A, gen.B, C, stats );
		t1 = process.hrtime.bigint();
		L = arms.levelsPerformed( a, n, n, n );
		m = metrics.compute({
			'M': n,
			'N': n,
			'K': n,
			'L': L,
			'C': C,
			'hi': ref.hi,
			'lo': ref.lo,
			'AB': AB,
			'maxA': maxA,
			'maxB': maxB,
			'kappa': ( shard.family === 'F9a' || shard.family === 'F9b' )
		}, ws );
		if ( a.alg === 'A0' ) {
			C0 = Float64Array.from( C );
		}
		if ( a.alg === 'V2' ) {
			m.metrics.scale_inexact = stats.scale_inexact;
			m.metrics.unscale_inexact = stats.unscale_inexact;
		}
		m.metrics.identical_to_A0 = ( C0 !== null && a.alg !== 'A0' ) ? same( C, C0 ) : null;
		r = records.record( 'accuracy', opts.campaign, {
			'family': shard.family,
			'params': shard.params,
			'seed': shard.seed,
			'seed_index': shard.seed_index,
			'master_seed': opts.masterSeed,
			'M': n,
			'N': n,
			'K': n,
			'alg': a.alg,
			'L': L,
			'levels': a.levels,
			'cutoff': ( a.alg === 'A0' ) ? null : arms.CUTOFF,
			'k0': n / Math.pow( 2, L ),
			'order': 'row-major',
			'transA': 'no-transpose',
			'transB': 'no-transpose',
			'alpha': 1,
			'beta': 0,
			'metrics': m.metrics,
			'worst': m.worst,
			'argmax': m.argmax,
			'ref_sha256': ref.ref_sha256,
			'inputs_sha256': inputsSha,
			'pkg_sha256': opts.pkgSha,
			'wall_ms': Number( t1 - t0 ) / 1e6,
			'warnings': []
		});
		v = gates.violations( r );
		if ( v.length ) {
			r.gate_violations = v;
			violations.push( shard.key + ' ' + a.alg + ' L=' + L + ': ' + v.join( '; ' ) );
		}
		r.warnings = r.warnings.concat( gates.recordWarnings( r ) );
		entries = entries.concat( m.worstIdx );
		out.push( r );
	}
	gates.shardWarnings( out );

	// Certify the reference on 1,000 random + every arm's worst entries (DotK(3)) and 32 entries (BigInt)...
	cert = certify.certify({
		'M': n,
		'N': n,
		'K': n,
		'A': gen.A,
		'B': gen.B,
		'hi': ref.hi,
		'lo': ref.lo,
		'entries': entries,
		'seed': shard.seed
	});
	certify.assertCertified( cert, shard.key );
	for ( i = 0; i < out.length; i++ ) {
		out[ i ].cert = {
			'dotk_n': cert.dotk.n,
			'dotk_max_ratio': cert.dotk.max_ratio,
			'bigint_n': cert.bigint.n,
			'bigint_max_ratio': cert.bigint.max_ratio
		};
	}
	return {
		'records': out,
		'cert': cert,
		'violations': violations
	};
}


// EXPORTS //

module.exports = evaluateShard;
