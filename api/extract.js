/* Vision fallback for TaxFlow: reads ONE statement page image and returns
   its transactions as JSON. Only used for pages the browser could not read
   from the PDF text layer (or whose rows didn't balance).

   Locked down: the prompt, model and max_tokens are fixed here. The browser
   can only send a page image; any other field (prompt, model, max_tokens…)
   is ignored, so this endpoint can't be used as a general AI proxy. */

const MODEL = 'anthropic/claude-sonnet-5';
const MAX_TOKENS = 8192;

// Must match MAX_IMAGE_B64 in index.html. Base64 characters of one JPEG
// page (~2.2 MB of image). Kept well under Vercel's request body limit so an
// oversized page gets this clear error instead of an unexplained 413.
const MAX_IMAGE_B64 = 3000000;

const PROMPT = `You are reading ONE page of a South African bank statement. Extract every transaction row on this page exactly as printed. Do not categorise anything.

Return ONLY a JSON object, no markdown, no commentary:
{
  "opening_balance": number or null,   // only if THIS page shows an opening balance / balance brought forward
  "closing_balance": number or null,   // only if THIS page shows a closing balance
  "transactions": [
    {
      "post_date": "YYYY-MM-DD",
      "trans_date": "YYYY-MM-DD" or null,
      "reference": "description / merchant text as printed (join wrapped lines)",
      "amount": number,   // the Debit / Credit / Amount figure printed on this row: money in positive, money out negative
      "fees_column": number or null,   // the figure printed in this row's Fees / Charges column, copied as a positive number; null if that cell is blank or there is no such column
      "fee_marked": boolean,   // true only if this row's amount itself is marked as a bank fee (for example with * after it)
      "balance": number or null   // running balance printed on this row; negative if overdrawn (Dr / minus)
    }
  ]
}

Rules:
- Include every transaction row, in the order printed.
- Skip column headers, page headers/footers, "balance brought forward" / "carried forward" lines, totals and VAT summaries.
- Copy figures exactly as printed. Do not add, subtract or move money between "amount" and "fees_column": a Fees column value goes only in "fees_column", and an amount marked as a fee (for example with *) stays in "amount" with "fee_marked": true.
- Do not check or correct the running balance; report it as printed.
- Thousands may be separated by spaces or commas: "1 977.00" and "1,977.00" are both 1977.00.
- If the page has no transactions, return {"opening_balance": null, "closing_balance": null, "transactions": []}.`;

function send(res, status, body) {
  return res.status(status).json(body);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return send(res, 500, { error: 'The extraction server is not configured (missing API key).' });

  const image = req.body && req.body.image;
  if (typeof image !== 'string' || !image.length) {
    return send(res, 400, { error: 'No page image was sent.' });
  }
  if (image.length > MAX_IMAGE_B64) {
    return send(res, 413, {
      error: `Page image is too large: ${image.length.toLocaleString('en-ZA')} characters, over the ${(MAX_IMAGE_B64 / 1e6).toFixed(1)} MB limit.`,
    });
  }
  // A base64 JPEG starts with "/9j/" and contains only base64 characters.
  if (!image.startsWith('/9j/') || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) {
    return send(res, 400, { error: 'The page image must be a base64-encoded JPEG.' });
  }

  let resp;
  try {
    resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://taxflow-bk.vercel.app',
        'X-Title': 'TaxFlow Statement Extractor',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } },
            { type: 'text', text: PROMPT },
          ],
        }],
      }),
    });
  } catch (err) {
    return send(res, 502, { error: 'Could not reach the AI service: ' + err.message });
  }

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    // Don't pass the upstream status straight through: a 413 from upstream
    // would otherwise look like our own size limit.
    return send(res, 502, { error: `AI service error ${resp.status}: ${(err.error && err.error.message) || resp.statusText}` });
  }

  const data = await resp.json().catch(() => null);
  const choice = data && data.choices && data.choices[0];
  const text = (choice && choice.message && choice.message.content) || '';
  if (choice && choice.finish_reason === 'length') {
    return send(res, 502, { error: 'The AI response was cut off — this page has more rows than fit in one response.' });
  }
  const clean = text.replace(/```json|```/g, '').trim();
  let result;
  try {
    result = JSON.parse(clean);
  } catch (e) {
    return send(res, 502, { error: 'The AI response was not valid JSON.' });
  }
  if (!result || !Array.isArray(result.transactions)) {
    return send(res, 502, { error: 'The AI response had no transactions list.' });
  }
  return send(res, 200, { result });
};
