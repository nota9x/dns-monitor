/**
 * Minimal GCP OAuth2 token generator using Web Crypto API.
 * Converts a Service Account JSON key into a short-lived access token.
 */

function str2ab(str: string) {
	const buf = new ArrayBuffer(str.length);
	const bufView = new Uint8Array(buf);
	for (let i = 0, strLen = str.length; i < strLen; i++) {
		bufView[i] = str.charCodeAt(i);
	}
	return buf;
}

function base64UrlEncode(buffer: ArrayBuffer | Uint8Array | string): string {
	let uint8Array: Uint8Array;
	if (typeof buffer === 'string') {
		const encoder = new TextEncoder();
		uint8Array = encoder.encode(buffer);
	} else if (buffer instanceof ArrayBuffer) {
		uint8Array = new Uint8Array(buffer);
	} else {
		uint8Array = buffer;
	}

	let binary = '';
	for (let i = 0; i < uint8Array.byteLength; i++) {
		binary += String.fromCharCode(uint8Array[i]);
	}
	const base64 = btoa(binary);
	return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getJwt(saKeyJson: string): Promise<string> {
	const creds = JSON.parse(saKeyJson);
	const header = { alg: 'RS256', typ: 'JWT' };
	const iat = Math.floor(Date.now() / 1000);
	const exp = iat + 3600;
	const payload = {
		iss: creds.client_email,
		sub: creds.client_email,
		aud: 'https://oauth2.googleapis.com/token',
		iat,
		exp,
		scope: 'https://www.googleapis.com/auth/compute',
	};

	const encodedHeader = base64UrlEncode(JSON.stringify(header));
	const encodedPayload = base64UrlEncode(JSON.stringify(payload));
	const signingInput = `${encodedHeader}.${encodedPayload}`;

	// Extract base64 from PEM
	const pemHeader = '-----BEGIN PRIVATE KEY-----';
	const pemFooter = '-----END PRIVATE KEY-----';
	const pemContents = creds.private_key
		.substring(creds.private_key.indexOf(pemHeader) + pemHeader.length, creds.private_key.indexOf(pemFooter))
		.replace(/\s/g, '');

	const binaryDerString = atob(pemContents);
	const binaryDer = str2ab(binaryDerString);

	const key = await crypto.subtle.importKey(
		'pkcs8',
		binaryDer,
		{
			name: 'RSASSA-PKCS1-v1_5',
			hash: 'SHA-256',
		},
		false,
		['sign'],
	);

	const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));

	const encodedSignature = base64UrlEncode(signature);
	return `${signingInput}.${encodedSignature}`;
}

/**
 * Exchanges a GCP Service Account JSON key for an OAuth2 Access Token.
 */
export async function getGcpAccessToken(saKeyJson: string): Promise<string> {
	const jwt = await getJwt(saKeyJson);

	const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({
			grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
			assertion: jwt,
		}).toString(),
	});

	if (!tokenResponse.ok) {
		const text = await tokenResponse.text();
		throw new Error(`Failed to get GCP access token: ${text}`);
	}

	const data = (await tokenResponse.json()) as any;
	return data.access_token;
}
