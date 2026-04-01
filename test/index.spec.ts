import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDnsQuery, parseDnsResponse, checkDomainWithRetry, promisePool } from '../src/dns';
import { escapeHtml } from '../src/reset';

// --- createDnsQuery ---

describe('createDnsQuery', () => {
	it('produces a valid DNS wire-format query for a simple domain', () => {
		const packet = createDnsQuery('example.com');

		// DNS header is 12 bytes
		expect(packet.length).toBeGreaterThanOrEqual(12);

		const view = new DataView(packet.buffer);
		// Flags: 0x0100 (standard query, RD=1)
		expect(view.getUint16(2)).toBe(0x0100);
		// QDCOUNT: 1
		expect(view.getUint16(4)).toBe(1);

		// Check question section starts at offset 12
		// First label: "example" (length 7)
		expect(packet[12]).toBe(7);
		// Second label: "com" (length 3)
		expect(packet[12 + 7 + 1]).toBe(3);
	});

	it('handles multi-level domains', () => {
		const packet = createDnsQuery('sub.example.com');
		// Should have 3 labels: sub(3) + example(7) + com(3)
		expect(packet[12]).toBe(3); // "sub"
	});
});

// --- parseDnsResponse ---

describe('parseDnsResponse', () => {
	it('returns empty array for too-short buffer', () => {
		const buffer = new ArrayBuffer(5);
		expect(parseDnsResponse(buffer)).toEqual([]);
	});

	it('returns empty array for response with zero answers', () => {
		// Minimal valid DNS header with ANCOUNT=0
		const buffer = new ArrayBuffer(12);
		const view = new DataView(buffer);
		view.setUint16(6, 0); // ANCOUNT = 0
		expect(parseDnsResponse(buffer)).toEqual([]);
	});

	it('parses a real A record response', () => {
		// Manually construct a DNS response with one A record for "example.com" -> 93.184.216.34
		const response = new Uint8Array([
			// Header (12 bytes)
			0x00, 0x00, // ID
			0x81, 0x80, // Flags: response, recursion available
			0x00, 0x01, // QDCOUNT: 1
			0x00, 0x01, // ANCOUNT: 1
			0x00, 0x00, // NSCOUNT: 0
			0x00, 0x00, // ARCOUNT: 0
			// Question: example.com A IN
			0x07, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, // "example"
			0x03, 0x63, 0x6f, 0x6d, // "com"
			0x00, // root
			0x00, 0x01, // QTYPE: A
			0x00, 0x01, // QCLASS: IN
			// Answer: compressed name pointer, A record
			0xc0, 0x0c, // Name: pointer to offset 12
			0x00, 0x01, // TYPE: A
			0x00, 0x01, // CLASS: IN
			0x00, 0x00, 0x00, 0x3c, // TTL: 60
			0x00, 0x04, // RDLENGTH: 4
			0x5d, 0xb8, 0xd8, 0x22, // RDATA: 93.184.216.34
		]);

		const ips = parseDnsResponse(response.buffer);
		expect(ips).toEqual(['93.184.216.34']);
	});

	it('handles malformed answer sections gracefully', () => {
		// Header says 1 answer but buffer is truncated
		const buffer = new ArrayBuffer(20);
		const view = new DataView(buffer);
		view.setUint16(6, 1); // ANCOUNT = 1
		// Rest is zeros — parser should not crash
		expect(() => parseDnsResponse(buffer)).not.toThrow();
	});
});

// --- escapeHtml ---

describe('escapeHtml', () => {
	it('escapes all dangerous characters', () => {
		expect(escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
	});

	it('escapes ampersands and single quotes', () => {
		expect(escapeHtml("a & b 'c'")).toBe("a &amp; b &#039;c&#039;");
	});

	it('returns empty string for empty input', () => {
		expect(escapeHtml('')).toBe('');
	});
});

// --- promisePool ---

describe('promisePool', () => {
	it('runs all tasks and returns results in order', async () => {
		const tasks = [() => Promise.resolve('a'), () => Promise.resolve('b'), () => Promise.resolve('c')];

		const results = await promisePool(tasks, 2);
		expect(results).toEqual(['a', 'b', 'c']);
	});

	it('respects concurrency limit', async () => {
		let activeConcurrency = 0;
		let maxConcurrency = 0;

		const makeTask = (id: number) => async () => {
			activeConcurrency++;
			maxConcurrency = Math.max(maxConcurrency, activeConcurrency);
			// Simulate async work
			await new Promise((r) => setTimeout(r, 50));
			activeConcurrency--;
			return id;
		};

		const tasks = [makeTask(1), makeTask(2), makeTask(3), makeTask(4), makeTask(5)];
		const results = await promisePool(tasks, 2);

		expect(results).toEqual([1, 2, 3, 4, 5]);
		expect(maxConcurrency).toBeLessThanOrEqual(2);
	});

	it('handles empty task list', async () => {
		const results = await promisePool([], 4);
		expect(results).toEqual([]);
	});
});

// --- checkDomainWithRetry ---

describe('checkDomainWithRetry', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('returns success on first try when domain resolves', async () => {
		// Build a valid DNS response with 1 A record (93.184.216.34)
		const dnsResponse = new Uint8Array([
			0x00, 0x00, 0x81, 0x80, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
			0x07, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, 0x03, 0x63, 0x6f, 0x6d,
			0x00, 0x00, 0x01, 0x00, 0x01,
			0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x3c, 0x00, 0x04,
			0x5d, 0xb8, 0xd8, 0x22,
		]);

		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(dnsResponse.buffer, {
				status: 200,
				headers: { 'Content-Type': 'application/dns-message' },
			}),
		);

		const resultPromise = checkDomainWithRetry('example.com', 'resolve', 'https://dns.test/dns-query');
		vi.runAllTimers();
		const result = await resultPromise;

		expect(result.success).toBe(true);
		expect(result.domain).toBe('example.com');
		expect(result.type).toBe('resolve');
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it('retries on failure and returns last result after exhausting retries', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(null, { status: 500 }),
		);

		const resultPromise = checkDomainWithRetry('fail.com', 'resolve', 'https://dns.test/dns-query');
		// Advance past all retry delays
		await vi.runAllTimersAsync();
		const result = await resultPromise;

		expect(result.success).toBe(false);
		expect(result.details).toContain('HTTP 500');
		// 1 initial + 2 retries = 3 total
		expect(fetchSpy).toHaveBeenCalledTimes(3);
	});

	it('returns on second try if first fails', async () => {
		const dnsResponse = new Uint8Array([
			0x00, 0x00, 0x81, 0x80, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
			0x07, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, 0x03, 0x63, 0x6f, 0x6d,
			0x00, 0x00, 0x01, 0x00, 0x01,
			0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x3c, 0x00, 0x04,
			0x5d, 0xb8, 0xd8, 0x22,
		]);

		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response(null, { status: 500 }))
			.mockResolvedValueOnce(
				new Response(dnsResponse.buffer, {
					status: 200,
					headers: { 'Content-Type': 'application/dns-message' },
				}),
			);

		const resultPromise = checkDomainWithRetry('example.com', 'resolve', 'https://dns.test/dns-query');
		await vi.runAllTimersAsync();
		const result = await resultPromise;

		expect(result.success).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});
});
