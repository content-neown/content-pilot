// api/text-to-video.js
// Vercel serverless function — wraps Google Veo 2 via Vertex AI
// Required env vars: VEO_PROJECT_ID, VEO_LOCATION (default: us-central1), GOOGLE_SERVICE_ACCOUNT_KEY (JSON string)

export const config = { runtime: 'edge' };

const PROJECT_ID = process.env.VEO_PROJECT_ID;
const LOCATION = process.env.VEO_LOCATION || 'us-central1';
const SA_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY; // JSON string of service account credentials

// Get a Google OAuth2 access token from a service account key
async function getAccessToken() {
  if (!SA_KEY) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY env var not set');
  const key = JSON.parse(SA_KEY);

  // Build JWT
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const enc = (obj) => btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const signingInput = `${enc(header)}.${enc(payload)}`;

  // Import private key
  const pemBody = key.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, '');
  const keyData = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyData.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signingInput));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const jwt = `${signingInput}.${signature}`;

  // Exchange JWT for access token
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const tokenData = await tokenResp.json();
  if (!tokenData.access_token) throw new Error('Failed to get access token: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  try {
    const body = await req.json();

    // ── Poll existing operation ──────────────────────────────────
    if (body.pollOperation) {
      const accessToken = await getAccessToken();
      const opResp = await fetch(
        `https://${LOCATION}-aiplatform.googleapis.com/v1/${body.pollOperation}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const opData = await opResp.json();

      if (opData.done) {
        if (opData.error) {
          return new Response(JSON.stringify({ error: opData.error.message }), { status: 200, headers });
        }
        // Extract video URI from response
        const videos = opData.response?.videos || opData.response?.generatedSamples || [];
        const videoUri = videos[0]?.videoUri || videos[0]?.video?.uri;
        if (!videoUri) {
          return new Response(JSON.stringify({ error: 'No video in response', raw: opData }), { status: 200, headers });
        }
        return new Response(JSON.stringify({ done: true, videoUrl: videoUri }), { status: 200, headers });
      }

      return new Response(JSON.stringify({ done: false }), { status: 200, headers });
    }

    // ── New generation request ───────────────────────────────────
    if (!PROJECT_ID) {
      return new Response(JSON.stringify({
        error: 'VEO_PROJECT_ID environment variable not configured. Add it in Vercel dashboard → Settings → Environment Variables.'
      }), { status: 200, headers });
    }

    const {
      prompt,
      aspectRatio = '9:16',
      durationSeconds = 5,
      negativePrompt,
      referenceImageUri,
    } = body;

    if (!prompt) {
      return new Response(JSON.stringify({ error: 'prompt is required' }), { status: 400, headers });
    }

    const accessToken = await getAccessToken();

    // Veo 2 endpoint
    const endpoint = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/veo-2.0-generate-001:predictLongRunning`;

    const requestBody = {
      instances: [{
        prompt,
        ...(negativePrompt ? { negativePrompt } : {}),
        ...(referenceImageUri ? {
          image: { referenceImage: { gcsUri: referenceImageUri } }
        } : {}),
      }],
      parameters: {
        aspectRatio,
        durationSeconds,
        sampleCount: 1,
        storageUri: `gs://${PROJECT_ID}-veo-outputs/` // You need to create this GCS bucket
      }
    };

    const genResp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    const genData = await genResp.json();

    if (!genResp.ok) {
      return new Response(JSON.stringify({
        error: genData.error?.message || 'Veo API error',
        details: genData
      }), { status: 200, headers });
    }

    // Returns operation name for polling
    return new Response(JSON.stringify({
      operationName: genData.name,
      status: 'processing'
    }), { status: 200, headers });

  } catch (err) {
    console.error('text-to-video error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 200, headers });
  }
}
