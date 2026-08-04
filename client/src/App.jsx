import { useEffect, useRef, useState } from 'react';
import { getApiKey, setApiKey, listDocuments } from './api.js';
import { endInitialRender, endUiOperation, failureTelemetry, startUiOperation } from './observability.js';
import ApiKeyGate from './components/ApiKeyGate.jsx';
import Uploader from './components/Uploader.jsx';
import DocumentList from './components/DocumentList.jsx';
import Chat from './components/Chat.jsx';

export default function App({ initialRender }) {
  const [apiKey, setKey] = useState(() => getApiKey());
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const initialRenderEnded = useRef(false);

  useEffect(() => {
    if (!initialRenderEnded.current) {
      endInitialRender(initialRender);
      initialRenderEnded.current = true;
    }
  }, [initialRender]);

  const refresh = async () => {
    const list = startUiOperation('ui.documents.list', 'list');
    setLoading(true);
    setLoadError(null);
    try {
      setDocuments(await listDocuments({ parentOperation: list }));
      endUiOperation(list, { outcome: 'success', statusCode: 200 });
    } catch (err) {
      endUiOperation(list, failureTelemetry(err));
      if (err.status === 401) {
        // Stored key is wrong/stale — kick back to gate.
        setApiKey('');
        setKey('');
      } else {
        setLoadError(err.message);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (apiKey) refresh();
  }, [apiKey]);

  if (!apiKey) {
    return <ApiKeyGate onSubmit={(k) => setKey(k)} />;
  }

  const handleSignOut = () => {
    setApiKey('');
    setKey('');
  };

  return (
    <div className="app">
      <header className="header">
        <h1 className="header__title">YaoAINote</h1>
        <button type="button" className="header__signout" onClick={handleSignOut}>
          Sign out
        </button>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <h2 className="sidebar__heading">Documents</h2>
          <Uploader onUploaded={(doc) => setDocuments((prev) => [doc, ...prev])} />
          {loading && <div className="sidebar__status">Loading…</div>}
          {loadError && <div className="sidebar__error">{loadError}</div>}
          <DocumentList
            documents={documents}
            onDeleted={(id) => setDocuments((prev) => prev.filter((d) => d.id !== id))}
          />
        </aside>

        <main className="main">
          <Chat />
        </main>
      </div>
    </div>
  );
}
