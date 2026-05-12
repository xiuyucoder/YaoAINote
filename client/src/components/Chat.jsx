import { useEffect, useRef, useState } from 'react';
import { ask } from '../api.js';

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

    setMessages((m) => [...m, { role: 'user', text: query }]);
    setInput('');
    setBusy(true);
    setError(null);

    try {
      const res = await ask(query);
      setMessages((m) => [
        ...m,
        { role: 'assistant', text: res.answer, sources: res.sources || [] },
      ]);
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
        {busy && <div className="chat__pending">Thinking…</div>}
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
        <div className="msg__text">{message.text}</div>
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
