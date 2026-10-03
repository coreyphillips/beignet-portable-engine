'use strict';
// Isolated portable receiver process with durable SQL.js storage and real relay transport.
const {
	createPortableRuntime,
	createRelaySocketFactory
} = require('../dist/portable.cjs');
const { createSqlJsDatabaseFactory } = require('../dist/sqljs.cjs');
const { makeVolume } = require('./regtest-harness.cjs');
let runtime;
process.on('message', async ({ id, operation, body }) => {
	try {
		let value;
		if (operation === 'start') {
			const volume = makeVolume(body.directory);
			const databaseFactory = await createSqlJsDatabaseFactory({
				load: volume.read,
				save: volume.write
			});
			runtime = await createPortableRuntime({
				volume,
				databaseFactory,
				electrum: body.electrum,
				socketFactory: createRelaySocketFactory({
					...body.transport,
					WebSocket: require('ws')
				})
			});
			value = { pid: process.pid };
		} else if (operation === 'close') {
			await runtime.close();
			value = true;
		} else value = await runtime.request(body);
		process.send({ id, value });
	} catch (error) {
		process.send({
			id,
			error: { message: error.message, code: error.code, status: error.status }
		});
	}
});
