// Fetch all upcoming, published, non-hidden events from the Ticket Tailor API
// and write a normalized list to embed/events.json for the frontend to consume.
//
// Usage:
//   TT_API_KEY=sk_xxx node scripts/fetch.mjs
//
// Notes on the TT API (observed via scripts/probe.mjs):
//   - Responses are wrapped as { data: [...] }.
//   - Boolean-ish fields (hidden, private, unavailable, tickets_available) come
//     back as the literal strings "true" / "false" — not real booleans.
//   - /v1/events returns all events, past and future. We filter client-side.
//   - Ticket prices are integer cents.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(__dirname, '..', 'embed', 'events.json');

const apiKey = process.env.TT_API_KEY;
if (!apiKey) {
  console.error('TT_API_KEY is not set. Export it or pass it inline:');
  console.error('  TT_API_KEY=sk_xxx node scripts/fetch.mjs');
  process.exit(1);
}

const auth = 'Basic ' + Buffer.from(apiKey + ':').toString('base64');
const PAGE_LIMIT = 100;
const API_BASE = 'https://api.tickettailor.com';

// Keep events that started up to an hour ago (so "currently happening"
// evening events don't disappear from the list mid-event).
const START_CUTOFF_GRACE_SECONDS = 60 * 60;
// Ignore anything more than a year in the future — guards against stray
// long-range drafts without capping any reasonable real schedule.
const HORIZON_SECONDS = 60 * 60 * 24 * 365;

// Case-insensitive substring blocklist applied to the event name. Events
// matching any of these are filtered out before events.json is written, so
// they never reach the public widget at all. Use for categories that can't
// be caught by TT's hidden/private flags (e.g. members-only gatherings that
// are technically public in TT but shouldn't surface on the public calendar).
const NAME_BLOCKLIST = ['member connection lab'];

async function fetchPage(startingAfter) {
  const url = new URL('/v1/events', API_BASE);
  url.searchParams.set('limit', String(PAGE_LIMIT));
  if (startingAfter) url.searchParams.set('starting_after', startingAfter);

  const res = await fetch(url, {
    headers: {
      Authorization: auth,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      'Ticket Tailor API returned ' + res.status + ' ' + res.statusText +
      ' for ' + url.toString() + '\n' + body.slice(0, 800)
    );
  }

  return res.json();
}

async function fetchAllEvents() {
  const all = [];
  let cursor = null;
  // Safety valve: if the cursor logic ever breaks, don't spin forever.
  const HARD_CAP = 5000;

  while (true) {
    const page = await fetchPage(cursor);
    const data = Array.isArray(page.data) ? page.data : [];
    all.push(...data);

    if (data.length < PAGE_LIMIT) break;
    cursor = data[data.length - 1].id;

    if (all.length >= HARD_CAP) {
      throw new Error('Aborting: fetched ' + all.length + ' events, pagination may be broken.');
    }
  }

  return all;
}

function truthy(v) {
  return v === true || v === 'true';
}

function normalizeEvent(ev) {
  const ticketTypes = Array.isArray(ev.ticket_types) ? ev.ticket_types : [];
  const onSale = ticketTypes.filter(t => t && t.status === 'on_sale');
  const minPriceCents = onSale.length
    ? Math.min(...onSale.map(t => Number(t.price) || 0))
    : null;

  return {
    id: ev.id,
    name: ev.name || '',
    description_html: ev.description || '',
    start_iso: ev.start?.iso || null,
    end_iso: ev.end?.iso || null,
    start_unix: ev.start?.unix ?? null,
    end_unix: ev.end?.unix ?? null,
    timezone: ev.timezone || null,
    venue_name: ev.venue?.name || '',
    image_header: ev.images?.header || null,
    image_thumbnail: ev.images?.thumbnail || null,
    checkout_url: ev.checkout_url || ev.url || null,
    event_url: ev.url || null,
    call_to_action: ev.call_to_action || 'Buy tickets',
    price_min_cents: minPriceCents,
    currency: (ev.currency || 'usd').toLowerCase(),
    sold_out: ticketTypes.length > 0 && onSale.length === 0,
  };
}

function isRelevant(ev, nowUnix) {
  if (ev.status !== 'published') return false;
  if (truthy(ev.hidden)) return false;
  if (truthy(ev.private)) return false;
  const name = (ev.name || '').toLowerCase();
  if (NAME_BLOCKLIST.some((term) => name.includes(term))) return false;
  const startUnix = ev.start?.unix;
  if (!startUnix) return false;
  if (startUnix < nowUnix - START_CUTOFF_GRACE_SECONDS) return false;
  if (startUnix > nowUnix + HORIZON_SECONDS) return false;
  return true;
}

const nowUnix = Math.floor(Date.now() / 1000);

console.log('Fetching events from Ticket Tailor…');
const raw = await fetchAllEvents();
console.log('Fetched ' + raw.length + ' total events.');

const upcoming = raw
  .filter(ev => isRelevant(ev, nowUnix))
  .sort((a, b) => (a.start?.unix || 0) - (b.start?.unix || 0))
  .map(normalizeEvent);

console.log('Kept ' + upcoming.length + ' upcoming published events.');

const output = {
  generated_at: new Date().toISOString(),
  count: upcoming.length,
  events: upcoming,
};

await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');
console.log('Wrote ' + OUTPUT_PATH);
