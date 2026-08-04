import { useEffect, useId, useRef, useState } from 'react';
import {
  askStream,
  FEEDBACK_REASON_CODES,
  submitAnswerFeedback,
} from '../api.js';

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
      {
        role: 'assistant',
        text: '',
        sources: [],
        streaming: true,
        completed: false,
        requestId: null,
      },
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
        onStarted: ({ requestId }) => updateAssistant((a) => { a.requestId = requestId; }),
        onSources: (sources) => updateAssistant((a) => { a.sources = sources; }),
        onText: (delta) => updateAssistant((a) => { a.text += delta; }),
        onDone: () => updateAssistant((a) => {
          a.completed = true;
          a.streaming = false;
        }),
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
        {message.completed && message.requestId && (
          <AnswerFeedback requestId={message.requestId} />
        )}
      </div>
    </div>
  );
}

const NOT_USEFUL_REASONS = [
  { code: FEEDBACK_REASON_CODES.INCORRECT, label: 'Incorrect' },
  { code: FEEDBACK_REASON_CODES.INCOMPLETE, label: 'Incomplete' },
  { code: FEEDBACK_REASON_CODES.IRRELEVANT, label: 'Not relevant' },
  { code: FEEDBACK_REASON_CODES.OTHER, label: 'Other' },
];

function AnswerFeedback({ requestId }) {
  const reasonsId = useId();
  const [showReasons, setShowReasons] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState('idle');

  const sendFeedback = async (reasonCode) => {
    if (sending) return;
    setSending(true);
    setResult('idle');
    try {
      await submitAnswerFeedback(requestId, reasonCode);
      setResult('sent');
    } catch {
      setResult('error');
    } finally {
      setSending(false);
    }
  };

  if (result === 'sent') {
    return <p className="feedback__status" role="status">Thanks for your feedback.</p>;
  }

  return (
    <section className="feedback" aria-label="Answer feedback">
      <p className="feedback__prompt">Was this answer useful?</p>
      <div className="feedback__actions">
        <button
          type="button"
          className="feedback__button"
          disabled={sending}
          onClick={() => sendFeedback(FEEDBACK_REASON_CODES.USEFUL)}
        >
          Useful
        </button>
        <button
          type="button"
          className="feedback__button"
          aria-expanded={showReasons}
          aria-controls={reasonsId}
          disabled={sending}
          onClick={() => setShowReasons((shown) => !shown)}
        >
          Not useful
        </button>
      </div>
      {showReasons && (
        <fieldset id={reasonsId} className="feedback__reasons" disabled={sending}>
          <legend>What could be improved?</legend>
          {NOT_USEFUL_REASONS.map(({ code, label }) => (
            <button
              key={code}
              type="button"
              className="feedback__reason"
              onClick={() => sendFeedback(code)}
            >
              {label}
            </button>
          ))}
        </fieldset>
      )}
      {result === 'error' && (
        <p className="feedback__error" role="alert">
          Feedback could not be saved. Please try again.
        </p>
      )}
    </section>
  );
}
