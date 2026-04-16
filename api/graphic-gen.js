// api/graphic-gen.js
// Vercel Edge Function — wraps Google Imagen 3 via Vertex AI
// Required env vars (same as text-to-video):
//   VEO_PROJECT_ID          — your GCP project ID
//   VEO_LOCATION            — e.g. us-central1 (default)
//   GOOGLE_SERVICE_ACCOUNT_KEY — full JSON string of service account

export const config = { runtime: 'edge' };

const PROJECT_ID = process.env.VEO_PROJECT_ID;
const LOCATION   = process.env.VEO_LOCATION || 'us-central1';
const SA_KEY     = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

// ── Google OAuth2 access token (reused from text-to-video) ──────
async function getAccessToken() {
  if (!SA_KEY) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY env var not set');
  const key = JSON.parse(SA_KEY);

  const header  = { alg: 'RS256', typ: 'JWT' };
  const now     = Math.floor(Date.now() / 1000);
  const payload = {
    iss:   key.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  };

  const enc = (obj) =>
    btoa(JSON.stringify(obj))
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const signingInput = `${enc(header)}.${enc(payload)}`;

  const pemBody = key.private_key
    .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, '');
  const keyData = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyData.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signingInput)
  );
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const jwt = `${signingInput}.${signature}`;

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const tokenData = await tokenResp.json();
  if (!tokenData.access_token)
    throw new Error('Failed to get access token: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

// ── Aspect ratio → Imagen sampleImageSize mapping ───────────────
// Imagen 3 supported output sizes
function getImagenSize(aspectRatio, dims) {
  // Imagen 3 accepts aspectRatio directly for imagen-3.0-generate-001
  // Supported: "1:1", "3:4", "4:3", "9:16", "16:9"
  const supportedRatios = ['1:1','3:4','4:3','9:16','16:9'];
  // Normalize common aliases
  const normalized = {
    '1:1':   '1:1',
    '9:16':  '9:16',
    '16:9':  '16:9',
    '4:5':   '4:3',    // closest supported
    '1.91:1':'16:9',   // banner → landscape
  };
  return normalized[aspectRatio] || '1:1';
}

// ── Handler ─────────────────────────────────────────────────────
export default async function handler(req) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: {
      ...headers,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }});
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  }

  if (!PROJECT_ID) {
    return new Response(JSON.stringify({
      error: 'VEO_PROJECT_ID environment variable not configured. Add it in Vercel → Settings → Environment Variables.'
    }), { status: 200, headers });
  }

  try {
    const body = await req.json();
    const {
      prompt,
      negativePrompt,
      aspectRatio = '1:1',
      slideIndex   = 0,
      totalSlides  = 1,
      sampleCount  = 1,   // images per call — always 1 for carousel consistency
    } = body;

    if (!prompt) {
      return new Response(JSON.stringify({ error: 'prompt is required' }), { status: 400, headers });
    }

    const accessToken = await getAccessToken();
    const imageSize   = getImagenSize(aspectRatio);

    // Imagen 3 endpoint
    const endpoint = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/imagen-3.0-generate-001:predict`;

    const requestBody = {
      instances: [{
        prompt,
        ...(negativePrompt ? { negativePrompt } : {}),
      }],
      parameters: {
        sampleCount:    1,
        aspectRatio:    imageSize,
        safetyFilterLevel: 'block_some',
        personGeneration: 'allow_adult',
        includeRaiReason: false,
        // Request base64 output
        outputOptions: {
          mimeType: 'image/jpeg',
          compressionQuality: 90
        }
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

    if (!genResp.ok || genData.error) {
      const errMsg = genData.error?.message || genData.error || 'Imagen API error';
      console.error('Imagen error:', JSON.stringify(genData));
      return new Response(JSON.stringify({ error: errMsg, details: genData }), { status: 200, headers });
    }

    // Imagen returns base64 encoded images
    const predictions = genData.predictions || [];
    if (!predictions.length) {
      return new Response(JSON.stringify({ error: 'No images returned from Imagen' }), { status: 200, headers });
    }

    const first = predictions[0];
    const imageData = first.bytesBase64Encoded || first.image?.bytesBase64Encoded;
    const mimeType  = first.mimeType || 'image/jpeg';

    if (!imageData) {
      return new Response(JSON.stringify({ error: 'No image data in response', raw: first }), { status: 200, headers });
    }

    return new Response(JSON.stringify({
      imageData,
      mimeType,
      slideIndex,
      totalSlides,
      aspectRatio: imageSize,
    }), { status: 200, headers });

  } catch (err) {
    console.error('graphic-gen error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 200, headers });
  }
}
