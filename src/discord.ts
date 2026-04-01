/**
 * Discord webhook notification logic.
 */
import type { MonitorResult } from './types';

export async function sendDiscordAlert(webhookUrl: string, data: MonitorResult, status: 'DOWN' | 'RESTORED' | 'RESTART', contentMessage?: string) {
	let color = 5763719; // Green
	let title = '🟢 DNS Monitor: Service RESTORED';
	let desc = 'All DNS checks are passing. Service is back online.';

	if (status === 'DOWN') {
		color = 15548997; // Red
		title = '🔴 DNS Monitor Alert: Service DOWN';
		desc = 'The DNS filtering service is failing multiple checks.';
	} else if (status === 'RESTART') {
		color = 15105570; // Orange
		title = '🟠 DNS Monitor Alert: Service Restarting';
		desc = 'A server reset has been initiated.';
	}

	const fields: Array<{ name: string; value: string; inline: boolean }> = [
		{
			name: 'Status',
			value: `**${status}** (Failures: ${data.summary.failed}/${data.summary.total})`,
			inline: true,
		},
		{
			name: 'Endpoint',
			value: `\`${data.summary.endpoint_used}\``,
			inline: true,
		},
	];

	if (status === 'DOWN') {
		const failedList = data.failures
			.map((f) => `**${f.domain}** (${f.type.toUpperCase()}): ${f.error}`)
			.join('\n')
			.substring(0, 1000);

		fields.push({ name: 'Failures', value: failedList, inline: false });

		fields.push({
			name: 'Quick Actions',
			value: `[🔄 Reset Server](https://monitor.dns2.hapara.fail/reset) • [⚡ Better Stack](https://uptime.betterstack.com/team/t321848/incidents) • [☁️ Open DigitalOcean](https://cloud.digitalocean.com/droplets/56229414)`,
			inline: false,
		});
	}

	const embed = {
		title,
		description: desc,
		color,
		fields,
		footer: { text: `Timestamp: ${data.timestamp}` },
	};

	const payload: Record<string, unknown> = { embeds: [embed] };
	if (contentMessage) {
		payload.content = contentMessage;
	}

	const res = await fetch(webhookUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});
	if (!res.ok) {
		const body = await res.text();
		console.error(`Discord alert webhook failed (${res.status}):`, body);
	}
}

export async function sendResetNotification(webhookUrl: string, email: string, reason: string, ip: string) {
	const embed = {
		title: '⚠️ Server Reset Initiated',
		description: `A reset request was sent to the DNS server instance.`,
		color: 16776960, // Yellow
		fields: [
			{ name: 'User', value: email || 'Unknown', inline: true },
			{ name: 'IP Address', value: ip || 'Unknown', inline: true },
			{ name: 'Reason', value: reason || 'No reason provided', inline: false },
			{ name: 'Target', value: `DO Droplet (56229414)`, inline: false },
		],
		footer: { text: `Timestamp: ${new Date().toISOString()}` },
	};

	const res = await fetch(webhookUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ embeds: [embed] }),
	});
	if (!res.ok) {
		const body = await res.text();
		console.error(`Discord reset webhook failed (${res.status}):`, body);
	}
}
