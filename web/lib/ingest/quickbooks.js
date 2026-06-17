// Full-history QuickBooks invoices → ext.quickbooks_invoice. DORMANT until a
// refresh token + realm id are present (the old app stored these in its DB, not
// env). Built and ready: refreshes an access token, then pages the Invoice query.
import { ensureExtSchema, upsertBatch, num } from './schema';

const CID = process.env.QUICKBOOKS_CLIENT_ID || '';
const CSEC = process.env.QUICKBOOKS_CLIENT_SECRET || '';
const RT = process.env.QUICKBOOKS_REFRESH_TOKEN || '';
const REALM = process.env.QUICKBOOKS_REALM_ID || '';
const ENV = process.env.QUICKBOOKS_ENVIRONMENT || 'production';
const COLS = ['id', 'doc_number', 'customer', 'txn_date', 'due_date', 'total_amount', 'balance', 'currency', 'status', 'raw'];

export async function syncQuickbooks() {
  if (!CID || !CSEC || !RT || !REALM) {
    return { source: 'quickbooks', ok: false, rows: 0, skipped: 'QuickBooks not connected — needs refresh token + realm id' };
  }
  await ensureExtSchema();

  // Refresh access token (NOTE: Intuit rotates the refresh token on use; persist
  // tj.refresh_token to your credential store if you keep one).
  const basic = Buffer.from(`${CID}:${CSEC}`).toString('base64');
  const tr = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: RT }),
  });
  if (!tr.ok) throw new Error(`QuickBooks refresh ${tr.status}`);
  const at = (await tr.json()).access_token;

  const base = ENV === 'production' ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com';
  const PAGE = 1000;
  let total = 0, start = 1;
  for (let i = 0; i < 200; i++) {
    const q = encodeURIComponent(`SELECT * FROM Invoice STARTPOSITION ${start} MAXRESULTS ${PAGE}`);
    const r = await fetch(`${base}/v3/company/${REALM}/query?query=${q}&minorversion=65`,
      { headers: { Authorization: `Bearer ${at}`, Accept: 'application/json' } });
    if (!r.ok) throw new Error(`QuickBooks query ${r.status}`);
    const invoices = (await r.json()).QueryResponse?.Invoice || [];
    if (!invoices.length) break;
    const rows = invoices.map((x) => [
      x.Id, x.DocNumber || null, x.CustomerRef?.name || null,
      x.TxnDate || null, x.DueDate || null, num(x.TotalAmt), num(x.Balance),
      x.CurrencyRef?.value || null, Number(x.Balance) > 0 ? 'open' : 'paid', JSON.stringify(x),
    ]);
    total += await upsertBatch('ext.quickbooks_invoice', COLS, 'id', rows, { jsonCols: ['raw'] });
    start += invoices.length;
    if (invoices.length < PAGE) break;
  }
  return { source: 'quickbooks', ok: true, rows: total };
}
