'use strict';

/**
* Statistics for the StrataMM timing campaign — research protocol rev. 2, §6.
*
* -   Per process: median per-call time. Per cell: median of the r process medians; IQR of pooled samples; min–max
*     of process medians.
* -   Speedup S = cell(A0)/cell(alg), paired within blocks; 95% CI by block bootstrap (B = 10,000, percentile, seed
*     recorded); r ≤ 4 ⇒ per-block ratios + t-interval on log ratios (df = r − 1), labelled "low replication".
* -   Verdicts exactly as §6 (evaluated in the order listed there).
* -   Ladder terms: ratios of cell medians with block-bootstrap CIs. §6 sanity rule "if A2/C2 ≥ (8/7)^L the cell is
*     flagged confounded": "A2/C2" is the speedup of A2 over C2, i.e. the time ratio cell(C2)/cell(A2) — SW is faster
*     than the 8-product recursion by at least the most its 7-vs-8 arithmetic saving can explain. Implemented as
*     `confounded = cell(C2)/cell(A2) ≥ (8/7)^L` on the arithmetic terms (`CONFOUNDED_RULE`, carried into the output).
* -   Position-in-block effect: within-block permutation test (pos_in_block is randomized, hence exchangeable under H0).
*
* Quantiles use the linear-interpolation definition (Hyndman–Fan type 7) throughout.
*/

var tQuantile = require( '@stdlib/stats/base/dists/t/quantile' );
var prng = require( './lib/prng.js' );
var desc = require( './lib/descriptive.js' );
var positionEffect = require( './lib/position.js' );

var sorted = desc.sorted;
var quantileSorted = desc.quantileSorted;
var median = desc.median;
var mean = desc.mean;
var sd = desc.sd;

var B_DEFAULT = 10000;
var LEVEL = 0.95;
var LOW_REP_MAX = 4;
var BAND = 0.02;
var VERDICTS = {
	'FASTER': 'faster',
	'FASTER_MARGIN': 'faster (<2% margin)',
	'EQUIVALENT': 'equivalent',
	'SLOWER': 'slower',
	'INCONCLUSIVE': 'inconclusive'
};
var LADDER_TERMS = [
	{ 'name': 'total_n', 'num': [ 'A0', 0 ], 'den': [ 'A2', 0 ], 'label': 'A0/A2, LD n (total)' },
	{ 'name': 'total_pad', 'num': [ 'A0', 8 ], 'den': [ 'A2', 8 ], 'label': 'A0/A2, LD n+8 (total)' },
	{ 'name': 'recursion_n', 'num': [ 'A0', 0 ], 'den': [ 'C2', 0 ], 'label': 'A0/C2, LD n (8-product recursion)' },
	{ 'name': 'recursion_pad', 'num': [ 'A0', 8 ], 'den': [ 'C2', 8 ], 'label': 'A0/C2, LD n+8 (8-product recursion)' },
	{ 'name': 'arith_n', 'num': [ 'C2', 0 ], 'den': [ 'A2', 0 ], 'label': 'C2/A2, LD n (7 vs 8 products; = speedup of A2 over C2)', 'ceiling': true },
	{ 'name': 'arith_pad', 'num': [ 'C2', 8 ], 'den': [ 'A2', 8 ], 'label': 'C2/A2, LD n+8 (7 vs 8 products; = speedup of A2 over C2)', 'ceiling': true },
	{ 'name': 'ld_A0', 'num': [ 'A0', 0 ], 'den': [ 'A0', 8 ], 'label': 'A0: LD n / LD n+8' },
	{ 'name': 'ld_C2', 'num': [ 'C2', 0 ], 'den': [ 'C2', 8 ], 'label': 'C2: LD n / LD n+8' },
	{ 'name': 'ld_A2', 'num': [ 'A2', 0 ], 'den': [ 'A2', 8 ], 'label': 'A2: LD n / LD n+8' },
	{ 'name': 'layout', 'num': [ 'A0', 0 ], 'den': [ 'C1', 0 ], 'label': 'A0/C1, LD n (pack B column-major)' },
	{ 'name': 'packed_vs_sw', 'num': [ 'C1', 0 ], 'den': [ 'A2', 0 ], 'label': 'C1/A2, LD n' }
];
var CONFOUNDED_RULE = 'confounded iff cell(C2)/cell(A2) ≥ (8/7)^L, i.e. the speedup of A2 over C2 (§6 "A2/C2") is at least the 7-vs-8-product arithmetic saving (8/7)^L';


// VERDICTS //

/**
* Returns the §6 verdict for a speedup estimate and its CI, evaluated in the protocol's order: faster (CI lower > 1
* and S ≥ 1.02); faster (< 2% margin) (CI lower > 1, S < 1.02); equivalent (CI ⊂ [0.98, 1.02], closed); slower (CI
* upper < 1 and S ≤ 0.98); otherwise inconclusive (including a missing CI).
*
* @param {number} S - speedup point estimate
* @param {number} lo - CI lower bound
* @param {number} hi - CI upper bound
* @returns {string} verdict
*/
function verdict( S, lo, hi ) {
	if ( !Number.isFinite( S ) || !Number.isFinite( lo ) || !Number.isFinite( hi ) ) {
		return VERDICTS.INCONCLUSIVE;
	}
	if ( lo > 1.0 ) {
		return ( S >= 1.0+BAND ) ? VERDICTS.FASTER : VERDICTS.FASTER_MARGIN;
	}
	if ( lo >= 1.0-BAND && hi <= 1.0+BAND ) {
		return VERDICTS.EQUIVALENT;
	}
	if ( hi < 1.0 && S <= 1.0-BAND ) {
		return VERDICTS.SLOWER;
	}
	return VERDICTS.INCONCLUSIVE;
}


// INTERVALS //

/**
* Returns a percentile interval of bootstrap replicates.
*
* @param {Collection} reps - replicates
* @param {number} [level=0.95] - confidence level
* @returns {Array<number>} `[lo, hi]`
*/
function percentileCI( reps, level ) {
	var a = ( 1.0 - ( level || LEVEL ) ) / 2.0;
	var s = sorted( reps );
	return [ quantileSorted( s, a ), quantileSorted( s, 1.0-a ) ];
}

/**
* Returns a t-interval on log ratios, back-transformed (df = r − 1).
*
* @param {Collection} ratios - per-block ratios
* @param {number} [level=0.95] - confidence level
* @returns {Object} `{ lo, hi, gm, df }` (NaN bounds when r < 2)
*/
function tIntervalLog( ratios, level ) {
	var logs = [];
	var half;
	var m;
	var s;
	var i;
	for ( i = 0; i < ratios.length; i++ ) {
		logs.push( Math.log( ratios[ i ] ) );
	}
	m = mean( logs );
	if ( logs.length < 2 ) {
		return { 'lo': NaN, 'hi': NaN, 'gm': Math.exp( m ), 'df': 0 };
	}
	s = sd( logs );
	half = tQuantile( 1.0 - ( ( 1.0-( level || LEVEL ) ) / 2.0 ), logs.length-1 ) * s / Math.sqrt( logs.length );
	return { 'lo': Math.exp( m-half ), 'hi': Math.exp( m+half ), 'gm': Math.exp( m ), 'df': logs.length-1 };
}

/**
* Returns the median of `vals` at the resampled indices (insertion sort into `buf`; r is small).
*
* @param {Collection} vals - values
* @param {Collection} idx - indices into `vals`
* @param {PositiveInteger} n - number of indices
* @param {Float64Array} buf - scratch buffer of length ≥ n
* @returns {number} median
*/
function medianAt( vals, idx, n, buf ) {
	var v;
	var i;
	var j;
	for ( i = 0; i < n; i++ ) {
		v = vals[ idx[ i ] ];
		j = i - 1;
		while ( j >= 0 && buf[ j ] > v ) {
			buf[ j+1 ] = buf[ j ];
			j -= 1;
		}
		buf[ j+1 ] = v;
	}
	return ( n % 2 ) ? buf[ ( n-1 ) / 2 ] : 0.5 * ( buf[ ( n/2 )-1 ] + buf[ n/2 ] );
}

/**
* Compares block ids (numeric when both are numbers).
*
* @private
*/
function cmpId( a, b ) {
	if ( typeof a === 'number' && typeof b === 'number' ) {
		return a - b;
	}
	a = String( a );
	b = String( b );
	return ( a < b ) ? -1 : ( ( a > b ) ? 1 : 0 );
}

/**
* Returns the block ids common to two maps, sorted.
*
* @param {Map} a - block id → value
* @param {Map} b - block id → value
* @returns {Array} ids
*/
function commonBlocks( a, b ) {
	var out = [];
	a.forEach( function each( v, k ) {
		if ( b.has( k ) && Number.isFinite( v ) && Number.isFinite( b.get( k ) ) ) {
			out.push( k );
		}
	});
	return out.sort( cmpId );
}

/**
* Ratio of cell medians paired within blocks, with its 95% CI.
*
* With r > `lowRepMax` paired blocks: block bootstrap (blocks resampled with replacement, both cells move together;
* percentile CI). Otherwise: per-block ratios and a t-interval on their logs, labelled low replication.
*
* @param {Map} num - numerator cell: block id → process median (e.g., A0 for a speedup)
* @param {Map} den - denominator cell: block id → process median
* @param {Object} [opts] - `{ B, seed, level, lowRepMax, keepReps }`
* @returns {Object} estimate, CI, method, seed and per-block ratios
*/
function pairedRatio( num, den, opts ) {
	var blocks = commonBlocks( num, den );
	var reps;
	var out;
	var idx;
	var bx;
	var by;
	var ti;
	var r = blocks.length;
	var x = new Float64Array( r );
	var y = new Float64Array( r );
	var b;
	var j;
	var g;

	opts = opts || {};
	out = {
		'pairing': 'paired', 'r': r, 'blocks': blocks, 'est': NaN, 'lo': NaN, 'hi': NaN, 'method': 'none',
		'low_replication': false, 'B': 0, 'seed': null, 'level': opts.level || LEVEL, 'block_ratios': [], 'gm': NaN
	};
	if ( r === 0 ) {
		return out;
	}
	for ( j = 0; j < r; j++ ) {
		x[ j ] = num.get( blocks[ j ] );
		y[ j ] = den.get( blocks[ j ] );
		out.block_ratios.push( x[ j ] / y[ j ] );
	}
	out.est = median( x ) / median( y );
	if ( r <= ( ( opts.lowRepMax === void 0 ) ? LOW_REP_MAX : opts.lowRepMax ) ) {
		ti = tIntervalLog( out.block_ratios, out.level );
		out.lo = ti.lo;
		out.hi = ti.hi;
		out.gm = ti.gm;
		out.method = 't-log (df=' + ti.df + ')';
		out.low_replication = true;
		return out;
	}
	out.B = opts.B || B_DEFAULT;
	out.seed = opts.seed || prng.DEFAULT_SEED;
	g = prng.createRng( out.seed );
	reps = new Float64Array( out.B );
	idx = new Int32Array( r );
	bx = new Float64Array( r );
	by = new Float64Array( r );
	for ( b = 0; b < out.B; b++ ) {
		for ( j = 0; j < r; j++ ) {
			idx[ j ] = g.randint( r );
		}
		reps[ b ] = medianAt( x, idx, r, bx ) / medianAt( y, idx, r, by );
	}
	ti = percentileCI( reps, out.level );
	out.lo = ti[ 0 ];
	out.hi = ti[ 1 ];
	out.gm = tIntervalLog( out.block_ratios ).gm;
	out.method = 'block-bootstrap';
	if ( opts.keepReps ) {
		out.reps = reps;
	}
	return out;
}

/**
* Ratio of medians of two unpaired samples (fallback when the reference was not run in the same blocks): independent
* bootstrap, or a Welch t-interval on log values when either side has ≤ `lowRepMax` processes.
*
* @param {Collection} num - numerator process medians
* @param {Collection} den - denominator process medians
* @param {Object} [opts] - `{ B, seed, level, lowRepMax }`
* @returns {Object} estimate and CI (`pairing: 'unpaired'`)
*/
function unpairedRatio( num, den, opts ) {
	var x = sorted( num );
	var y = sorted( den );
	var reps;
	var out;
	var idx;
	var bx;
	var by;
	var lx;
	var ly;
	var v1;
	var v2;
	var se;
	var df;
	var q;
	var g;
	var b;
	var j;

	opts = opts || {};
	out = {
		'pairing': 'unpaired', 'r': Math.min( x.length, y.length ), 'est': median( x ) / median( y ), 'lo': NaN,
		'hi': NaN, 'method': 'none', 'low_replication': false, 'B': 0, 'seed': null, 'level': opts.level || LEVEL,
		'block_ratios': []
	};
	if ( x.length === 0 || y.length === 0 ) {
		return out;
	}
	if ( Math.min( x.length, y.length ) <= ( ( opts.lowRepMax === void 0 ) ? LOW_REP_MAX : opts.lowRepMax ) ) {
		out.low_replication = true;
		out.method = 'welch-t-log';
		if ( x.length < 2 || y.length < 2 ) {
			return out;
		}
		lx = Array.prototype.map.call( x, Math.log );
		ly = Array.prototype.map.call( y, Math.log );
		v1 = Math.pow( sd( lx ), 2 ) / lx.length;
		v2 = Math.pow( sd( ly ), 2 ) / ly.length;
		se = Math.sqrt( v1 + v2 );
		df = ( se > 0 ) ? Math.pow( v1+v2, 2 ) / ( ( v1*v1/( lx.length-1 ) ) + ( v2*v2/( ly.length-1 ) ) ) : 1;
		q = tQuantile( 1.0 - ( ( 1.0-out.level ) / 2.0 ), df ) * se;
		out.lo = Math.exp( mean( lx ) - mean( ly ) - q );
		out.hi = Math.exp( mean( lx ) - mean( ly ) + q );
		return out;
	}
	out.B = opts.B || B_DEFAULT;
	out.seed = opts.seed || prng.DEFAULT_SEED;
	out.method = 'bootstrap (independent)';
	g = prng.createRng( out.seed );
	reps = new Float64Array( out.B );
	bx = new Float64Array( x.length );
	by = new Float64Array( y.length );
	idx = new Int32Array( Math.max( x.length, y.length ) );
	for ( b = 0; b < out.B; b++ ) {
		for ( j = 0; j < x.length; j++ ) {
			idx[ j ] = g.randint( x.length );
		}
		reps[ b ] = medianAt( x, idx, x.length, bx );
		for ( j = 0; j < y.length; j++ ) {
			idx[ j ] = g.randint( y.length );
		}
		reps[ b ] /= medianAt( y, idx, y.length, by );
	}
	q = percentileCI( reps, out.level );
	out.lo = q[ 0 ];
	out.hi = q[ 1 ];
	return out;
}


// LADDER //

/**
* Returns the ceiling (8/7)^L of the 7-vs-8-product ratio at L levels.
*
* @param {NonNegativeInteger} L - recursion levels
* @returns {number} ceiling
*/
function ladderCeiling( L ) {
	return Math.pow( 8.0/7.0, L );
}

/**
* Computes the attribution-ladder terms at one size (E3): ratios of cell medians paired by block, with CIs. The
* arithmetic terms (time ratio C2/A2 = speedup of A2 over C2) carry `confounded = est ≥ (8/7)^L` (`CONFOUNDED_RULE`).
*
* @param {Function} get - `get(alg, ldPad)` returning `{ id, byBlock: Map }` or null when the cell was not run
* @param {NonNegativeInteger} L - recursion levels of A2 (and C2) at this size
* @param {Object} [opts] - `{ B, seedFor(name), level, lowRepMax }`
* @returns {Object} `{ L, ceiling, rule, terms }`
*/
function ladder( get, L, opts ) {
	var ceiling = ladderCeiling( L );
	var terms = [];
	var num;
	var den;
	var res;
	var t;
	var i;

	opts = opts || {};
	for ( i = 0; i < LADDER_TERMS.length; i++ ) {
		t = LADDER_TERMS[ i ];
		num = get( t.num[ 0 ], t.num[ 1 ] );
		den = get( t.den[ 0 ], t.den[ 1 ] );
		if ( !num || !den ) {
			continue;
		}
		res = pairedRatio( num.byBlock, den.byBlock, {
			'B': opts.B,
			'seed': ( opts.seedFor ) ? opts.seedFor( t.name ) : void 0,
			'level': opts.level,
			'lowRepMax': opts.lowRepMax
		});
		res.name = t.name;
		res.label = t.label;
		res.num = num.id;
		res.den = den.id;
		if ( t.ceiling ) {
			// res.est = median time of C2 / median time of A2 (num C2, den A2): the speedup of A2 over C2.
			res.ceiling = ceiling;
			res.ceiling_ratio = res.est / ceiling;
			res.confounded = res.est >= ceiling;
			res.rule = CONFOUNDED_RULE;
		}
		delete res.blocks;
		terms.push( res );
	}
	return { 'L': L, 'ceiling': ceiling, 'rule': CONFOUNDED_RULE, 'terms': terms };
}


// EXPORTS //

module.exports = {
	'B_DEFAULT': B_DEFAULT,
	'LEVEL': LEVEL,
	'LOW_REP_MAX': LOW_REP_MAX,
	'BAND': BAND,
	'VERDICTS': VERDICTS,
	'LADDER_TERMS': LADDER_TERMS,
	'CONFOUNDED_RULE': CONFOUNDED_RULE,
	'sorted': sorted,
	'quantile': desc.quantile,
	'quantileSorted': quantileSorted,
	'median': median,
	'mean': mean,
	'sd': sd,
	'describe': desc.describe,
	'theilSen': desc.theilSen,
	'steadyClass': desc.steadyClass,
	'verdict': verdict,
	'percentileCI': percentileCI,
	'tIntervalLog': tIntervalLog,
	'commonBlocks': commonBlocks,
	'medianAt': medianAt,
	'pairedRatio': pairedRatio,
	'unpairedRatio': unpairedRatio,
	'ladderCeiling': ladderCeiling,
	'ladder': ladder,
	'positionEffect': positionEffect
};
