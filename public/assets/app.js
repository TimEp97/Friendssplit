// FriendSplit – Frontend. Reines JavaScript ohne Build-Schritt.
// Alle Daten kommen von der API (api/index.php). Angemeldet wird mit E-Mail und Passwort;
// die Sitzung liegt in einem HttpOnly-Cookie, das JavaScript nicht lesen kann.

const API_URL = 'api/index.php';
const POLL_MS = 15000;
const MAX_AMOUNT_CENTS = 10_000_000;

const CATEGORIES = [
  { key: 'getraenke', label: 'Getränke', icon: '🍹' },
  { key: 'essen', label: 'Essen', icon: '🍕' },
  { key: 'tickets', label: 'Tickets', icon: '🎟️' },
  { key: 'transport', label: 'Transport', icon: '🚕' },
  { key: 'unterkunft', label: 'Unterkunft', icon: '🏨' },
  { key: 'sonstiges', label: 'Sonstiges', icon: '🛍️' },
];
const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.key, c]));
const CODE_ALPHABET = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/;

// ---------------------------------------------------------------- HTML-Hilfen

class Raw {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}
const raw = (value) => new Raw(value);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const part = (v) => (v instanceof Raw ? v.value : Array.isArray(v) ? v.map(part).join('') : v === false || v == null ? '' : esc(v));
/** Template-Tag: Werte werden automatisch escaped, außer sie sind mit raw()/html`` erzeugt. */
function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => { out += part(v) + strings[i + 1]; });
  return raw(out);
}

const ICONS = {
  events: '<path d="M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z"/>',
  expenses: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6M9 12h6"/>',
  settle: '<path d="M7 7h11l-3-3M17 17H6l3 3"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M17 14.5c2.3 0 4 1.5 4.5 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  share: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4.5 4.4-7 8-7s7 2.5 8 7"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
};
const icon = (name, cls = 'icon') => raw(`<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`);

// ---------------------------------------------------------------- Formatierung

const euroFormat = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const euro = (cents) => euroFormat.format(Math.abs(cents) / 100);
const signedEuro = (cents) => (cents > 0 ? '+' : cents < 0 ? '−' : '') + euro(cents);
const amountInput = (cents) => (cents / 100).toFixed(2).replace('.', ',');

/** PayPal.me-Link, der direkt mit dem Betrag in Euro öffnet, z. B. https://www.paypal.me/alex/12.34EUR */
const paypalLink = (handle, cents) => `https://www.paypal.me/${encodeURIComponent(handle)}${cents ? `/${(cents / 100).toFixed(2)}EUR` : ''}`;
const canScanQr = () => 'BarcodeDetector' in window;

/** "42,50", "42.5", "1.234,56 €" → Cent als ganze Zahl; ungültig → null */
function parseAmount(input) {
  let s = String(input ?? '').trim().replace(/[\s€]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

const parseLocalDate = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d); };
const parseLocalDateTime = (s) => { const [d, t = '00:00'] = s.split('T'); const [h, min] = t.split(':').map(Number); const date = parseLocalDate(d); date.setHours(h, min); return date; };
const formatDate = (ymd) => parseLocalDate(ymd).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const formatDayHeading = (ymd) => parseLocalDate(ymd).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const formatTime = (dt) => parseLocalDateTime(dt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const formatDateTime = (iso) => new Date(iso).toLocaleString('de-DE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const pad = (n) => String(n).padStart(2, '0');
function nowLocalInput() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const relFormat = new Intl.RelativeTimeFormat('de', { numeric: 'auto' });
function relativeTime(iso) {
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return 'gerade eben';
  if (abs < 3600) return relFormat.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return relFormat.format(Math.round(diff / 3600), 'hour');
  if (abs < 7 * 86400) return relFormat.format(Math.round(diff / 86400), 'day');
  return formatDateTime(iso);
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const joinNames = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}`);

const normalizeCode = (value) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const formatCode = (code) => code.match(/.{1,4}/g)?.join('-') ?? code;
const eventLink = (code) => `${location.origin}${location.pathname}#/e/${code}`;

/** Gleiche Rundungsregel wie auf dem Server (Split::equal) – nur für die Vorschau im Formular. */
function splitEqual(amount, ids, payer) {
  const n = ids.length;
  const base = Math.floor(amount / n);
  const rest = amount % n;
  const order = payer && ids.includes(payer) ? [payer, ...ids.filter((id) => id !== payer)] : ids;
  const shares = Object.fromEntries(ids.map((id) => [id, base]));
  for (let i = 0; i < rest; i++) shares[order[i]]++;
  return shares;
}

function randomToken() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- Lokaler Speicher (nur Komfort)

const local = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* privater Modus o. Ä. */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignorieren */ } },
};
const lastEventCode = () => local.get('fs.lastEvent', null);
/** Ziel nach der Anmeldung merken – auch über den Bestätigungslink in einem neuen Tab hinweg. */
const rememberAfterLogin = (hash) => (hash && hash.startsWith('#/e/') ? local.set('fs.afterLogin', hash) : local.remove('fs.afterLogin'));
function takeAfterLogin() {
  const hash = local.get('fs.afterLogin', null);
  local.remove('fs.afterLogin');
  return hash && hash.startsWith('#/e/') ? hash : '#/';
}
/** Eigene Person im geöffneten Event – kommt vom Server, abhängig vom angemeldeten Konto. */
const getMe = (code) => (S.data && S.data.event.code === code ? S.data.me : null);

// ---------------------------------------------------------------- API

class ApiError extends Error {
  constructor(code, message, { fields = null, status = 0, data = null } = {}) {
    super(message);
    Object.assign(this, { code, fields, status, data });
  }
}

async function api(action, { body = null, code = null } = {}) {
  const headers = { Accept: 'application/json' };
  if (code) headers['X-Event-Code'] = code;
  if (body) {
    headers['Content-Type'] = 'application/json';
    headers['X-Requested-With'] = 'FriendSplit'; // Schutz vor CSRF, prüft der Server
  }
  let response;
  try {
    response = await fetch(`${API_URL}?action=${encodeURIComponent(action)}`, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError('network', 'Keine Verbindung zum Server. Bitte prüfe deine Internetverbindung und versuche es erneut.');
  }
  let json = null;
  try { json = await response.json(); } catch { /* keine JSON-Antwort */ }
  if (!json) throw new ApiError('bad_response', `Unerwartete Antwort vom Server (HTTP ${response.status}). Die Änderung wurde möglicherweise nicht gespeichert.`, { status: response.status });
  if (!response.ok || !json.ok) {
    const e = json.error ?? {};
    if (e.code === 'not_authenticated' && S.user) {
      // Sitzung abgelaufen oder anderswo abgemeldet → zur Anmeldung
      S.user = null;
      rememberAfterLogin(location.hash);
      setTimeout(() => go('#/login'), 0);
    }
    throw new ApiError(e.code ?? 'error', e.message ?? 'Unbekannter Fehler.', { fields: e.fields, status: response.status, data: e.data });
  }
  return json.data;
}

// ---------------------------------------------------------------- Zustand

const S = {
  route: { name: 'home' },
  code: null,
  data: null,
  dataJson: '',
  loading: false,
  loadError: null,
  stale: false,
  filters: { person: '', category: '' },
  openDetails: new Set(),
  createPeople: [],
  form: null, // { token, version, expenseId }
  conflict: null,
  renaming: null,
  editingPaypal: null,
  editingEvent: false,
  afterPick: null,
  user: undefined, // undefined = noch nicht geprüft, null = abgemeldet, sonst Profil vom Server
  notice: null, // Hinweis nach Registrierung o. Ä.: { email, kind }
  verifying: null, // Zustand beim Bestätigen per E-Mail-Link
};

const main = document.getElementById('main');
const tabbar = document.getElementById('tabbar');
const person = (id) => S.data?.participants.find((p) => p.id === id) ?? null;
const personName = (id) => person(id)?.name ?? 'Ehemalige Person';
const avatarClass = (id) => `avatar avatar--c${[...String(id)].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 8}`;
const avatar = (id, name) => html`<span class="${avatarClass(id)}" aria-hidden="true">${(name || '?').trim().charAt(0).toUpperCase()}</span>`;

function applyState(data) {
  const json = JSON.stringify(data);
  const changed = json !== S.dataJson;
  S.data = data;
  S.dataJson = json;
  S.stale = false;
  local.set('fs.lastEvent', data.event.code);
  if (S.user && data.me && !S.user.events.some((e) => e.code === data.event.code)) {
    S.user.events.unshift({ code: data.event.code, name: data.event.name, date: data.event.date });
  }
  return changed;
}

async function loadEvent({ silent = false } = {}) {
  const code = S.code;
  if (!silent) S.loading = true;
  try {
    const data = await api('event', { code });
    if (code !== S.code) return false;
    S.loadError = null;
    return applyState(data);
  } catch (error) {
    if (code !== S.code) return false;
    if (S.data && silent) S.stale = true;
    else S.loadError = error;
    return true;
  } finally {
    if (code === S.code) S.loading = false;
  }
}

// ---------------------------------------------------------------- Routing

function parseRoute() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'neu') return { name: 'create' };
  if (parts[0] === 'login') return { name: 'login' };
  if (parts[0] === 'registrieren') return { name: 'register' };
  if (parts[0] === 'passwort-vergessen') return { name: 'forgot' };
  if (parts[0] === 'bestaetigen' && parts[1]) return { name: 'verify', token: parts[1] };
  if (parts[0] === 'passwort-neu' && parts[1]) return { name: 'reset', token: parts[1] };
  if (parts[0] === 'email-bestaetigen' && parts[1]) return { name: 'verify', token: parts[1], kind: 'email' };
  if (parts[0] === 'profil') return { name: 'profile' };
  if (parts[0] === 'e' && parts[1]) {
    const code = normalizeCode(parts[1]);
    if (parts[2] === 'ausgabe') return { name: 'expense', code, expenseId: parts[3] && parts[3] !== 'neu' ? parts[3] : null };
    const sub = ['ausgaben', 'abrechnung', 'personen', 'wer'].includes(parts[2]) ? parts[2] : 'ausgaben';
    return { name: sub, code, query: new URLSearchParams(query) };
  }
  return { name: 'home' };
}

const go = (hash) => { if (location.hash === hash) onRoute(); else location.hash = hash; };
const eventPath = (sub = 'ausgaben') => `#/e/${S.code}/${sub}`;

const PUBLIC_ROUTES = ['login', 'register', 'forgot', 'verify', 'reset'];

async function loadUser() {
  try {
    S.user = (await api('me')).user;
  } catch (error) {
    S.user = error.code === 'not_authenticated' ? null : undefined;
    if (S.user === undefined) throw error;
  }
}

async function onRoute() {
  let route = parseRoute();
  if (S.user === undefined) {
    try { await loadUser(); } catch (error) { main.innerHTML = String(viewOffline(error)); return; }
    route = parseRoute();
  }
  // Ohne Anmeldung nur Login, Registrierung und E-Mail-Links; angemeldet keine Login-Seiten.
  if (!S.user && !PUBLIC_ROUTES.includes(route.name)) {
    rememberAfterLogin(location.hash);
    location.replace('#/login');
    return;
  }
  if (S.user && ['login', 'register', 'forgot'].includes(route.name)) {
    location.replace(takeAfterLogin());
    return;
  }
  const previous = S.route;
  S.route = route;
  if (route.name === 'verify' && previous.token !== route.token) verifyEmail(route.token, route.kind);
  if (route.name !== 'expense') S.form = null;
  if (route.name !== 'personen') { S.renaming = null; S.editingEvent = false; }

  if (route.code) {
    if (S.code !== route.code) {
      Object.assign(S, { code: route.code, data: null, dataJson: '', loadError: null, stale: false, filters: { person: '', category: '' } });
      S.openDetails.clear();
    }
    if (!S.data && !CODE_ALPHABET.test(route.code)) {
      S.loadError = new ApiError('event_not_found', 'Dieser Link enthält keinen gültigen Event-Code.');
    } else if (!S.data) {
      render();
      await loadEvent();
      if (S.route !== route) return;
    }
    if (S.data && route.name === 'wer' && person(getMe(S.code))) {
      location.replace(eventPath());
      return;
    }
    if (S.data && route.name !== 'wer' && !person(getMe(S.code))) {
      S.afterPick = location.hash;
      location.replace(eventPath('wer'));
      return;
    }
  } else {
    S.code = null;
  }
  render();
  if (previous.name !== route.name || previous.code !== route.code || route.name === 'expense') {
    window.scrollTo(0, 0);
    (main.querySelector('h1') ?? main).focus({ preventScroll: true });
  }
}

// ---------------------------------------------------------------- Rendering

function render() {
  const views = {
    home: viewHome, create: viewCreate, wer: viewPicker, ausgaben: viewExpenses, abrechnung: viewSettle, personen: viewPeople, expense: viewExpenseForm,
    login: viewLogin, register: viewRegister, forgot: viewForgot, verify: viewVerify, reset: viewReset, profile: viewProfile,
  };
  let content;
  if (S.route.code && !S.data) content = S.loadError ? viewLoadError() : viewLoading();
  else content = views[S.route.name]();
  main.innerHTML = String(content);
  renderTabbar();
  if (S.route.name === 'expense' && S.data) updateSplitPreview();
  if (S.route.name === 'create') renderCreatePeople();
}

function renderTabbar() {
  const hideOn = ['create', 'expense', 'wer', ...PUBLIC_ROUTES];
  const code = S.route.code ? S.code : S.user?.events.find((e) => e.code === lastEventCode())?.code;
  if (hideOn.includes(S.route.name) || (S.route.code && !S.data)) { tabbar.hidden = true; document.body.classList.remove('has-tabbar'); return; }
  const items = [
    { key: 'home', href: '#/', label: 'Events', icon: 'events' },
    ...(code ? [
      { key: 'ausgaben', href: `#/e/${code}/ausgaben`, label: 'Ausgaben', icon: 'expenses' },
      { key: 'abrechnung', href: `#/e/${code}/abrechnung`, label: 'Abrechnung', icon: 'settle' },
      { key: 'personen', href: `#/e/${code}/personen`, label: 'Teilnehmende', icon: 'people' },
    ] : []),
  ];
  tabbar.innerHTML = String(html`<ul>${items.map((item) => html`
    <li><a href="${item.href}" class="tabbar__item" ${S.route.name === item.key ? raw('aria-current="page"') : ''}>${icon(item.icon)}<span>${item.label}</span></a></li>`)}</ul>`);
  tabbar.hidden = false;
  document.body.classList.add('has-tabbar');
}

const viewLoading = () => html`<div class="state-msg" role="status"><span class="spinner" aria-hidden="true"></span> Event wird geladen …</div>`;

function viewLoadError() {
  const e = S.loadError;
  const notFound = e.code === 'event_not_found';
  return html`
    <section class="empty">
      <div class="empty__icon" aria-hidden="true">${notFound ? '🔍' : '📡'}</div>
      <h1 tabindex="-1">${notFound ? 'Event nicht gefunden' : 'Laden fehlgeschlagen'}</h1>
      <p>${e.message}</p>
      <div class="row row--center">
        ${notFound ? '' : html`<button class="btn btn--primary" data-action="retry-load">${icon('refresh')} Erneut versuchen</button>`}
        <a class="btn" href="#/">Zur Startseite</a>
      </div>
    </section>`;
}

function staleBanner() {
  if (!S.stale) return '';
  return html`<div class="banner banner--warn" role="status">
    <span>Keine Verbindung – die angezeigten Daten sind möglicherweise nicht aktuell.</span>
    <button class="btn btn--small" data-action="retry-load">${icon('refresh')} Aktualisieren</button></div>`;
}

function eventHeader(subtitle) {
  const { event, participants } = S.data;
  const me = person(getMe(S.code));
  const meta = [event.date && formatDate(event.date), event.location, plural(participants.length, 'Teilnehmende:r', 'Teilnehmende')].filter(Boolean).join(' · ');
  return html`
    ${staleBanner()}
    <header class="event-head">
      <div class="event-head__text">
        <p class="eyebrow">${subtitle}</p>
        <h1 tabindex="-1">${event.name}</h1>
        <p class="muted">${meta}</p>
      </div>
      <div class="event-head__actions">
        <a class="chip chip--me" href="#/profil" aria-label="Du bist ${me?.name ?? 'niemand'}. Zu deinem Profil">
          ${icon('user')}<span>Du: <strong>${me?.name ?? '–'}</strong></span></a>
        <a class="btn btn--primary hide-mobile" href="${eventPath('ausgabe/neu')}">${icon('plus')} Ausgabe hinzufügen</a>
      </div>
    </header>`;
}

const fab = () => html`<a class="fab" href="${eventPath('ausgabe/neu')}">${icon('plus')}<span>Ausgabe hinzufügen</span></a>`;

// ---------- Start / Events

function viewHome() {
  const events = S.user.events;
  return html`
    <div class="topbar">
      <a class="chip chip--me" href="#/profil">${icon('user')}<span>${S.user.name}</span></a>
    </div>
    <section class="hero">
      <p class="brand"><img src="assets/icon.svg" alt="" width="36" height="36"> FriendSplit</p>
      <h1 tabindex="-1">Gemeinsam unterwegs, fair geteilt.</h1>
      <p class="lead">Tragt eure Ausgaben ein, wählt aus, wer dabei war – FriendSplit rechnet aus, wer wem wie viel schuldet.</p>
      <a class="btn btn--primary btn--large" href="#/neu">${icon('plus')} Neues Event erstellen</a>
    </section>

    <section class="card">
      <h2>Mit Code beitreten</h2>
      <form id="join-form" class="inline-form" novalidate>
        <div class="field field--grow">
          <label for="join-code">Zugangscode oder Event-Link</label>
          <input id="join-code" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="z. B. K7Q2-MX9P-4HTR" aria-describedby="err-code">
          <p class="field-error" id="err-code"></p>
        </div>
        <button class="btn btn--primary" type="submit">Öffnen</button>
      </form>
    </section>

    <section>
      <h2>Meine Events</h2>
      ${events.length === 0
        ? html`<p class="muted">Hier erscheinen alle Events, an denen du teilnimmst – auf jedem Gerät, auf dem du angemeldet bist.</p>`
        : html`<ul class="list">${events.map((e) => html`
          <li class="card card--link">
            <a href="#/e/${e.code}/ausgaben" class="card__main">
              <span class="card__title">${e.name}</span>
              ${e.date ? html`<span class="muted small">${formatDate(e.date)}</span>` : ''}
            </a>
          </li>`)}</ul>`}
    </section>`;
}

function viewCreate() {
  return html`
    <header class="form-head">
      <a class="btn-icon" href="#/" aria-label="Zurück zur Startseite">${icon('back')}</a>
      <h1 tabindex="-1">Neues Event</h1>
    </header>
    <form id="create-form" class="form" novalidate>
      <div class="form-error" id="form-error" role="alert" hidden></div>
      <div class="field">
        <label for="f-name">Eventname <span class="req" aria-hidden="true">*</span></label>
        <input id="f-name" name="name" maxlength="120" required placeholder="z. B. Stuttgart Night" aria-describedby="err-name">
        <p class="field-error" id="err-name"></p>
      </div>
      <div class="grid-2">
        <div class="field">
          <label for="f-date">Datum <span class="opt">(optional)</span></label>
          <input id="f-date" name="date" type="date" aria-describedby="err-date">
          <p class="field-error" id="err-date"></p>
        </div>
        <div class="field">
          <label for="f-location">Ort <span class="opt">(optional)</span></label>
          <input id="f-location" name="location" maxlength="120" placeholder="z. B. Stuttgart">
        </div>
      </div>
      <div class="field">
        <label for="f-notes">Notiz <span class="opt">(optional)</span></label>
        <textarea id="f-notes" name="notes" rows="2" maxlength="1000"></textarea>
      </div>
      <div class="field">
        <label for="f-person">Weitere Teilnehmende</label>
        <div class="inline-form">
          <input id="f-person" maxlength="60" placeholder="Name eingeben, z. B. Alex" aria-describedby="hint-person err-participants" enterkeyhint="enter">
          <button class="btn" type="button" data-action="create-add-person">${icon('plus')} Hinzufügen</button>
        </div>
        <p class="hint" id="hint-person">Du (${S.user.name}) bist automatisch dabei. Mit Enter hinzufügen. Die anderen wählen ihren Namen, wenn sie den Link öffnen und sich anmelden.</p>
        <p class="field-error" id="err-participants"></p>
        <ul class="chips" id="people-chips" aria-label="Hinzugefügte Teilnehmende"></ul>
      </div>
      <div class="form-actions">
        <a class="btn" href="#/">Abbrechen</a>
        <button class="btn btn--primary" type="submit">Event erstellen</button>
      </div>
    </form>`;
}

function renderCreatePeople() {
  const list = document.getElementById('people-chips');
  if (!list) return;
  list.innerHTML = String(html`${S.createPeople.map((name, i) => html`
    <li class="chip chip--static">${name}<button type="button" class="chip__remove" data-action="create-remove-person" data-index="${i}" aria-label="${name} entfernen">${icon('close')}</button></li>`)}`);
}

// ---------- Person wählen

function viewPicker() {
  const { event, participants } = S.data;
  const free = participants.filter((p) => !p.linked);
  const nameTaken = participants.some((p) => p.name.toLowerCase() === S.user.name.toLowerCase());
  return html`
    ${staleBanner()}
    <section class="picker">
      <p class="eyebrow">${event.name}</p>
      <h1 tabindex="-1">Wer bist du in diesem Event?</h1>
      ${free.length
        ? html`<p class="lead">Steht dein Name schon in der Liste? Dann wähle ihn – Ausgaben, die schon für dich eingetragen sind, gehören danach zu deinem Konto.</p>
          <ul class="person-grid">${free.map((p) => html`
            <li><button class="person-btn" data-action="pick-person" data-id="${p.id}">
              ${avatar(p.id, p.name)}<span>${p.name}</span></button></li>`)}</ul>`
        : ''}
      <form id="join-self-form" class="card" novalidate>
        <h2>${free.length ? 'Nicht in der Liste?' : 'Event beitreten'}</h2>
        <div class="inline-form">
          <div class="field field--grow">
            <label for="f-self">Dein Name im Event</label>
            <input id="f-self" name="name" maxlength="60" value="${nameTaken ? '' : S.user.name}" autocomplete="given-name" aria-describedby="err-name">
            <p class="field-error" id="err-name"></p>
          </div>
          <button class="btn btn--primary" type="submit">Beitreten</button>
        </div>
      </form>
      ${participants.some((p) => p.linked) ? html`<p class="muted small">Bereits mit Konto dabei: ${joinNames(participants.filter((p) => p.linked).map((p) => p.name))}</p>` : ''}
    </section>`;
}

// ---------- Konto: Anmelden, Registrieren, E-Mail-Links, Profil

function viewOffline(error) {
  return html`
    <section class="empty">
      <div class="empty__icon" aria-hidden="true">📡</div>
      <h1 tabindex="-1">FriendSplit ist gerade nicht erreichbar</h1>
      <p>${error.message}</p>
      <div class="row row--center"><button class="btn btn--primary" data-action="reload">${icon('refresh')} Neu laden</button></div>
    </section>`;
}

const authHead = (title, lead) => html`
  <section class="hero hero--auth">
    <p class="brand"><img src="assets/icon.svg" alt="" width="36" height="36"> FriendSplit</p>
    <h1 tabindex="-1">${title}</h1>
    ${lead ? html`<p class="lead">${lead}</p>` : ''}
  </section>`;

/** Hinweis „Schau in dein Postfach“ nach Registrierung bzw. bei unbestätigter Adresse. */
function mailNotice() {
  const n = S.notice;
  if (!n) return '';
  return html`
    <div class="card notice" role="status">
      <h2>📬 Schau in dein Postfach</h2>
      <p>${n.kind === 'unverified'
        ? html`Deine E-Mail-Adresse <strong>${n.email}</strong> ist noch nicht bestätigt. Klicke auf den Link in unserer E-Mail.`
        : html`Wir haben eine E-Mail an <strong>${n.email}</strong> geschickt. Klicke auf den Link darin, um dein Konto zu bestätigen – danach bist du direkt angemeldet.`}</p>
      <p class="muted small">Nichts angekommen? Prüfe den Spam-Ordner oder lass dir den Link noch einmal schicken.</p>
      <button class="btn btn--small" data-action="resend-verification" data-email="${n.email}">Bestätigungslink erneut senden</button>
    </div>`;
}

function viewLogin() {
  return html`
    ${authHead('Anmelden', 'Teilt Ausgaben mit euren Freund:innen – alle Events an einem Ort, auf jedem Gerät.')}
    ${mailNotice()}
    <form id="login-form" class="form card" novalidate>
      <div class="form-error" id="form-error" role="alert" hidden></div>
      <div class="field"><label for="f-email">E-Mail-Adresse</label>
        <input id="f-email" name="email" type="email" autocomplete="username" inputmode="email" autocapitalize="off" spellcheck="false" value="${S.notice?.email ?? ''}" aria-describedby="err-email"><p class="field-error" id="err-email"></p></div>
      <div class="field"><label for="f-password">Passwort</label>
        <input id="f-password" name="password" type="password" autocomplete="current-password" aria-describedby="err-password"><p class="field-error" id="err-password"></p></div>
      <div class="form-actions form-actions--split">
        <a href="#/passwort-vergessen">Passwort vergessen?</a>
        <button class="btn btn--primary" type="submit">Anmelden</button>
      </div>
    </form>
    <p class="center">Noch kein Konto? <a href="#/registrieren">Jetzt registrieren</a></p>`;
}

function viewRegister() {
  if (S.notice?.kind === 'registered') {
    return html`${authHead('Fast geschafft!')}${mailNotice()}<p class="center"><a href="#/login">Zur Anmeldung</a></p>`;
  }
  return html`
    ${authHead('Konto erstellen', 'Mit deinem Konto siehst du alle deine Events und musst deinen PayPal.me-Link nur einmal hinterlegen.')}
    <form id="register-form" class="form card" novalidate>
      <div class="form-error" id="form-error" role="alert" hidden></div>
      <div class="field"><label for="f-name">Dein Name</label>
        <input id="f-name" name="name" maxlength="60" autocomplete="given-name" placeholder="z. B. Alex" aria-describedby="hint-name err-name">
        <p class="hint" id="hint-name">So erscheinst du in neuen Events.</p><p class="field-error" id="err-name"></p></div>
      <div class="field"><label for="f-email">E-Mail-Adresse</label>
        <input id="f-email" name="email" type="email" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" aria-describedby="err-email"><p class="field-error" id="err-email"></p></div>
      <div class="field"><label for="f-password">Passwort</label>
        <input id="f-password" name="password" type="password" autocomplete="new-password" minlength="8" aria-describedby="hint-password err-password">
        <p class="hint" id="hint-password">Mindestens 8 Zeichen.</p><p class="field-error" id="err-password"></p></div>
      <div class="form-actions"><button class="btn btn--primary" type="submit">Registrieren</button></div>
    </form>
    <p class="center">Schon registriert? <a href="#/login">Anmelden</a></p>`;
}

function viewForgot() {
  if (S.notice?.kind === 'reset') {
    return html`${authHead('E-Mail ist unterwegs')}
      <div class="card notice" role="status"><p>Falls es ein Konto zu <strong>${S.notice.email}</strong> gibt, haben wir dir einen Link geschickt. Er ist 60 Minuten gültig.</p></div>
      <p class="center"><a href="#/login">Zur Anmeldung</a></p>`;
  }
  return html`
    ${authHead('Passwort vergessen', 'Gib deine E-Mail-Adresse ein. Wir schicken dir einen Link, mit dem du ein neues Passwort festlegst.')}
    <form id="forgot-form" class="form card" novalidate>
      <div class="form-error" id="form-error" role="alert" hidden></div>
      <div class="field"><label for="f-email">E-Mail-Adresse</label>
        <input id="f-email" name="email" type="email" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" aria-describedby="err-email"><p class="field-error" id="err-email"></p></div>
      <div class="form-actions form-actions--split"><a href="#/login">Zurück</a><button class="btn btn--primary" type="submit">Link senden</button></div>
    </form>`;
}

async function verifyEmail(token, kind) {
  S.verifying = { state: 'busy' };
  try {
    const result = await api(kind === 'email' ? 'confirm_email_change' : 'verify_email', { body: { token } });
    S.user = result.user;
    S.notice = null;
    S.verifying = null;
    if (kind === 'email') { toast(`Deine E-Mail-Adresse ist jetzt ${result.user.email}.`); go('#/profil'); return; }
    toast('E-Mail bestätigt – willkommen bei FriendSplit!');
    go(takeAfterLogin());
  } catch (error) {
    S.verifying = { state: 'error', message: error.message };
    if (S.route.name === 'verify') render();
  }
}

function viewVerify() {
  if (!S.verifying || S.verifying.state === 'busy') {
    return html`<div class="state-msg" role="status"><span class="spinner" aria-hidden="true"></span> E-Mail-Adresse wird bestätigt …</div>`;
  }
  return html`
    <section class="empty">
      <div class="empty__icon" aria-hidden="true">⌛</div>
      <h1 tabindex="-1">Link funktioniert nicht</h1>
      <p>${S.verifying.message}</p>
      <div class="row row--center"><a class="btn btn--primary" href="${S.user ? '#/' : '#/login'}">${S.user ? 'Zur Startseite' : 'Zur Anmeldung'}</a></div>
    </section>`;
}

function viewReset() {
  return html`
    ${authHead('Neues Passwort', 'Lege ein neues Passwort fest. Danach bist du angemeldet und auf allen anderen Geräten abgemeldet.')}
    <form id="reset-form" class="form card" novalidate>
      <div class="form-error" id="form-error" role="alert" hidden></div>
      <div class="field"><label for="f-password">Neues Passwort</label>
        <input id="f-password" name="password" type="password" autocomplete="new-password" minlength="8" aria-describedby="hint-password err-password">
        <p class="hint" id="hint-password">Mindestens 8 Zeichen.</p><p class="field-error" id="err-password"></p></div>
      <div class="form-actions"><button class="btn btn--primary" type="submit">Passwort speichern</button></div>
    </form>`;
}

function viewProfile() {
  const u = S.user;
  return html`
    <header class="form-head">
      <a class="btn-icon" href="${S.code ? eventPath() : '#/'}" aria-label="Zurück">${icon('back')}</a>
      <h1 tabindex="-1">Dein Profil</h1>
    </header>
    <section class="card">
      <div class="profile-head">${avatar(u.id, u.name)}<div><p class="card__title">${u.name}</p><p class="muted small">${u.email}</p></div></div>
    </section>

    <section class="card section" aria-labelledby="name-heading">
      <h2 id="name-heading">Name</h2>
      <form id="name-form" class="inline-form" novalidate>
        <div class="field field--grow"><label for="f-name">Dein Name</label>
          <input id="f-name" name="name" maxlength="60" value="${u.name}" autocomplete="given-name" aria-describedby="hint-name err-name">
          <p class="hint" id="hint-name">Gilt für neue Events. In bestehenden Events kannst du deinen Namen unter „Teilnehmende“ ändern.</p>
          <p class="field-error" id="err-name"></p></div>
        <button class="btn btn--primary" type="submit">Speichern</button>
      </form>
    </section>

    <section class="card section" aria-labelledby="paypal-heading">
      <h2 id="paypal-heading">PayPal</h2>
      <form id="profile-form" class="form" novalidate>
        <div class="field"><label for="f-paypal">Dein PayPal.me-Link</label>
          <input id="f-paypal" name="paypal" maxlength="200" value="${u.paypal ? `paypal.me/${u.paypal}` : ''}" placeholder="paypal.me/deinname"
            inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="hint-paypal err-paypal">
          <p class="hint" id="hint-paypal">Gilt automatisch in allen deinen Events. Wer dir Geld schuldet, kann dir den Betrag in der Abrechnung mit einem Tipp per PayPal senden.
            ${canScanQr() ? '' : 'Tipp: Deinen PayPal-QR-Code kannst du mit der Kamera-App scannen und den Link hier einfügen.'}</p>
          <p class="field-error" id="err-paypal"></p></div>
        ${u.paypal ? html`<p class="small">Test: <a href="${paypalLink(u.paypal, 0)}" target="_blank" rel="noopener noreferrer">paypal.me/${u.paypal}</a> öffnen</p>` : ''}
        <div class="form-actions">
          ${canScanQr() ? html`<label class="btn">📷 QR-Code scannen<input type="file" id="f-paypal-qr" accept="image/*" capture="environment" class="visually-hidden"></label>` : ''}
          <button class="btn btn--primary" type="submit">Speichern</button>
        </div>
      </form>
    </section>

    <section class="card section" aria-labelledby="account-heading">
      <h2 id="account-heading">Konto</h2>
      ${u.pending_email ? html`<div class="banner banner--warn" role="status"><span>Neue Adresse <strong>${u.pending_email}</strong> wartet auf Bestätigung – klicke auf den Link in der E-Mail an diese Adresse.</span></div>` : ''}

      <details class="account-box">
        <summary>E-Mail-Adresse ändern</summary>
        <form id="email-form" class="form" novalidate>
          <div class="form-error" role="alert" hidden></div>
          <div class="field"><label for="f-new-email">Neue E-Mail-Adresse</label>
            <input id="f-new-email" name="email" type="email" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" aria-describedby="hint-new-email err-email">
            <p class="hint" id="hint-new-email">Wir schicken einen Bestätigungslink an die neue Adresse. Bis du ihn anklickst, bleibt die bisherige aktiv.</p>
            <p class="field-error" id="err-email"></p></div>
          <div class="field"><label for="f-email-pw">Aktuelles Passwort</label>
            <input id="f-email-pw" name="current_password" type="password" autocomplete="current-password" aria-describedby="err-email-pw">
            <p class="field-error" id="err-email-pw"></p></div>
          <div class="form-actions"><button class="btn btn--primary" type="submit">Bestätigungslink senden</button></div>
        </form>
      </details>

      <details class="account-box">
        <summary>Passwort ändern</summary>
        <form id="password-form" class="form" novalidate>
          <div class="form-error" role="alert" hidden></div>
          <div class="field"><label for="f-cur-pw">Aktuelles Passwort</label>
            <input id="f-cur-pw" name="current_password" type="password" autocomplete="current-password" aria-describedby="err-cur-pw">
            <p class="field-error" id="err-cur-pw"></p></div>
          <div class="field"><label for="f-new-pw">Neues Passwort</label>
            <input id="f-new-pw" name="new_password" type="password" autocomplete="new-password" minlength="8" aria-describedby="hint-new-pw err-new_password">
            <p class="hint" id="hint-new-pw">Mindestens 8 Zeichen. Andere Geräte werden danach abgemeldet.</p>
            <p class="field-error" id="err-new_password"></p></div>
          <div class="form-actions"><button class="btn btn--primary" type="submit">Passwort ändern</button></div>
        </form>
      </details>

      <details class="account-box account-box--danger">
        <summary>Konto löschen</summary>
        <form id="delete-form" class="form" novalidate>
          <div class="form-error" role="alert" hidden></div>
          <p>Dein Konto, deine E-Mail-Adresse, dein Passwort und dein PayPal.me-Link werden endgültig gelöscht.
            In deinen Events bleibst du mit deinem Namen und deinen Ausgaben als Person ohne Konto stehen, damit die Abrechnung für die anderen stimmt.</p>
          <div class="field"><label for="f-del-pw">Aktuelles Passwort</label>
            <input id="f-del-pw" name="current_password" type="password" autocomplete="current-password" aria-describedby="err-del-pw">
            <p class="field-error" id="err-del-pw"></p></div>
          <div class="form-actions"><button class="btn btn--danger" type="submit">Konto endgültig löschen</button></div>
        </form>
      </details>
    </section>

    <button class="btn btn--ghost btn--danger-ghost" data-action="logout">Abmelden</button>`;
}

/** Nach dem Beitreten zurück dorthin, wo man hinwollte. */
function afterJoin() {
  const next = S.afterPick && !S.afterPick.includes('/wer') ? S.afterPick : eventPath();
  S.afterPick = null;
  go(next);
}

// ---------- Ausgaben

function kpis() {
  const { summary, expenses } = S.data;
  const me = getMe(S.code);
  const mine = summary.people[me]?.balance ?? 0;
  const mineText = mine > 0 ? 'bekommst du zurück' : mine < 0 ? 'musst du noch beisteuern' : 'du bist ausgeglichen';
  const mineClass = mine > 0 ? 'pos' : mine < 0 ? 'neg' : 'zero';
  return html`
    <div class="kpis">
      <div class="kpi"><span class="kpi__label">Gesamtausgaben</span><span class="kpi__value">${euro(summary.total_cents)}</span><span class="kpi__sub">${plural(expenses.length, 'Ausgabe', 'Ausgaben')}</span></div>
      <div class="kpi kpi--${mineClass}"><span class="kpi__label">Dein Saldo</span><span class="kpi__value">${signedEuro(mine)}</span><span class="kpi__sub">${mine > 0 ? '▲ ' : mine < 0 ? '▼ ' : '✓ '}${mineText}</span></div>
      <a class="kpi kpi--link" href="${eventPath('abrechnung')}"><span class="kpi__label">Offener Ausgleich</span><span class="kpi__value">${euro(summary.open_cents)}</span><span class="kpi__sub">${summary.plan.length ? `${plural(summary.plan.length, 'Zahlung', 'Zahlungen')} → Abrechnung` : 'alles ausgeglichen'}</span></a>
    </div>`;
}

function shareExplanation(expense) {
  const shares = expense.shares;
  if (!shares.length) return '';
  const min = Math.min(...shares.map((s) => s.share_cents));
  const extra = shares.filter((s) => s.share_cents > min).map((s) => personName(s.person_id));
  if (shares.length === 1) return 'Nur eine Person beteiligt – sie trägt den ganzen Betrag.';
  return extra.length
    ? `Gleichmäßig auf ${shares.length} Personen geteilt. ${extra.length === 1 ? '1 Rest-Cent geht' : `${extra.length} Rest-Cents gehen`} durch Rundung an ${joinNames(extra)}.`
    : `Gleichmäßig auf ${shares.length} Personen geteilt: je ${euro(min)}.`;
}

function expenseCard(e) {
  const me = getMe(S.code);
  const cat = CAT[e.category] ?? CAT.sonstiges;
  const myShare = e.shares.find((s) => s.person_id === me)?.share_cents;
  const names = e.shares.map((s) => personName(s.person_id));
  const involved = e.shares.length === S.data.participants.length && e.shares.length > 2 ? 'alle' : e.shares.length <= 3 ? joinNames(names) : plural(e.shares.length, 'Person', 'Personen');
  const changed = e.version > 1 && e.updated_by;
  return html`
    <li>
      <details class="expense" data-id="${e.id}" ${S.openDetails.has(e.id) ? raw('open') : ''}>
        <summary>
          <span class="expense__icon" aria-hidden="true">${e.icon}</span>
          <span class="expense__main">
            <span class="expense__title">${e.description}</span>
            <span class="expense__meta"><span class="tag">${cat.label}</span> ${e.paid_by === me ? 'Du hast' : `${personName(e.paid_by)} hat`} bezahlt · für ${involved} · ${formatTime(e.spent_at)}</span>
          </span>
          <span class="expense__amount">${euro(e.amount_cents)}${myShare != null ? html`<span class="expense__mine">dein Anteil ${euro(myShare)}</span>` : ''}</span>
        </summary>
        <div class="expense__body">
          <p>Bezahlt von <strong>${personName(e.paid_by)}</strong> am ${parseLocalDateTime(e.spent_at).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}</p>
          <h3 class="small-heading">Aufteilung</h3>
          <ul class="shares">${e.shares.map((s) => html`<li><span>${personName(s.person_id)}${s.person_id === me ? ' (du)' : ''}</span><span>${euro(s.share_cents)}</span></li>`)}</ul>
          <p class="muted small">${shareExplanation(e)}</p>
          ${e.notes ? html`<p class="notes">${e.notes}</p>` : ''}
          <p class="muted small">Eingetragen von ${e.created_by ? personName(e.created_by) : 'unbekannt'}${changed ? ` · zuletzt geändert von ${personName(e.updated_by)} ${relativeTime(e.updated_at)}` : ''}</p>
          <div class="row">
            <a class="btn btn--small" href="${eventPath(`ausgabe/${e.id}`)}">${icon('edit')} Bearbeiten</a>
            <button class="btn btn--small btn--danger-ghost" data-action="delete-expense" data-id="${e.id}">${icon('trash')} Löschen</button>
          </div>
        </div>
      </details>
    </li>`;
}

function viewExpenses() {
  const { expenses, participants } = S.data;
  const { person: fPerson, category: fCat } = S.filters;
  const filtered = expenses.filter((e) => (!fCat || e.category === fCat) && (!fPerson || e.paid_by === fPerson || e.shares.some((s) => s.person_id === fPerson)));
  const groups = [];
  for (const e of filtered) {
    const day = e.spent_at.slice(0, 10);
    if (groups.at(-1)?.day !== day) groups.push({ day, items: [] });
    groups.at(-1).items.push(e);
  }
  const me = getMe(S.code);

  let list;
  if (participants.length === 0) {
    list = html`<div class="empty"><div class="empty__icon" aria-hidden="true">👥</div><p>Noch keine Teilnehmenden.</p><a class="btn btn--primary" href="${eventPath('personen')}">Personen hinzufügen</a></div>`;
  } else if (expenses.length === 0) {
    list = html`<div class="empty">
      <div class="empty__icon" aria-hidden="true">🧾</div>
      <p><strong>Noch keine Ausgaben – fügt den ersten Betrag hinzu.</strong></p>
      <div class="row row--center">
        <a class="btn btn--primary" href="${eventPath('ausgabe/neu')}">${icon('plus')} Erste Ausgabe eintragen</a>
        <button class="btn" data-action="share">${icon('share')} Gruppe einladen</button>
      </div></div>`;
  } else if (filtered.length === 0) {
    list = html`<div class="empty empty--inline"><p>Keine Ausgaben für diesen Filter.</p><button class="btn btn--small" data-action="reset-filters">Filter zurücksetzen</button></div>`;
  } else {
    list = groups.map((g) => html`
      <section class="day">
        <h3 class="day__heading">${formatDayHeading(g.day)}</h3>
        <ul class="list">${g.items.map(expenseCard)}</ul>
      </section>`);
  }

  return html`
    ${eventHeader('Ausgaben')}
    ${kpis()}
    <section aria-labelledby="exp-heading">
      <div class="toolbar">
        <h2 id="exp-heading">Ausgaben</h2>
        ${expenses.length ? html`<div class="filters">
          <label class="select-label"><span class="visually-hidden">Nach Person filtern</span>
            <select id="filter-person">
              <option value="">Alle Personen</option>
              ${participants.map((p) => html`<option value="${p.id}" ${fPerson === p.id ? raw('selected') : ''}>${p.name}${p.id === me ? ' (du)' : ''}</option>`)}
            </select></label>
          <label class="select-label"><span class="visually-hidden">Nach Kategorie filtern</span>
            <select id="filter-category">
              <option value="">Alle Kategorien</option>
              ${CATEGORIES.map((c) => html`<option value="${c.key}" ${fCat === c.key ? raw('selected') : ''}>${c.icon} ${c.label}</option>`)}
            </select></label>
        </div>` : ''}
      </div>
      ${(fPerson || fCat) && filtered.length ? html`<p class="muted small" role="status">${plural(filtered.length, 'Ausgabe', 'Ausgaben')} · zusammen ${euro(filtered.reduce((sum, e) => sum + e.amount_cents, 0))}</p>` : ''}
      ${list}
    </section>
    ${participants.length ? fab() : ''}`;
}

// ---------- Ausgabe-Formular

function viewExpenseForm() {
  const { participants, expenses } = S.data;
  const editing = S.route.expenseId;
  const expense = editing ? expenses.find((e) => e.id === editing) : null;
  if (editing && !expense) {
    return html`<section class="empty"><div class="empty__icon" aria-hidden="true">🗑️</div><h1 tabindex="-1">Ausgabe nicht gefunden</h1>
      <p>Diese Ausgabe wurde möglicherweise inzwischen gelöscht.</p><a class="btn btn--primary" href="${eventPath()}">Zur Übersicht</a></section>`;
  }
  if (participants.length === 0) {
    return html`<section class="empty"><div class="empty__icon" aria-hidden="true">👥</div><h1 tabindex="-1">Noch keine Teilnehmenden</h1>
      <p>Füge zuerst Personen hinzu, bevor du Ausgaben einträgst.</p><a class="btn btn--primary" href="${eventPath('personen')}">Personen hinzufügen</a></section>`;
  }
  if (!S.form || S.form.expenseId !== (expense?.id ?? null)) {
    S.form = { token: randomToken(), version: expense?.version ?? null, expenseId: expense?.id ?? null };
  }
  const me = getMe(S.code);
  const values = expense
    ? { amount: amountInput(expense.amount_cents), description: expense.description, category: expense.category, paid_by: expense.paid_by, participants: expense.shares.map((s) => s.person_id), spent_at: expense.spent_at, notes: expense.notes ?? '' }
    : { amount: '', description: '', category: 'getraenke', paid_by: me, participants: participants.map((p) => p.id), spent_at: nowLocalInput(), notes: '' };

  return html`
    <header class="form-head">
      <a class="btn-icon" href="${eventPath()}" aria-label="Zurück zur Übersicht">${icon('back')}</a>
      <div><p class="eyebrow">${S.data.event.name}</p><h1 tabindex="-1">${expense ? 'Ausgabe bearbeiten' : 'Ausgabe hinzufügen'}</h1></div>
    </header>
    <form id="expense-form" class="form" novalidate>
      <div class="form-error" id="form-error" role="alert" hidden></div>

      <div class="field">
        <label for="f-amount">Betrag <span class="req" aria-hidden="true">*</span></label>
        <div class="amount-input">
          <input id="f-amount" name="amount" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${values.amount}" aria-describedby="err-amount" required>
          <span aria-hidden="true">€</span>
        </div>
        <p class="field-error" id="err-amount"></p>
      </div>

      <div class="field">
        <label for="f-description">Beschreibung</label>
        <input id="f-description" name="description" maxlength="140" placeholder="z. B. Getränke in der Bar" value="${values.description}" aria-describedby="hint-description err-description">
        <p class="hint" id="hint-description">Optional – ohne Beschreibung wird die Kategorie verwendet.</p>
        <p class="field-error" id="err-description"></p>
      </div>

      <fieldset class="field" aria-describedby="err-category">
        <legend>Kategorie</legend>
        <div class="cat-grid">${CATEGORIES.map((c) => html`
          <label class="cat-option"><input type="radio" name="category" value="${c.key}" ${values.category === c.key ? raw('checked') : ''}>
            <span><span class="cat-option__icon" aria-hidden="true">${c.icon}</span>${c.label}</span></label>`)}
        </div>
        <p class="field-error" id="err-category"></p>
      </fieldset>

      <div class="field">
        <label for="f-paid-by">Bezahlt von</label>
        <select id="f-paid-by" name="paid_by" aria-describedby="err-paid_by">
          ${participants.map((p) => html`<option value="${p.id}" ${values.paid_by === p.id ? raw('selected') : ''}>${p.name}${p.id === me ? ' (du)' : ''}</option>`)}
        </select>
        <p class="field-error" id="err-paid_by"></p>
      </div>

      <fieldset class="field" aria-describedby="split-preview err-participants">
        <div class="legend-row">
          <legend>Beteiligt</legend>
          <button type="button" class="btn btn--small btn--ghost" data-action="toggle-all" id="toggle-all"></button>
        </div>
        <div class="chips chips--select">${participants.map((p) => html`
          <label class="chip chip--check"><input type="checkbox" name="participants" value="${p.id}" ${values.participants.includes(p.id) ? raw('checked') : ''}><span>${p.name}${p.id === me ? ' (du)' : ''}</span></label>`)}
        </div>
        <p class="split-preview" id="split-preview" aria-live="polite"></p>
        <p class="field-error" id="err-participants"></p>
      </fieldset>

      <div class="field">
        <label for="f-spent-at">Datum und Uhrzeit</label>
        <input id="f-spent-at" name="spent_at" type="datetime-local" value="${values.spent_at}" required aria-describedby="err-spent_at">
        <p class="field-error" id="err-spent_at"></p>
      </div>

      <div class="field">
        <label for="f-notes">Notiz <span class="opt">(optional)</span></label>
        <textarea id="f-notes" name="notes" rows="2" maxlength="500" aria-describedby="err-notes">${values.notes}</textarea>
        <p class="field-error" id="err-notes"></p>
      </div>

      <div class="form-actions form-actions--sticky">
        <a class="btn" href="${eventPath()}">Abbrechen</a>
        <button class="btn btn--primary" type="submit" id="save-btn">${expense ? 'Änderungen speichern' : 'Ausgabe speichern'}</button>
      </div>
    </form>`;
}

function readExpenseForm(form) {
  const ids = S.data.participants.map((p) => p.id);
  const selected = new Set([...form.querySelectorAll('input[name="participants"]:checked')].map((i) => i.value));
  return {
    cents: parseAmount(form.elements.amount.value),
    payer: form.elements.paid_by.value,
    participants: ids.filter((id) => selected.has(id)),
  };
}

function updateSplitPreview() {
  const form = document.getElementById('expense-form');
  const preview = document.getElementById('split-preview');
  if (!form || !preview) return;
  const { cents, payer, participants } = readExpenseForm(form);
  const toggle = document.getElementById('toggle-all');
  const all = participants.length === S.data.participants.length;
  toggle.textContent = all ? 'Keine auswählen' : 'Alle auswählen';
  let text;
  if (!participants.length) text = 'Wähle aus, wer an dieser Ausgabe beteiligt war.';
  else if (!cents || cents <= 0) text = `Wird gleichmäßig auf ${plural(participants.length, 'Person', 'Personen')} aufgeteilt.`;
  else {
    const shares = splitEqual(cents, participants, payer);
    const base = Math.floor(cents / participants.length);
    const extra = participants.filter((id) => shares[id] > base).map(personName);
    text = participants.length === 1
      ? `${personName(participants[0])} trägt den ganzen Betrag von ${euro(cents)}.`
      : extra.length
        ? `${euro(base)} pro Person – ${extra.length === 1 ? '1 Rest-Cent geht' : `${extra.length} Rest-Cents gehen`} an ${joinNames(extra)}.`
        : `${euro(base)} pro Person (${participants.length} Personen).`;
  }
  preview.textContent = text;
}

function findDuplicate(body) {
  const spent = parseLocalDateTime(body.spent_at).getTime();
  return S.data.expenses.find((e) => e.amount_cents === body.amount_cents && e.paid_by === body.paid_by
    && (e.description.toLowerCase() === (body.description || CAT[body.category].label).toLowerCase()
      || Math.abs(parseLocalDateTime(e.spent_at).getTime() - spent) < 30 * 60 * 1000));
}

// ---------- Abrechnung

function viewSettle() {
  const { summary, participants, settlements, expenses } = S.data;
  const me = getMe(S.code);
  const nameFor = (id) => (id === me ? 'Du' : personName(id));

  const people = participants.map((p) => ({ ...p, ...(summary.people[p.id] ?? { paid: 0, share: 0, sent: 0, received: 0, balance: 0 }) }));
  return html`
    ${eventHeader('Abrechnung')}
    <div class="kpis kpis--2">
      <div class="kpi"><span class="kpi__label">Gesamtausgaben</span><span class="kpi__value">${euro(summary.total_cents)}</span><span class="kpi__sub">${plural(expenses.length, 'Ausgabe', 'Ausgaben')}</span></div>
      <div class="kpi ${summary.open_cents ? 'kpi--neg' : 'kpi--pos'}"><span class="kpi__label">Offener Ausgleich</span><span class="kpi__value">${euro(summary.open_cents)}</span><span class="kpi__sub">${summary.open_cents ? `▼ ${plural(summary.plan.length, 'Zahlung', 'Zahlungen')} offen` : '✓ alles ausgeglichen'}</span></div>
    </div>

    <section aria-labelledby="plan-heading" class="section">
      <h2 id="plan-heading">So gleicht ihr aus</h2>
      ${expenses.length === 0
        ? html`<p class="muted">Noch keine Ausgaben – sobald ihr Ausgaben eintragt, erscheinen hier Vorschläge.</p>`
        : summary.plan.length === 0
          ? html`<div class="banner banner--pos"><span>✓ Alles ausgeglichen – niemand schuldet jemandem etwas.</span></div>`
          : html`<ol class="list">${summary.plan.map((pay) => html`
            <li class="card payment ${pay.from === me || pay.to === me ? 'payment--mine' : ''}">
              <p class="payment__text">${avatar(pay.from, personName(pay.from))}
                <span><strong>${nameFor(pay.from)}</strong> ${pay.from === me ? 'zahlst' : 'zahlt'} <strong>${pay.to === me ? 'dir' : personName(pay.to)}</strong></span>
                <span class="payment__amount">${euro(pay.amount_cents)}</span></p>
              <div class="payment__actions">
                ${person(pay.to)?.paypal
                  ? html`<a class="btn btn--small btn--paypal ${pay.from === me ? 'btn--primary' : ''}" href="${paypalLink(person(pay.to).paypal, pay.amount_cents)}" target="_blank" rel="noopener noreferrer"
                      aria-label="${euro(pay.amount_cents)} per PayPal an ${personName(pay.to)} senden">PayPal: ${euro(pay.amount_cents)} senden</a>`
                  : pay.to === me
                    ? html`<a class="btn btn--small btn--ghost" href="#/profil">PayPal.me im Profil hinterlegen</a>`
                    : html`<span class="muted small">${personName(pay.to)} hat keinen PayPal.me-Link hinterlegt</span>`}
                <button class="btn btn--small" data-action="settle" data-from="${pay.from}" data-to="${pay.to}" data-amount="${pay.amount_cents}">✓ Als bezahlt markieren</button>
              </div>
            </li>`)}</ol>
            <p class="muted small">Der PayPal-Button öffnet PayPal mit dem Betrag schon eingetragen – du bestätigst die Zahlung dort. Danach hier „Als bezahlt markieren“. Die Vorschläge verändern keine Ausgaben.</p>`}
    </section>

    <section aria-labelledby="bal-heading" class="section">
      <h2 id="bal-heading">Salden je Person</h2>
      <ul class="list">${people.map((p) => {
        const status = p.balance > 0 ? ['pos', '▲', `bekommt ${euro(p.balance)} zurück`] : p.balance < 0 ? ['neg', '▼', `muss ${euro(p.balance)} beisteuern`] : ['zero', '✓', 'ausgeglichen'];
        return html`
        <li class="card balance">
          <div class="balance__head">
            ${avatar(p.id, p.name)}
            <span class="balance__name">${p.name}${p.id === me ? html` <span class="badge">Du</span>` : ''}</span>
            <span class="balance__value balance__value--${status[0]}">${signedEuro(p.balance)}</span>
          </div>
          <p class="balance__status balance__status--${status[0]}"><span aria-hidden="true">${status[1]}</span> ${status[2]}</p>
          <dl class="balance__grid">
            <div><dt>Bezahlt</dt><dd>${euro(p.paid)}</dd></div>
            <div><dt>Anteil</dt><dd>${euro(p.share)}</dd></div>
            ${p.sent || p.received ? html`<div><dt>Ausgleich</dt><dd>${p.sent ? `${euro(p.sent)} gezahlt` : ''}${p.sent && p.received ? ', ' : ''}${p.received ? `${euro(p.received)} erhalten` : ''}</dd></div>` : ''}
          </dl>
        </li>`;
      })}</ul>
    </section>

    ${settlements.length ? html`
    <section aria-labelledby="done-heading" class="section">
      <h2 id="done-heading">Erledigte Zahlungen</h2>
      <ul class="list">${settlements.map((st) => html`
        <li class="card settled">
          <span><strong>${personName(st.from)}</strong> hat <strong>${personName(st.to)}</strong> ${euro(st.amount_cents)} gezahlt
            <span class="muted small">· ${st.paid_at ? formatDateTime(st.paid_at) : ''}</span></span>
          <button class="btn btn--small btn--ghost" data-action="unsettle" data-id="${st.id}">Rückgängig</button>
        </li>`)}</ul>
    </section>` : ''}

    <details class="card explain">
      <summary>So wird gerechnet</summary>
      <ul>
        <li>Jede Ausgabe wird gleichmäßig auf die ausgewählten Beteiligten verteilt. Wer nicht beteiligt war, zahlt nichts.</li>
        <li><strong>Saldo = selbst bezahlt − eigener Anteil</strong> (± als bezahlt markierte Ausgleichszahlungen).</li>
        <li>Positiver Saldo: Die Person bekommt Geld zurück. Negativer Saldo: Die Person muss etwas beisteuern.</li>
        <li>Rundung: Geht ein Betrag nicht glatt auf, erhalten einzelne Personen 1 Cent mehr – zuerst die zahlende Person (falls beteiligt), dann in der Reihenfolge der Teilnehmendenliste. Die Anteile ergeben immer exakt den Rechnungsbetrag.</li>
        <li>Der Ausgleichsplan lässt jeweils die Person mit der größten Schuld an die Person mit dem größten Guthaben zahlen – so braucht ihr höchstens ${Math.max(0, participants.length - 1)} Überweisungen.</li>
      </ul>
    </details>
    ${participants.length ? fab() : ''}`;
}

// ---------- Teilnehmende

/** PayPal-Status einer Person: eigener Link → Profil, andere mit Konto → nur Anzeige, Platzhalter → bearbeitbar. */
function paypalChip(p, me) {
  const set = p.paypal ? 'paypal-chip--set' : '';
  const label = p.paypal ? '✓ PayPal' : '+ PayPal';
  if (p.id === me) return html`<a class="paypal-chip ${set}" href="#/profil" title="Im Profil ändern">${label}</a>`;
  if (p.linked) return p.paypal ? html`<span class="paypal-chip ${set}" title="paypal.me/${p.paypal}">✓ PayPal</span>` : '';
  return html`<button class="paypal-chip ${set}" data-action="edit-paypal" data-id="${p.id}"
    aria-label="${p.paypal ? `PayPal.me von ${p.name} ändern (${p.paypal})` : `PayPal.me für ${p.name} hinterlegen`}"
    title="${p.paypal ? `paypal.me/${p.paypal}` : 'PayPal.me hinterlegen'}">${label}</button>`;
}

function viewPeople() {
  const { event, participants, activity, summary } = S.data;
  const me = getMe(S.code);
  return html`
    ${eventHeader('Teilnehmende')}

    <section class="card share-card" aria-labelledby="share-heading">
      <h2 id="share-heading">Gruppe einladen</h2>
      <p>Teile den Link oder den Code. Wer ihn hat, kann das Event sehen und Ausgaben eintragen.</p>
      <p class="code" aria-label="Zugangscode ${formatCode(event.code).split('').join(' ')}">${formatCode(event.code)}</p>
      <div class="row">
        <button class="btn btn--primary" data-action="share">${icon('share')} Link teilen</button>
        <button class="btn" data-action="copy-link">${icon('copy')} Link kopieren</button>
        <button class="btn" data-action="copy-code">${icon('copy')} Code kopieren</button>
      </div>
    </section>

    <section aria-labelledby="people-heading" class="section">
      <h2 id="people-heading">Teilnehmende (${participants.length})</h2>
      ${participants.length === 0 ? html`<p class="muted">Noch keine Teilnehmenden – füge unten die erste Person hinzu.</p>` : ''}
      <ul class="list">${participants.map((p) => S.editingPaypal === p.id
        ? html`<li class="card"><form id="paypal-form" class="form" data-id="${p.id}" novalidate>
            <div class="field"><label for="f-paypal">PayPal.me-Link von ${p.name}</label>
              <input id="f-paypal" name="paypal" maxlength="200" value="${p.paypal ? `paypal.me/${p.paypal}` : ''}" placeholder="paypal.me/deinname"
                inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="hint-paypal err-paypal">
              <p class="hint" id="hint-paypal">${p.name} hat noch kein Konto. Trag den PayPal.me-Link für ${p.name} ein, damit die anderen in der Abrechnung direkt per PayPal zahlen können. Sobald ${p.name} sich anmeldet, gilt der Link aus dem Profil.</p>
              <p class="field-error" id="err-paypal"></p></div>
            <div class="form-actions">
              ${canScanQr() ? html`<label class="btn">📷 QR-Code scannen<input type="file" id="f-paypal-qr" accept="image/*" capture="environment" class="visually-hidden"></label>` : ''}
              ${p.paypal ? html`<button class="btn btn--ghost btn--danger-ghost" type="button" data-action="remove-paypal" data-id="${p.id}">Entfernen</button>` : ''}
              <button class="btn" type="button" data-action="cancel-paypal">Abbrechen</button>
              <button class="btn btn--primary" type="submit">Speichern</button>
            </div></form></li>`
        : S.renaming === p.id
        ? html`<li class="card"><form id="rename-form" class="inline-form" data-id="${p.id}" novalidate>
            <div class="field field--grow"><label for="f-rename">Neuer Name für ${p.name}</label>
              <input id="f-rename" name="name" maxlength="60" value="${p.name}" aria-describedby="err-name"><p class="field-error" id="err-name"></p></div>
            <button class="btn btn--primary" type="submit">Speichern</button>
            <button class="btn" type="button" data-action="cancel-rename">Abbrechen</button></form></li>`
        : html`<li class="card person-row">
            ${avatar(p.id, p.name)}
            <span class="person-row__name">${p.name}
              ${p.id === me ? html`<span class="badge">Du</span>` : ''}
              ${p.role === 'organizer' ? html`<span class="badge badge--soft">Organisator:in</span>` : ''}
              ${p.linked ? '' : html`<span class="badge badge--muted" title="Noch nicht mit einem Konto verknüpft">ohne Konto</span>`}
              ${paypalChip(p, me)}</span>
            <span class="muted small person-row__bal">${signedEuro(summary.people[p.id]?.balance ?? 0)}</span>
            <button class="btn-icon" data-action="rename" data-id="${p.id}" aria-label="${p.name} umbenennen" title="Umbenennen">${icon('edit')}</button>
            <button class="btn-icon btn-icon--danger" data-action="remove-person" data-id="${p.id}" aria-label="${p.name} entfernen" title="Entfernen">${icon('trash')}</button>
          </li>`)}</ul>
      <form id="add-person-form" class="inline-form add-person" novalidate>
        <div class="field field--grow">
          <label for="f-new-person">Person hinzufügen</label>
          <input id="f-new-person" name="name" maxlength="60" placeholder="Name" aria-describedby="err-new-name">
          <p class="field-error" id="err-new-name"></p>
        </div>
        <button class="btn btn--primary" type="submit">${icon('plus')} Hinzufügen</button>
      </form>
      <button class="btn btn--ghost" data-action="switch-person">${icon('user')} Ich bin nicht ${person(me)?.name ?? '…'} – anderen Namen wählen</button>
    </section>

    <section class="card section" aria-labelledby="details-heading">
      <h2 id="details-heading">Eventdaten</h2>
      ${S.editingEvent ? html`
        <form id="event-form" class="form" novalidate>
          <div class="form-error" id="form-error" role="alert" hidden></div>
          <div class="field"><label for="e-name">Eventname</label><input id="e-name" name="name" maxlength="120" value="${event.name}" aria-describedby="err-name"><p class="field-error" id="err-name"></p></div>
          <div class="grid-2">
            <div class="field"><label for="e-date">Datum</label><input id="e-date" name="date" type="date" value="${event.date ?? ''}" aria-describedby="err-date"><p class="field-error" id="err-date"></p></div>
            <div class="field"><label for="e-location">Ort</label><input id="e-location" name="location" maxlength="120" value="${event.location ?? ''}"></div>
          </div>
          <div class="field"><label for="e-notes">Notiz</label><textarea id="e-notes" name="notes" rows="2" maxlength="1000">${event.notes ?? ''}</textarea></div>
          <div class="form-actions"><button class="btn" type="button" data-action="cancel-event-edit">Abbrechen</button><button class="btn btn--primary" type="submit">Speichern</button></div>
        </form>` : html`
        <dl class="details">
          <div><dt>Name</dt><dd>${event.name}</dd></div>
          <div><dt>Datum</dt><dd>${event.date ? formatDate(event.date) : '–'}</dd></div>
          <div><dt>Ort</dt><dd>${event.location || '–'}</dd></div>
          ${event.notes ? html`<div><dt>Notiz</dt><dd class="notes">${event.notes}</dd></div>` : ''}
        </dl>
        <button class="btn btn--small" data-action="edit-event">${icon('edit')} Eventdaten bearbeiten</button>`}
    </section>

    <section class="section" aria-labelledby="log-heading">
      <h2 id="log-heading">Verlauf</h2>
      ${activity.length ? html`<ul class="log">${activity.map((a) => html`<li><span>${a.summary}</span><time class="muted small" datetime="${a.at}">${relativeTime(a.at)}</time></li>`)}</ul>`
        : html`<p class="muted">Noch keine Änderungen.</p>`}
    </section>

    <p class="note">ℹ️ Alle Teilnehmenden können Ausgaben eintragen, ändern und löschen. Jede Änderung erscheint mit Namen im Verlauf.</p>
    ${participants.length ? fab() : ''}`;
}

// ---------------------------------------------------------------- Rückmeldungen

let toastTimer;
function toast(message, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast toast--visible toast--${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, type === 'error' ? 6000 : 3500);
}

function confirmDialog({ title, text, confirm = 'OK', danger = false }) {
  const dialog = document.getElementById('dialog');
  if (typeof dialog.showModal !== 'function') return Promise.resolve(window.confirm(`${title}\n\n${text}`));
  dialog.innerHTML = String(html`
    <form method="dialog">
      <h2 id="dialog-title">${title}</h2>
      <p id="dialog-text">${text}</p>
      <div class="row row--end">
        <button class="btn" value="cancel">Abbrechen</button>
        <button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" value="ok">${confirm}</button>
      </div>
    </form>`);
  dialog.setAttribute('aria-labelledby', 'dialog-title');
  dialog.setAttribute('aria-describedby', 'dialog-text');
  dialog.returnValue = '';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
    dialog.showModal();
  });
}

function clearErrors(form) {
  form.querySelectorAll('.field-error').forEach((el) => { el.textContent = ''; });
  form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  const box = form.querySelector('.form-error');
  if (box) { box.hidden = true; box.innerHTML = ''; }
}

function showFieldErrors(form, fields, idMap = {}) {
  let first = null;
  for (const [field, message] of Object.entries(fields)) {
    const errEl = form.querySelector(`#${idMap[field] ?? `err-${field}`}`);
    if (errEl) errEl.textContent = message;
    const input = form.querySelector(`[name="${field}"]`);
    if (input) {
      input.setAttribute('aria-invalid', 'true');
      first ??= input;
    }
  }
  if (!first) {
    showFormError(form, Object.values(fields).join(' '));
  } else {
    first.focus();
  }
}

function showFormError(form, message, buttons = [{ action: 'retry-submit', label: 'Erneut speichern' }]) {
  const box = form.querySelector('.form-error');
  if (!box) { toast(message, 'error'); return; }
  box.innerHTML = String(html`<p>${message}</p>${buttons.length ? html`<div class="row">${buttons.map((b) => html`<button type="button" class="btn btn--small" data-action="${b.action}">${b.label}</button>`)}</div>` : ''}`);
  box.hidden = false;
  box.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function setBusy(button, busy, label = 'Speichert …') {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.innerHTML;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = label;
  } else if (button.dataset.label != null) {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.innerHTML = button.dataset.label;
  }
}

/** Führt eine Änderung aus und übernimmt den neuen Gesamtzustand vom Server. */
async function mutate(action, body, { success, button } = {}) {
  setBusy(button, true);
  try {
    const result = await api(action, { body, code: S.code });
    applyState(result.state);
    render();
    if (success) toast(success);
    return result;
  } catch (error) {
    setBusy(button, false);
    toast(error.message, 'error');
    if (['conflict', 'expense_not_found', 'person_not_found', 'settlement_not_found', 'not_member', 'person_taken', 'already_member'].includes(error.code)) {
      await loadEvent({ silent: true });
      render();
    }
    return null;
  }
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'visually-hidden';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (!ok) { toast(`Kopieren nicht möglich. ${text}`, 'error'); return; }
  }
  toast(message);
}

// ---------------------------------------------------------------- Aktionen

const actions = {
  'retry-load': async () => {
    S.loadError = null;
    if (!S.data) render();
    await loadEvent({ silent: !!S.data });
    render();
  },
  reload: () => location.reload(),
  'retry-submit': (el) => el.closest('form')?.requestSubmit(),
  'create-add-person': () => addCreatePerson(),
  'create-remove-person': (el) => { S.createPeople.splice(Number(el.dataset.index), 1); renderCreatePeople(); document.getElementById('f-person')?.focus(); },
  'pick-person': async (el) => {
    const name = personName(el.dataset.id);
    const ok = await confirmDialog({ title: `Bist du ${name}?`, text: `${name} wird mit deinem Konto verknüpft. Andere sehen das in der Teilnehmendenliste.`, confirm: `Ja, ich bin ${name}` });
    if (!ok) return;
    const result = await mutate('claim_person', { person_id: el.dataset.id }, { success: `Willkommen, ${name}!`, button: el });
    if (result) afterJoin();
  },
  'switch-person': async () => {
    const name = person(getMe(S.code))?.name ?? '';
    const ok = await confirmDialog({ title: 'Anderen Namen wählen?', text: `Die Verknüpfung von ${name} mit deinem Konto wird gelöst. ${name} bleibt mit allen Ausgaben im Event. Danach wählst du deinen richtigen Namen.`, confirm: 'Verknüpfung lösen' });
    if (!ok) return;
    S.afterPick = eventPath('personen');
    if (await mutate('release_person', {}, {})) go(eventPath('wer'));
  },
  logout: async (el) => {
    setBusy(el, true, 'Abmelden …');
    try { await api('logout', { body: {} }); } catch { /* trotzdem lokal abmelden */ }
    S.user = null;
    S.data = null; S.code = null; S.dataJson = '';
    go('#/login');
    toast('Du bist abgemeldet.');
  },
  'resend-verification': async (el) => {
    setBusy(el, true, 'Sendet …');
    try {
      const result = await api('resend_verification', { body: { email: el.dataset.email } });
      toast(result.message);
    } catch (error) { toast(error.message, 'error'); }
    setBusy(el, false);
  },
  'reset-filters': () => { S.filters = { person: '', category: '' }; render(); },
  'toggle-all': () => {
    const boxes = [...document.querySelectorAll('#expense-form input[name="participants"]')];
    const all = boxes.every((b) => b.checked);
    boxes.forEach((b) => { b.checked = !all; });
    updateSplitPreview();
  },
  'delete-expense': async (el) => {
    const expense = S.data.expenses.find((e) => e.id === el.dataset.id);
    if (!expense) return;
    const ok = await confirmDialog({ title: 'Ausgabe löschen?', text: `„${expense.description}“ über ${euro(expense.amount_cents)} wird für alle gelöscht. Die Salden werden neu berechnet.`, confirm: 'Löschen', danger: true });
    if (!ok) return;
    S.openDetails.delete(expense.id);
    await mutate('delete_expense', { id: expense.id, version: expense.version }, { success: 'Ausgabe gelöscht', button: el });
  },
  settle: async (el) => {
    const { from, to } = el.dataset;
    const amount = Number(el.dataset.amount);
    const ok = await confirmDialog({ title: 'Zahlung als erledigt markieren?', text: `${personName(from)} hat ${personName(to)} ${euro(amount)} gezahlt. Die Zahlung wird in den Salden berücksichtigt und kann rückgängig gemacht werden.`, confirm: 'Als bezahlt markieren' });
    if (!ok) return;
    await mutate('add_settlement', { from, to, amount_cents: amount }, { success: 'Zahlung als erledigt markiert', button: el });
  },
  unsettle: async (el) => {
    const ok = await confirmDialog({ title: 'Zahlung zurücknehmen?', text: 'Die Zahlung gilt danach wieder als offen.', confirm: 'Zurücknehmen' });
    if (ok) await mutate('delete_settlement', { id: el.dataset.id }, { success: 'Zahlung zurückgenommen', button: el });
  },
  'edit-paypal': (el) => { S.editingPaypal = el.dataset.id; S.renaming = null; render(); document.getElementById('f-paypal')?.focus(); },
  'cancel-paypal': () => { S.editingPaypal = null; render(); },
  'remove-paypal': async (el) => {
    const result = await mutate('set_paypal', { person_id: el.dataset.id, paypal: '' }, { success: 'PayPal.me-Link entfernt', button: el });
    if (result) { S.editingPaypal = null; render(); }
  },
  rename: (el) => { S.renaming = el.dataset.id; S.editingPaypal = null; render(); document.getElementById('f-rename')?.select(); },
  'cancel-rename': () => { S.renaming = null; render(); },
  'remove-person': async (el) => {
    const p = person(el.dataset.id);
    if (!p) return;
    const ok = await confirmDialog({ title: `${p.name} entfernen?`, text: 'Die Person wird aus dem Event entfernt. Das geht nur, solange sie an keiner Ausgabe beteiligt ist.', confirm: 'Entfernen', danger: true });
    if (!ok) return;
    const wasMe = p.id === getMe(S.code);
    const result = await mutate('remove_participant', { person_id: p.id }, { success: `${p.name} wurde entfernt`, button: el });
    if (result && wasMe) {
      S.user.events = S.user.events.filter((e) => e.code !== S.code);
      go('#/');
    }
  },
  'edit-event': () => { S.editingEvent = true; render(); document.getElementById('e-name')?.focus(); },
  'cancel-event-edit': () => { S.editingEvent = false; render(); },
  share: async () => {
    const { event } = S.data;
    const url = eventLink(event.code);
    if (navigator.share) {
      try { await navigator.share({ title: event.name, text: `Trag deine Ausgaben für „${event.name}“ in FriendSplit ein (Code ${formatCode(event.code)}):`, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    copyText(url, 'Link kopiert – teile ihn mit deiner Gruppe.');
  },
  'copy-link': () => copyText(eventLink(S.data.event.code), 'Link kopiert'),
  'copy-code': () => copyText(formatCode(S.data.event.code), 'Code kopiert'),
};

function addCreatePerson() {
  const input = document.getElementById('f-person');
  const err = document.getElementById('err-participants');
  const names = input.value.split(/[,;\n]/).map((n) => n.trim()).filter(Boolean);
  const creator = S.user.name.toLowerCase();
  err.textContent = '';
  for (const name of names) {
    if (name.length > 60) { err.textContent = 'Namen dürfen höchstens 60 Zeichen lang sein.'; continue; }
    const lower = name.toLowerCase();
    if (lower === creator || S.createPeople.some((p) => p.toLowerCase() === lower)) { err.textContent = `${name} ist bereits in der Liste.`; continue; }
    S.createPeople.push(name);
  }
  input.value = '';
  renderCreatePeople();
  input.focus();
}

// ---------------------------------------------------------------- Formulare

const forms = {
  'login-form': async (form) => {
    clearErrors(form);
    const data = Object.fromEntries(new FormData(form));
    const errors = {};
    if (!data.email.trim()) errors.email = 'Bitte gib deine E-Mail-Adresse ein.';
    if (!data.password) errors.password = 'Bitte gib dein Passwort ein.';
    if (Object.keys(errors).length) return showFieldErrors(form, errors);
    const button = form.querySelector('[type="submit"]');
    setBusy(button, true, 'Anmelden …');
    try {
      S.user = (await api('login', { body: data })).user;
      S.notice = null;
      go(takeAfterLogin());
    } catch (error) {
      setBusy(button, false);
      if (error.code === 'email_not_verified') { S.notice = { email: data.email.trim(), kind: 'unverified' }; render(); return; }
      if (error.fields) showFieldErrors(form, error.fields);
      else showFormError(form, error.message, []);
      form.elements.password.value = '';
    }
  },

  'register-form': async (form) => {
    clearErrors(form);
    const data = Object.fromEntries(new FormData(form));
    const errors = {};
    if (!data.name.trim()) errors.name = 'Bitte gib deinen Namen ein.';
    if (!data.email.trim()) errors.email = 'Bitte gib deine E-Mail-Adresse ein.';
    if (data.password.length < 8) errors.password = 'Das Passwort muss mindestens 8 Zeichen lang sein.';
    if (Object.keys(errors).length) return showFieldErrors(form, errors);
    const button = form.querySelector('[type="submit"]');
    setBusy(button, true, 'Registriert …');
    try {
      await api('register', { body: data });
      S.notice = { email: data.email.trim(), kind: 'registered' };
      render();
    } catch (error) {
      setBusy(button, false);
      if (error.fields) showFieldErrors(form, error.fields);
      else showFormError(form, error.message, []);
    }
  },

  'forgot-form': async (form) => {
    clearErrors(form);
    const email = form.elements.email.value.trim();
    if (!email) return showFieldErrors(form, { email: 'Bitte gib deine E-Mail-Adresse ein.' });
    const button = form.querySelector('[type="submit"]');
    setBusy(button, true, 'Sendet …');
    try {
      await api('request_password_reset', { body: { email } });
      S.notice = { email, kind: 'reset' };
      render();
    } catch (error) {
      setBusy(button, false);
      if (error.fields) showFieldErrors(form, error.fields);
      else showFormError(form, error.message, []);
    }
  },

  'reset-form': async (form) => {
    clearErrors(form);
    const password = form.elements.password.value;
    if (password.length < 8) return showFieldErrors(form, { password: 'Das Passwort muss mindestens 8 Zeichen lang sein.' });
    const button = form.querySelector('[type="submit"]');
    setBusy(button, true);
    try {
      S.user = (await api('reset_password', { body: { token: S.route.token, password } })).user;
      S.notice = null;
      toast('Neues Passwort gespeichert – du bist angemeldet.');
      go(takeAfterLogin());
    } catch (error) {
      setBusy(button, false);
      if (error.fields) showFieldErrors(form, error.fields);
      else showFormError(form, error.code === 'invalid_token' ? html`${error.message} <a href="#/passwort-vergessen">Neuen Link anfordern</a>` : error.message, []);
    }
  },

  'name-form': async (form) => {
    clearErrors(form);
    const name = form.elements.name.value.trim();
    if (!name) return showFieldErrors(form, { name: 'Bitte gib deinen Namen ein.' });
    const button = form.querySelector('[type="submit"]');
    setBusy(button, true);
    try {
      S.user = (await api('update_profile', { body: { name } })).user;
      render();
      toast('Name gespeichert');
    } catch (error) {
      setBusy(button, false);
      if (error.fields) showFieldErrors(form, error.fields);
      else toast(error.message, 'error');
    }
  },

  'email-form': async (form) => {
    clearErrors(form);
    const data = Object.fromEntries(new FormData(form));
    const errors = {};
    if (!data.email.trim()) errors.email = 'Bitte gib die neue E-Mail-Adresse ein.';
    if (!data.current_password) errors.current_password = 'Bitte gib dein aktuelles Passwort ein.';
    if (Object.keys(errors).length) return showFieldErrors(form, errors, { current_password: 'err-email-pw' });
    const button = form.querySelector('[type="submit"]');
    setBusy(button, true, 'Sendet …');
    try {
      S.user = (await api('change_email', { body: data })).user;
      render();
      toast(`Bestätigungslink an ${data.email.trim()} geschickt`);
    } catch (error) {
      setBusy(button, false);
      if (error.fields) showFieldErrors(form, error.fields, { current_password: 'err-email-pw' });
      else showFormError(form, error.message, []);
    }
  },

  'password-form': async (form) => {
    clearErrors(form);
    const data = Object.fromEntries(new FormData(form));
    const errors = {};
    if (!data.current_password) errors.current_password = 'Bitte gib dein aktuelles Passwort ein.';
    if (data.new_password.length < 8) errors.new_password = 'Das neue Passwort muss mindestens 8 Zeichen lang sein.';
    if (Object.keys(errors).length) return showFieldErrors(form, errors, { current_password: 'err-cur-pw' });
    const button = form.querySelector('[type="submit"]');
    setBusy(button, true);
    try {
      S.user = (await api('change_password', { body: data })).user;
      render();
      toast('Passwort geändert – andere Geräte sind abgemeldet.');
    } catch (error) {
      setBusy(button, false);
      if (error.fields) showFieldErrors(form, error.fields, { current_password: 'err-cur-pw' });
      else showFormError(form, error.message, []);
    }
  },

  'delete-form': async (form) => {
    clearErrors(form);
    const password = form.elements.current_password.value;
    if (!password) return showFieldErrors(form, { current_password: 'Bitte gib dein aktuelles Passwort ein.' }, { current_password: 'err-del-pw' });
    const ok = await confirmDialog({ title: 'Konto wirklich löschen?', text: 'Das kann nicht rückgängig gemacht werden. Du wirst abgemeldet und kannst dich mit dieser E-Mail-Adresse neu registrieren.', confirm: 'Endgültig löschen', danger: true });
    if (!ok) return;
    const button = form.querySelector('[type="submit"]');
    setBusy(button, true, 'Löscht …');
    try {
      await api('delete_account', { body: { current_password: password } });
      S.user = null;
      S.data = null; S.code = null; S.dataJson = '';
      local.remove('fs.lastEvent');
      go('#/login');
      toast('Dein Konto wurde gelöscht.');
    } catch (error) {
      setBusy(button, false);
      if (error.fields) showFieldErrors(form, error.fields, { current_password: 'err-del-pw' });
      else showFormError(form, error.message, []);
    }
  },

  'profile-form': async (form) => {
    clearErrors(form);
    const paypal = form.elements.paypal.value.trim();
    const button = form.querySelector('[type="submit"]');
    setBusy(button, true);
    try {
      S.user = (await api('update_profile', { body: { paypal } })).user;
      if (S.code) await loadEvent({ silent: true });
      render();
      toast(paypal ? 'PayPal.me-Link gespeichert' : 'PayPal.me-Link entfernt');
    } catch (error) {
      setBusy(button, false);
      if (error.fields) showFieldErrors(form, error.fields);
      else toast(error.message, 'error');
    }
  },

  'join-form': (form) => {
    clearErrors(form);
    const value = form.elements.code.value;
    const fromLink = value.match(/#\/e\/([A-Za-z0-9-]+)/);
    const code = normalizeCode(fromLink ? fromLink[1] : value);
    if (!CODE_ALPHABET.test(code)) {
      showFieldErrors(form, { code: 'Der Code besteht aus 12 Zeichen, z. B. K7Q2-MX9P-4HTR. Du kannst auch den kompletten Link einfügen.' });
      return;
    }
    go(`#/e/${code}/ausgaben`);
  },

  'create-form': async (form) => {
    clearErrors(form);
    if (document.getElementById('f-person').value.trim()) addCreatePerson();
    const data = Object.fromEntries(new FormData(form));
    const errors = {};
    if (!data.name.trim()) errors.name = 'Bitte gib einen Eventnamen ein.';
    if (Object.keys(errors).length) return showFieldErrors(form, errors);
    const button = form.querySelector('[type="submit"]');
    setBusy(button, true, 'Erstellt …');
    try {
      const result = await api('create_event', { body: { ...data, participants: S.createPeople } });
      S.createPeople = [];
      toast('Event erstellt – lade jetzt deine Gruppe ein.');
      go(`#/e/${result.code}/ausgaben`);
    } catch (error) {
      setBusy(button, false);
      if (error.fields) showFieldErrors(form, error.fields);
      else showFormError(form, `${error.message} Das Event wurde nicht erstellt.`);
    }
  },

  'join-self-form': async (form) => {
    clearErrors(form);
    const name = form.elements.name.value.trim();
    if (!name) return showFieldErrors(form, { name: 'Bitte gib deinen Namen ein.' });
    const button = form.querySelector('[type="submit"]');
    setBusy(button, true);
    try {
      const result = await api('join_event', { body: { name }, code: S.code });
      applyState(result.state);
      toast(`Willkommen, ${name}!`);
      afterJoin();
    } catch (error) {
      setBusy(button, false);
      if (error.fields) showFieldErrors(form, error.fields);
      else toast(error.message, 'error');
    }
  },

  'add-person-form': async (form) => {
    clearErrors(form);
    const name = form.elements.name.value.trim();
    if (!name) return showFieldErrors(form, { name: 'Bitte gib einen Namen ein.' }, { name: 'err-new-name' });
    const button = form.querySelector('[type="submit"]');
    setBusy(button, true);
    try {
      const result = await api('add_participant', { body: { name }, code: S.code });
      applyState(result.state);
      render();
      toast(`${name} wurde hinzugefügt`);
      document.getElementById('f-new-person')?.focus();
    } catch (error) {
      setBusy(button, false);
      if (error.fields) showFieldErrors(form, error.fields, { name: 'err-new-name' });
      else toast(error.message, 'error');
    }
  },

  'rename-form': async (form) => {
    clearErrors(form);
    const name = form.elements.name.value.trim();
    if (!name) return showFieldErrors(form, { name: 'Bitte gib einen Namen ein.' });
    const button = form.querySelector('[type="submit"]');
    setBusy(button, true);
    try {
      const result = await api('rename_participant', { body: { person_id: form.dataset.id, name }, code: S.code });
      S.renaming = null;
      applyState(result.state);
      render();
      toast('Name geändert');
    } catch (error) {
      setBusy(button, false);
      if (error.fields) showFieldErrors(form, error.fields);
      else toast(error.message, 'error');
    }
  },

  'paypal-form': async (form) => {
    clearErrors(form);
    const paypal = form.elements.paypal.value.trim();
    const button = form.querySelector('[type="submit"]');
    setBusy(button, true);
    try {
      const result = await api('set_paypal', { body: { person_id: form.dataset.id, paypal }, code: S.code });
      S.editingPaypal = null;
      applyState(result.state);
      render();
      toast(paypal ? 'PayPal.me-Link gespeichert' : 'PayPal.me-Link entfernt');
    } catch (error) {
      setBusy(button, false);
      if (error.fields) showFieldErrors(form, error.fields);
      else toast(error.message, 'error');
    }
  },

  'event-form': async (form) => {
    clearErrors(form);
    const data = Object.fromEntries(new FormData(form));
    if (!data.name.trim()) return showFieldErrors(form, { name: 'Bitte gib einen Eventnamen ein.' });
    const button = form.querySelector('[type="submit"]');
    setBusy(button, true);
    try {
      const result = await api('update_event', { body: data, code: S.code });
      S.editingEvent = false;
      applyState(result.state);
      render();
      toast('Eventdaten gespeichert');
    } catch (error) {
      setBusy(button, false);
      if (error.fields) showFieldErrors(form, error.fields);
      else showFormError(form, `${error.message} Die Änderungen wurden nicht gespeichert.`);
    }
  },

  'expense-form': async (form, { force = false } = {}) => {
    clearErrors(form);
    const fd = new FormData(form);
    const { cents, payer, participants } = readExpenseForm(form);
    const errors = {};
    if (cents == null || cents <= 0) errors.amount = 'Bitte gib einen gültigen Betrag größer als 0,00 € ein, z. B. 42,50.';
    else if (cents > MAX_AMOUNT_CENTS) errors.amount = `Der Betrag darf höchstens ${euro(MAX_AMOUNT_CENTS)} betragen.`;
    if (!fd.get('category')) errors.category = 'Bitte wähle eine Kategorie.';
    if (!payer) errors.paid_by = 'Bitte wähle aus, wer bezahlt hat.';
    if (!participants.length) errors.participants = 'Bitte wähle mindestens eine beteiligte Person aus.';
    if (!fd.get('spent_at')) errors.spent_at = 'Bitte gib Datum und Uhrzeit an.';
    if (Object.keys(errors).length) return showFieldErrors(form, errors);

    const editing = S.form.expenseId;
    const body = {
      amount_cents: cents,
      description: fd.get('description').trim(),
      category: fd.get('category'),
      paid_by: payer,
      participants,
      spent_at: fd.get('spent_at'),
      notes: fd.get('notes').trim(),
    };
    if (editing) Object.assign(body, { id: editing, version: S.form.version });
    else body.client_token = S.form.token;

    if (!editing && !force) {
      const dup = findDuplicate(body);
      if (dup) {
        const ok = await confirmDialog({
          title: 'Doppelter Eintrag?',
          text: `Es gibt bereits „${dup.description}“ über ${euro(dup.amount_cents)}, bezahlt von ${personName(dup.paid_by)} (${formatTime(dup.spent_at)} Uhr). Trotzdem speichern?`,
          confirm: 'Trotzdem speichern',
        });
        if (!ok) return;
      }
    }

    const button = document.getElementById('save-btn');
    setBusy(button, true);
    try {
      const result = await api('save_expense', { body, code: S.code });
      applyState(result.state);
      if (!editing) S.openDetails.add(result.expense_id);
      S.form = null;
      toast(editing ? 'Änderungen gespeichert' : 'Ausgabe gespeichert');
      go(eventPath());
    } catch (error) {
      setBusy(button, false);
      if (error.code === 'validation' && error.fields) {
        showFieldErrors(form, error.fields);
      } else if (error.code === 'conflict') {
        const current = error.data?.expense;
        S.conflict = current;
        showFormError(form, `${error.message} Aktueller Stand: „${current.description}“, ${euro(current.amount_cents)}, bezahlt von ${personName(current.paid_by)}${current.updated_by ? `, geändert von ${personName(current.updated_by)}` : ''}.`, [
          { action: 'conflict-overwrite', label: 'Meine Version trotzdem speichern' },
          { action: 'conflict-reload', label: 'Aktuelle Version laden' },
        ]);
      } else if (error.code === 'expense_not_found') {
        showFormError(form, `${error.message} Du kannst deine Eingaben als neue Ausgabe speichern.`, [{ action: 'save-as-new', label: 'Als neue Ausgabe speichern' }]);
      } else {
        showFormError(form, `${error.message} Die Ausgabe wurde nicht gespeichert.`);
      }
    }
  },
};

Object.assign(actions, {
  'conflict-overwrite': () => {
    if (!S.conflict) return;
    S.form.version = S.conflict.version;
    S.conflict = null;
    forms['expense-form'](document.getElementById('expense-form'), { force: true });
  },
  'conflict-reload': async () => {
    S.conflict = null;
    await loadEvent({ silent: true });
    S.form = null;
    render();
    toast('Aktuelle Version geladen');
  },
  'save-as-new': () => {
    S.form = { token: randomToken(), version: null, expenseId: null };
    forms['expense-form'](document.getElementById('expense-form'), { force: true });
  },
});

// ---------------------------------------------------------------- Ereignisse

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (!el || !actions[el.dataset.action]) return;
  event.preventDefault();
  actions[el.dataset.action](el, event);
});

document.addEventListener('submit', (event) => {
  const handler = forms[event.target.id];
  if (!handler) return;
  event.preventDefault();
  handler(event.target);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.id === 'f-person') {
    event.preventDefault();
    addCreatePerson();
  }
});

document.addEventListener('input', (event) => {
  const input = event.target;
  if (input.getAttribute('aria-invalid')) {
    input.removeAttribute('aria-invalid');
    const errId = input.getAttribute('aria-describedby')?.split(' ').find((id) => id.startsWith('err-'));
    if (errId) document.getElementById(errId).textContent = '';
  }
  if (input.closest('#expense-form')) updateSplitPreview();
});

document.addEventListener('change', (event) => {
  const { id, value } = event.target;
  if (id === 'f-paypal-qr') { scanPaypalQr(event.target); return; }
  if (id === 'filter-person') { S.filters.person = value; render(); document.getElementById(id)?.focus(); }
  if (id === 'filter-category') { S.filters.category = value; render(); document.getElementById(id)?.focus(); }
  if (event.target.closest('#expense-form')) {
    if (event.target.name === 'participants') {
      const err = document.getElementById('err-participants');
      if (err) err.textContent = '';
    }
    updateSplitPreview();
  }
});

document.addEventListener('toggle', (event) => {
  const el = event.target;
  if (el.matches?.('details.expense')) {
    if (el.open) S.openDetails.add(el.dataset.id); else S.openDetails.delete(el.dataset.id);
  }
}, true);

/** Liest den PayPal-QR-Code aus einem Foto (BarcodeDetector, z. B. Chrome auf Android) und trägt den Link ein. */
async function scanPaypalQr(fileInput) {
  const file = fileInput.files?.[0];
  const input = document.getElementById('f-paypal');
  const err = document.getElementById('err-paypal');
  if (!file || !input) return;
  try {
    const bitmap = await createImageBitmap(file);
    const codes = await new window.BarcodeDetector({ formats: ['qr_code'] }).detect(bitmap);
    const value = codes.find((c) => /paypal/i.test(c.rawValue))?.rawValue ?? codes[0]?.rawValue;
    if (!value) throw new Error('none');
    input.value = value;
    err.textContent = '';
    input.removeAttribute('aria-invalid');
    toast('QR-Code erkannt – prüfen und speichern');
  } catch {
    err.textContent = 'Im Bild wurde kein QR-Code erkannt. Bitte trag deinen PayPal.me-Link von Hand ein.';
  } finally {
    fileInput.value = '';
  }
}

// Regelmäßig aktualisieren, damit Änderungen anderer ohne Neuladen erscheinen.
function isBusyEditing() {
  const active = document.activeElement;
  return S.renaming || S.editingPaypal || S.editingEvent || document.getElementById('dialog').open
    || (active && main.contains(active) && active.matches('input, textarea, select'));
}
async function refresh() {
  if (document.hidden || !S.code || !S.data || isBusyEditing()) return;
  if (!['ausgaben', 'abrechnung', 'personen', 'wer'].includes(S.route.name)) return;
  const wasStale = S.stale;
  const changed = await loadEvent({ silent: true });
  if (changed || wasStale !== S.stale) {
    if (S.route.name !== 'wer' && !person(getMe(S.code))) { onRoute(); return; }
    render();
  }
}
setInterval(refresh, POLL_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.addEventListener('online', refresh);
window.addEventListener('hashchange', onRoute);
onRoute();
