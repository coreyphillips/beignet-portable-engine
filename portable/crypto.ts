import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha1 } from '@noble/hashes/sha1';
import { hmac } from '@noble/hashes/hmac';
import { hkdf } from '@noble/hashes/hkdf';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { gcm } from '@noble/ciphers/aes';
import { chacha20, chacha20poly1305 } from '@noble/ciphers/chacha';
const hashes: any = { sha256, sha512, ripemd160, rmd160: ripemd160, sha1 };
const bytes = (value: any, encoding?: any) =>
	Buffer.isBuffer(value) ? value : Buffer.from(value, encoding);
const hash = (name: string) => {
	if (!hashes[name]) throw new Error(`Unsupported hash: ${name}`);
	return hashes[name];
};
export function createHash(name: string) {
	const h = hash(name).create();
	const result = {
		update(data: any, encoding?: any) {
			h.update(bytes(data, encoding));
			return result;
		},
		digest(encoding?: any) {
			const v = Buffer.from(h.digest());
			return encoding ? v.toString(encoding) : v;
		}
	};
	return result;
}
export function createHmac(name: string, key: any) {
	const h = hmac.create(hash(name), bytes(key));
	const result = {
		update(data: any, encoding?: any) {
			h.update(bytes(data, encoding));
			return result;
		},
		digest(encoding?: any) {
			const v = Buffer.from(h.digest());
			return encoding ? v.toString(encoding) : v;
		}
	};
	return result;
}
export function randomBytes(length: number) {
	const out = Buffer.alloc(length);
	if (!globalThis.crypto?.getRandomValues)
		throw new Error('A secure getRandomValues implementation is required');
	for (let i = 0; i < length; i += 65536)
		globalThis.crypto.getRandomValues(
			out.subarray(i, Math.min(i + 65536, length))
		);
	return out;
}
export function timingSafeEqual(a: Uint8Array, b: Uint8Array) {
	if (a.length !== b.length) throw new RangeError('Length mismatch');
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}
export function hkdfSync(
	name: string,
	ikm: any,
	salt: any,
	info: any,
	length: number
) {
	return Buffer.from(
		hkdf(hash(name), bytes(ikm), bytes(salt), bytes(info), length)
	);
}
export function pbkdf2Sync(
	password: any,
	salt: any,
	iterations: number,
	length: number,
	digest: string
) {
	return Buffer.from(
		pbkdf2(hash(digest), bytes(password), bytes(salt), {
			c: iterations,
			dkLen: length
		})
	);
}
function cipher(name: string, key: any, iv: any, decrypt: boolean) {
	let aad = Buffer.alloc(0),
		tag: Buffer | undefined,
		used = false;
	const chunks: Buffer[] = [];
	const result = {
		setAAD(value: any) {
			aad = bytes(value);
			return result;
		},
		setAuthTag(value: any) {
			tag = bytes(value);
			return result;
		},
		update(value: any, encoding?: any) {
			if (used) throw new Error('Cipher already finalized');
			const data = bytes(value, encoding);
			if (name === 'chacha20') {
				if (decrypt) throw new Error('Use ChaCha20 stream encryption');
				if (iv.length !== 16) throw new Error('Invalid chacha20 IV');
				used = true;
				return Buffer.from(
					chacha20(
						key,
						iv.subarray(4),
						data,
						undefined,
						bytes(iv).readUInt32LE(0)
					)
				);
			}
			chunks.push(data);
			return Buffer.alloc(0);
		},
		final() {
			if (used) throw new Error('Cipher already finalized');
			used = true;
			const impl =
				name === 'aes-256-gcm'
					? gcm(key, iv, aad)
					: name === 'chacha20-poly1305'
					? chacha20poly1305(key, iv, aad)
					: null;
			if (!impl) throw new Error(`Unsupported cipher ${name}`);
			const data = Buffer.concat(chunks);
			if (decrypt) {
				if (!tag || tag.length !== 16)
					throw new Error('Missing authentication tag');
				try {
					return Buffer.from(impl.decrypt(Buffer.concat([data, tag])));
				} catch (error: any) {
					// Which frame failed is the whole diagnosis of a transport
					// desync, and the cipher library says only "invalid tag".
					throw Object.assign(
						new Error(
							`${error?.message ?? 'decrypt failed'} (${name}, ${data.length} bytes, aad ${aad.length})`
						),
						{ cause: error }
					);
				}
			}
			const sealed = Buffer.from(impl.encrypt(data));
			tag = sealed.subarray(-16);
			return sealed.subarray(0, -16);
		},
		getAuthTag() {
			if (!used || !tag) throw new Error('Cipher not finalized');
			return tag;
		}
	};
	return result;
}
export const createCipheriv = (name: string, key: any, iv: any) =>
	cipher(name, key, iv, false);
export const createDecipheriv = (name: string, key: any, iv: any) =>
	cipher(name, key, iv, true);
// Upstream's optional OpenSSL fast path catches this and uses audited JS secp256k1.
export function createPublicKey() {
	throw new Error('Use pure JavaScript secp256k1 verification');
}
export function verify() {
	throw new Error('Use pure JavaScript secp256k1 verification');
}
export default {
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
	hkdfSync,
	pbkdf2Sync,
	createCipheriv,
	createDecipheriv,
	createPublicKey,
	verify
};
