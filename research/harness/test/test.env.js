'use strict';

/*
* Tests for research/harness/env.js: machine/runtime/timer probes, the dynamic snapshot, git state, provenance
* assertions (paths inside the repository, one dgemm module, pure-JS dgemm/ddot, no addons) and the CLI.
*/

// MODULES //

var tape = require( 'tape' );
var path = require( 'path' );
var spawnSync = require( 'child_process' ).spawnSync;
var algorithms = require( './../algorithms.js' );
var env = require( './../env.js' );


// VARIABLES //

var ROOT = algorithms.library().root;
var ENV_JS = path.resolve( __dirname, '..', 'env.js' );


// TESTS //

tape( 'timer, machine and runtime', function test( t ) {
	var tm = env.timer( 5000 );
	var m = env.machine();
	var rt = env.runtime();
	t.ok( tm.calls === 5000 && tm.hrtime_bigint_overhead_ns > 0 && tm.min_positive_tick_ns > 0 && tm.frac_zero_deltas >= 0, 'timer: ' + JSON.stringify( tm ) );
	t.ok( m.logical_cpus > 0 && m.platform === process.platform && m.arch === process.arch, 'machine: ' + m.model + ', ' + m.cpu + ', ' + m.os_name + ' ' + m.os_version );
	if ( process.platform === 'darwin' ) {
		t.ok( typeof m.model === 'string' && m.memory_bytes > 0 && m.perf_cores > 0, 'macOS sysctl values present' );
		t.strictEqual( rt.v8_flag_defaults.maglev, '--no-maglev', 'Maglev disabled by default in this Node build' );
	}
	t.strictEqual( rt.node, process.version, 'node version' );
	t.ok( Object.keys( rt.v8_config ).length > 0 && Object.keys( rt.v8_config ).every( function f( k ) {
		return k.indexOf( 'v8_' ) === 0;
	}), 'process.config v8_* options recorded' );
	t.end();
});

tape( 'snapshot (power, Low Power Mode, thermal state, load, swap, pressure, top CPU)', function test( t ) {
	var s = env.snapshot();
	t.ok( !isNaN( Date.parse( s.t_wall ) ) && s.load_avg.length === 3 && Array.isArray( s.top_cpu ), 'fields present' );
	t.ok( s.thermal_state === null || ( s.thermal_state >= 0 && s.thermal_state <= 3 ), 'thermal_state ' + s.thermal_state );
	t.ok( s.low_power_mode === null || typeof s.low_power_mode === 'boolean', 'low_power_mode ' + s.low_power_mode );
	t.ok( s.pressure_level === null || s.pressure_level >= 0, 'pressure_level ' + s.pressure_level );
	t.comment( JSON.stringify( s ) );
	t.end();
});

tape( 'git: commit and dirty flag (research/data excluded)', function test( t ) {
	var g = env.git( ROOT );
	t.ok( /^[0-9a-f]{40}$/.test( g.commit ), 'commit ' + g.commit );
	t.strictEqual( typeof g.dirty, 'boolean', 'dirty = ' + g.dirty + ' (' + g.dirty_count + ' paths)' );
	t.ok( g.dirty_paths.every( function f( p ) {
		return p.indexOf( 'research/data' ) < 0;
	}), 'research/data never counted' );
	t.end();
});

tape( 'provenance: assertions hold and every loaded @stdlib file is hashed', function test( t ) {
	var p = env.provenance( ROOT );
	var files = Object.keys( p.stdlib.files );
	t.ok( p.ok, 'assertions: ' + JSON.stringify( p.assertions ) );
	t.ok( p.stdlib.count === files.length && files.length > 100, files.length + ' @stdlib files hashed' );
	t.ok( files.every( function f( k ) {
		return k.indexOf( '..' ) !== 0 && /^[0-9a-f]{64}$/.test( p.stdlib.files[ k ] );
	}), 'all inside the repository, SHA-256 hex' );
	t.ok( files.indexOf( 'lib/node_modules/@stdlib/blas/ext/base/dgemmsw/lib/winograd.js' ) >= 0, 'library files loaded by base.js are included' );
	t.strictEqual( p.stdlib.packages[ 'node_modules/@stdlib/blas' ].version, '0.4.1', '@stdlib/blas version' );
	t.strictEqual( p.resolved[ '@stdlib/blas/base/dgemm (dgemmsw)' ], 'node_modules/@stdlib/blas/base/dgemm/lib/index.js', 'dgemm resolved from the package' );
	t.ok( p.library.files[ 'base.js' ] && /^[0-9a-f]{64}$/.test( p.library.digest ), 'package lib files hashed' );
	t.ok( p.harness.files[ 'research/harness/child.js' ] && p.harness.files[ 'research/harness/controls/classic.js' ], 'harness sources hashed' );
	t.end();
});

tape( 'CLI prints {env, provenance} as one JSON line; bad usage exits 1', function test( t ) {
	var res = spawnSync( process.execPath, [ ENV_JS, '--repo', ROOT ], {
		'cwd': '/',
		'env': {
			'PATH': process.env.PATH,
			'HOME': process.env.HOME
		},
		'encoding': 'utf8',
		'timeout': 60000
	});
	var out = JSON.parse( res.stdout );
	t.ok( res.status === 0 && out.env.machine && out.env.runtime && out.env.timer && out.env.snapshot && out.provenance.ok, 'exit 0, provenance ok' );
	t.strictEqual( res.stdout.trim().split( '\n' ).length, 1, 'one line' );
	res = spawnSync( process.execPath, [ ENV_JS, '--bogus' ], {
		'encoding': 'utf8'
	});
	t.ok( res.status === 1 && /usage/.test( res.stderr ), 'usage error' );
	t.end();
});
