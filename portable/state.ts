export type Volume = {
	read(path: string): Uint8Array | null;
	write(path: string, bytes: Uint8Array): void;
	remove(path: string): void;
	rename(from: string, to: string): void;
	list?(prefix?: string): string[];
};
export type SocketFactory = (target: {
	host: string;
	port: number;
	tls: boolean;
}) => any;
let current: any;
export function configure(options: any) {
	if (current)
		throw new Error('Only one portable wallet runtime may own this JS realm');
	current = options;
}
export function release() {
	current = undefined;
}
export function environment() {
	if (!current) throw new Error('Portable engine has not been configured');
	return current;
}
