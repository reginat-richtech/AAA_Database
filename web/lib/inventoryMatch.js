// Match a proposal's AI-extracted package list (ops.project_proposal.package_list,
// shape [{item, quantity, notes}]) to current inventory SKUs (inventory.cn_sku), so
// the inventory team gets a recommended pick-list: what's needed vs what's in stock.
//
// Heuristic and best-effort — the package text comes from AI extraction, so a match
// is a suggestion the team confirms, not a guarantee. Pure (no I/O).
import { SKU_RE } from './inventory';

// Words that add noise to a product name without identifying it.
const STOP = new Set(['robot', 'robots', 'unit', 'units', 'the', 'a', 'an', 'of', 'for',
  'and', 'with', 'system', 'set', 'pcs', 'pc', 'pack', 'finished', 'goods', 'raw', 'materials', 'parts']);

function toks(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

// First SKU-shaped token in a string (e.g. a model code the AI kept in `notes`).
function skuIn(text) {
  for (const w of String(text || '').toUpperCase().split(/[^A-Z0-9.&-]+/)) if (SKU_RE.test(w)) return w;
  return null;
}

// Two tokens "match" if equal, or one contains the other (min length 3 to avoid
// junk 2-char hits like "se"). e.g. "360mm" ~ "360", "cup" ~ "cups".
function tokenMatch(a, b) {
  if (a === b) return true;
  if (a.length >= 3 && b.includes(a)) return true;
  if (b.length >= 3 && a.includes(b)) return true;
  return false;
}

// Word similarity between the package item and a stock row's PRODUCT NAME, as a
// symmetric Dice coefficient over their meaningful tokens:  2·|shared| / (|item|+|name|).
// Symmetric on purpose: an exact/near-exact name scores 1.0, while a name padded
// with extra words scores lower — so ranking is purely by how alike the WORDS are,
// never by how many units are in stock. Excludes product_line/sku (the brand repeats
// across a whole line); explicit SKU codes are matched outright in step 1.
function similarity(itemToks, rowToks) {
  if (!itemToks.length || !rowToks.length) return 0;
  let shared = 0;
  for (const t of itemToks) if (rowToks.some((h) => tokenMatch(t, h))) shared++;
  return (2 * shared) / (itemToks.length + rowToks.length);
}

const MIN_SCORE = 0.4;

// → [{ item, notes, needed, match: {id, sku, product_name, product_line}|null,
//      onHand, shortfall, status, confidence }]
// status: in_stock | short | out | no_match
export function matchPackageList(packageList, stockRows) {
  const all = Array.isArray(stockRows) ? stockRows : [];
  // RaaS (Robot-as-a-Service) rows are service/lease SKUs, not physical stock to
  // pick — exclude them so they're never recommended.
  const stock = all.filter((r) => !/raas/i.test(String(r.product_name || '')));
  const bySku = new Map();
  for (const r of stock) if (r.sku) bySku.set(String(r.sku).toUpperCase(), r);

  // Pre-tokenize each stock row's product name once.
  const stockToks = stock.map((r) => ({ r, toks: toks(r.product_name) }));

  return (Array.isArray(packageList) ? packageList : []).map((pkg) => {
    const item = String(pkg?.item || '').trim();
    const notes = String(pkg?.notes || '').trim();
    const needed = Number(pkg?.quantity) > 0 ? Number(pkg.quantity) : 1;

    let match = null;
    let confidence = 0;

    // 1) An explicit SKU code in the item/notes wins outright.
    const coded = skuIn(`${item} ${notes}`);
    if (coded && bySku.has(coded)) { match = bySku.get(coded); confidence = 1; }

    // 2) Otherwise the best WORD-SIMILARITY match. Ranked by similarity only;
    //    inventory count is never used. Ties prefer a finished good, then the more
    //    specific (shorter) product name.
    if (!match) {
      const itemToks = toks(item);
      const scored = stockToks
        .map((x) => ({ r: x.r, s: similarity(itemToks, x.toks) }))
        .filter((x) => x.s >= MIN_SCORE)
        .sort((a, b) =>
          b.s - a.s
          || ((b.r.item_class === 'finished_goods') - (a.r.item_class === 'finished_goods'))
          || (String(a.r.product_name || '').length - String(b.r.product_name || '').length));
      if (scored.length) { match = scored[0].r; confidence = scored[0].s; }
    }

    const onHand = match ? (Number(match.quantity) || 0) : 0;
    const shortfall = Math.max(0, needed - onHand);
    const status = !match ? 'no_match' : onHand === 0 ? 'out' : shortfall > 0 ? 'short' : 'in_stock';

    return {
      item, notes, needed,
      match: match ? { id: match.id, sku: match.sku, product_name: match.product_name, product_line: match.product_line } : null,
      onHand, shortfall, status,
      confidence: Math.round(confidence * 100) / 100,
    };
  });
}
