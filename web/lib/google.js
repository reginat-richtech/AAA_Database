// Google Calendar + Gmail via a service account with domain-wide delegation
// (impersonates GOOGLE_IMPERSONATE_SUBJECT). Everything degrades gracefully:
// if creds/package are missing, calls return { skipped: '...' } instead of throwing.
import { readFileSync } from 'node:fs';
import path from 'node:path';

let _clients;
async function getClients() {
  if (_clients !== undefined) return _clients;
  const saRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const subject = process.env.GOOGLE_IMPERSONATE_SUBJECT;
  if (!saRaw || !subject) { _clients = null; return null; }
  try {
    // Accept the service-account creds as either inline JSON (a cloud app setting
    // / Key Vault reference, used in production) or a path to a JSON file (local
    // dev). Inline JSON starts with '{'; anything else is treated as a file path.
    const trimmed = saRaw.trim();
    const sa = JSON.parse(trimmed.startsWith('{') ? trimmed : readFileSync(path.resolve(trimmed), 'utf8'));
    const { google } = await import('googleapis');
    const auth = new google.auth.JWT({
      email: sa.client_email,
      key: sa.private_key,
      subject,
      scopes: [
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/gmail.send',
      ],
    });
    _clients = { google, auth, subject };
  } catch (e) {
    _clients = null;
  }
  return _clients;
}

export async function calendarCreate({ summary, description, date, attendees }) {
  const c = await getClients();
  if (!c) return { skipped: 'Google service account not configured' };
  try {
    const cal = c.google.calendar({ version: 'v3', auth: c.auth });
    const res = await cal.events.insert({
      calendarId: 'primary',
      sendUpdates: 'all',
      requestBody: {
        summary,
        description,
        start: { date }, // all-day
        end: { date },
        attendees: (attendees || []).filter(Boolean).map((email) => ({ email })),
      },
    });
    return { event_id: res.data.id, html_link: res.data.htmlLink, organizer: c.subject, date };
  } catch (e) {
    return { error: String(e?.message || e), date };
  }
}

export async function sendEmail({ to, subject, text, html }) {
  const c = await getClients();
  if (!c) return { to, skipped: 'Google service account not configured' };
  try {
    const gmail = c.google.gmail({ version: 'v1', auth: c.auth });
    const mime = [
      `To: ${to}`, `From: ${c.subject}`, `Subject: ${subject}`,
      'MIME-Version: 1.0', 'Content-Type: text/html; charset=UTF-8', '', html || text || '',
    ].join('\r\n');
    const raw = Buffer.from(mime).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    return { to, sent: true, method: 'gmail' };
  } catch (e) {
    return { to, error: String(e?.message || e) };
  }
}
