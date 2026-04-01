/**
 * Shared type definitions for the DNS Monitor worker.
 */

export interface Env {
	DISCORD_WEBHOOK_URL?: string;
	DOH_SECRET_PATH?: string;
	GCP_SA_KEY?: string;
}

export interface CheckResult {
	domain: string;
	success: boolean;
	type: 'resolve' | 'block';
	details: string;
	duration: number;
}

export interface FailureDetail {
	domain: string;
	error: string;
	type: 'resolve' | 'block';
}

export interface MonitorSummary {
	total: number;
	failed: number;
	endpoint_used: string;
	min_latency_ms: number;
	avg_latency_ms: number;
	p95_latency_ms: number;
	max_latency_ms: number;
}

export interface MonitorResult {
	status: 'up' | 'degraded' | 'down';
	timestamp: string;
	summary: MonitorSummary;
	failures: FailureDetail[];
}
