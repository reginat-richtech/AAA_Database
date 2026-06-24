'use client';
// Embeddable read-only chat assistant for the AI tabs. Scoped by `domain`
// (hubspot | finance | travel) so each tab's assistant only sees that domain's
// tables. Talks to /api/assistant (which runs the model ↔ read-only-SQL loop).
import { useEffect, useRef, useState } from 'react';

export default function ChatAssistant({ domain, scope }) {
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  const [configured, setConfigured] = useState(true);
  const [messages, setMessages] = useState([]);   // {role, content, sqlLog?, model?}
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);

  useEffect(() => {
    fetch('/api/assistant')
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || 'x'); return j; })
      .then((j) => { setModels(j.models || []); setModel(j.defaultModel || j.models?.[0]?.id || ''); setConfigured(!!j.configured); })
      .catch(() => setConfigured(false));
  }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, busy]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    const next = [...messages, { role: 'user', content: text }];
    setMessages(next); setBusy(true);
    try {
      const res = await fetch('/api/assistant', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, domain, messages: next.map((m) => ({ role: m.role, content: m.content })) }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Request failed');
      setMessages((m) => [...m, { role: 'assistant', content: j.reply, sqlLog: j.sqlLog || [], model: j.model }]);
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', content: '⚠️ ' + e.message }]);
    } finally { setBusy(false); }
  }

  if (!configured) {
    return <div className="chat-soon note">💬 Add <span className="mono">OPENROUTER_API_KEY</span> to enable the assistant.</div>;
  }

  return (
    <div className="casst">
      <div className="casst-bar">
        <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy} title="Model — switch to compare">
          {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        {messages.length > 0 && <button className="secondary" onClick={() => setMessages([])} disabled={busy}>Clear</button>}
      </div>

      <div className="casst-log">
        {messages.length === 0 && (
          <p className="note">Ask about {scope || 'this data'} — counts, totals, “top N”, trends. The assistant writes read-only SQL and answers.</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`cb ${m.role}`}>
            <div className="cwho">{m.role === 'user' ? 'You' : 'Assistant'}{m.model ? ` · ${m.model}` : ''}</div>
            <div className="ctxt">{m.content}</div>
            {m.sqlLog?.length > 0 && (
              <details className="csql">
                <summary>{m.sqlLog.length} quer{m.sqlLog.length === 1 ? 'y' : 'ies'} run</summary>
                {m.sqlLog.map((q, j) => (
                  <div key={j}><pre className="mono">{q.sql}</pre><span className="note">{q.error ? `⚠️ ${q.error}` : `${q.rows} row(s)`}</span></div>
                ))}
              </details>
            )}
          </div>
        ))}
        {busy && <div className="cb assistant"><div className="cwho">Assistant</div><div className="ctxt note">Thinking…</div></div>}
        <div ref={endRef} />
      </div>

      <div className="casst-input">
        <textarea rows={2} value={input} placeholder={`Ask about ${scope || 'this data'}…`}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          disabled={busy} />
        <button onClick={send} disabled={busy || !input.trim()}>{busy ? '…' : 'Send'}</button>
      </div>

      <style>{`
        .casst { display:flex; flex-direction:column; gap:10px; }
        .casst-bar { display:flex; gap:8px; align-items:center; }
        .casst-bar select { flex:1; }
        .casst-log { display:flex; flex-direction:column; gap:10px; min-height:200px; max-height:46vh; overflow-y:auto; }
        .cb { max-width:92%; padding:9px 12px; border-radius:11px; border:1px solid var(--line); }
        .cb.user { align-self:flex-end; background:var(--chip); }
        .cb.assistant { align-self:flex-start; background:var(--surface); }
        .cwho { font-family:var(--font-mono); font-size:10px; letter-spacing:.05em; text-transform:uppercase; color:var(--muted); margin-bottom:3px; }
        .ctxt { white-space:pre-wrap; font-size:13.5px; line-height:1.5; }
        .csql { margin-top:6px; }
        .csql summary { cursor:pointer; font-size:12px; color:var(--primary); }
        .csql pre { background:var(--ink); color:#cfe0f5; padding:7px 9px; border-radius:7px; font-size:11.5px; overflow-x:auto; margin:4px 0 1px; white-space:pre-wrap; }
        .casst-input { display:flex; gap:8px; align-items:flex-end; }
        .casst-input textarea { flex:1; resize:vertical; }
      `}</style>
    </div>
  );
}
