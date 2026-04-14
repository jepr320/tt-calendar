// Probe the Ticket Tailor API so we can see the real shape of event objects
// before writing the real fetch / render code against it.
//
// Usage:
//   TT_API_KEY=sk_xxx node scripts/probe.mjs
//
// Prints the first few objects from /v1/events and /v1/event_series plus
// rate-limit headers. Nothing is written to disk; paste the output back to
// Claude so we can map real field names.

const apiKey = process.env.TT_API_KEY;
if (!apiKey) {
  console.error('Set TT_API_KEY in your environment first, e.g.:');
  console.error('  TT_API_KEY=sk_xxx node scripts/probe.mjs');
  process.exit(1);
}

const auth = 'Basic ' + Buffer.from(apiKey + ':').toString('base64');

async function probe(path) {
  const url = new URL(path, 'https://api.tickettailor.com');
  console.log('\n=== GET ' + url.toString());
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: auth,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    console.error('Network error:', err.message);
    return;
  }
  console.log('Status:', res.status, res.statusText);
  const limit = res.headers.get('x-rate-limit-limit');
  const remaining = res.headers.get('x-rate-limit-remaining');
  if (limit || remaining) {
    console.log('Rate limit: ' + remaining + ' / ' + limit + ' remaining');
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.log('Body (non-JSON):');
    console.log(text.slice(0, 2000));
    return;
  }
  const pretty = JSON.stringify(json, null, 2);
  if (pretty.length > 12000) {
    console.log(pretty.slice(0, 12000));
    console.log('... [truncated, ' + (pretty.length - 12000) + ' more chars]');
  } else {
    console.log(pretty);
  }
}

await probe('/v1/events?limit=3');
await probe('/v1/event_series?limit=3');
