'use strict';

// Keep exact engine amounts and errors at the portable boundary. The engine
// owns validation, payment journaling, retry budgets and commitment admission.
function sendRoutes({ node, channelsWithFunding, failure }) {
	return {
		'GET /channels': () => channelsWithFunding(node.listChannels()),
		'GET /liquidity': () => node.getLiquiditySnapshot(),
		'GET /payments': () => node.listPayments(),
		'GET /payment': (body, query) => {
			const paymentHash = query.get('paymentHash') || body.paymentHash;
			if (!paymentHash) failure('INVALID_PARAMS', 'paymentHash required');
			const payment = node.getPayment(paymentHash);
			if (!payment) failure('NOT_FOUND', 'Payment not found', 404);
			return payment;
		},
		'POST /channel/splice-quote': (body) =>
			node.spliceQuote(body.channelId, body.direction, body.feeratePerkw, body.address),
		'POST /channel/close-quote': (body) => {
			if (!body.channelId) failure('INVALID_PARAMS', 'channelId required');
			return node.closeQuote(body.channelId, body.address, body.acceptStaleStateRisk === true);
		},
		'POST /channel/close': (body) => {
			if (!body.channelId) failure('INVALID_PARAMS', 'channelId required');
			return node.closeChannel(body.channelId, body.acceptStaleStateRisk === true, body.address);
		},
		'POST /tx/sweep/prepare': (body) => node.prepareOnchainSweep({
			requestId: body.requestId, address: body.address, satsPerVbyte: body.satsPerVbyte,
			inputOutpoints: body.inputOutpoints, debitSats: body.debitSats, maxFeeSats: body.maxFeeSats
		}),
		'POST /tx/sweep/submit': (body) => node.submitOnchainSweep(body.requestId),
		'POST /tx/sweep/cancel': (body) => node.cancelOnchainSweep(body.requestId),
		'GET /tx/sweep': (_body, query) => {
			const sweep = node.getOnchainSweep(query.get('requestId'));
			if (!sweep) failure('NOT_FOUND', 'On-chain sweep not found', 404);
			return sweep;
		},
		'POST /tx/quote': (body) => node.quoteOnchain({
			address: body.address, amountSats: body.amountSats, satsPerVbyte: body.satsPerVbyte,
			max: body.max, channelFunding: body.channelFunding
		}),
		// A channel send pays an address out of one channel or several channels
		// in one transaction (coreyphillips/beignet#1922). The engine decides
		// which, prices it, counts it once against the spend limits and keeps
		// the composite record; refusals are its BeignetErrors.
		'POST /channel-send/quote': (body) => {
			if (!body.address || body.amountSats === undefined || body.feeratePerkw === undefined)
				failure('INVALID_PARAMS', 'address, amountSats and feeratePerkw required');
			return node.quoteChannelSend(body.address, body.amountSats, body.feeratePerkw);
		},
		'POST /channel-send/execute': (body) => {
			if (!body.quoteId) failure('INVALID_PARAMS', 'quoteId required');
			return node.executeChannelSend(body.quoteId);
		},
		'GET /channel-send/status': (body, query) => {
			const id = query.get('id') || body.id;
			if (!id) failure('INVALID_PARAMS', 'id required');
			const status = node.getChannelSend(id);
			if (!status) failure('NOT_FOUND', 'Channel send not found', 404);
			return status;
		},
		'GET /channel-send/list': () => node.listChannelSends(),
		'POST /channel-send/abort': (body) => {
			if (!body.id) failure('INVALID_PARAMS', 'id required');
			return node.abortChannelSend(body.id, body.reason);
		},
		'POST /invoice/pay-all/quote': (body) => {
			if (typeof body.bolt11 !== 'string' || !body.bolt11 || body.maxFeeMsat === undefined)
				failure('INVALID_PARAMS', 'bolt11 and maxFeeMsat required');
			return node.quotePayAll(body.bolt11, body.maxFeeMsat);
		},
		'POST /invoice/pay-all': (body) => {
			if (typeof body.bolt11 !== 'string' || !body.bolt11 ||
				body.debitMsat === undefined || body.maxFeeMsat === undefined)
				failure('INVALID_PARAMS', 'bolt11, debitMsat and maxFeeMsat required');
			return node.payInvoiceAll(body.bolt11, body.debitMsat, body.maxFeeMsat, body.timeoutMs);
		}
	};
}

module.exports = { sendRoutes };
