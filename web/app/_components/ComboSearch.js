'use client';
import { useState } from 'react';

// A type-to-search dropdown combobox. `options` = [{ key, label, sub, data }].
// Typing filters by label+sub; clicking an option calls onPick(option). Free text
// is allowed (onChange fires on every keystroke) so you can also type a new value.
export default function ComboSearch({ value, onChange, options = [], onPick, placeholder, disabled }) {
  const [open, setOpen] = useState(false);
  const q = String(value || '').toLowerCase();
  const matches = (!q ? options : options.filter((o) => `${o.label} ${o.sub || ''}`.toLowerCase().includes(q))).slice(0, 40);

  return (
    <div className="combo">
      <input
        value={value || ''}
        disabled={disabled}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => { onChange?.(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && !disabled && matches.length > 0 && (
        <div className="combo-drop">
          {matches.map((o, i) => (
            <div
              key={o.key ?? i}
              className="combo-opt"
              onMouseDown={(e) => { e.preventDefault(); onPick?.(o); setOpen(false); }}
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
