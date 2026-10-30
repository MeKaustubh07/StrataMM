'use strict';

/*
* Environment and provenance (protocol §2 and §10) for the `campaign` record (`env`, `provenance` fields).
*
*   node research/harness/env.js [--repo <root>] [--no-strict]   → one JSON line {env, provenance}
*
* Run as a separate process, `provenance` hashes exactly the @stdlib files a timing child loads (algorithms.js + the
* library); required in-process, it hashes whatever that process has loaded. macOS tools are called by absolute path;
* a probe that fails yields `null` (never throws), except the provenance assertions in strict mode.
*/

/* eslint-disable max-len, no-sync */

// MODULES //

var execFileSync = require( 'child_process' ).execFileSync;
var crypto = require( 'crypto' );
var path = require( 'path' );
var fs = require( 'fs' );
var os = require( 'os' );


// VARIABLES //

var DEFAULT_REPO_ROOT = path.resolve( __dirname, '..', '..' );
var JXA = 'ObjC.import("Foundation"); var p = $.NSProcessInfo.processInfo; JSON.stringify({"thermal_state": Number(p.thermalState), "low_power_mode": Boolean(p.isLowPowerModeEnabled)});';
var STDLIB_RE = /[\\/]node_modules[\\/]@stdlib[\\/]/;
var NPM_PKG_RE = /^(.*[\\/]node_modules[\\/]@stdlib[\\/][^\\/]+)[\\/]/;
var V8_FLAGS = [ 'maglev', 'sparkplug', 'turbofan', 'concurrent-recompilation', 'concurrent-sparkplug', 'expose-gc' ];


// FUNCTIONS //

// Runs a command and returns its stdout (null on failure).
function run( cmd, args ) {
	try {
		return execFileSync( cmd, args, { 'encoding': 'utf8', 'stdio': [ 'ignore', 'pipe', 'ignore' ], 'timeout': 15000 } );
	} catch ( err ) { // eslint-disable-line no-unused-vars
		return null;
	}
}

// Returns the trimmed value of a sysctl (null on failure).
function sysctl( name ) {
	var out = run( '/usr/sbin/sysctl', [ '-n', name ] );
	return ( out === null ) ? null : out.trim();
}

// Parses a number (null when not numeric).
function num( s ) {
	var v = ( s === null || s === void 0 ) ? NaN : parseFloat( s );
	return ( v === v ) ? v : null; // eslint-disable-line no-self-compare
}

// Hex SHA-256 of a buffer or string.
function sha256( data ) {
	return crypto.createHash( 'sha256' ).update( data ).digest( 'hex' );
}

// SHA-256 of a {key: sha} map (sorted `key\0sha\n` lines).
function digestMap( map ) {
	return sha256( Object.keys( map ).sort().map( function line( k ) {
		return k + '\0' + map[ k ] + '\n';
	}).join( '' ) );
}

// Path relative to root, with forward slashes.
function rel( root, p ) {
	return path.relative( root, p ).split( path.sep ).join( '/' );
}

// Tests whether `p` lies strictly inside `root`.
function isInside( root, p ) {
	return ( typeof p === 'string' && p.indexOf( root + path.sep ) === 0 );
}

/**
* Returns static machine information (sysctl, sw_vers).
*
* @returns {Object} machine description
*/
function machine() {
	return {
		'model': sysctl( 'hw.model' ),
		'cpu': sysctl( 'machdep.cpu.brand_string' ),
		'perf_cores': num( sysctl( 'hw.perflevel0.physicalcpu' ) ),
		'efficiency_cores': num( sysctl( 'hw.perflevel1.physicalcpu' ) ),
		'logical_cpus': os.cpus().length,
		'memory_bytes': num( sysctl( 'hw.memsize' ) ),
		'page_size': num( sysctl( 'hw.pagesize' ) ),
		'cacheline_bytes': num( sysctl( 'hw.cachelinesize' ) ),
		'perf_l1d_bytes': num( sysctl( 'hw.perflevel0.l1dcachesize' ) ),
		'perf_l2_bytes': num( sysctl( 'hw.perflevel0.l2cachesize' ) ),
		'eff_l1d_bytes': num( sysctl( 'hw.perflevel1.l1dcachesize' ) ),
		'eff_l2_bytes': num( sysctl( 'hw.perflevel1.l2cachesize' ) ),
		'os_name': ( run( '/usr/bin/sw_vers', [ '-productName' ] ) || '' ).trim() || null,
		'os_version': ( run( '/usr/bin/sw_vers', [ '-productVersion' ] ) || '' ).trim() || null,
		'os_build': ( run( '/usr/bin/sw_vers', [ '-buildVersion' ] ) || '' ).trim() || null,
		'kernel': os.release(),
		'platform': process.platform,
		'arch': process.arch
	};
}

// Defaults of selected V8 flags as printed by `node --v8-options` (e.g. `--no-maglev`).
function v8FlagDefaults() {
	var out = run( process.execPath, [ '--v8-options' ] );
	var res = {};
	V8_FLAGS.forEach( function each( name ) {
		var re = new RegExp( '^\\s*--' + name + ' \\(.*\\)\\s*\\n\\s*type: \\S+\\s+default: (.*)$', 'm' );
		var m = ( out ) ? re.exec( out ) : null;
		res[ name ] = ( m ) ? m[ 1 ].trim() : null;
	});
	return res;
}

/**
* Returns runtime information (Node/V8 versions, flags, `process.config` V8 build options).
*
* @returns {Object} runtime description
*/
function runtime() {
	var vars = ( process.config && process.config.variables ) || {};
	var v8cfg = {};
	Object.keys( vars ).sort().forEach( function each( k ) {
		if ( k.indexOf( 'v8_' ) === 0 ) {
			v8cfg[ k ] = vars[ k ];
		}
	});
	return {
		'node': process.version,
		'v8': process.versions.v8,
		'versions': Object.assign( {}, process.versions ),
		'exec_path': process.execPath,
		'exec_argv': process.execArgv,
		'node_options': process.env.NODE_OPTIONS || '',
		'v8_config': v8cfg,
		'v8_flag_defaults': v8FlagDefaults()
	};
}

/**
* Measures `process.hrtime.bigint` overhead and tick (back-to-back calls).
*
* @param {PositiveInteger} [n=200000] - number of calls
* @returns {Object} `{calls, hrtime_bigint_overhead_ns, min_positive_tick_ns, frac_zero_deltas}`
*/
function timer( n ) {
	var minPos, zeros, t0, t1, a, d, i; // eslint-disable-line one-var

	n = n || 200000;
	a = new Array( n );
	t0 = process.hrtime.bigint();
	for ( i = 0; i < n; i++ ) {
		a[ i ] = process.hrtime.bigint();
	}
	t1 = process.hrtime.bigint();
	zeros = 0;
	minPos = Infinity;
	for ( i = 1; i < n; i++ ) {
		d = Number( a[ i ] - a[ i-1 ] );
		if ( d === 0 ) {
			zeros += 1;
		} else if ( d < minPos ) {
			minPos = d;
		}
	}
	return {
		'calls': n,
		'hrtime_bigint_overhead_ns': Number( t1 - t0 ) / n,
		'min_positive_tick_ns': ( minPos === Infinity ) ? null : minPos,
		'frac_zero_deltas': zeros / ( n-1 )
	};
}

/**
* Returns `NSProcessInfo.thermalState` (0 nominal … 3 critical) and `isLowPowerModeEnabled` via JXA.
*
* @returns {Object} `{thermal_state, low_power_mode}` (`null` fields on failure)
*/
function thermal() {
	var out = run( '/usr/bin/osascript', [ '-l', 'JavaScript', '-e', JXA ] );
	var res;
	try {
		res = JSON.parse( out );
	} catch ( err ) { // eslint-disable-line no-unused-vars
		res = {};
	}
	return {
		'thermal_state': num( res.thermal_state ),
		'low_power_mode': ( typeof res.low_power_mode === 'boolean' ) ? res.low_power_mode : null
	};
}

/**
* Returns the power source and battery state (`pmset -g batt`) and the `pmset` low-power-mode setting.
*
* @returns {Object} `{source, battery_pct, battery_state, low_power_mode_pmset}`
*/
function power() {
	var batt = run( '/usr/bin/pmset', [ '-g', 'batt' ] ) || '';
	var all = run( '/usr/bin/pmset', [ '-g' ] ) || '';
	var src = /drawing from '([^']+)'/.exec( batt );
	var pct = /(\d+)%;\s*([^;]+);/.exec( batt );
	var lpm = /lowpowermode\s+(\d+)/i.exec( all );
	return {
		'source': ( src ) ? src[ 1 ] : null,
		'battery_pct': ( pct ) ? num( pct[ 1 ] ) : null,
		'battery_state': ( pct ) ? pct[ 2 ].trim() : null,
		'low_power_mode_pmset': ( lpm ) ? num( lpm[ 1 ] ) : null
	};
}

/**
* Returns memory state: swap used (MB), `kern.memorystatus_vm_pressure_level` (1 normal, 2 warn, 4 critical) and the cumulative `vm_stat` swapouts.
*
* @returns {Object} `{swap_used_mb, pressure_level, swapouts}`
*/
function memoryState() {
	var swap = /used\s*=\s*([\d.]+)M/.exec( sysctl( 'vm.swapusage' ) || '' );
	var vm = /Swapouts:\s+(\d+)/.exec( run( '/usr/bin/vm_stat', [] ) || '' );
	return {
		'swap_used_mb': ( swap ) ? num( swap[ 1 ] ) : null,
		'pressure_level': num( sysctl( 'kern.memorystatus_vm_pressure_level' ) ),
		'swapouts': ( vm ) ? num( vm[ 1 ] ) : null
	};
}

/**
* Returns the processes with the highest CPU usage (`ps -r`), command basenames only.
*
* @param {PositiveInteger} [limit=8] - number of processes
* @returns {ObjectArray} `[{pid, pcpu, comm}]`
*/
function topCpu( limit ) {
	var out = run( '/bin/ps', [ '-Ao', 'pcpu=,pid=,comm=', '-r' ] ) || '';
	var res = [];
	out.split( '\n' ).forEach( function each( line ) {
		var m = /^\s*([\d.]+)\s+(\d+)\s+(.*)$/.exec( line );
		if ( m && res.length < ( limit || 8 ) ) {
			res.push({
				'pid': num( m[ 2 ] ),
				'pcpu': num( m[ 1 ] ),
				'comm': path.basename( m[ 3 ].trim() )
			});
		}
	});
	return res;
}

/**
* Returns a snapshot of the dynamic machine state (power, Low Power Mode, thermal state, load, swap, pressure, top CPU).
*
* @returns {Object} snapshot
*/
function snapshot() {
	var th = thermal();
	var pw = power();
	var mem = memoryState();
	return {
		't_wall': new Date().toISOString(),
		'power': pw.source,
		'battery_pct': pw.battery_pct,
		'battery_state': pw.battery_state,
		'low_power_mode': th.low_power_mode,
		'low_power_mode_pmset': pw.low_power_mode_pmset,
		'thermal_state': th.thermal_state,
		'load_avg': os.loadavg(),
		'swap_used_mb': mem.swap_used_mb,
		'pressure_level': mem.pressure_level,
		'swapouts': mem.swapouts,
		'top_cpu': topCpu( 8 )
	};
}

/**
* Returns the git commit, branch and dirty flag of the repository (`research/data/` excluded from the dirty check).
*
* @param {string} root - repository root
* @returns {Object} `{commit, branch, dirty, dirty_count, dirty_paths}`
*/
function git( root ) {
	var commit = run( 'git', [ '-C', root, 'rev-parse', 'HEAD' ] );
	var branch = run( 'git', [ '-C', root, 'rev-parse', '--abbrev-ref', 'HEAD' ] );
	var status = run( 'git', [ '-C', root, 'status', '--porcelain', '--', '.', ':(exclude)research/data' ] );
	var lines = ( status ) ? status.replace( /\n+$/, '' ).split( '\n' ) : [];
	return {
		'commit': ( commit ) ? commit.trim() : null,
		'branch': ( branch ) ? branch.trim() : null,
		'dirty': ( status === null ) ? null : ( lines.length > 0 ),
		'dirty_count': lines.length,
		'dirty_paths': lines.slice( 0, 50 )
	};
}

// SHA-256 of every regular file in a directory (non-recursive), keyed by name.
function hashDir( dir ) {
	var out = {};
	fs.readdirSync( dir ).sort().forEach( function each( name ) {
		var p = path.join( dir, name );
		if ( fs.statSync( p ).isFile() ) {
			out[ name ] = sha256( fs.readFileSync( p ) );
		}
	});
	return out;
}

// Tests whether a loaded stdlib package resolved to pure JS (index.js exports main.js; native.js not loaded).
function isPureJS( indexFile ) {
	var dir;
	if ( !indexFile || !require.cache[ indexFile ] ) {
		return false;
	}
	dir = path.dirname( indexFile );
	return ( require( indexFile ) === require( path.join( dir, 'main.js' ) ) && !require.cache[ path.join( dir, 'native.js' ) ] );
}

/**
* Returns provenance (protocol §10): git state, library and harness source hashes, versions and resolved paths of the loaded @stdlib packages, SHA-256 of every loaded @stdlib file, and the assertions (paths inside the repository, one dgemm module, pure-JS dgemm/ddot, no native addons).
*
* @param {string} [repoRoot] - repository root
* @param {Object} [opts] - options
* @param {boolean} [opts.strict=true] - throw when an assertion fails
* @throws {Error} assertion failure (strict mode)
* @returns {Object} provenance
*/
function provenance( repoRoot, opts ) {
	var algorithms = require( './algorithms.js' );
	var assertions, packages, resolved, hashes, stdlib, cache, root, lib, out, ok, k; // eslint-disable-line one-var

	root = fs.realpathSync( path.resolve( repoRoot || DEFAULT_REPO_ROOT ) );
	lib = algorithms.library( root );
	cache = Object.keys( require.cache );
	stdlib = cache.filter( function filter( f ) {
		return STDLIB_RE.test( f );
	}).sort();
	hashes = {};
	packages = {};
	stdlib.forEach( function each( f ) {
		var m = NPM_PKG_RE.exec( f );
		var pkg;
		var key;
		hashes[ rel( root, f ) ] = sha256( fs.readFileSync( f ) );
		key = ( m ) ? rel( root, m[ 1 ] ) : null;
		if ( key && !packages[ key ] ) {
			try {
				pkg = JSON.parse( fs.readFileSync( path.join( m[ 1 ], 'package.json' ), 'utf8' ) );
			} catch ( err ) { // eslint-disable-line no-unused-vars
				pkg = {}; // e.g., the library mirror under lib/node_modules (no package.json)
			}
			packages[ key ] = { 'name': pkg.name || null, 'version': pkg.version || null, 'files': 0 };
		}
		if ( key ) {
			packages[ key ].files += 1;
		}
	});
	resolved = {
		'dgemmsw/lib/base.js': lib.files.base,
		'dgemmsw/lib/workspace_length.js': lib.files.workspaceLength,
		'dgemmsw/lib/depth.js': lib.files.depth,
		'@stdlib/blas/base/dgemm (harness)': require.resolve( '@stdlib/blas/base/dgemm' ),
		'@stdlib/blas/base/dgemm (dgemmsw)': lib.dgemmPath,
		'@stdlib/random/base/uniform (harness)': require.resolve( '@stdlib/random/base/uniform' )
	};
	assertions = {
		'resolved_inside_repo': Object.keys( resolved ).every( function check( key ) {
			return isInside( root, resolved[ key ] );
		}) && stdlib.every( function check( f ) {
			return isInside( root, f );
		}),
		'same_dgemm_module': ( resolved[ '@stdlib/blas/base/dgemm (harness)' ] === lib.dgemmPath ),
		'dgemm_pure_js': isPureJS( lib.dgemmPath ),
		'ddot_pure_js': isPureJS( stdlib.filter( function filter( f ) {
			return /[\\/]blas[\\/]base[\\/]ddot[\\/]lib[\\/]index\.js$/.test( f );
		})[ 0 ] || null ),
		'no_native_addons': cache.every( function check( f ) {
			return !/\.node$/.test( f );
		})
	};
	ok = true;
	for ( k in assertions ) {
		if ( assertions[ k ] !== true ) {
			ok = false;
		}
	}
	for ( k in resolved ) {
		if ( isInside( root, resolved[ k ] ) ) {
			resolved[ k ] = rel( root, resolved[ k ] );
		}
	}
	if ( !ok && !( opts && opts.strict === false ) ) {
		throw new Error( 'provenance assertion failed: ' + JSON.stringify( assertions ) );
	}
	out = {
		'repo_root': root,
		'git': git( root ),
		'library': { 'dir': rel( root, lib.dir ), 'files': hashDir( lib.dir ), 'digest': null },
		'harness': { 'files': {}, 'digest': null },
		'stdlib': { 'count': stdlib.length, 'digest': digestMap( hashes ), 'packages': packages, 'files': hashes },
		'resolved': resolved,
		'assertions': assertions,
		'ok': ok
	};
	out.library.digest = digestMap( out.library.files );
	[ '', 'controls' ].forEach( function each( sub ) { // the harness sources (this directory and controls/)
		var map = hashDir( path.join( __dirname, sub ) );
		Object.keys( map ).forEach( function add( name ) {
			out.harness.files[ rel( root, path.join( __dirname, sub, name ) ) ] = map[ name ];
		});
	});
	out.harness.digest = digestMap( out.harness.files );
	return out;
}

/**
* Collects the `env` and `provenance` fields of the `campaign` record.
*
* @param {string} [repoRoot] - repository root
* @param {Object} [opts] - options (`strict`, `timerCalls`)
* @returns {Object} `{env: {machine, runtime, timer, snapshot}, provenance}`
*/
function collect( repoRoot, opts ) {
	opts = opts || {};
	return {
		'env': {
			'machine': machine(),
			'runtime': runtime(),
			'timer': timer( opts.timerCalls ),
			'snapshot': snapshot()
		},
		'provenance': provenance( repoRoot, opts )
	};
}

// Writes a string synchronously and completely to a file descriptor.
function writeAll( fd, str ) {
	var buf = Buffer.from( str, 'utf8' );
	var off = 0;
	while ( off < buf.length ) {
		try {
			off += fs.writeSync( fd, buf, off, buf.length - off );
		} catch ( err ) {
			if ( err.code !== 'EAGAIN' ) {
				throw err;
			}
		}
	}
}

// Command-line entry point.
function main( argv ) {
	var strict = true;
	var root = DEFAULT_REPO_ROOT;
	var i;
	try {
		for ( i = 2; i < argv.length; i++ ) {
			if ( argv[ i ] === '--no-strict' ) {
				strict = false;
			} else if ( argv[ i ] === '--repo' && argv[ i+1 ] ) {
				i += 1;
				root = path.resolve( argv[ i ] );
			} else {
				throw new Error( 'usage: node research/harness/env.js [--repo <root>] [--no-strict]' );
			}
		}
		writeAll( 1, JSON.stringify( collect( root, {
			'strict': strict
		}) ) + '\n' );
	} catch ( err ) {
		writeAll( 2, 'env: ' + err.message + '\n' );
		process.exitCode = 1;
	}
}


// EXPORTS //

module.exports = {
	'collect': collect,
	'git': git,
	'machine': machine,
	'memoryState': memoryState,
	'power': power,
	'provenance': provenance,
	'runtime': runtime,
	'snapshot': snapshot,
	'thermal': thermal,
	'timer': timer,
	'topCpu': topCpu
};

if ( require.main === module ) {
	main( process.argv );
}
