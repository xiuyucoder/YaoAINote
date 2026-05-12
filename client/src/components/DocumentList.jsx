import { deleteDocument } from '../api.js';

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export default function DocumentList({ documents, onDeleted }) {
  if (!documents.length) {
    return <div className="doclist__empty">No documents yet. Upload one to start.</div>;
  }

  const handleDelete = async (id) => {
    if (!confirm('Delete this document and all its embeddings?')) return;
    try {
      await deleteDocument(id);
      onDeleted?.(id);
    } catch (err) {
      alert(`Delete failed: ${err.message}`);
    }
  };

  return (
    <ul className="doclist">
      {documents.map((d) => (
        <li key={d.id} className="doclist__item">
          <div className="doclist__main">
            <div className="doclist__name" title={d.name}>{d.name}</div>
            <div className="doclist__meta">
              {formatBytes(d.sizeBytes)} · {d.chunkCount} chunks · {formatDate(d.createdAt)}
            </div>
          </div>
          <button
            type="button"
            className="doclist__delete"
            title="Delete"
            onClick={() => handleDelete(d.id)}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
