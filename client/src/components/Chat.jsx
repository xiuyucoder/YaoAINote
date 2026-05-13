import { useEffect, useRef, useState } from 'react';
import { askStream } from '../api.js';

export default function Chat() {
  const [messages, setMessages] = useState([]); // {role, text, sources?}
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, busy]);

  const send = async (e) => {
    e?.preventDefault?.();
    const query = input.trim();
    if (!query || busy) return;

    // Push the user message and an empty assistant placeholder. We mutate the
    // placeholder as text deltas arrive.
    setMessages((m) => [
      ...m,
      { role: 'user', text: query },
      { role: 'assistant', text: '', sources: [], streaming: true },
    ]);
    setInput('');
    setBusy(true);
    setError(null);

    const updateAssistant = (mut) =>
      setMessages((m) => {
        const next = m.slice();
        const last = { ...next[next.length - 1] };
        mut(last);
        next[next.length - 1] = last;
        return next;
      });

    try {
      await askStream(query, {
        onSources: (sources) => updateAssistant((a) => { a.sources = sources; }),
        onText: (delta) => updateAssistant((a) => { a.text += delta; }),
        onDone: () => updateAssistant((a) => { a.streaming = false; }),
        onError: (err) => {
          setError(err.message || String(err));
          updateAssistant((a) => { a.streaming = false; });
        },
      });
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chat">
      <div className="chat__messages" ref={scrollRef}>
        {messages.length === 0 && !busy && (
          <div className="chat__empty">
            <p>Ask a question about your uploaded documents.</p>
            <p className="chat__hint">
              Answers will cite sources like [1], [2] — click a chip below to expand the source.
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <Message key={i} message={m} />
        ))}
        {error && <div className="chat__error">{error}</div>}
      </div>

      <form className="chat__input" onSubmit={send}>
        <textarea
          rows={2}
          placeholder="Ask a question…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          disabled={busy}
        />
        <button type="submit" disabled={busy || !input.trim()}>
          {busy ? '…' : 'Ask'}
        </button>
      </form>
    </div>
  );
}

function Message({ message }) {
  const [openSource, setOpenSource] = useState(null);

  if (message.role === 'user') {
    return (
      <div className="msg msg--user">
        <div className="msg__bubble">{message.text}</div>
      </div>
    );
  }

  // assistant
  return (
    <div className="msg msg--assistant">
      <div className="msg__bubble">
        <div className="msg__text">
          {message.text}
          {message.streaming && (message.text || !message.sources?.length) && (
            <span className="msg__cursor">▍</span>
          )}
          {message.streaming && !message.text && message.sources?.length > 0 && (
            <span className="msg__pending">Thinking…</span>
          )}
        </div>
        {message.sources?.length > 0 && (
          <div className="msg__sources">
            {message.sources.map((s, i) => (
              <button
                key={`${s.documentId}-${s.chunkIndex}`}
                type="button"
                className={`chip ${openSource === i ? 'chip--open' : ''}`}
                title={s.documentName}
                onClick={() => setOpenSource(openSource === i ? null : i)}
              >
                [{i + 1}] {s.documentName}
              </button>
            ))}
          </div>
        )}
        {openSource !== null && message.sources[openSource] && (
          <div className="msg__source-detail">
            <div className="msg__source-meta">
              {message.sources[openSource].documentName} · chunk{' '}
              {message.sources[openSource].chunkIndex} · score{' '}
              {message.sources[openSource].score?.toFixed(3)}
            </div>
            <pre>{message.sources[openSource].text}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
