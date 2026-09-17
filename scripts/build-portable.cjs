const esbuild = require('esbuild');
const path = require('node:path');
const fs = require('node:fs');
// The portable bundle reports the upstream Beignet release it was cut from.
// Recorded once in package.json so /api/config cannot drift from the source.
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const engineVersion = `${pkg.upstreamVersion}-portable`;
const aliases = {
	crypto: 'crypto',
	fs: 'fs',
	net: 'net',
	tls: 'tls',
	dns: 'unsupported',
	http: 'unsupported',
	https: 'unsupported',
	os: 'unsupported',
	zlib: 'zlib',
	'better-sqlite3': 'sqlite'
};
for (const k in aliases)
	aliases[k] = path.resolve('portable', aliases[k] + '.ts');
aliases.path = require.resolve('path-browserify');
aliases.stream = require.resolve('stream-browserify');
(async () => {
	fs.mkdirSync('dist', { recursive: true });
	for (const format of ['esm', 'cjs'])
		await esbuild
			.build({
				entryPoints: ['portable/runtime.ts'],
				bundle: true,
				platform: 'browser',
				format,
				target: 'es2020',
				outfile: `dist/portable.${format === 'esm' ? 'mjs' : 'cjs'}`,
				alias: aliases,
				inject: ['portable/globals.ts'],
				define: {
					'process.env.NODE_ENV': '"production"',
					__BEIGNET_ENGINE_VERSION__: JSON.stringify(engineVersion)
				},
				metafile: true
			})
			.then((r) =>
				fs.writeFileSync('dist/meta.json', JSON.stringify(r.metafile))
			);
	for (const format of ['esm', 'cjs'])
		await esbuild.build({
			entryPoints: ['portable/sqljs.ts'],
			bundle: true,
			platform: 'browser',
			format,
			target: 'es2020',
			outfile: `dist/sqljs.${format === 'esm' ? 'mjs' : 'cjs'}`,
			external: ['sql.js']
		});
	for (const format of ['cjs'])
		await esbuild.build({
			entryPoints: ['portable/crypto.ts'],
			bundle: true,
			platform: 'browser',
			format,
			target: 'es2020',
			outfile: 'dist/crypto-test.cjs'
		});
	await esbuild.build({
		entryPoints: ['portable/receipts.ts'], bundle: true, platform: 'node',
		format: 'cjs', target: 'es2020', outfile: 'dist/receipts.cjs'
	});
	await esbuild.build({entryPoints:['portable/receive-requests.ts'],bundle:true,platform:'node',format:'cjs',
		target:'es2020',outfile:'dist/receive-requests.cjs'});
})();
