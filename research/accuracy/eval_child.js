'use strict';

// E6 evaluation child process (single-threaded): receives shards over IPC from run.js, evaluates them, and sends
// the records back (run.js is the single writer of accuracy.jsonl). Any error is reported as `fatal`.

// MODULES //

var evaluateShard = require( './evaluate.js' );


// MAIN //

process.on( 'message', function onMessage( msg ) {
	var res;
	if ( msg.type === 'exit' ) {
		process.disconnect();
		return;
	}
	if ( msg.type !== 'shard' ) {
		return;
	}
	try {
		res = evaluateShard( msg.shard, msg.opts );
		process.send({
			'type': 'records',
			'key': msg.shard.key,
			'records': res.records,
			'violations': res.violations
		});
	} catch ( err ) {
		process.send({
			'type': 'fatal',
			'key': msg.shard.key,
			'message': String( err && err.message || err ),
			'stack': String( err && err.stack || '' )
		});
	}
});
process.on( 'disconnect', function onDisconnect() {
	process.exit( 0 ); // the parent is gone (stopped or crashed): never linger
});
process.send({
	'type': 'ready'
});
