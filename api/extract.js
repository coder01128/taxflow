module.exports = async function handler(req, res) {
  console.log("ENV KEY EXISTS:", !!process.env.OPENROUTER_API_KEY);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENROUTER_API_KEY not configured' });
  }

  const { image, prompt, max_tokens } = req.body;
  if (!image || !prompt) {
    return res.status(400).json({ error: 'Missing required fields: image, prompt' });
  }

  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://taxflow.vercel.app',
        'X-Title': 'TaxFlow Statement Extractor',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-5',
        max_tokens: max_tokens || 8192,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      return res.status(resp.status).json({
        error: err.error?.message || resp.statusText,
      });
    }

    const data = await resp.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
};
