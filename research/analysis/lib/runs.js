'use strict';

/**
* Campaign runs and provenance (protocol §10; §11 rule 1). A campaign that was stopped and resumed has one `campaign`
* record per run (a resume appends one with `resumed: true` and its own provenance) and one `campaign_end` per stop.
* Every run is reported with its start time, commit, dirty flag and the stop that preceded it; a commit, dirty-flag,
* protocol-hash, machine, OS, Node or V8 change between consecutive runs is flagged; blocks whose processes were
* recorded by different runs are listed (their within-block pairing spans the interruption).
*/


/**
* Finds the project commit and dirty flag in a provenance object.
*
* @param {Object} prov - provenance
* @returns {Object} `{ commit, dirty }`
*/
function findCommit( prov ) {
	var cands;
	var sha;
	var i;
	if ( !prov || typeof prov !== 'object' ) {
		return { 'commit': null, 'dirty': null };
	}
	cands = [ prov, prov.git, prov.project, prov.repo ];
	for ( i = 0; i < cands.length; i++ ) {
		if ( cands[ i ] && typeof cands[ i ] === 'object' ) {
			sha = cands[ i ].commit || cands[ i ].head || cands[ i ].sha;
			if ( typeof sha === 'string' ) {
				return { 'commit': sha, 'dirty': ( cands[ i ].dirty === void 0 ) ? null : cands[ i ].dirty };
			}
		}
	}
	return { 'commit': null, 'dirty': null };
}

/**
* Extracts machine, OS and Node/V8 identifiers from an env record, tolerating several field layouts.
*
* @param {Object} env - env object of the campaign record
* @returns {Object} `{ machine, os, node, v8 }` (null when absent)
*/
function envSummary( env ) {
	var osName = first( [ 'machine.os_name' ] );
	return {
		'machine': first( [ 'machine.model', 'model', 'hw_model', 'machine', 'hardware.model', 'hw.model' ] ),
		'os': ( osName ) ? osName + ' ' + ( first( [ 'machine.os_version' ] ) || '' ) + ( ( first( [ 'machine.os_build' ] ) ) ? ' (' + first( [ 'machine.os_build' ] ) + ')' : '' ) : first( [ 'os', 'os_release', 'macos', 'os.release', 'os.version' ] ),
		'node': first( [ 'runtime.node', 'node', 'node_version', 'versions.node', 'node.version' ] ),
		'v8': first( [ 'runtime.v8', 'v8', 'v8_version', 'versions.v8', 'node.v8' ] )
	};

	function first( paths ) {
		var v;
		var i;
		for ( i = 0; i < paths.length; i++ ) {
			v = paths[ i ].split( '.' ).reduce( function f( o, k ) {
				return ( o && typeof o === 'object' ) ? o[ k ] : void 0;
			}, env || {} );
			if ( typeof v === 'string' || typeof v === 'number' ) {
				return String( v );
			}
		}
		return null;
	}
}

/**
* Returns the 0-based index of the run that recorded a line (the last `campaign` record above it; -1 if none).
*
* @private
* @param {Array<number>} starts - line numbers of the `campaign` records, ascending
* @param {number} line - line number
* @returns {integer} run index
*/
function runIndex( starts, line ) {
	var k = -1;
	var i;
	for ( i = 0; i < starts.length; i++ ) {
		if ( starts[ i ] < line ) {
			k = i;
		}
	}
	return k;
}

/**
* Summarizes a `campaign_end` record.
*
* @private
*/
function endOf( e ) {
	return { 'status': e.status, 'reason': ( e.reason === void 0 ) ? null : e.reason, 'warnings': e.warnings || [], 't_wall': e.t_wall || null, 'src': { 'file': 'campaign.jsonl', 'lines': [ e._line ] } };
}

/**
* Returns a short commit label.
*
* @private
*/
function short( sha ) {
	return ( typeof sha === 'string' ) ? sha.slice( 0, 12 ) : String( sha );
}

/**
* Lists the blocks whose non-sentinel processes were recorded by more than one run.
*
* @private
* @param {Array<Object>} procs - proc records
* @param {Array<number>} starts - line numbers of the `campaign` records
* @returns {Array<Object>} `{ block_id, runs, src }`
*/
function blocksAcrossRuns( procs, starts ) {
	var by = new Map();
	procs.forEach( function each( p ) {
		var run = runIndex( starts, p._line ) + 1;
		var b;
		if ( p.alg === 'SENTINEL' || p.experiment === 'sentinel' || p.block_id === void 0 || p.block_id === null ) {
			return;
		}
		if ( !by.has( String( p.block_id ) ) ) {
			by.set( String( p.block_id ), { 'block_id': p.block_id, 'runs': [], 'ids': [], 'lines': [] } );
		}
		b = by.get( String( p.block_id ) );
		if ( b.runs.indexOf( run ) < 0 ) {
			b.runs.push( run );
		}
		b.ids.push( p.proc_id );
		b.lines.push( p._line );
	});
	return Array.from( by.values() ).filter( function f( b ) {
		return b.runs.length > 1;
	}).map( function each( b ) {
		return { 'block_id': b.block_id, 'runs': b.runs.sort(), 'src': { 'file': 'campaign.jsonl', 'ids': b.ids, 'lines': b.lines } };
	});
}

/**
* Summarizes the runs of a campaign (every `campaign` and `campaign_end` record).
*
* @param {Object} data - loaded campaign (`io.loadCampaign`)
* @returns {Object} `{ n_runs, runs, commits, dirty_any, provenance_changed, changes, final_end, ends, blocks_across_runs }`
*/
function runs( data ) {
	var camps = data.campaigns || ( ( data.campaign ) ? [ data.campaign ] : [] );
	var ends = data.ends || ( ( data.end ) ? [ data.end ] : [] );
	var starts = camps.map( function f( c ) {
		return c._line;
	});
	var changes = [];
	var commits = [];
	var last = ( camps.length ) ? camps[ camps.length-1 ] : null;
	var fin = ( ends.length ) ? ends[ ends.length-1 ] : null;
	var list;
	var i;

	list = camps.map( function each( c, j ) {
		var prov = findCommit( c.provenance );
		var next = ( j+1 < starts.length ) ? starts[ j+1 ] : Infinity;
		var own = ends.filter( function f( e ) {
			return e._line > starts[ j ] && e._line < next;
		});
		if ( prov.commit !== null && commits.indexOf( prov.commit ) < 0 ) {
			commits.push( prov.commit );
		}
		return {
			'run': j+1,
			't_wall': c.t_wall || null,
			'commit': prov.commit,
			'dirty': prov.dirty,
			'resumed': ( typeof c.resumed === 'boolean' ) ? c.resumed : j > 0,
			'start_index': ( c.start_index === void 0 ) ? null : c.start_index,
			'argv': c.argv || null,
			'protocol_sha256': c.protocol_sha256 || null,
			'env': envSummary( c.env ),
			'end': ( own.length ) ? endOf( own[ own.length-1 ] ) : null,
			'preceded_by': null,
			'src': { 'file': 'campaign.jsonl', 'lines': [ c._line ] }
		};
	});
	for ( i = 1; i < list.length; i++ ) {
		list[ i ].preceded_by = list[ i-1 ].end || { 'status': 'no campaign_end', 'reason': 'run ' + i + ' ended without a campaign_end record (killed, crash or power loss)', 'warnings': [], 't_wall': null, 'src': null };
		if ( list[ i ].commit !== list[ i-1 ].commit ) {
			changes.push( 'commit changed between run ' + i + ' (' + short( list[ i-1 ].commit ) + ') and run ' + ( i+1 ) + ' (' + short( list[ i ].commit ) + ')' );
		}
		if ( list[ i ].dirty !== list[ i-1 ].dirty ) {
			changes.push( 'dirty flag changed between run ' + i + ' (' + list[ i-1 ].dirty + ') and run ' + ( i+1 ) + ' (' + list[ i ].dirty + ')' );
		}
		if ( list[ i ].protocol_sha256 !== list[ i-1 ].protocol_sha256 ) {
			changes.push( 'protocol sha256 changed between run ' + i + ' and run ' + ( i+1 ) );
		}
		[ 'machine', 'os', 'node', 'v8' ].forEach( function each( k ) {
			if ( list[ i ].env[ k ] !== list[ i-1 ].env[ k ] ) {
				changes.push( k + ' changed between run ' + i + ' (' + list[ i-1 ].env[ k ] + ') and run ' + ( i+1 ) + ' (' + list[ i ].env[ k ] + ')' );
			}
		});
	}
	return {
		'n_runs': list.length,
		'runs': list,
		'commits': commits,
		'dirty_any': ( list.some( function f( r ) {
			return r.dirty === true;
		}) ) ? true : ( ( list.length && list.every( function f( r ) {
			return r.dirty === false;
		}) ) ? false : null ),
		'provenance_changed': changes.length > 0,
		'changes': changes,
		// The campaign's status is the last run's own campaign_end (an end written before the last run started is not):
		'final_end': ( fin && ( !last || fin._line > last._line ) ) ? endOf( fin ) : null,
		'ends': ends.map( endOf ),
		'blocks_across_runs': blocksAcrossRuns( data.procs || [], starts )
	};
}


// EXPORTS //

module.exports = {
	'findCommit': findCommit,
	'envSummary': envSummary,
	'runIndex': runIndex,
	'runs': runs
};
