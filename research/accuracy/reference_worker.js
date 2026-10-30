'use strict';

// Worker thread entry for the parallel reference product: computes a contiguous block of rows into shared memory.

// MODULES //

var parentPort = require( 'worker_threads' ).parentPort;
var rows = require( './reference.js' ).rows;


// MAIN //

parentPort.on( 'message', function onMessage( msg ) {
	var b = msg.bufs;
	var P;
	try {
		P = {
			'M': msg.M,
			'N': msg.N,
			'K': msg.K,
			'A': new Float64Array( b.A ),
			'Ah': new Float64Array( b.Ah ),
			'Al': new Float64Array( b.Al ),
			'Bt': new Float64Array( b.Bt ),
			'Bh': new Float64Array( b.Bh ),
			'Bl': new Float64Array( b.Bl )
		};
		rows( P, msg.r0, msg.r1, new Float64Array( b.hi ), new Float64Array( b.lo ) );
		parentPort.postMessage({
			'id': msg.id
		});
	} catch ( err ) {
		parentPort.postMessage({
			'id': msg.id,
			'error': String( err && err.stack || err )
		});
	}
});
