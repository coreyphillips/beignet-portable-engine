import { Socket } from './net';
export class TLSSocket extends Socket {
	constructor(...args: any[]) {
		super();
		this.encrypted = true;
	}
}
export function connect(...args: any[]) {
	return new TLSSocket().connect(...args);
}
export default { TLSSocket, connect };
