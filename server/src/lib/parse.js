import path from 'node:path';

/**
 * Parse a buffer of an uploaded file into plain text.
 * For Slice 1 we only handle .txt and .md. PDF/DOCX come in Slice 4.
 */
export async function parseToText({ buffer, originalName }) {
  const ext = path.extname(originalName).toLowerCase();

  switch (ext) {
    case '.txt':
    case '.md':
      return buffer.toString('utf8');

    case '.pdf': {
      // Import the inner module directly — pdf-parse's index.js has a top-level
      // debug block that reads ./test/data/*.pdf and crashes in production.
      const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
      const result = await pdfParse(buffer);
      return result.text;
    }

    case '.docx': {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }

    default:
      throw Object.assign(
        new Error(`unsupported file type: ${ext || '(none)'}. supported: .txt, .md, .pdf, .docx`),
        { status: 400 },
      );
  }
}
