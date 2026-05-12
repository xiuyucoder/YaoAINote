import Anthropic from '@anthropic-ai/sdk';

let _client = null;

function getClient() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  // The SDK reads ANTHROPIC_BASE_URL automatically when set in the environment,
  // so a UIUIAPI / other-relay user just sets that env var and this code is unchanged.
  _client = new Anthropic({ apiKey });
  return _client;
}

const MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `You are a personal knowledge assistant. The user has uploaded their own documents to a private knowledge base. Answer the user's question using only the information in the <context> section below.

Rules:
- Cite the chunks you used with bracket numbers like [1] or [2, 3].
- If the context doesn't contain enough information to answer, say so honestly. Do not fabricate.
- Be concise and direct. Skip preambles like "Based on the context...".
- If the user's question is ambiguous, point out the ambiguity and answer the most likely interpretation.`;

function buildContextBlock(chunks) {
  return chunks.map((c, i) => `[${i + 1}] (${c.documentName}) ${c.text}`).join('\n\n');
}

/**
 * Generate a grounded answer for a user's question.
 *
 * @param {object} args
 * @param {string} args.query
 * @param {Array<{
 *   text: string,
 *   documentName: string,
 *   documentId: string,
 *   chunkIndex: number,
 *   score: number,
 * }>} args.chunks
 */
export async function answerQuestion({ query, chunks }) {
  if (!chunks.length) {
    return {
      answer:
        "I don't have any information that matches your question. Your knowledge base may be empty, or none of the uploaded documents are relevant. Try uploading more documents or rephrasing the question.",
      usage: null,
      stopReason: 'no_context',
    };
  }

  const client = getClient();

  const userMessage = `<context>
${buildContextBlock(chunks)}
</context>

Question: ${query}`;

  // Stream under the hood (avoids HTTP timeouts on long answers / deep thinking)
  // and await the final accumulated message for a clean single response.
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const message = await stream.finalMessage();

  // Extract text content; ignore thinking blocks (internal reasoning).
  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  return {
    answer: text,
    usage: message.usage,
    stopReason: message.stop_reason,
  };
}
