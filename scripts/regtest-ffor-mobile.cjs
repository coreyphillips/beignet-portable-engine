'use strict';
// Use an isolated simulator or emulator with Chicory's qualification entry installed.
const http = require('node:http');
const { execFileSync } = require('node:child_process');
let run = 0;
exports.start = async ({ h }) => {
	const platform = process.env.FFOR_MOBILE_PLATFORM;
	const device = process.env.FFOR_MOBILE_DEVICE;
	const app = process.env.FFOR_MOBILE_APP;
	if (!['ios', 'android'].includes(platform) || !device || !app)
		throw Error(
			'Set FFOR_MOBILE_PLATFORM, FFOR_MOBILE_DEVICE and FFOR_MOBILE_APP'
		);
	h.primaryUri = `${h.primary.getInfo().nodeId}@127.0.0.1:${h.peerPort}`;
	h.electrum = { host: '127.0.0.1', port: 60001, tls: false };
	const settings = {
		network: 'regtest',
		primaryUri: h.primaryUri,
		electrum: h.electrum,
		transport: 'native',
		relayUrl: '',
		relayToken: ''
	};
	let next = 0,
		readyResolve,
		readyReject,
		waiting;
	const ready = new Promise((resolve, reject) => {
		readyResolve = resolve;
		readyReject = reject;
	});
	const pending = new Map(),
		queue = [];
	const server = http.createServer(async (req, res) => {
		let raw = '';
		for await (const chunk of req) raw += chunk;
		const body = raw ? JSON.parse(raw) : {};
		res.setHeader('Content-Type', 'application/json');
		if (req.url === '/config') return res.end(JSON.stringify({ settings }));
		if (req.url === '/ready') readyResolve(body);
		if (req.url === '/failed') readyReject(Error(body.message));
		if (req.url === '/next') {
			if (queue.length) return res.end(JSON.stringify(queue.shift()));
			waiting = res;
			res.on('close', () => {
				if (waiting === res) waiting = undefined;
			});
			return;
		}
		if (req.url === '/result') {
			const entry = pending.get(body.id);
			pending.delete(body.id);
			if (entry)
				body.error
					? entry.reject(Object.assign(Error(body.error.message), body.error))
					: entry.resolve(body.result);
		}
		res.end('{}');
	});
	await new Promise((resolve) => server.listen(31078, '127.0.0.1', resolve));
	const adb =
		process.env.ADB ||
		`${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
	function execute(action) {
		if (platform === 'ios')
			return execFileSync(
				'xcrun',
				['simctl', action === 'stop' ? 'terminate' : 'launch', device, app],
				{ encoding: 'utf8' }
			).trim();
		if (action === 'stop')
			return execFileSync(
				adb,
				['-s', device, 'shell', 'am', 'force-stop', app],
				{ encoding: 'utf8' }
			).trim();
		for (const port of [31078, 60001, h.peerPort])
			execFileSync(adb, [
				'-s',
				device,
				'reverse',
				`tcp:${port}`,
				`tcp:${port}`
			]);
		return execFileSync(
			adb,
			[
				'-s',
				device,
				'shell',
				'am',
				'start',
				'-W',
				'-n',
				`${app}/com.chicory.MainActivity`
			],
			{ encoding: 'utf8' }
		).trim();
	}
	let launch, native;
	try {
		launch = execute('start');
		native = await Promise.race([
			ready,
			new Promise((_, reject) => {
				const timer = setTimeout(
					() => reject(Error('Native startup timed out')),
					90000
				);
				timer.unref();
			})
		]);
		if (!native.hermes) throw Error('Native qualification requires Hermes');
	} catch (error) {
		try {
			execute('stop');
		} catch {}
		if (waiting) waiting.end('{}');
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		throw error;
	}
	const pid =
		platform === 'android'
			? Number(
					execFileSync(adb, ['-s', device, 'shell', 'pidof', app], {
						encoding: 'utf8'
					}).trim()
			  )
			: Number(launch.split(':').pop().trim());
	const call = (operation, body, args) =>
		new Promise((resolve, reject) => {
			const id = ++next;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(Error(`Native ${operation} timed out`));
			}, 120000);
			pending.set(id, {
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				}
			});
			const command = { id, operation, body, args };
			if (waiting) {
				waiting.end(JSON.stringify(command));
				waiting = undefined;
			} else queue.push(command);
		});
	return {
		request: (body) => call('request', body),
		client: new Proxy(
			{},
			{
				get:
					(_, method) =>
					(...args) =>
						call(method, undefined, args)
			}
		),
		identity: { platform, device, app, pid, launch, run: ++run, ...native },
		stop: async () => {
			execute('stop');
			if (waiting) waiting.end('{}');
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
	};
};
