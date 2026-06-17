// Navan travel — native client. OAuth2 client-credentials token, then paginated
// /v1/bookings over a date window. Computes the Travel Expense Review: trips,
// spend, flight/hotel averages, over-budget + weekend flags, per-traveler totals.
// (TRF/JotForm cross-referencing is a later phase.)
const NAVAN_BASE = 'https://api.navan.com';
const TOKEN_URL = `${NAVAN_BASE}/ta-auth/oauth/token`;
const CID = process.env.NAVAN_CLIENT_ID || '';
const CSEC = process.env.NAVAN_CLIENT_SECRET || '';

// Old-app budget thresholds.
const FLIGHT_RT_MAX = 500;   // round-trip
const FLIGHT_OW_MAX = 250;   // one-way
const HOTEL_NIGHT_MAX = 200; // per night

let _tok = { value: '', exp: 0 };
async function getToken() {
  const now = Date.now();
  if (_tok.value && now < _tok.exp - 60000) return _tok.value;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CID, client_secret: CSEC }),
  });
  if (!res.ok) throw new Error(`Navan token ${res.status}`);
  const j = await res.json();
  _tok = { value: j.access_token, exp: now + (j.expires_in || 3600) * 1000 };
  return _tok.value;
}

async function fetchBookings(days) {
  const token = await getToken();
  const nowS = Math.floor(Date.now() / 1000);
  const fromS = nowS - days * 86400;
  const out = [];
  for (let page = 0; page < 12; page++) {
    const res = await fetch(`${NAVAN_BASE}/v1/bookings?size=50&page=${page}&createdFrom=${fromS}&createdTo=${nowS}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Navan bookings ${res.status}`);
    const d = (await res.json()).data || [];
    out.push(...d);
    if (d.length < 50) break;
  }
  // active bookings only
  return out.filter((b) => b.bookingStatus !== 'CANCELLED' && !b.cancelledAt);
}

const amt = (b) => Number(b.usdGrandTotal || b.grandTotal || b.travelSpend || 0);
const travelerOf = (b) => b.passengers?.[0]?.person?.name || b.booker?.name || '—';

function isWeekend(b) {
  for (const d of [b.startDate, b.endDate]) {
    if (!d) continue;
    const g = new Date(d + 'T00:00:00Z').getUTCDay();
    if (g === 0 || g === 6) return true;
  }
  return false;
}
function overBudget(b) {
  const a = amt(b);
  if (b.bookingType === 'FLIGHT') return a > (/round/i.test(b.routeType || '') ? FLIGHT_RT_MAX : FLIGHT_OW_MAX);
  if (b.bookingType === 'HOTEL') return a / (b.bookingDuration || 1) > HOTEL_NIGHT_MAX;
  return false;
}
function flagReasons(b) {
  const r = [];
  if (overBudget(b)) r.push('over budget');
  if (isWeekend(b)) r.push('weekend');
  return r;
}

export async function travelReview(days = 7) {
  if (!CID || !CSEC) return { ok: false, count: 0, error: 'Navan credentials not configured' };
  try {
    const bs = await fetchBookings(days);
    const flights = bs.filter((b) => b.bookingType === 'FLIGHT');
    const hotels = bs.filter((b) => b.bookingType === 'HOTEL');
    const totalSpend = bs.reduce((s, b) => s + amt(b), 0);
    const flightAvg = flights.length ? flights.reduce((s, b) => s + amt(b), 0) / flights.length : 0;
    const hotelAvg = hotels.length ? hotels.reduce((s, b) => s + amt(b) / (b.bookingDuration || 1), 0) / hotels.length : 0;
    const trips = new Set(bs.map((b) => (b.tripUuids && b.tripUuids[0]) || `${travelerOf(b)}|${b.startDate}`)).size;

    const flagged = bs.map((b) => ({ b, reasons: flagReasons(b) })).filter((x) => x.reasons.length);
    const flaggedSpend = flagged.reduce((s, x) => s + amt(x.b), 0);

    const tmap = {};
    for (const b of bs) {
      const t = travelerOf(b);
      const m = tmap[t] || (tmap[t] = { name: t, spend: 0, flights: 0, hotels: 0, flagged: 0 });
      m.spend += amt(b);
      if (b.bookingType === 'FLIGHT') m.flights++;
      if (b.bookingType === 'HOTEL') m.hotels++;
      if (flagReasons(b).length) m.flagged++;
    }
    const travelers = Object.values(tmap).sort((a, b) => b.spend - a.spend);

    const flaggedList = flagged.sort((a, b) => amt(b.b) - amt(a.b)).slice(0, 50).map((x) => ({
      traveler: travelerOf(x.b), type: x.b.bookingType, vendor: x.b.vendor || '',
      amount: amt(x.b), startDate: x.b.startDate || '', endDate: x.b.endDate || '',
      detail: x.b.bookingType === 'FLIGHT' ? (x.b.airlineRoute || x.b.routeType || '') : (x.b.destination || x.b.tripName || ''),
      reasons: x.reasons,
    }));

    return {
      ok: true, days, count: flagged.length,
      summary: {
        trips, bookings: bs.length, totalSpend,
        flights: { count: flights.length, avg: flightAvg },
        hotels: { count: hotels.length, avgPerNight: hotelAvg },
        overBudget: bs.filter(overBudget).length,
        weekend: bs.filter(isWeekend).length,
        flaggedCount: flagged.length, flaggedSpend,
      },
      travelers, flagged: flaggedList, error: null,
    };
  } catch (e) {
    return { ok: false, count: 0, error: String(e?.message || e) };
  }
}

export async function travelCount(days = 7) {
  const r = await travelReview(days);
  return r.ok ? r.count : null;
}
