import { useState } from 'react';
import { setApiKey } from '../api.js';

export default function ApiKeyGate({ onSubmit }) {
  const [value, setValue] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    setApiKey(trimmed);
    onSubmit(trimmed);
  };

  return (
    <div className="gate">
      <form className="gate__card" onSubmit={handleSubmit}>
        <h1>YaoAINote</h1>
        <p className="gate__sub">Enter your APP_API_KEY to continue.</p>
        <input
          type="password"
          autoFocus
          placeholder="APP_API_KEY"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" disabled={!value.trim()}>
          Unlock
        </button>
        <p className="gate__hint">
          The key is stored in your browser's localStorage on this device only.
        </p>
      </form>
    </div>
  );
}
