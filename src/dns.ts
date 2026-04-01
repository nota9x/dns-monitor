/**
 * DNS wire-format encoding/decoding and domain check logic.
 */
import { BASE_CONFIG } from './config';
import type { CheckResult } from './types';

// --- DNS Wire Format ---

export function createDnsQuery(domain: string): Uint8Array {
	const labels = domain.split('.');
	const length = 12 + labels.reduce((acc, l) => acc + l.length + 1, 0) + 1 + 4;
	const buffer = new Uint8Array(length);
	const view = new DataView(buffer.buffer);

	// Header
	view.setUint16(0, 0); // ID
	view.setUint16(2, 0x0100); // Flags: standard query, recursion desired
	view.setUint16(4, 1); // QDCOUNT

	// Question
	let offset = 12;
	for (const label of labels) {
		buffer[offset] = label.length;
		offset++;
		for (let i = 0; i < label.length; i++) {
			buffer[offset++] = label.charCodeAt(i);
		}
	}
	buffer[offset++] = 0; // Root label
	view.setUint16(offset, 1); // QTYPE: A
	offset += 2;
	view.setUint16(offset, 1); // QCLASS: IN

	return buffer;
}

export function parseDnsResponse(buffer: ArrayBuffer): string[] {
	const view = new DataView(buffer);
	const bytes = new Uint8Array(buffer);
	const ips: string[] = [];

	if (buffer.byteLength < 12) return ips; // Too short for a DNS header

	const anCount = view.getUint16(6);
	let offset = 12;

	// Skip question section
	while (offset < bytes.length && bytes[offset] !== 0) {
		if ((bytes[offset] & 0xc0) === 0xc0) {
			offset += 2;
			break;
		}
		const labelLen = bytes[offset];
		if (offset + labelLen + 1 > bytes.length) return ips; // Bounds check
		offset += labelLen + 1;
	}
	if (offset < bytes.length && bytes[offset] === 0) offset++;
	offset += 4; // QTYPE + QCLASS
	if (offset > bytes.length) return ips; // Bounds check

	// Parse answer section
	for (let i = 0; i < anCount; i++) {
		if (offset >= bytes.length) break;

		// Skip name (may be compressed)
		if ((bytes[offset] & 0xc0) === 0xc0) {
			offset += 2;
		} else {
			while (offset < bytes.length && bytes[offset] !== 0) {
				const labelLen = bytes[offset];
				if (offset + labelLen + 1 > bytes.length) return ips; // Bounds check
				offset += labelLen + 1;
			}
			if (offset < bytes.length) offset++; // Skip root label
		}

		// Need at least 10 bytes for TYPE(2) + CLASS(2) + TTL(4) + RDLENGTH(2)
		if (offset + 10 > bytes.length) break;

		const type = view.getUint16(offset);
		offset += 2;
		offset += 6; // CLASS + TTL
		const rdLength = view.getUint16(offset);
		offset += 2;

		if (offset + rdLength > bytes.length) break; // Bounds check on RDATA

		if (type === 1 && rdLength === 4) {
			const ip = `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
			ips.push(ip);
		}

		offset += rdLength;
	}

	return ips;
}

// --- Domain Checking ---

export async function checkDomain(domain: string, expectedType: 'resolve' | 'block', endpoint: string): Promise<CheckResult> {
	const start = Date.now();
	const dnsPacket = createDnsQuery(domain);

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), BASE_CONFIG.timeoutMs);

	try {
		const response = await fetch(endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/dns-message',
				Accept: 'application/dns-message',
			},
			body: dnsPacket,
			signal: controller.signal,
		});

		clearTimeout(timeoutId);
		const duration = Date.now() - start;

		if (!response.ok) {
			return { domain, success: false, type: expectedType, details: `HTTP ${response.status}`, duration };
		}

		const buffer = await response.arrayBuffer();
		const ips = parseDnsResponse(buffer);

		if (expectedType === 'resolve') {
			if (ips.length === 0) return { domain, success: false, type: 'resolve', details: 'NXDOMAIN', duration };
			if (ips.includes('0.0.0.0')) return { domain, success: false, type: 'resolve', details: 'Blocked (0.0.0.0)', duration };
			return { domain, success: true, type: 'resolve', details: `Resolved: ${ips[0]}`, duration };
		}

		if (expectedType === 'block') {
			const leakedIps = ips.filter((ip) => ip !== '0.0.0.0');
			if (leakedIps.length > 0) {
				return { domain, success: false, type: 'block', details: `LEAK: ${leakedIps.join(', ')}`, duration };
			}
			return { domain, success: true, type: 'block', details: 'Blocked', duration };
		}

		return { domain, success: false, type: expectedType, details: 'Logic Error', duration };
	} catch (err) {
		clearTimeout(timeoutId);
		return { domain, success: false, type: expectedType, details: `Fetch Error: ${(err as Error).message}`, duration: Date.now() - start };
	}
}

/**
 * Retries a domain check on failure with exponential backoff.
 * Unlike the previous version, this actually checks `result.success`
 * instead of relying on thrown exceptions (which `checkDomain` never throws).
 */
export async function checkDomainWithRetry(domain: string, expectedType: 'resolve' | 'block', endpoint: string): Promise<CheckResult> {
	let lastResult: CheckResult | undefined;

	for (let attempt = 0; attempt <= BASE_CONFIG.retries; attempt++) {
		lastResult = await checkDomain(domain, expectedType, endpoint);
		if (lastResult.success) return lastResult;

		// Backoff before next retry (skip delay after last attempt)
		// Jitter (0-200ms) prevents synchronized retry storms when multiple domains fail
		if (attempt < BASE_CONFIG.retries) {
			const jitter = Math.random() * 200;
			await new Promise((r) => setTimeout(r, BASE_CONFIG.retryBaseDelayMs * (attempt + 1) + jitter));
		}
	}

	return lastResult!;
}

// --- Concurrency Limiter ---

/**
 * Runs async tasks with a concurrency limit to prevent thundering-herd.
 */
export async function promisePool<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
	const results: T[] = new Array(tasks.length);
	let nextIndex = 0;

	const runNext = async (): Promise<void> => {
		while (nextIndex < tasks.length) {
			const idx = nextIndex++;
			results[idx] = await tasks[idx]();
		}
	};

	const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => runNext());
	await Promise.all(workers);
	return results;
}
