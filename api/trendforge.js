// api/trendforge.js
// Vercel Serverless Function — TrendForge trend discovery + content generation
// Uses Claude web_search tool to fetch live trends, then generates ad concepts
// Set CLAUDE_API_KEY in Vercel → Settings → Environment Variables

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  if (!process.env.CLAUDE_API_KEY) {
    return res.status(500).json({ error: 'CLAUDE_API_KEY not set in Vercel environment variables' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'interleaved-thinking-2025-05-14'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 4000,
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search'
          }
        ],
        messages: [
          { role: 'user', content: prompt }
        ]
      })
    });

    const data = await response.json();

    if (data.error) {
      return res.status(400).json({ error: data.error.message });
    }

    // Extract all text blocks from the response (Claude may use web_search tool mid-response)
    const fullText = (data.content || [])
      .map(b => b.type === 'text' ? b.text : '')
      .filter(Boolean)
      .join('\n');

    return res.status(200).json({ content: fullText });

  } catch (err) {
    console.error('TrendForge API error:', err);
    return res.status(500).json({ error: 'Failed to reach Claude API' });
  }
}
