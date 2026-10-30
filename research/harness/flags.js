'use strict';

/*
* Sample and process flags of the timing child (research-protocol.md §4 "Flags" and §12). Flags never delete data.
*
* -   Sample flags: `gc` (GCProfiler events > 0), `preempt` (cpu/wall < 0.90), `slow_mode` (per-call time > 1.5 ×
*     process median), `tukey3` (outside [Q1 − 3·IQR, Q3 + 3·IQR]).
* -   Process flags: `warmup_suspect` (min/median < 0.98) and `early_slow` (k ≥ 4 and sample 0 / median of samples
*     ⌊k/2⌋…k−1 > 1.05, a slow start that `warmup_suspect` cannot see); the ratio is kept as `first_sample_ratio`.
* -   Provisional exclusion when more than 20% of the samples are flagged `preempt` or `slow_mode` (protocol §4);
*     the orchestrator adds the gate, swap, pressure, thermal and power exclusions.
*/

// VARIABLES //

var PREEMPT_RATIO = 0.90; // cpu/wall below this ⇒ `preempt`
var SLOW_FACTOR = 1.5; // per-call time above this × process median ⇒ `slow_mode`
var TUKEY_FENCE = 3.0; // outside [Q1 − 3·IQR, Q3 + 3·IQR] ⇒ `tukey3`
var WARMUP_SUSPECT_RATIO = 0.98; // min/median below this ⇒ process flag `warmup_suspect`
var EARLY_SLOW_RATIO = 1.05; // sample 0 / median(samples ⌊k/2⌋…k−1) above this ⇒ process flag `early_slow`
var EARLY_SLOW_MIN_K = 4; // `early_slow` needs at least this many samples
var MAX_FLAGGED_FRACTION = 0.20; // > 20% of samples flagged `preempt` or `slow_mode` ⇒ excluded


// FUNCTIONS //

function ascending( a, b ) {
	return a - b;
}

// Returns the per-call times of samples, in the given order.
function perCall( samples ) {
	return samples.map( function get( s ) {
		return s.per_call_ns;
	});
}

/**
* Returns the `p`-quantile of an ascending array (linear interpolation, type 7).
*
* @param {NumericArray} sorted - ascending values
* @param {number} p - probability in [0, 1]
* @returns {number} quantile
*/
function quantile( sorted, p ) {
	var h = ( sorted.length-1 ) * p;
	var lo = Math.floor( h );
	var hi = Math.ceil( h );
	return sorted[ lo ] + ( ( sorted[ hi ] - sorted[ lo ] ) * ( h - lo ) );
}

/**
* Returns the per-call time of sample 0 divided by the median of samples ⌊k/2⌋…k−1 (samples in index order).
*
* @param {ObjectArray} samples - samples (`per_call_ns`), in sample-index order
* @returns {(number|null)} ratio, or null when there are fewer than two samples
*/
function firstSampleRatio( samples ) {
	if ( samples.length < 2 ) {
		return null;
	}
	return samples[ 0 ].per_call_ns / quantile( perCall( samples.slice( Math.floor( samples.length/2 ) ) ).sort( ascending ), 0.5 ); // eslint-disable-line max-len
}

/**
* Flags the samples of a process and summarizes it (protocol §4).
*
* @param {ObjectArray} samples - samples in sample-index order (mutated: `flags` set)
* @returns {Object} `{per_call_median_ns, first_sample_ratio, flags, flag_counts, excluded, exclusion_reason}`
*/
function annotate( samples ) {
	var counts = { 'gc': 0, 'preempt': 0, 'slow_mode': 0, 'tukey3': 0, 'flagged': 0 };
	var sorted, flags, ratio, med, lo, hi, q1, q3, ex; // eslint-disable-line one-var

	sorted = perCall( samples ).sort( ascending );
	med = quantile( sorted, 0.5 );
	q1 = quantile( sorted, 0.25 );
	q3 = quantile( sorted, 0.75 );
	lo = q1 - ( TUKEY_FENCE * ( q3-q1 ) );
	hi = q3 + ( TUKEY_FENCE * ( q3-q1 ) );
	samples.forEach( function flag( s ) {
		var f = [];
		if ( s.gc_n > 0 ) {
			f.push( 'gc' );
		}
		if ( s.cpu_us*1000.0 < PREEMPT_RATIO*s.wall_ns ) {
			f.push( 'preempt' );
		}
		if ( s.per_call_ns > SLOW_FACTOR*med ) {
			f.push( 'slow_mode' );
		}
		if ( s.per_call_ns < lo || s.per_call_ns > hi ) {
			f.push( 'tukey3' );
		}
		f.forEach( function count( name ) {
			counts[ name ] += 1;
		});
		if ( f.indexOf( 'preempt' ) >= 0 || f.indexOf( 'slow_mode' ) >= 0 ) {
			counts.flagged += 1;
		}
		s.flags = f;
	});
	flags = [];
	if ( sorted[ 0 ]/med < WARMUP_SUSPECT_RATIO ) {
		flags.push( 'warmup_suspect' );
	}
	ratio = firstSampleRatio( samples );
	if ( samples.length >= EARLY_SLOW_MIN_K && ratio > EARLY_SLOW_RATIO ) {
		flags.push( 'early_slow' );
	}
	ex = ( counts.flagged/samples.length ) > MAX_FLAGGED_FRACTION;
	return {
		'per_call_median_ns': med,
		'first_sample_ratio': ratio,
		'flags': flags,
		'flag_counts': counts,
		'excluded': ex,
		'exclusion_reason': ( ex ) ? 'flagged_samples_gt_20pct' : null
	};
}


// EXPORTS //

module.exports = {
	'EARLY_SLOW_MIN_K': EARLY_SLOW_MIN_K,
	'EARLY_SLOW_RATIO': EARLY_SLOW_RATIO,
	'annotate': annotate,
	'firstSampleRatio': firstSampleRatio,
	'quantile': quantile
};
