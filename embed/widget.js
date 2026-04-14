// Colorado Connection Collective — Ticket Tailor calendar widget.
//
// Fetches embed/events.json (produced by scripts/fetch.mjs on a cron) and
// renders into any element with the class `tt-calendar-widget`. Each
// mount reads per-instance options from data attributes so you can drop
// a list in one Squarespace code block and a calendar in another:
//
//   <div class="tt-calendar-widget" data-view="list" data-days="45"></div>
//   <div class="tt-calendar-widget" data-view="calendar"></div>
//
// Supported data attributes:
//   data-view   — "list" | "calendar" | "both" (default: "both")
//   data-days   — optional horizon in days; only show events starting
//                 within N days from now. Applies to both views.
//
// Clicking any event opens the TT event page in a full-screen modal
// iframe (with ?modal_widget=true&widget=true appended). TT then hands
// checkout off to a new tab because their checkout pages set
// X-Frame-Options: SAMEORIGIN — unavoidable without a custom domain.

(function () {
  const selfScript = document.currentScript;

  const MOUNT_SELECTOR = '.tt-calendar-widget';

  // Case-insensitive substring blocklist applied to event title +
  // plain-text description. Server-side fetch.mjs already filters events by
  // name; this is a browser-side safety net you can extend if needed.
  const HIDE_KEYWORDS = [];

  const DESCRIPTION_SNIPPET_CHARS = 220;

  const FALLBACK_URL =
    'https://www.tickettailor.com/all-tickets-full-calendar/coloradoconnectioncollective/';

  function resolveEventsUrl() {
    if (selfScript && selfScript.dataset && selfScript.dataset.eventsUrl) {
      return selfScript.dataset.eventsUrl;
    }
    if (selfScript && selfScript.src) {
      return new URL('events.json', selfScript.src).toString();
    }
    return 'events.json';
  }
  const EVENTS_URL = resolveEventsUrl();

  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  // ---------- Small helpers ----------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function stripHtml(html) {
    if (!html) return '';
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return doc.body.textContent || '';
  }

  function truncate(text, max) {
    const clean = (text || '').trim().replace(/\s+/g, ' ');
    if (clean.length <= max) return clean;
    const cut = clean.slice(0, max);
    const lastSpace = cut.lastIndexOf(' ');
    return cut.slice(0, lastSpace > 60 ? lastSpace : max).trim() + '…';
  }

  function parseStart(ev) {
    if (ev.start_iso) return new Date(ev.start_iso);
    if (ev.start_unix) return new Date(ev.start_unix * 1000);
    return new Date(NaN);
  }

  function formatEventDate(ev) {
    const d = parseStart(ev);
    if (isNaN(d.getTime())) return '';
    const datePart = d.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    const timePart = d.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
    return datePart + ' · ' + timePart;
  }

  function localDateKey(d) {
    return (
      d.getFullYear() +
      '-' +
      String(d.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(d.getDate()).padStart(2, '0')
    );
  }

  function shouldShow(ev) {
    if (!HIDE_KEYWORDS.length) return true;
    const hay = ((ev.name || '') + ' ' + stripHtml(ev.description_html || '')).toLowerCase();
    return !HIDE_KEYWORDS.some((k) => hay.includes(k.toLowerCase()));
  }

  // ---------- Event modal ----------
  //
  // Opens TT's own event page (event_url) in an iframe with TT's modal
  // params (`modal_widget=true&widget=true`). This shows the full TT
  // marketing page + description + ticket picker inside our modal.
  //
  // Clicking "Next" on the ticket picker will break out into a new tab.
  // That's unavoidable: TT's checkout pages set `X-Frame-Options:
  // SAMEORIGIN`, so the browser refuses cross-origin iframing of anything
  // past the ticket picker. Per TT support, the only way to keep the full
  // checkout on-site is to set up a custom domain in the TT box office.
  // Until then, this is the nicest option — users get a slick modal for
  // browsing and picking tickets, then TT takes over in a fresh tab.

  // Append the query params TT's widget.js appends when it hands a URL off
  // to its modal. `widget=true` puts the TT page in embeddable mode,
  // `modal_widget=true` unlocks its modal-specific layout, and the
  // bg_fill flip matches what TT does internally.
  function buildModalUrl(rawUrl) {
    const hashIdx = rawUrl.indexOf('#');
    let base = rawUrl;
    let hash = '';
    if (hashIdx !== -1) {
      hash = rawUrl.substring(hashIdx);
      base = rawUrl.substring(0, hashIdx);
    }
    base += base.indexOf('?') === -1 ? '?' : '&';
    base += 'modal_widget=true&widget=true';
    base = base.replace('bg_fill=false', 'bg_fill=true');
    if (window.location.protocol === 'https:' && base.indexOf('http:') === 0) {
      base = 'https:' + base.slice(5);
    }
    return base + hash;
  }

  let activeModal = null;

  function openEventModal(ev) {
    const startUrl = ev.event_url || ev.checkout_url;
    if (!startUrl) return false;

    if (activeModal) activeModal.teardown();

    const backdrop = el('div', 'ttc-modal-backdrop');
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-label', ev.name || 'Event details');

    const frame = el('div', 'ttc-modal-frame');

    const iframe = document.createElement('iframe');
    iframe.className = 'ttc-modal-iframe';
    iframe.src = buildModalUrl(startUrl);
    iframe.setAttribute('allow', 'fullscreen; payment');
    iframe.setAttribute('allowfullscreen', 'true');
    iframe.title = ev.name || 'Event';

    const closeBtn = el('button', 'ttc-modal-close', '×');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');

    frame.appendChild(iframe);
    frame.appendChild(closeBtn);
    backdrop.appendChild(frame);
    document.body.appendChild(backdrop);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function teardown() {
      window.removeEventListener('keydown', onKey);
      backdrop.remove();
      document.body.style.overflow = previousOverflow;
      activeModal = null;
    }

    function onKey(e) {
      if (e.key === 'Escape') teardown();
    }

    closeBtn.addEventListener('click', teardown);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) teardown();
    });
    window.addEventListener('keydown', onKey);

    activeModal = { teardown };
    return true;
  }

  // Shared click handler: open the event modal, but let modifier-click fall
  // through to a regular new-tab navigation.
  function bindEventClick(anchor, ev) {
    anchor.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
      e.preventDefault();
      if (!openEventModal(ev)) {
        window.open(anchor.href, '_blank', 'noopener');
      }
    });
  }

  // ---------- List view ----------

  function renderList(events) {
    const wrap = el('section', 'ttc-list');
    wrap.appendChild(el('h2', 'ttc-list-heading', 'Upcoming events'));
    const container = el('div', 'ttc-cards');
    for (const ev of events) container.appendChild(renderCard(ev));
    wrap.appendChild(container);
    return wrap;
  }

  function renderCard(ev) {
    const card = document.createElement('a');
    card.className = 'ttc-card';
    // event_url is the marketing page (image + full description + ticket
    // picker); the modal starts there and flows through to checkout.
    card.href = ev.event_url || ev.checkout_url || FALLBACK_URL;
    card.target = '_blank';
    card.rel = 'noopener';
    card.id = 'ttc-card-' + ev.id;

    const imgSrc = ev.image_header || ev.image_thumbnail;
    if (imgSrc) {
      const img = document.createElement('img');
      img.className = 'ttc-card-image';
      img.src = imgSrc;
      img.alt = ev.name || '';
      img.loading = 'lazy';
      card.appendChild(img);
    }

    const body = el('div', 'ttc-card-body');
    body.appendChild(el('h3', 'ttc-card-title', ev.name || 'Untitled event'));

    const meta = el('div', 'ttc-card-meta');
    const when = formatEventDate(ev);
    if (when) meta.appendChild(el('span', 'ttc-card-when', when));
    if (ev.venue_name) {
      if (when) meta.appendChild(el('span', 'ttc-card-dot', '·'));
      meta.appendChild(el('span', 'ttc-card-venue', ev.venue_name));
    }
    body.appendChild(meta);

    const desc = truncate(stripHtml(ev.description_html || ''), DESCRIPTION_SNIPPET_CHARS);
    if (desc) body.appendChild(el('p', 'ttc-card-desc', desc));

    const cta = el(
      'span',
      'ttc-card-cta' + (ev.sold_out ? ' ttc-card-cta-disabled' : ''),
      ev.sold_out ? 'Sold out' : 'View event',
    );
    body.appendChild(cta);

    card.appendChild(body);

    if (!ev.sold_out) bindEventClick(card, ev);
    return card;
  }

  // ---------- Calendar view ----------

  function renderCalendar(events) {
    const wrap = el('section', 'ttc-calendar');

    const eventsByDay = new Map();
    for (const ev of events) {
      const d = parseStart(ev);
      if (isNaN(d.getTime())) continue;
      const key = localDateKey(d);
      if (!eventsByDay.has(key)) eventsByDay.set(key, []);
      eventsByDay.get(key).push(ev);
    }

    const now = new Date();
    let viewYear = now.getFullYear();
    let viewMonth = now.getMonth();

    // If the current month has no events, jump to the first *upcoming*
    // month that does (not just the first overall, which would land us
    // in the distant past when past events are included).
    const currentKey = viewYear + '-' + viewMonth;
    const monthsWithEvents = new Set();
    for (const ev of events) {
      const d = parseStart(ev);
      if (!isNaN(d.getTime())) {
        monthsWithEvents.add(d.getFullYear() + '-' + d.getMonth());
      }
    }
    if (!monthsWithEvents.has(currentKey) && events.length) {
      const nowUnix = Date.now() / 1000;
      const upcoming = events.find((ev) => (ev.start_unix || 0) >= nowUnix);
      const picked = parseStart(upcoming || events[0]);
      viewYear = picked.getFullYear();
      viewMonth = picked.getMonth();
    }

    const container = el('div', 'ttc-calendar-container');
    wrap.appendChild(container);

    function render() {
      container.innerHTML = '';
      container.appendChild(
        renderMonth(viewYear, viewMonth, eventsByDay, (year, month) => {
          viewYear = year;
          viewMonth = month;
          render();
        }),
      );
    }
    render();
    return wrap;
  }

  function renderMonth(year, month, eventsByDay, onNav) {
    const wrap = el('div', 'ttc-month');

    const header = el('div', 'ttc-month-header');
    const prev = el('button', 'ttc-month-nav', '‹');
    prev.type = 'button';
    prev.setAttribute('aria-label', 'Previous month');
    prev.addEventListener('click', () => {
      const m = month - 1;
      onNav(m < 0 ? year - 1 : year, (m + 12) % 12);
    });
    const title = el('div', 'ttc-month-title', MONTH_NAMES[month] + ' ' + year);
    const next = el('button', 'ttc-month-nav', '›');
    next.type = 'button';
    next.setAttribute('aria-label', 'Next month');
    next.addEventListener('click', () => {
      const m = month + 1;
      onNav(m > 11 ? year + 1 : year, m % 12);
    });
    header.appendChild(prev);
    header.appendChild(title);
    header.appendChild(next);
    wrap.appendChild(header);

    const dow = el('div', 'ttc-month-dow');
    for (const name of DAY_NAMES) dow.appendChild(el('div', 'ttc-month-dow-cell', name));
    wrap.appendChild(dow);

    const grid = el('div', 'ttc-month-grid');
    const first = new Date(year, month, 1);
    const startOffset = first.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;
    const todayKey = localDateKey(new Date());

    for (let i = 0; i < totalCells; i++) {
      const dayNum = i - startOffset + 1;
      const inMonth = dayNum >= 1 && dayNum <= daysInMonth;
      const cell = el('div', 'ttc-day' + (inMonth ? '' : ' ttc-day-off'));

      if (inMonth) {
        const key =
          year +
          '-' +
          String(month + 1).padStart(2, '0') +
          '-' +
          String(dayNum).padStart(2, '0');
        const dayEvents = eventsByDay.get(key) || [];

        cell.appendChild(el('div', 'ttc-day-num', String(dayNum)));
        if (key === todayKey) cell.classList.add('ttc-day-today');

        if (dayEvents.length === 1) {
          // Single event: fill the cell with the event image and make the
          // whole square clickable. Day number overlays the image.
          cell.classList.add('ttc-day-has-event', 'ttc-day-single');
          cell.appendChild(renderDaySingleEvent(dayEvents[0]));
        } else if (dayEvents.length > 1) {
          cell.classList.add('ttc-day-has-event');
          const list = el('div', 'ttc-day-events');
          for (const ev of dayEvents.slice(0, 3)) {
            list.appendChild(renderDayEventTile(ev));
          }
          if (dayEvents.length > 3) {
            list.appendChild(
              el('span', 'ttc-day-event-more', '+' + (dayEvents.length - 3) + ' more'),
            );
          }
          cell.appendChild(list);
        }
      }

      grid.appendChild(cell);
    }

    wrap.appendChild(grid);
    return wrap;
  }

  function renderDaySingleEvent(ev) {
    const link = document.createElement('a');
    link.className = 'ttc-day-single-link';
    link.href = ev.event_url || ev.checkout_url || FALLBACK_URL;
    link.target = '_blank';
    link.rel = 'noopener';
    link.title = ev.name || '';

    const imgSrc = ev.image_header || ev.image_thumbnail;
    if (imgSrc) {
      const img = document.createElement('img');
      img.className = 'ttc-day-single-img';
      img.src = imgSrc;
      img.alt = ev.name || '';
      img.loading = 'lazy';
      link.appendChild(img);
    }

    if (!ev.sold_out) bindEventClick(link, ev);
    return link;
  }

  function renderDayEventTile(ev) {
    const link = document.createElement('a');
    link.className = 'ttc-day-event';
    link.href = ev.event_url || ev.checkout_url || FALLBACK_URL;
    link.target = '_blank';
    link.rel = 'noopener';
    link.title = ev.name || '';

    if (ev.image_thumbnail || ev.image_header) {
      const img = document.createElement('img');
      img.className = 'ttc-day-event-thumb';
      img.src = ev.image_thumbnail || ev.image_header;
      img.alt = '';
      img.loading = 'lazy';
      link.appendChild(img);
    }
    link.appendChild(el('span', 'ttc-day-event-title', ev.name || 'Event'));

    if (!ev.sold_out) bindEventClick(link, ev);
    return link;
  }

  // ---------- Boot ----------

  // Cache the fetch promise so multiple mounts on the same page share a
  // single request. If the user pastes both a list block and a calendar
  // block into Squarespace, they'll read from the same in-flight promise.
  let eventsPromise = null;
  function loadEvents() {
    if (!eventsPromise) {
      eventsPromise = fetch(EVENTS_URL, { cache: 'no-cache' })
        .then((res) => {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then((data) => (data.events || []).filter(shouldShow));
    }
    return eventsPromise;
  }

  // Upcoming-only filter with a small grace period so an event that
  // started an hour ago (currently happening) still shows in the list.
  function filterUpcoming(events, days) {
    const now = Date.now() / 1000;
    const lower = now - 60 * 60;
    const upper = days ? now + days * 24 * 60 * 60 : Infinity;
    return events.filter((ev) => {
      const t = ev.start_unix || 0;
      return t >= lower && t <= upper;
    });
  }

  async function mount(root) {
    // Guard against double-mounting — if the user includes <script> in two
    // Squarespace code blocks, the IIFE runs twice.
    if (root.dataset.ttcMounted) return;
    root.dataset.ttcMounted = '1';

    const view = (root.dataset.view || 'both').toLowerCase();
    const daysRaw = parseInt(root.dataset.days, 10);
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : null;

    root.classList.add('ttc-root');
    root.innerHTML = '<div class="ttc-loading">Loading events…</div>';

    let events;
    try {
      events = await loadEvents();
    } catch (err) {
      console.error('[tt-calendar] failed to load', EVENTS_URL, err);
      root.innerHTML =
        '<div class="ttc-error">We couldn\u2019t load the event list right now. ' +
        '<a href="' + FALLBACK_URL + '" target="_blank" rel="noopener">See all events on Ticket Tailor</a>.</div>';
      return;
    }

    // List view: upcoming only, optionally capped to N days.
    // Calendar view: everything we fetched (past + upcoming).
    const listEvents = filterUpcoming(events, days);
    const calendarEvents = events;

    const willRenderList = view === 'list' || view === 'both';
    const willRenderCalendar = view === 'calendar' || view === 'both';

    // Empty state only blocks rendering when nothing at all would appear.
    if (
      (!willRenderList || !listEvents.length) &&
      (!willRenderCalendar || !calendarEvents.length)
    ) {
      root.innerHTML = '<div class="ttc-empty">No upcoming events right now — check back soon.</div>';
      return;
    }

    root.innerHTML = '';
    if (willRenderList && listEvents.length) {
      root.appendChild(renderList(listEvents));
    }
    if (willRenderCalendar && calendarEvents.length) {
      root.appendChild(renderCalendar(calendarEvents));
    }
  }

  function main() {
    const mounts = document.querySelectorAll(MOUNT_SELECTOR);
    if (!mounts.length) {
      console.error(
        '[tt-calendar] No mount found. Add <div class="tt-calendar-widget"></div> to the page.',
      );
      return;
    }
    mounts.forEach(mount);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
