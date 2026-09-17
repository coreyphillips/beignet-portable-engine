import { EventEmitter } from 'events';
const unavailable = () => {
	throw new Error(
		'This server-side service is unavailable in an embedded wallet'
	);
};
export const request = unavailable,
	get = unavailable,
	createServer = unavailable;
export class Server extends EventEmitter {
	listen = unavailable;
	close() {}
}
export const promises = {
	lookup: unavailable,
	resolveSrv: unavailable,
	resolveTxt: unavailable
};
export const resolveSrv = unavailable,
	resolveTxt = unavailable;
export const tmpdir = () => '/tmp',
	homedir = () => '/wallet',
	hostname = () => 'embedded-wallet';
export default {
	request,
	get,
	createServer,
	Server,
	promises,
	resolveSrv,
	resolveTxt,
	tmpdir,
	homedir,
	hostname
};
