// Full-history Navan bookings → ext.navan_booking. Pulls every booking from a
// fixed early date to now, paginating until exhausted, and upserts on uuid.
import { ensureExtSchema, upsertBatch, num, day } from './schema';

const BASE = 'https://api.navan.com';
const CID = process.env.NAVAN_CLIENT_ID || '';
const CSEC = process.env.NAVAN_CLIENT_SECRET || '';
const HISTORY_START = Math.floor(Date.parse('2015-01-01T00:00:00Z') / 1000);
const COLS = ['uuid', 'booking_type', 'status', 'traveler', 'traveler_email', 'start_date', 'end_date', 'vendor', 'usd_total', 'currency', 'created_at', 'raw'];

async function getToken() {
  const r = await fetch(`${BASE}/ta-auth/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CID, client_secret: CSEC }),
  });
  if (!r.ok) throw new Error(`Navan token ${r.status}`);
  return (await r.json()).access_token;
}

export async function syncNavan() {
  if (!CID || !CSEC) return { source: 'navan', ok: false, rows: 0, skipped: 'Navan credentials not configured' };
  await ensureExtSchema();
  const token = await getToken();
  const nowS = Math.floor(Date.now() / 1000);
  let total = 0;
  for (let page = 0; page < 400; page++) {
    const r = await fetch(`${BASE}/v1/bookings?size=50&page=${page}&createdFrom=${HISTORY_START}&createdTo=${nowS}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (!r.ok) throw new Error(`Navan bookings ${r.status}: ${(await r.text()).slice(0, 140)}`);
    const data = (await r.json()).data || [];
    if (!data.length) break;
    const rows = data.map((b) => {
      const person = b.passengers?.[0]?.person || {};
      return [
        b.uuid, b.bookingType || null, b.bookingStatus || null,
        person.name || b.booker?.name || null, person.email || b.booker?.email || null,
        day(b.startDate), day(b.endDate), b.vendor || null,
        num(b.usdGrandTotal ?? b.grandTotal ?? b.travelSpend), b.currency || null,
        b.created || null, JSON.stringify(b),
      ];
    });
    total += await upsertBatch('ext.navan_booking', COLS, 'uuid', rows, { jsonCols: ['raw'] });
    if (data.length < 50) break;
  }
  return { source: 'navan', ok: true, rows: total };
}
