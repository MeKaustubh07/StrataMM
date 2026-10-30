'use strict';

/**
* Crossover definitions — research protocol rev. 2, §7.
*
* -   Families P (primary), O and R are fixed (§5.2). Per family, two thresholds, never mixed:
*     -   break-even (θ = 1): conservative n*₁ = smallest n such that every larger n in the family has CI lower > 1,
*         found by a fixed-sequence test from n_max downward at the per-cell 95% level, stopping at the first
*         failure — so n*₁ is the size at which the test stopped (the first failing size, not the smallest passing
*         one); a missing n_max means no test (censored, not a failure); point estimate = crossing of log S = log θ
*         interpolated against log₂ n between the bracketing
*         sizes inside each bootstrap replicate (last upward crossing; censored at < n_min / > n_max);
*     -   practical (θ = 1.02): the same procedure with "faster" verdicts and log S = log 1.02.
* -   Pre-registered pairing: θ = 1 on A1, θ = 1.02 on A2 (`primary: true`); the other two combinations are computed
*     and labelled secondary. A2 equals A0 exactly for n ≤ τ* (delegation), so A2 uses only sizes n > τ*.
*
* Censored replicates enter the summaries as −∞ (< n_min) or +∞ (> n_max); the median and the 95% interval use the
* inverse empirical CDF, so a bound inside the censored mass is reported as "< n_min" / "> n_max". JSON has no ±∞, so
* every interpolated value also carries an explicit status (`censoring`: 'finite' | 'left' | 'right' | 'none').
*/

var stats = require( './stats.js' );
var prng = require( './lib/prng.js' );

var FAMILIES = {
	'P': [ 32, 64, 128, 256, 512, 1024, 2048 ],
	'O': [ 255, 257, 511, 513, 1023, 1025 ],
	'R': [ 48, 96, 160, 192, 320, 384, 768, 1536 ]
};
var PRIMARY_FAMILY = 'P';
var THRESHOLDS = [
	{ 'alg': 'A1', 'theta': 1.0, 'rule': 'ci_lower_gt_1', 'name': 'break-even', 'primary': true },
	{ 'alg': 'A2', 'theta': 1.02, 'rule': 'faster', 'name': 'practical', 'primary': true },
	{ 'alg': 'A2', 'theta': 1.0, 'rule': 'ci_lower_gt_1', 'name': 'break-even', 'primary': false },
	{ 'alg': 'A1', 'theta': 1.02, 'rule': 'faster', 'name': 'practical', 'primary': false }
];
var N_STAR_DEFINITION = 'n*₁ = the smallest n of the family such that every larger n passes (§7), i.e. the size at which the fixed-sequence test from n_max downward stopped; all sizes pass: ≤ n_min (left-censored); n_max fails: > n_max (right-censored); n_max not measured: no test (censored, not a failure)';


/**
* Returns whether a cell passes the per-cell test of a threshold rule.
*
* @private
*/
function passes( pt, rule ) {
	if ( rule === 'faster' ) {
		return pt.verdict === stats.VERDICTS.FASTER;
	}
	return pt.lo > 1.0;
}

/**
* Fixed-sequence test (§7) from n_max downward at the per-cell 95% level, stopping at the first size that fails or has
* no test (missing cell or no CI). n*₁ = the smallest n of the family such that every larger n passes, i.e. the size
* at which the sequence stopped:
*
* -   stopped at f < n_max: n* = f (`status: 'partial'`; when f was not measured, `censored: 'stopped_at_missing'`:
*     the sizes below f were never tested, so n* is an upper bound);
* -   every size passes: n* = n_min (`status: 'all'`, `censored: 'left'`: the crossing is at or below n_min);
* -   n_max fails: no crossover within the family (`status: 'none'`, `censored: 'right'`, n* = null);
* -   n_max not measured: no test (`status: 'not_measured'`, `censored: 'not_measured'`, n* = null) — not a failure.
*
* @param {Array<Object>} points - `{ n, S, lo, hi, verdict, low_replication }` per size
* @param {Array<number>} sizes - sizes of the family considered (any order)
* @param {string} rule - `'ci_lower_gt_1'` (θ = 1) or `'faster'` (θ = 1.02)
* @returns {Object} `{ n_star, smallest_passing, status, censored, stopped_at, reason, tested, label, definition }`
*/
function fixedSequence( points, sizes, rule ) {
	var byN = new Map();
	var tested = [];
	var stopped = null;
	var reason = null;
	var passing = null;
	var censored = null;
	var nStar = null;
	var status;
	var desc;
	var pt;
	var ok;
	var i;
	var n;

	points.forEach( function each( p ) {
		byN.set( p.n, p );
	});
	desc = sizes.slice().sort( function cmp( a, b ) {
		return b - a;
	});
	for ( i = 0; i < desc.length; i++ ) {
		n = desc[ i ];
		pt = byN.get( n );
		if ( !pt || !Number.isFinite( pt.lo ) ) {
			tested.push( { 'n': n, 'pass': null, 'missing': !pt } );
			stopped = n;
			reason = ( pt ) ? 'no CI' : 'missing cell';
			break;
		}
		ok = passes( pt, rule );
		tested.push( { 'n': n, 'pass': ok, 'S': pt.S, 'lo': pt.lo, 'hi': pt.hi, 'verdict': pt.verdict, 'low_replication': !!pt.low_replication } );
		if ( !ok ) {
			stopped = n;
			reason = 'failed';
			break;
		}
		passing = n;
	}
	if ( desc.length === 0 ) {
		status = 'no_sizes';
	} else if ( stopped === null ) {
		status = 'all';
		nStar = desc[ desc.length-1 ];
		censored = 'left';
	} else if ( stopped === desc[ 0 ] ) {
		status = ( reason === 'failed' ) ? 'none' : 'not_measured';
		censored = ( reason === 'failed' ) ? 'right' : 'not_measured';
	} else {
		status = 'partial';
		nStar = stopped;
		censored = ( reason === 'failed' ) ? null : 'stopped_at_missing';
	}
	return {
		'n_star': nStar,
		'smallest_passing': passing,
		'status': status,
		'censored': censored,
		'stopped_at': stopped,
		'reason': reason,
		'tested': tested,
		'label': fsLabel( status, nStar, desc, reason, passing ),
		'definition': N_STAR_DEFINITION
	};
}

/**
* Returns a label for a fixed-sequence result.
*
* @private
*/
function fsLabel( status, nStar, desc, reason, passing ) {
	switch ( status ) {
	case 'no_sizes':
		return 'no sizes';
	case 'none':
		return '> ' + desc[ 0 ] + ' (fails at n_max)';
	case 'not_measured':
		return 'not measured (' + ( ( reason === 'no CI' ) ? 'no CI' : 'no cell' ) + ' at n_max = ' + desc[ 0 ] + '; censored, no test)';
	case 'all':
		return '≤ ' + nStar + ' (all sizes pass)';
	default:
		return nStar + ' (every n ≥ ' + passing + ' passes' + ( ( reason === 'failed' ) ? ')' : '; censored: ' + nStar + ' not measured)' );
	}
}

/**
* Returns the censoring status of an interpolated value.
*
* @private
*/
function censorStatus( v ) {
	if ( v === -Infinity ) {
		return 'left';
	}
	if ( v === Infinity ) {
		return 'right';
	}
	return ( Number.isFinite( v ) ) ? 'finite' : 'none';
}

/**
* Returns the last upward crossing of zero of `d` against `x` (ascending x).
*
* @param {Collection} x - abscissae (log₂ n), ascending
* @param {Collection} d - log S − log θ per size
* @returns {Object} `{ status: 'crossed'|'left'|'right', x }` (left: above θ at every size; right: below θ at n_max)
*/
function lastCrossing( x, d ) {
	var last = d.length - 1;
	var j;
	if ( last < 0 ) {
		return { 'status': 'none', 'x': NaN };
	}
	if ( d[ last ] < 0.0 ) {
		return { 'status': 'right', 'x': Infinity };
	}
	for ( j = last-1; j >= 0; j-- ) {
		if ( d[ j ] < 0.0 ) {
			return { 'status': 'crossed', 'x': x[ j ] + ( ( -d[ j ] ) * ( x[ j+1 ]-x[ j ] ) / ( d[ j+1 ]-d[ j ] ) ) };
		}
	}
	return { 'status': 'left', 'x': -Infinity };
}

/**
* Returns the inverse-ECDF quantile of sorted values (type 1; well defined with ±∞).
*
* @private
*/
function quantile1( s, p ) {
	var k = Math.ceil( p * s.length ) - 1;
	return s[ Math.min( Math.max( k, 0 ), s.length-1 ) ];
}

/**
* Formats an interpolated crossing for display.
*
* @private
*/
function crossLabel( v, nMin, nMax ) {
	if ( v === -Infinity ) {
		return '< ' + nMin;
	}
	if ( v === Infinity ) {
		return '> ' + nMax;
	}
	if ( !Number.isFinite( v ) ) {
		return 'n/a';
	}
	return String( Math.round( v ) );
}

/**
* Interpolates the crossing of log S = log θ inside each block-bootstrap replicate.
*
* Blocks are resampled jointly across sizes when every size has the same paired block ids (one block spanning the
* family), otherwise independently per size.
*
* @param {Array<Object>} points - `{ n, ref: Map, alg: Map, S }` per size (ascending order not required)
* @param {number} theta - threshold
* @param {Object} [opts] - `{ B, seed }`
* @returns {Object} replicate summary: observed crossing, median, 95% interval, censoring fractions
*/
function interpolate( points, theta, opts ) {
	var joint = true;
	var reps;
	var bufs;
	var pts;
	var idx;
	var xs;
	var d;
	var g;
	var B;
	var b;
	var i;
	var j;
	var c;
	var s;
	var out;

	opts = opts || {};
	B = opts.B || stats.B_DEFAULT;
	pts = points.slice().sort( function cmp( a, z ) {
		return a.n - z.n;
	}).map( function each( p ) {
		var blocks = stats.commonBlocks( p.ref, p.alg );
		return {
			'n': p.n,
			'blocks': blocks,
			'x': Float64Array.from( blocks, function f( k ) {
				return p.ref.get( k );
			}),
			'y': Float64Array.from( blocks, function f( k ) {
				return p.alg.get( k );
			})
		};
	}).filter( function f( p ) {
		return p.blocks.length > 0;
	});
	out = {
		'theta': theta, 'sizes': pts.map( function f( p ) {
			return p.n;
		}), 'B': B, 'seed': opts.seed || prng.DEFAULT_SEED, 'resampling': null, 'observed': null,
		'median': NaN, 'lo': NaN, 'hi': NaN, 'frac_left': NaN, 'frac_right': NaN, 'labels': null,
		'censoring': { 'observed': 'none', 'median': 'none', 'lo': 'none', 'hi': 'none' }
	};
	if ( pts.length === 0 ) {
		return out;
	}
	for ( i = 1; i < pts.length; i++ ) {
		if ( pts[ i ].blocks.join( '\u0000' ) !== pts[ 0 ].blocks.join( '\u0000' ) ) {
			joint = false;
		}
	}
	out.resampling = ( joint && pts.length > 1 ) ? 'joint' : 'independent';
	xs = pts.map( function f( p ) {
		return Math.log2( p.n );
	});
	d = new Float64Array( pts.length );
	for ( i = 0; i < pts.length; i++ ) {
		d[ i ] = Math.log( stats.median( pts[ i ].x ) / stats.median( pts[ i ].y ) ) - Math.log( theta );
	}
	c = lastCrossing( xs, d );
	out.observed = { 'status': c.status, 'n': Math.pow( 2, c.x ) };
	g = prng.createRng( out.seed );
	reps = new Float64Array( B );
	bufs = pts.map( function f( p ) {
		return [ new Float64Array( p.blocks.length ), new Float64Array( p.blocks.length ), new Int32Array( p.blocks.length ) ];
	});
	for ( b = 0; b < B; b++ ) {
		for ( i = 0; i < pts.length; i++ ) {
			s = pts[ i ].blocks.length;
			idx = bufs[ ( joint ) ? 0 : i ][ 2 ];
			if ( !joint || i === 0 ) {
				for ( j = 0; j < s; j++ ) {
					idx[ j ] = g.randint( s );
				}
			}
			d[ i ] = Math.log( stats.medianAt( pts[ i ].x, idx, s, bufs[ i ][ 0 ] ) / stats.medianAt( pts[ i ].y, idx, s, bufs[ i ][ 1 ] ) ) - Math.log( theta );
		}
		c = lastCrossing( xs, d );
		reps[ b ] = Math.pow( 2, c.x );
	}
	reps.sort();
	out.median = quantile1( reps, 0.5 );
	out.lo = quantile1( reps, 0.025 );
	out.hi = quantile1( reps, 0.975 );
	out.frac_left = countIf( reps, function f( v ) {
		return v === 0;
	}) / B;
	out.frac_right = countIf( reps, function f( v ) {
		return v === Infinity;
	}) / B;
	// 2^(−∞) = 0 encodes left censoring:
	out.median = ( out.median === 0 ) ? -Infinity : out.median;
	out.lo = ( out.lo === 0 ) ? -Infinity : out.lo;
	out.hi = ( out.hi === 0 ) ? -Infinity : out.hi;
	if ( out.observed.n === 0 ) {
		out.observed.n = -Infinity;
	}
	out.censoring = { 'observed': censorStatus( out.observed.n ), 'median': censorStatus( out.median ), 'lo': censorStatus( out.lo ), 'hi': censorStatus( out.hi ) };
	out.labels = {
		'observed': crossLabel( out.observed.n, out.sizes[ 0 ], out.sizes[ out.sizes.length-1 ] ),
		'median': crossLabel( out.median, out.sizes[ 0 ], out.sizes[ out.sizes.length-1 ] ),
		'interval': '[' + crossLabel( out.lo, out.sizes[ 0 ], out.sizes[ out.sizes.length-1 ] ) + ', ' + crossLabel( out.hi, out.sizes[ 0 ], out.sizes[ out.sizes.length-1 ] ) + ']'
	};
	return out;
}

/**
* Counts the elements satisfying a predicate.
*
* @private
*/
function countIf( arr, pred ) {
	var n = 0;
	var i;
	for ( i = 0; i < arr.length; i++ ) {
		if ( pred( arr[ i ] ) ) {
			n += 1;
		}
	}
	return n;
}

/**
* Computes the §7 crossovers for one family, algorithm and threshold.
*
* @param {Object} spec - `{ family, sizes, alg, theta, rule, name, primary, minExclusive }` (`minExclusive`: only
*   sizes n > minExclusive are used, i.e. τ* for A2)
* @param {Function} getPoint - `getPoint(alg, n)` → `{ n, ref: Map, alg: Map, S, lo, hi, verdict, low_replication }`
*   or null
* @param {Object} [opts] - `{ B, seed }`
* @returns {Object} fixed-sequence and interpolation results
*/
function crossover( spec, getPoint, opts ) {
	var sizes = spec.sizes.filter( function f( n ) {
		return spec.minExclusive === void 0 || spec.minExclusive === null || n > spec.minExclusive;
	});
	var points = [];
	sizes.forEach( function each( n ) {
		var p = getPoint( spec.alg, n );
		if ( p ) {
			points.push( p );
		}
	});
	return {
		'family': spec.family,
		'alg': spec.alg,
		'theta': spec.theta,
		'rule': spec.rule,
		'name': spec.name,
		'primary': !!spec.primary && spec.family === PRIMARY_FAMILY,
		'pre_registered': !!spec.primary,
		'min_exclusive': ( spec.minExclusive === void 0 ) ? null : spec.minExclusive,
		'sizes': sizes,
		'missing': sizes.filter( function f( n ) {
			return !points.some( function g( p ) {
				return p.n === n;
			});
		}),
		'fixed_sequence': fixedSequence( points, sizes, spec.rule ),
		'interpolation': interpolate( points, spec.theta, opts )
	};
}

/**
* Computes all crossovers (families × threshold specs).
*
* @param {Function} getPoint - see `crossover`
* @param {Object} opts - `{ B, seed (master), tauStar }`
* @returns {Array<Object>} results
*/
function crossovers( getPoint, opts ) {
	var out = [];
	Object.keys( FAMILIES ).forEach( function each( fam ) {
		THRESHOLDS.forEach( function each2( t ) {
			out.push( crossover( {
				'family': fam,
				'sizes': FAMILIES[ fam ],
				'alg': t.alg,
				'theta': t.theta,
				'rule': t.rule,
				'name': t.name,
				'primary': t.primary,
				'minExclusive': ( t.alg === 'A2' ) ? opts.tauStar : null
			}, getPoint, {
				'B': opts.B,
				'seed': prng.deriveSeed( opts.seed, 'X|' + fam + '|' + t.alg + '|' + t.theta )
			}) );
		});
	});
	return out;
}


// EXPORTS //

module.exports = {
	'FAMILIES': FAMILIES,
	'PRIMARY_FAMILY': PRIMARY_FAMILY,
	'THRESHOLDS': THRESHOLDS,
	'N_STAR_DEFINITION': N_STAR_DEFINITION,
	'fixedSequence': fixedSequence,
	'lastCrossing': lastCrossing,
	'interpolate': interpolate,
	'crossover': crossover,
	'crossovers': crossovers
};
