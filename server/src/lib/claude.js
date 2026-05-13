import Anthropic from '@anthropic-ai/sdk';

let _client = null;

export function getClient() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  // The SDK reads ANTHROPIC_BASE_URL automatically when set in the environment,
  // so a UIUIAPI / other-relay user just sets that env var and this code is unchanged.
  _client = new Anthropic({ apiKey });
  return _client;
}

export const MODEL = 'claude-sonnet-4-6';

export const SYSTEM_PROMPT = `You are a personal knowledge assistant. The user has uploaded their own documents to a private knowledge base. Answer the user's question using only the information in the <context> section below.

Rules:
- Cite the chunks you used with bracket numbers like [1] or [2, 3].
- If the context doesn't contain enough information to answer, say so honestly. Do not fabricate.
- Be concise and direct. Skip preambles like "Based on the context...".
- If the user's question is ambiguous, point out the ambiguity and answer the most likely interpretation.`;

export const NO_CONTEXT_FALLBACK =
  "I don't have any information that matches your question. Your knowledge base may be empty, or none of the uploaded documents are relevant. Try uploading more documents or rephrasing the question.";

function buildContextBlock(chunks) {
  return chunks.map((c, i) => `[${i + 1}] (${c.documentName}) ${c.text}`).join('\n\n');
}

/**
 * Build the Anthropic request params for a RAG question.
 * Caller invokes client.messages.stream(params) and iterates the stream
 * so we can pipe deltas straight to SSE.
 */
export function buildAnswerParams({ query, chunks }) {
  const userMessage = `<context>
${buildContextBlock(chunks)}
</context>

Question: ${query}`;

  return {
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  };
}
