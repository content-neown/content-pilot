// api/graphic-gen.js
// Vercel Edge Function — wraps Google Imagen 3 via AI Studio (Gemini API)
// Required env var:
//   GEMINI_API_KEY — your Google AI Studio API key

export const config = { runtime: 'edge' };

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const IMAGEN_MODEL   = 'imagen-4.0-generate-001';

// Normalize incoming aspectRatio to values Imagen 3 accepts
// Supported: "1:1", "3:4", "4:3", "9:16", "16:9"
function normalizeAspectRatio(aspectRatio) {
  const map = {
    '1:1':    '1:1',
    '9:16':   '9:16',
    '16:9':   '16:9',
    '3:4':    '3:4',
    '4:3':    '4:3',
    '4:5':    '3:4',    // closest supported
    '1.91:1': '16:9',   // banner → landscape
  };
  return map[aspectRatio] || '1:1';
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

  if (!GEMINI_API_KEY) {
    return new Response(JSON.stringify({
      error: 'GEMINI_API_KEY environment variable not configured. Add it in Vercel → Settings → Environment Variables.'
    }), { status: 200, headers });
  }

  try {
    const body = await req.json();
    const {
      prompt,
      negativePrompt,
      aspectRatio = '1:1',
      slideIndex  = 0,
      totalSlides = 1,
    } = body;

    if (!prompt) {
      return new Response(JSON.stringify({ error: 'prompt is required' }), { status: 400, headers });
    }

    const normalizedRatio = normalizeAspectRatio(aspectRatio);

    // AI Studio Imagen 3 endpoint
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGEN_MODEL}:predict?key=${GEMINI_API_KEY}`;

    const requestBody = {
      instances: [{
        prompt,
        ...(negativePrompt ? { negativePrompt } : {}),
      }],
      parameters: {
        sampleCount:       1,
        aspectRatio:       normalizedRatio,
        safetyFilterLevel: 'block_some',
        personGeneration:  'allow_adult',
        includeRaiReason:  false,
        outputOptions: {
          mimeType:           'image/jpeg',
          compressionQuality: 90,
        },
      },
    };

    const genResp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    const genData = await genResp.json();

    if (!genResp.ok || genData.error) {
      const errMsg = genData.error?.message || genData.error || 'Imagen API error';
      console.error('Imagen error:', JSON.stringify(genData));
      return new Response(JSON.stringify({ error: errMsg, details: genData }), { status: 200, headers });
    }

    const predictions = genData.predictions || [];
    if (!predictions.length) {
      return new Response(JSON.stringify({ error: 'No images returned from Imagen' }), { status: 200, headers });
    }

    const first     = predictions[0];
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
      aspectRatio: normalizedRatio,
    }), { status: 200, headers });

  } catch (err) {
    console.error('graphic-gen error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 200, headers });
  }
}
