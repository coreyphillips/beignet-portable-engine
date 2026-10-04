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
