'use client';
import { useEffect, useState, useCallback } from 'react';
import { PageHeader } from './blueprint';
import { getAi, peekAi, setAi } from '../../lib/aiCache';
import ChatAssistant from './ChatAssistant';

// Shared two-pane shell for the AI tabs. Normal loads read from the shared client
// cache (which reads the DB-backed brief) so tab switches / alert details are
// instant. Refresh does an Option-B sync: pulls fresh from the source into the DB
// (?sync=1), then shows the recomputed result and updates the cache.
export default function AiTab({ title, sub, sheet, endpoint, chatScope, domain, renderLeft }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback((force = false) => {
    setErr(null);
    if (force) {
      // Option B: re-pull from the source into the DB, then recompute.
      setLoading(true);
      const sep = endpoint.includes('?') ? '&' : '?';
      fetch(endpoint + sep + 'sync=1')
        .then((r) => r.json())
        .then((d) => { setData(d); setAi(endpoint, d); })
        .catch((e) => setErr(String(e?.message || e)))
        .finally(() => setLoading(false));
      return;
    }
    const cached = peekAi(endpoint);
    if (cached != null) { setData(cached); setLoading(false); } else { setLoading(true); }
    getAi(endpoint)
      .then((d) => setData(d))
      .catch((e) => setErr(String(e?.message || e)))
      .finally(() => setLoading(false));
  }, [endpoint]);

  useEffect(() => { load(false); }, [load]);

  const count = data && data.count != null ? data.count : null;

  return (
    <>
      <PageHeader title={title} sub={sub} sheet={sheet} />
      <div className="split">
        <section className="panel">
          <div className="panel-title">
            <h2>{title}{count != null && <span className="chip" style={{ marginLeft: 8 }}>{count}</span>}</h2>
            <button className="secondary" onClick={() => load(true)} disabled={loading} title="Pull fresh data from the source, then recompute">
              {loading ? 'Syncing…' : '↻ Refresh'}
            </button>
          </div>
          {loading && !data && <p className="note">Loading…</p>}
          {!loading && err && <p className="error">{err}</p>}
          {data && data.ok === false && (
            <p className={data.pending ? 'note' : 'error'}>{data.error}</p>
          )}
          {data && data.ok !== false && renderLeft(data)}
        </section>
        <section className="panel">
          <div className="panel-title"><h2>AI chat</h2><span className="meta">{chatScope}</span></div>
          <ChatAssistant domain={domain} scope={chatScope} />
        </section>
      </div>
    </>
  );
}
