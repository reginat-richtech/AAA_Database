'use client';
import { useState } from 'react';

// A type-to-search dropdown combobox. `options` = [{ key, label, sub, data }].
// Typing filters by label+sub; clicking an option calls onPick(option).
//
// Default: free text is allowed (onChange fires on every keystroke) so you can also
// type a new value.
//
// selectOnly: the field can ONLY hold a value chosen from `options`. Typing just
// filters/searches the list (onSearch fires for live/server-side search) and the
// committed value is set ONLY via onPick — any unpicked text is discarded on blur.
export default function ComboSearch({ value, onChange, options = [], onPick, placeholder, disabled, selectOnly = false, onSearch }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');   // selectOnly: the live search text (separate from the committed value)

  // Shown in the box: in selectOnly mode the search text while open, else the
  // committed value; in free mode always the committed value.
  const shown = selectOnly ? (open ? query : (value || '')) : (value || '');
  const q = String(shown).toLowerCase();
  const matches = (!q ? options : options.filter((o) => `${o.label} ${o.sub || ''}`.toLowerCase().includes(q))).slice(0, 40);

  const type = (text) => {
    setOpen(true);
    if (selectOnly) { setQuery(text); onSearch?.(text); }   // search only — do NOT commit
    else { onChange?.(text); }
  };
  const pick = (o) => { onPick?.(o); setOpen(false); if (selectOnly) setQuery(''); };

  return (
    <div className="combo">
      <input
        value={shown}
        disabled={disabled}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => type(e.target.value)}
        onFocus={() => { if (selectOnly) setQuery(value || ''); setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && !disabled && matches.length > 0 && (
        <div className="combo-drop">
          {matches.map((o, i) => (
            <div
              key={o.key ?? i}
              className="combo-opt"
              onMouseDown={(e) => { e.preventDefault(); pick(o); }}
            >
              <span className="combo-lbl">{o.label}</span>
              {o.sub && <span className="combo-sub">{o.sub}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
