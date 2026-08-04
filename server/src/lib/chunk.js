/**
 * Simple paragraph-aware chunker.
 *
 * Approximates "tokens" as words (1 word ≈ 0.75 tokens for English) — close
 * enough for sizing decisions; Voyage's tokenizer can handle inputs up to
 * 32K tokens per document, so we just need chunks of a sensible retrieval size.
 *
 * Defaults: ~500 tokens per chunk, ~50 token overlap.
 */
export const CHUNK_TARGET_TOKENS = 500;
export const CHUNK_OVERLAP_TOKENS = 50;

export function chunkText(
  text,
  { chunkSize = CHUNK_TARGET_TOKENS, overlap = CHUNK_OVERLAP_TOKENS } = {},
) {
  // Approximate words per chunk — 1 token ≈ 0.75 words for English prose.
  const wordsPerChunk = Math.round(chunkSize * 0.75);
  const overlapWords = Math.round(overlap * 0.75);

  const cleaned = text.replace(/\r\n/g, '\n').trim();
  if (!cleaned) return [];

  // Split on blank lines first; this preserves paragraph boundaries.
  const paragraphs = cleaned.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  const chunks = [];
  let buffer = [];
  let bufferWords = 0;

  const flush = () => {
    if (!buffer.length) return;
    chunks.push(buffer.join('\n\n').trim());
    if (overlapWords > 0) {
      // Keep the tail of the last chunk as a prefix of the next one.
      const tailWords = buffer.join(' ').split(/\s+/).slice(-overlapWords);
      buffer = tailWords.length ? [tailWords.join(' ')] : [];
      bufferWords = tailWords.length;
    } else {
      buffer = [];
      bufferWords = 0;
    }
  };

  for (const para of paragraphs) {
    const paraWords = para.split(/\s+/).length;

    if (paraWords > wordsPerChunk) {
      // Paragraph alone exceeds chunk size — sentence-split it.
      flush();
      const sentences = para.split(/(?<=[.!?])\s+/);
      let sentenceBuffer = [];
      let sentenceWords = 0;
      for (const sentence of sentences) {
        const sw = sentence.split(/\s+/).length;
        if (sentenceWords + sw > wordsPerChunk && sentenceBuffer.length) {
          chunks.push(sentenceBuffer.join(' ').trim());
          sentenceBuffer = [];
          sentenceWords = 0;
        }
        sentenceBuffer.push(sentence);
        sentenceWords += sw;
      }
      if (sentenceBuffer.length) chunks.push(sentenceBuffer.join(' ').trim());
      continue;
    }

    if (bufferWords + paraWords > wordsPerChunk) flush();
    buffer.push(para);
    bufferWords += paraWords;
  }

  if (buffer.length) chunks.push(buffer.join('\n\n').trim());
  return chunks.filter((c) => c.length > 0);
}
