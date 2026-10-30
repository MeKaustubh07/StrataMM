'use strict';

// Filesystem locations used by the accuracy (E6) and correctness (E1) pipelines.

// MODULES //

var path = require( 'path' );


// VARIABLES //

var ROOT = path.resolve( __dirname, '..', '..' );
var PKG_LIB = path.join( ROOT, 'lib', 'node_modules', '@stdlib', 'blas', 'ext', 'base', 'dgemmsw', 'lib' );


// EXPORTS //

module.exports = {
	'ROOT': ROOT,
	'PKG_LIB': PKG_LIB,
	'BASE': path.join( PKG_LIB, 'base.js' ),
	'DEPTH': path.join( PKG_LIB, 'depth.js' ),
	'WORKSPACE_LENGTH': path.join( PKG_LIB, 'workspace_length.js' ),
	'CACHE_REF': path.join( ROOT, 'research', 'cache', 'ref' ),
	'DATA': path.join( ROOT, 'research', 'data' )
};
