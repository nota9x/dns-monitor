/**
 * GCP Compute Engine API interactions.
 */
import { GCP_CONFIG } from './config';

export interface GcpResetResult {
	success: boolean;
	error?: string;
}

/**
 * Sends a reset (hard reboot) command to the configured GCP Compute Engine instance.
 */
export async function resetInstance(token: string): Promise<GcpResetResult> {
	const gcpUrl = `https://compute.googleapis.com/compute/v1/projects/${GCP_CONFIG.PROJECT}/zones/${GCP_CONFIG.ZONE}/instances/${GCP_CONFIG.INSTANCE}/reset`;

	const response = await fetch(gcpUrl, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
	});

	if (!response.ok) {
		const errorText = await response.text();
		console.error('GCP Error:', errorText);
		return { success: false, error: 'Failed to trigger GCP reset. Check logs.' };
	}

	return { success: true };
}
