/**
 * DNS Monitor — Cloudflare Worker entrypoint.
 *
 * Slim router that delegates to focused modules:
 * - dns.ts:     DNS wire-format, domain checks, retries, concurrency
 * - discord.ts: Webhook notifications
 * - gcp.ts:     GCP Compute Engine reset
 * - reset.ts:   /reset page & handlers
 * - config.ts:  All constants
 * - types.ts:   Shared interfaces
 */
import { BASE_CONFIG, TARGETS_RESOLVE, TARGETS_BLOCK, ALLOWED_ORIGINS } from './config';
import { checkDomainWithRetry, promisePool } from './dns';
import { sendDiscordAlert } from './discord';
import { handleResetGet, handleResetPost } from './reset';
import type { Env, MonitorResult } from './types';

// NOTE: No in-memory state — isolates are ephemeral. Previous status is
// derived from the cached result, which is shared within a Cloudflare PoP.

// Synthetic URL used as a key for the Cache API
const CACHE_KEY = new Request('https://dns-monitor.internal/latest-check');
const STATE_CACHE_KEY = new Request('https://dns-monitor.internal/discord-state');

// --- Core Check Logic ---

async function performDnsCheck(env: Env, ctx: ExecutionContext, isCron: boolean = false): Promise<MonitorResult> {
	// 1. Build endpoint
	let finalEndpoint = BASE_CONFIG.baseEndpoint;
	if (env.DOH_SECRET_PATH) {
		const secret = env.DOH_SECRET_PATH.split('/').pop() || env.DOH_SECRET_PATH;
		finalEndpoint = `${BASE_CONFIG.baseEndpoint}/${secret}`;
	}

	// 2. Build task list
	const tasks = [
		...TARGETS_RESOLVE.map((d) => () => checkDomainWithRetry(d, 'resolve', finalEndpoint)),
		...TARGETS_BLOCK.map((d) => () => checkDomainWithRetry(d, 'block', finalEndpoint)),
	];

	// 3. Run with concurrency limit
	const results = await promisePool(tasks, BASE_CONFIG.concurrency);

	const failures = results.filter((r) => !r.success);
	const failureCount = failures.length;

	// 4. Compute latency metrics (guard against empty results)
	const durations = results.map((r) => r.duration).sort((a, b) => a - b);
	const avgLatency = durations.length > 0 ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length) : 0;
	const p95Index = durations.length > 0 ? Math.min(Math.ceil(durations.length * 0.95) - 1, durations.length - 1) : 0;

	// 5. Determine health
	const isHealthy = failureCount <= BASE_CONFIG.failureTolerance;
	const currentStatus = isHealthy ? 'UP' : 'DOWN';

	// 6. Mask secret path in endpoint display
	const maskedEndpoint = env.DOH_SECRET_PATH
		? finalEndpoint.replace(env.DOH_SECRET_PATH, '***')
		: finalEndpoint;

	const now = new Date().toISOString();

	const responseBody: MonitorResult = {
		status: isHealthy ? (failureCount > 0 ? 'degraded' : 'up') : 'down',
		timestamp: now,
		summary: {
			total: results.length,
			failed: failureCount,
			endpoint_used: maskedEndpoint,
			min_latency_ms: durations[0] ?? 0,
			avg_latency_ms: avgLatency,
			p95_latency_ms: durations[p95Index] ?? 0,
			max_latency_ms: durations[durations.length - 1] ?? 0,
		},
		failures: failures.map((f) => ({ domain: f.domain, error: f.details, type: f.type })),
	};

	// 7. Smart notification (state-change only, tracked via Cache API)
	// ONLY on cron runs — prevents HTTP bursts from triggering duplicate alerts.
	// Cache API is per-PoP but Smart Placement ensures consistent cron location.
	//
	// State tracks { status, consecutiveDown, alerted }:
	//   - consecutiveDown: how many consecutive DOWN cron results we've seen
	//   - alerted: whether we already sent a DOWN notification for this episode
	//
	// We require 2+ consecutive DOWN before alerting, then set alerted=true
	// to prevent duplicate notifications. On recovery, we send RESTORED only
	// if we previously alerted (or were in a DOWN state).
	if (isCron && env.DISCORD_WEBHOOK_URL) {
		try {
			const prevStateRes = await caches.default.match(STATE_CACHE_KEY);
			let previousStatus: string | null = null;
			let prevConsecutiveDown = 0;
			let prevAlerted = false;

			if (prevStateRes) {
				try {
					const prevData = (await prevStateRes.json()) as {
						status: string;
						consecutiveDown: number;
						alerted?: boolean;
					};
					previousStatus = prevData.status ?? null;
					prevConsecutiveDown = prevData.consecutiveDown ?? 0;
					prevAlerted = prevData.alerted ?? false;
				} catch {
					// Corrupted/legacy state — treat as fresh start
					previousStatus = null;
				}
			}

			const consecutiveDown = currentStatus === 'DOWN' ? prevConsecutiveDown + 1 : 0;
			let alerted = prevAlerted;
			let shouldNotify: 'DOWN' | 'RESTORED' | null = null;

			if (currentStatus === 'DOWN' && consecutiveDown >= 2 && !prevAlerted) {
				// First time hitting the threshold for this outage episode
				shouldNotify = 'DOWN';
				alerted = true;
			} else if (currentStatus === 'UP' && (previousStatus === 'DOWN' || prevAlerted)) {
				// Recovery — notify only if we were in an outage
				shouldNotify = 'RESTORED';
				alerted = false;
			}

			// If we recovered, reset alerted
			if (currentStatus === 'UP') {
				alerted = false;
			}

			// Always write current state to keep TTL fresh (10 min > 5 min cron interval)
			const statePayload = JSON.stringify({ status: currentStatus, consecutiveDown, alerted });
			await caches.default.put(
				STATE_CACHE_KEY,
				new Response(statePayload, {
					headers: { 'Cache-Control': 'max-age=600', 'Content-Type': 'application/json' },
				}),
			);

			console.log(
				`[state] current=${currentStatus} previous=${previousStatus ?? 'null'} consecutiveDown=${consecutiveDown} alerted=${alerted} notify=${shouldNotify ?? 'none'}`,
			);

			if (shouldNotify === 'DOWN') {
				ctx.waitUntil(
					sendDiscordAlert(env.DISCORD_WEBHOOK_URL, responseBody, 'DOWN').catch((err) =>
						console.error('Notification error:', err),
					),
				);
			} else if (shouldNotify === 'RESTORED') {
				ctx.waitUntil(
					sendDiscordAlert(env.DISCORD_WEBHOOK_URL, responseBody, 'RESTORED').catch((err) =>
						console.error('Notification error:', err),
					),
				);
			}
		} catch (err) {
			console.error('State transition error:', err);
		}
	}

	// 8. Cache result via Cache API (free, no KV usage)
	const cacheResponse = new Response(JSON.stringify(responseBody), {
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'max-age=300', // retain for manual freshness logic (STALE window is 60-180s)
		},
	});
	ctx.waitUntil(caches.default.put(CACHE_KEY, cacheResponse));

	return responseBody;
}

// --- CORS ---

function getCorsHeaders(requestOrigin: string | null): Record<string, string> {
	// If the request origin is in our allow-list, reflect it. Otherwise omit.
	if (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) {
		return {
			'Access-Control-Allow-Origin': requestOrigin,
			'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
			Vary: 'Origin',
		};
	}
	return {};
}

// --- Worker Export ---

export default {
	async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		try {
			await performDnsCheck(env, ctx, true);
		} catch (err) {
			console.error('Scheduled check failed:', err);
		}
	},

	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// --- /health (lightweight liveness check) ---
		if (url.pathname === '/health') {
			return new Response(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }), {
				headers: { 'content-type': 'application/json' },
			});
		}

		// --- /reset ---
		if (url.pathname === '/reset') {
			const email = request.headers.get('Cf-Access-Authenticated-User-Email') || 'unknown@user';

			if (request.method === 'GET') return handleResetGet(email);
			if (request.method === 'POST') return handleResetPost(request, env, ctx);
			return new Response('Method Not Allowed', { status: 405 });
		}

		// --- CORS ---
		const requestOrigin = request.headers.get('Origin');
		const corsHeaders = getCorsHeaders(requestOrigin);

		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		// --- Cache / Check ---
		try {
			const pretty = url.searchParams.has('pretty');
			const jsonIndent = pretty ? 2 : undefined;
			let cachedResult: MonitorResult | null = null;
			let cacheStatus = 'MISS';
			let cacheAgeMs = 0;

			// Try cache
			try {
				const cachedResponse = await caches.default.match(CACHE_KEY);
				if (cachedResponse) {
					const cached = (await cachedResponse.json()) as MonitorResult;
					cacheAgeMs = Date.now() - new Date(cached.timestamp).getTime();

					cachedResult = cached;

					if (cacheAgeMs < 60_000) {
						cacheStatus = 'HIT';
					} else if (cacheAgeMs < 180_000) {
						cacheStatus = 'STALE';
					} else {
						cacheStatus = 'EXPIRED';
						cachedResult = null;
					}
				}
			} catch {
				// Cache read failure — proceed as MISS
			}

			// Serve from cache
			if (cachedResult) {
				if (cacheStatus === 'STALE') {
					ctx.waitUntil(performDnsCheck(env, ctx).catch((e) => console.error('Background refresh failed:', e)));
				}

				const isHealthy = cachedResult.status === 'up' || cachedResult.status === 'degraded';
				return new Response(JSON.stringify(cachedResult, null, jsonIndent), {
					status: isHealthy ? 200 : 500,
					headers: {
						'content-type': 'application/json',
						'x-cache': cacheStatus,
						'x-cache-age': Math.floor(cacheAgeMs / 1000) + 's',
						...corsHeaders,
					},
				});
			}

			// Cache miss — blocking check
			const result = await performDnsCheck(env, ctx);
			const isHealthy = result.status === 'up' || result.status === 'degraded';

			return new Response(JSON.stringify(result, null, jsonIndent), {
				status: isHealthy ? 200 : 500,
				headers: {
					'content-type': 'application/json',
					'x-cache': 'MISS',
					...corsHeaders,
				},
			});
		} catch (err) {
			// Top-level safety net — always return valid JSON
			console.error('Monitor endpoint error:', err);
			const errorResult: MonitorResult = {
				status: 'down',
				timestamp: new Date().toISOString(),
				summary: {
					total: 0,
					failed: 0,
					endpoint_used: 'error',
					min_latency_ms: 0,
					avg_latency_ms: 0,
					p95_latency_ms: 0,
					max_latency_ms: 0,
				},
				failures: [{ domain: 'monitor-internal', error: `Worker error: ${(err as Error).message}`, type: 'resolve' }],
			};
			return new Response(JSON.stringify(errorResult), {
				status: 500,
				headers: { 'content-type': 'application/json', ...corsHeaders },
			});
		}
	},
};
