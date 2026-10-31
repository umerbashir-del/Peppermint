export async function responses(body, { fetchImpl = fetch } = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key || key === 'your_api_key_here') throw new Error('Add OPENAI_API_KEY to your local .env file first.');
  const response = await fetchImpl('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4.1', store: false, ...body }),
    signal: AbortSignal.timeout(90000),
  });
  // Do not print provider error bodies: they can contain submitted account data.
  if (!response.ok) throw new Error(`OpenAI request failed (HTTP ${response.status}). Check your key, model access, and billing.`);
  const result = await response.json();
  if (result.status !== 'completed') throw new Error('The agent response was incomplete. Please retry.');
  return result;
}

export function outputText(response) {
  return (response.output ?? []).flatMap(item => item.content ?? [])
    .filter(item => item.type === 'output_text').map(item => item.text).join('\n');
}
