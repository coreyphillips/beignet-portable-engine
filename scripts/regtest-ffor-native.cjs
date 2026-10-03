'use strict';
// Build and install Chicory's native-tests/OfflineReceive.tsx on an isolated device first.
process.env.FFOR_RUNTIME_ADAPTER = require('node:path').join(
	__dirname,
	'regtest-ffor-mobile.cjs'
);
require('./regtest-ffor.cjs');
