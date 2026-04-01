/**
 * Configuration constants for the DNS Monitor worker.
 */

export const BASE_CONFIG = {
	// Base DoH endpoint
	baseEndpoint: 'https://dns2.hapara.fail/dns-query',

	// Failure tolerance:
	// 2 = Lenient (1–2 fails = UP/Degraded, 3+ fails = DOWN)
	failureTolerance: 2,

	// Timeout for each DNS request (ms)
	timeoutMs: 5000,

	// Retries per domain
	retries: 2,

	// Max concurrent DNS checks (prevents thundering herd)
	concurrency: 4,

	// Base delay between retries (ms), multiplied by attempt number
	retryBaseDelayMs: 500,
};

export const TARGETS_RESOLVE = ['google.com', 'amazon.com', 'meta.com', 'wikipedia.org', 'chatgpt.com'];

export const TARGETS_BLOCK = ['hapara.com', 'goguardian.com', 'securly.com', 'lightspeedsystems.com', 'blocksi.net'];

export const DO_CONFIG = {
	DROPLET_ID: '56229414',
};

/**
 * Allowed CORS origins. Set to ['*'] to allow all, or specify exact origins.
 * Update these to match your actual frontend domain(s).
 */
export const ALLOWED_ORIGINS = [
	'https://www.hapara.fail',
	'https://support.hapara.fail',
];
