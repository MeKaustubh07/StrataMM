'use strict';

/**
* Descriptive statistics for the analysis (quantiles use the linear-interpolation definition, Hyndman–Fan type 7;
* non-numeric and non-finite values are ignored) and the per-process run-sequence classification.
*/

var STEADY_DRIFT = 0.02;
var STEADY_DISPERSION = 0.05;


/**
* Returns the finite values of an array-like object, sorted ascending.
*
* @param {Collection} x - values
* @returns {Float64Array} sorted finite values
*/
function sorted( x ) {
	var out = [];
	var i;
	for ( i = 0; i < x.length; i++ ) {
		if ( typeof x[ i ] === 'number' && Number.isFinite( x[ i ] ) ) {
			out.push( x[ i ] );
		}
	}
	return new Float64Array( out ).sort();
}

/**
* Returns the p-quantile of sorted values (type 7).
*
* @param {Collection} s - sorted values
* @param {number} p - probability in [0,1]
* @returns {number} quantile (NaN if empty)
*/
function quantileSorted( s, p ) {
	var h;
	var j;
	if ( s.length === 0 ) {
		return NaN;
	}
	h = ( s.length-1 ) * p;
	j = Math.floor( h );
	if ( j+1 >= s.length ) {
		return s[ s.length-1 ];
	}
	return s[ j ] + ( ( h-j ) * ( s[ j+1 ]-s[ j ] ) );
}

/**
* Returns the p-quantile (type 7) of the finite values of `x`.
*
* @param {Collection} x - values
* @param {number} p - probability
* @returns {number} quantile
*/
function quantile( x, p ) {
	return quantileSorted( sorted( x ), p );
}

/**
* Returns the median of the finite values of `x`.
*
* @param {Collection} x - values
* @returns {number} median (NaN if empty)
*/
function median( x ) {
	return quantile( x, 0.5 );
}

/**
* Returns the arithmetic mean of the finite values of `x`.
*
* @param {Collection} x - values
* @returns {number} mean
*/
function mean( x ) {
	var s = sorted( x );
	var t = 0.0;
	var i;
	for ( i = 0; i < s.length; i++ ) {
		t += s[ i ];
	}
	return ( s.length ) ? t / s.length : NaN;
}

/**
* Returns the sample standard deviation (n−1) of the finite values of `x`.
*
* @param {Collection} x - values
* @returns {number} standard deviation
*/
function sd( x ) {
	var s = sorted( x );
	var m = mean( s );
	var t = 0.0;
	var i;
	if ( s.length < 2 ) {
		return NaN;
	}
	for ( i = 0; i < s.length; i++ ) {
		t += ( s[ i ]-m ) * ( s[ i ]-m );
	}
	return Math.sqrt( t / ( s.length-1 ) );
}

/**
* Returns descriptive statistics of a set of values.
*
* @param {Collection} x - values
* @returns {Object} `{ n, median, iqr, q1, q3, min, max, mean, p90 }`
*/
function describe( x ) {
	var s = sorted( x );
	var q1 = quantileSorted( s, 0.25 );
	var q3 = quantileSorted( s, 0.75 );
	return {
		'n': s.length,
		'median': quantileSorted( s, 0.5 ),
		'iqr': q3 - q1,
		'q1': q1,
		'q3': q3,
		'min': ( s.length ) ? s[ 0 ] : NaN,
		'max': ( s.length ) ? s[ s.length-1 ] : NaN,
		'mean': mean( s ),
		'p90': quantileSorted( s, 0.9 )
	};
}

/**
* Returns the Theil–Sen slope of `y` against its index.
*
* @param {Collection} y - values in run order
* @returns {number} slope per index step
*/
function theilSen( y ) {
	var slopes = [];
	var i;
	var j;
	for ( i = 0; i < y.length; i++ ) {
		for ( j = i+1; j < y.length; j++ ) {
			slopes.push( ( y[ j ]-y[ i ] ) / ( j-i ) );
		}
	}
	return median( slopes );
}

/**
* Classifies a process's run sequence of per-call times (after Barrett et al. 2017, simplified for k ≤ 30).
*
* -   `short`: fewer than 3 samples (not classifiable);
* -   `no_steady_state`: MAD/median > 5%;
* -   `warmup` / `slowdown`: Theil–Sen drift across the run below −2% / above +2% of the median;
* -   `flat`: otherwise.
*
* @param {Collection} perCall - per-call times in run order
* @returns {Object} `{ class, drift, rel_mad }`
*/
function steadyClass( perCall ) {
	var dev = [];
	var drift;
	var mad;
	var m;
	var i;
	if ( perCall.length < 3 ) {
		return { 'class': 'short', 'drift': NaN, 'rel_mad': NaN };
	}
	m = median( perCall );
	for ( i = 0; i < perCall.length; i++ ) {
		dev.push( Math.abs( perCall[ i ]-m ) );
	}
	mad = median( dev ) / m;
	drift = theilSen( perCall ) * ( perCall.length-1 ) / m;
	if ( mad > STEADY_DISPERSION ) {
		return { 'class': 'no_steady_state', 'drift': drift, 'rel_mad': mad };
	}
	if ( drift < -STEADY_DRIFT ) {
		return { 'class': 'warmup', 'drift': drift, 'rel_mad': mad };
	}
	if ( drift > STEADY_DRIFT ) {
		return { 'class': 'slowdown', 'drift': drift, 'rel_mad': mad };
	}
	return { 'class': 'flat', 'drift': drift, 'rel_mad': mad };
}



// EXPORTS //

module.exports = {
	'STEADY_DRIFT': STEADY_DRIFT,
	'STEADY_DISPERSION': STEADY_DISPERSION,
	'sorted': sorted,
	'quantileSorted': quantileSorted,
	'quantile': quantile,
	'median': median,
	'mean': mean,
	'sd': sd,
	'describe': describe,
	'theilSen': theilSen,
	'steadyClass': steadyClass
};
