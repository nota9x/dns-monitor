/**
 * /reset page HTML template and route handlers.
 */
import type { Env, MonitorResult } from './types';
import { sendDiscordAlert, sendResetNotification } from './discord';
import { resetInstance } from './digitalocean';

// --- In-memory rate-limiting (persists within a single isolate's lifetime) ---
let lastResetTime: number | null = null;

// --- Helpers ---

export function escapeHtml(str: string): string {
	if (!str) return '';
	return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function getResetPage(email: string, message: string = ''): string {
	const safeEmail = escapeHtml(email);
	const safeMessage = escapeHtml(message);

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Reset DNS 2 | DNS Manager</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#0f172a;--c:#1e293b;--t:#f8fafc;--t2:#94a3b8;--a:#ef4444;--border:#334155;--accent:#3b82f6}
body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--t);display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.internal-banner{position:absolute;top:0;left:0;width:100%;background:#b91c1c;color:#fff;text-align:center;font-size:0.75rem;font-weight:700;letter-spacing:0.1em;padding:0.25rem 0;z-index:50;}
.box{background:var(--c);padding:2.5rem;border-radius:1rem;width:100%;max-width:400px;border:1px solid var(--border);box-shadow:0 10px 25px -5px rgba(0,0,0,0.5),0 8px 10px -6px rgba(0,0,0,0.1)}
.brand{text-align:center;font-size:0.875rem;color:var(--accent);font-weight:600;letter-spacing:0.05em;text-transform:uppercase;margin-bottom:0.5rem}
h1{margin:0 0 1.5rem;font-size:1.75rem;text-align:center;font-weight:700;letter-spacing:-0.025em}
p{color:var(--t2);font-size:0.95rem;margin-bottom:1.5rem;text-align:center;display:flex;align-items:center;justify-content:center;gap:0.5rem}
input,button{width:100%;padding:0.875rem;border-radius:0.5rem;border:1px solid var(--border);background:var(--bg);color:#fff;box-sizing:border-box;margin-bottom:1rem;display:block;font-family:inherit;font-size:0.95rem}
input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 2px rgba(59,130,246,0.3)}
button{background:var(--a);border:none;font-weight:600;cursor:pointer;color:#fff}
button:hover{opacity:0.9}
.sec{background:var(--accent)}
.msg{padding:0.875rem;border-radius:0.5rem;text-align:center;font-size:0.875rem;margin-top:1rem;font-weight:500}
.success{background:rgba(6,78,59,0.5);color:#34d399;border:1px solid #065f46}
.error{background:rgba(69,10,10,0.5);color:#fca5a5;border:1px solid #7f1d1d}
.u{background:#334155;padding:0.25rem 0.5rem;border-radius:0.375rem;color:#e2e8f0;font-family:monospace;font-size:0.85rem}
.logout{display:block;text-align:center;margin-top:1.5rem;color:var(--t2);text-decoration:none;font-size:0.875rem;transition:color 0.2s}
.logout:hover{color:var(--t)}
</style>
</head>
<body>
<div class="internal-banner">INTERNAL USE ONLY</div>
<div class="box">
<div class="brand">hapara.fail</div>
<h1>DNS 2 Server Reset</h1>
<p>User: <span class="u">${safeEmail}</span></p>
<form method="POST" action="/reset">
<label hidden for="reason">Reason</label>
<input type="text" id="reason" name="reason" placeholder="Reason (Optional)">
<button type="submit" name="action" value="reset">Reset Server</button>
<button type="submit" name="action" value="test_alert" class="sec">Test Alert</button>
</form>
<a href="https://haparafail.cloudflareaccess.com/cdn-cgi/access/logout" class="logout">Logout</a>
${safeMessage ? `<div class="msg ${message.includes('Success') ? 'success' : 'error'}">${safeMessage}</div>` : ''}
</div>
</body>
</html>`;
}

// --- Route Handlers ---

export function handleResetGet(email: string): Response {
	return new Response(getResetPage(email), {
		headers: { 'Content-Type': 'text/html' },
	});
}

export async function handleResetPost(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const email = request.headers.get('Cf-Access-Authenticated-User-Email') || 'unknown@user';

	// CSRF Protection: Strict origin check
	const origin = request.headers.get('Origin');
	const urlObj = new URL(request.url);
	if (!origin || origin !== urlObj.origin) {
		return new Response('Forbidden: Invalid Origin', { status: 403 });
	}

	try {
		const formData = await request.formData();
		const action = formData.get('action') as string;

		// A) RESET ACTION
		if (action === 'reset') {
			// Rate limiting (1 reset / hour)
			if (lastResetTime !== null) {
				const timeSince = Date.now() - lastResetTime;
				if (timeSince < 3600 * 1000) {
					const minsRemaining = Math.ceil((3600 * 1000 - timeSince) / 60000);
					return new Response(getResetPage(email, `Error: Rate limit exceeded. Try again in ${minsRemaining} minutes.`), {
						headers: { 'Content-Type': 'text/html' },
					});
				}
			}

			const reason = (formData.get('reason') as string) || 'No reason provided';

			if (!env.DO_API_TOKEN) {
				return new Response(getResetPage(email, 'Error: System configuration error (Missing DO_API_TOKEN).'), {
					headers: { 'Content-Type': 'text/html' },
				});
			}

			let token: string = env.DO_API_TOKEN;

			const result = await resetInstance(token);
			if (!result.success) {
				return new Response(getResetPage(email, `Error: ${result.error}`), {
					headers: { 'Content-Type': 'text/html' },
				});
			}

			// Update in-memory rate-limit state
			lastResetTime = Date.now();

			// Send Discord notification (fire-and-forget with error handling)
			if (env.DISCORD_WEBHOOK_URL) {
				ctx.waitUntil(
					sendResetNotification(env.DISCORD_WEBHOOK_URL, email, reason, request.headers.get('CF-Connecting-IP') || 'Unknown').catch(
						(err) => console.error('Reset notification error:', err),
					),
				);
			}

			return new Response(getResetPage(email, 'Success: Power cycle command sent to DigitalOcean.'), {
				headers: { 'Content-Type': 'text/html' },
			});
		}

		// B) TEST ALERT ACTION
		if (action === 'test_alert') {
			if (env.DISCORD_WEBHOOK_URL) {
				const mockResult: MonitorResult = {
					status: 'down',
					timestamp: new Date().toISOString(),
					summary: { total: 10, failed: 10, endpoint_used: 'TEST-ENDPOINT', min_latency_ms: 0, avg_latency_ms: 0, p95_latency_ms: 0, max_latency_ms: 0 },
					failures: [{ domain: 'test.example.com', type: 'resolve', error: 'Simulated Failure' }],
				};
				const ip = request.headers.get('CF-Connecting-IP') || 'Unknown IP';
				const alertMessage = `This is a test alert requested by ${email} [${ip}]`;

				const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

				ctx.waitUntil(
					(async () => {
						await sendDiscordAlert(env.DISCORD_WEBHOOK_URL!, mockResult, 'DOWN', alertMessage);
						await wait(2000);
						await sendDiscordAlert(env.DISCORD_WEBHOOK_URL!, mockResult, 'RESTART');
						await wait(2000);
						await sendDiscordAlert(env.DISCORD_WEBHOOK_URL!, { ...mockResult, status: 'up', failures: [] }, 'RESTORED');
					})().catch((err) => console.error('Test alert error:', err)),
				);

				return new Response(getResetPage(email, 'Success: Test alert sequence sent to Discord.'), {
					headers: { 'Content-Type': 'text/html' },
				});
			} else {
				return new Response(getResetPage(email, 'Error: No Discord Webhook configured.'), {
					headers: { 'Content-Type': 'text/html' },
				});
			}
		}

		return new Response(getResetPage(email, 'Error: Invalid action.'), {
			headers: { 'Content-Type': 'text/html' },
		});
	} catch (e) {
		return new Response(getResetPage(email, `Error: ${(e as Error).message}`), {
			headers: { 'Content-Type': 'text/html' },
		});
	}
}
