export function isLlmStreamingEnabled(value = process.env.LLM_STREAMING_ENABLED) {
  return (
    String(value || '')
      .trim()
      .toLowerCase() === 'true'
  );
}

export function beginSse(res) {
  res.status(200);
  res.set({
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'content-type': 'text/event-stream; charset=utf-8',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();
}

export function writeSseEvent(res, event) {
  if (res.writableEnded || res.destroyed) return false;
  res.write(`data: ${JSON.stringify(event)}\n\n`);
  return true;
}

export function endSse(res) {
  if (res.writableEnded || res.destroyed) return false;
  res.write('data: [DONE]\n\n');
  res.end();
  return true;
}
