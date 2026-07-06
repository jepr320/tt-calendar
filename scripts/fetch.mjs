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

// Include past events going back this far so the calendar view can show
// historical activity. The list view filters these out client-side;
// only the calendar renders them. Three years is enough to give a sense
// of history without bloating events.json.
const PAST_HORIZON_SECONDS = 60 * 60 * 24 * 365 * 3;
// Ignore anything more than a year in the future — guards against stray
// long-range drafts without capping any reasonable real schedule.
const HORIZON_SECONDS = 60 * 60 * 24 * 365;

// The portal (admin app) exposes affiliate — i.e. non–Ticket-Tailor — events as
// a pre-normalized JSON feed. We fetch it server-side here and merge it into
// events.json so the public calendar shows those too. Non-fatal: if it fails,
// the Ticket Tailor events still publish. Override with PORTAL_EVENTS_URL
// (e.g. ...?scope=all to later source everything from the portal).
const PORTAL_EVENTS_URL = process.env.PORTAL_EVENTS_URL
  || 'https://admin.coloradoconnectioncollective.com/events/calendar/public.json?scope=affiliate';

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

async function fetchPortalEvents() {
  try {
    const res = await fetch(PORTAL_EVENTS_URL, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const events = Array.isArray(data.events) ? data.events : [];
    console.log('Fetched ' + events.length + ' portal (affiliate) events.');
    return events;
  } catch (err) {
    console.warn(
      'Portal events fetch failed (' + err.message + '); ' +
      'publishing Ticket Tailor events only.'
    );
    return [];
  }
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
    source: 'ticket_tailor',
  };
}

function isRelevant(ev, nowUnix) {
  if (ev.status !== 'published') return false;
  if (truthy(ev.hidden)) return false;
  if (truthy(ev.private)) return false;
  // Members-only events are intentionally shown on the public calendar now —
  // anyone can see them; Ticket Tailor still gates who can actually sign up.
  const startUnix = ev.start?.unix;
  if (!startUnix) return false;
  if (startUnix < nowUnix - PAST_HORIZON_SECONDS) return false;
  if (startUnix > nowUnix + HORIZON_SECONDS) return false;
  return true;
}

const nowUnix = Math.floor(Date.now() / 1000);

console.log('Fetching events from Ticket Tailor…');
const raw = await fetchAllEvents();
console.log('Fetched ' + raw.length + ' total events.');

const kept = raw
  .filter(ev => isRelevant(ev, nowUnix))
  .map(normalizeEvent);

console.log('Kept ' + kept.length + ' published Ticket Tailor events (past + upcoming).');

// Merge in the portal's affiliate events, then sort the combined list by
// start time (both sources expose start_unix).
const portalEvents = await fetchPortalEvents();
const merged = [...kept, ...portalEvents]
  .sort((a, b) => (a.start_unix || 0) - (b.start_unix || 0));

console.log('Total after merge: ' + merged.length + ' events.');

const output = {
  generated_at: new Date().toISOString(),
  count: merged.length,
  events: merged,
};

await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');
console.log('Wrote ' + OUTPUT_PATH);
