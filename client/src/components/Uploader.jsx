import { useRef, useState } from 'react';
import { uploadDocument } from '../api.js';

const ACCEPTED = '.txt,.md,.pdf,.docx';

export default function Uploader({ onUploaded }) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const handleFiles = async (files) => {
    if (!files || !files.length) return;
    setError(null);
    setBusy(true);
    try {
      // Upload sequentially — keeps Voyage rate limits sane and makes UI status easy.
      for (const file of files) {
        const doc = await uploadDocument(file);
        onUploaded?.(doc);
      }
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  };

  return (
    <div
      className={`uploader ${dragOver ? 'uploader--drag' : ''} ${busy ? 'uploader--busy' : ''}`}
      onClick={() => !busy && inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED}
        multiple
        onChange={(e) => handleFiles(e.target.files)}
        style={{ display: 'none' }}
      />
      <div className="uploader__title">
        {busy ? 'Uploading…' : 'Drop files or click to upload'}
      </div>
      <div className="uploader__sub">.txt, .md, .pdf, .docx</div>
      {error && <div className="uploader__error">{error}</div>}
    </div>
  );
}
