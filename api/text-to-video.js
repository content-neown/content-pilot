// api/text-to-video.js
// Vercel Edge Function — wraps Google Veo 3.1 via AI Studio (Gemini API)
// Required env var:
//   GEMINI_API_KEY — your Google AI Studio API key

export const config = { runtime: 'edge' };

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const VEO_MODEL      = 'veo-3.1-generate-preview';
const BASE_URL       = 'https://generativelanguage.googleapis.com/v1beta';

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (!GEMINI_API_KEY) {
    return new Response(JSON.stringify({
      error: 'GEMINI_API_KEY environment variable not configured. Add it in Vercel → Settings → Environment Variables.'
    }), { status: 200, headers });
  }

  try {
    const body = await req.json();

    // ── Poll existing operation ──────────────────────────────────
    if (body.pollOperation) {
      const opName  = body.pollOperation;
      const pollUrl = `${BASE_URL}/${opName}?key=${GEMINI_API_KEY}`;

      const opResp = await fetch(pollUrl);
      const opData = await opResp.json();

      if (opData.error) {
        return new Response(JSON.stringify({ error: opData.error.message || JSON.stringify(opData.error) }), { status: 200, headers });
      }

      if (opData.done) {
        // Correct response path per AI Studio Veo docs:
        // .response.generateVideoResponse.generatedSamples[0].video.uri
        const samples = opData.response?.generateVideoResponse?.generatedSamples
                     || opData.response?.generatedSamples
                     || opData.response?.videos
                     || [];
        const videoUri = samples[0]?.video?.uri || samples[0]?.videoUri;

        if (!videoUri) {
          return new Response(JSON.stringify({ error: 'No video in response', raw: opData }), { status: 200, headers });
        }

        // AI Studio video URIs require the API key as a query param to download
        const videoUrl = videoUri.includes('?')
          ? `${videoUri}&key=${GEMINI_API_KEY}`
          : `${videoUri}?key=${GEMINI_API_KEY}`;

        return new Response(JSON.stringify({ done: true, videoUrl }), { status: 200, headers });
      }

      return new Response(JSON.stringify({ done: false }), { status: 200, headers });
    }

    // ── New generation request ───────────────────────────────────
    const {
      prompt,
      aspectRatio     = '9:16',
      durationSeconds = 5,
      // negativePrompt is NOT supported by Veo 3.1 via AI Studio — ignored
    } = body;

    if (!prompt) {
      return new Response(JSON.stringify({ error: 'prompt is required' }), { status: 400, headers });
    }

    // AI Studio Veo 3.1 endpoint (long-running operation)
    const endpoint = `${BASE_URL}/models/${VEO_MODEL}:predictLongRunning?key=${GEMINI_API_KEY}`;

    const requestBody = {
      instances: [{ prompt }],
      parameters: {
        aspectRatio,
        durationSeconds,
      },
    };

    const genResp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    const genData = await genResp.json();

    if (!genResp.ok || genData.error) {
      return new Response(JSON.stringify({
        error: genData.error?.message || 'Veo API error',
        details: genData,
      }), { status: 200, headers });
    }

    // Returns operation name for polling
    // e.g. "models/veo-3.1-generate-preview/operations/xxxxxxxx"
    return new Response(JSON.stringify({
      operationName: genData.name,
      status: 'processing',
    }), { status: 200, headers });

  } catch (err) {
    console.error('text-to-video error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 200, headers });
  }
}
