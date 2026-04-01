/**
 * DigitalOcean API interactions.
 */
import { DO_CONFIG } from './config';

export interface DOResetResult {
	success: boolean;
	error?: string;
}

/**
 * Sends a power cycle command to the configured DigitalOcean droplet.
 */
export async function resetInstance(token: string): Promise<DOResetResult> {
	const doUrl = `https://api.digitalocean.com/v2/droplets/${DO_CONFIG.DROPLET_ID}/actions`;

	const response = await fetch(doUrl, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ type: 'power_cycle' })
	});

	if (!response.ok) {
		const errorText = await response.text();
		console.error('DigitalOcean Error:', errorText);
		return { success: false, error: 'Failed to trigger DigitalOcean power_cycle. Check logs.' };
	}

	return { success: true };
}
