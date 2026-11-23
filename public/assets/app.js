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
  whatsapp: '<path d="M3.5 20.5l1.3-4.2A8.5 8.5 0 1 1 8 19.3l-4.5 1.2Z"/><path d="M9 8.5c0 3 2.5 6 6 6.5l1.3-1.4-2-1-1 .9c-1.2-.5-2.2-1.5-2.7-2.7l.9-1-1-2L9 8.5Z"/>',
};
const icon = (name, cls = 'icon') => raw(`<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`);

// ---------------------------------------------------------------- Formatierung

const euroFormat = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const euro = (cents) => euroFormat.format(Math.abs(cents) / 100);
const signedEuro = (cents) => (cents > 0 ? '+' : cents < 0 ? '−' : '') + euro(cents);
const amountInput = (cents) => (cents / 100).toFixed(2).replace('.', ',');

/** PayPal.me-Link, der direkt mit dem Betrag in Euro öffnet, z. B. https://www.paypal.me/alex/12.34EUR */
const paypalLink = (handle, cents) => `https://www.paypal.me/${encodeURIComponent(handle)}${cents ? `/${(cents / 100).toFixed(2)}EUR` : ''}`;
/** PayPal „Geld senden“ – dort fügt man die kopierte E-Mail ein und wählt „Freunde & Familie“ (kostenlos). */
const PAYPAL_SEND = 'https://www.paypal.com/myaccount/transfer/homepage/pay';
/** Fertiger Zahlungslink an eine E-Mail-Adresse – technisch „Waren & Dienstleistungen“: Gebühren für den Empfänger. */
const paypalInstantLink = (email, cents, note) => `https://www.paypal.com/cgi-bin/webscr?${new URLSearchParams({
  cmd: '_xclick', business: email, amount: (cents / 100).toFixed(2), currency_code: 'EUR', ...(note ? { item_name: note } : {}),
})}`;
/** PayPal-Feld im Formular vorbelegen: E-Mail-Adresse oder PayPal.me-Link */
const paypalValue = (p) => p.paypal_email ?? (p.paypal ? `paypal.me/${p.paypal}` : '');
const hasPaypal = (p) => Boolean(p?.paypal || p?.paypal_email);
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

/**
 * Letzter bekannter Stand auf diesem Gerät (Konto und die zuletzt geöffneten Events). Damit zeigt die App
 * beim Öffnen sofort etwas an und holt den aktuellen Stand im Hintergrund. Beim Abmelden wird alles gelöscht.
 */
const MAX_CACHED_EVENTS = 5;
let savedUserJson = '';
const cache = {
  user: () => local.get('fs.user', null),
  saveUser(user) {
    const json = JSON.stringify(user ?? null);
    if (json === savedUserJson) return;
    savedUserJson = json;
    if (user) local.set('fs.user', user); else local.remove('fs.user');
  },
  state: (code) => local.get(`fs.state.${code}`, null),
  saveState(data) {
    const code = data.event.code;
    local.set(`fs.state.${code}`, data);
    const codes = [code, ...local.get('fs.states', []).filter((c) => c !== code)];
    codes.slice(MAX_CACHED_EVENTS).forEach((c) => local.remove(`fs.state.${c}`));
    local.set('fs.states', codes.slice(0, MAX_CACHED_EVENTS));
  },
  clear() {
    local.get('fs.states', []).forEach((c) => local.remove(`fs.state.${c}`));
    ['fs.states', 'fs.user', 'fs.lastEvent'].forEach((k) => local.remove(k));
    savedUserJson = '';
  },
};
/** Ziel nach der Anmeldung merken – auch über den Bestätigungslink in einem neuen Tab hinweg. */
const rememberAfterLogin = (hash) => (hash && hash.startsWith('#/e/') ? local.set('fs.afterLogin', hash) : local.remove('fs.afterLogin'));
/** Event-Code aus dem gemerkten Ziel (wer über einen Event-Link kam) – oder null. */
const pendingEventCode = () => (local.get('fs.afterLogin', null) ?? '').match(/^#\/e\/([A-Z0-9]{12})/)?.[1] ?? null;

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

async function api(action, { body = null, code = null, params = {} } = {}) {
  const headers = { Accept: 'application/json' };
  if (code) headers['X-Event-Code'] = code;
  if (body) {
    headers['Content-Type'] = 'application/json';
    headers['X-Requested-With'] = 'FriendSplit'; // Schutz vor CSRF, prüft der Server
  }
  let response;
  try {
    const query = new URLSearchParams({ action, ...params });
    response = await fetch(`${API_URL}?${query}`, {
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
      cache.clear();
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
  setupNeeded: false, // noch kein Konto: erstes Konto mit Einrichtungscode anlegen
  challenge: null, // Code aus der E-Mail nötig: { pending, purpose, email }
  inviteInfo: null, // Einladung auf der Registrierungsseite: { code, valid, from, group }
  resetSent: null, // „Passwort vergessen“ abgeschickt (Eingabe zur Anzeige)
  verifying: null, // Zustand beim Bestätigen einer neuen E-Mail-Adresse
  friends: null, // { friends, incoming, outgoing } vom Server
  invites: null,
  permanentInvite: null, // fester Einladungslink (läuft nicht ab)
  search: { q: '', results: [] },
  adminUsers: null,
  createFriends: new Set(), // im Formular „Neues Event“ ausgewählte Freund:innen
};

const main = document.getElementById('main');
const tabbar = document.getElementById('tabbar');
const person = (id) => S.data?.participants.find((p) => p.id === id) ?? null;
const personName = (id) => person(id)?.name ?? 'Ehemalige Person';
const avatarClass = (id) => `avatar avatar--c${[...String(id)].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 8}`;
const avatar = (id, name) => html`<span class="${avatarClass(id)}" aria-hidden="true">${(name || '?').trim().charAt(0).toUpperCase()}</span>`;

function applyState(data, { fromCache = false } = {}) {
  const json = JSON.stringify(data);
  const changed = json !== S.dataJson;
  S.data = data;
  S.dataJson = json;
  S.stale = false;
  local.set('fs.lastEvent', data.event.code);
  if (!fromCache) cache.saveState(data);
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

/** Aktuellen Stand nachladen, nachdem der gespeicherte schon angezeigt wird. */
async function refreshEvent(route) {
  const changed = await loadEvent({ silent: true });
  if (!changed || S.route !== route || !S.data) return;
  const me = person(getMe(S.code));
  if (route.name === 'wer' && me) location.replace(eventPath());
  else if (route.name !== 'wer' && !me) { S.afterPick = location.hash; location.replace(eventPath('wer')); }
  else if (!isBusyEditing()) render();
}

// ---------------------------------------------------------------- Routing

function parseRoute() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'neu') return { name: 'create' };
  if (parts[0] === 'login') return { name: 'login' };
  if (parts[0] === 'einrichten') return { name: 'setup' };
  if (parts[0] === 'registrieren') return { name: 'register', invite: parts[1] ?? '' };
  if (parts[0] === 'code') return { name: 'code' };
  if (parts[0] === 'passwort-vergessen') return { name: 'forgot' };
  if (parts[0] === 'passwort-neu' && parts[1]) return { name: 'reset', token: parts[1] };
  if (parts[0] === 'email-bestaetigen' && parts[1]) return { name: 'verify', token: parts[1] };
  if (parts[0] === 'profil') return { name: 'profile' };
  if (parts[0] === 'freunde') return { name: 'friends' };
  if (parts[0] === 'admin') return { name: 'admin' };
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

const PUBLIC_ROUTES = ['login', 'setup', 'register', 'code', 'forgot', 'verify', 'reset'];
const LOGIN_ROUTES = ['login', 'setup', 'register', 'code', 'forgot'];

async function loadUser() {
  try {
    S.user = (await api('me')).user;
  } catch (error) {
    S.user = error.code === 'not_authenticated' ? null : undefined;
    if (S.user === undefined) throw error;
    S.setupNeeded = (await api('status')).setup_needed;
  }
}

/** Antwort von Login, Registrierung usw.: entweder angemeldet oder Code aus der E-Mail nötig. */
function afterAuth(result) {
  if (result.pending) {
    S.challenge = result;
    go('#/code');
    return;
  }
  S.user = result.user;
  S.challenge = null;
  S.setupNeeded = false;
  S.friends = null;
  go(takeAfterLogin());
}

/** Lädt Daten, die eine Seite braucht, und zeichnet danach neu. */
async function loadFor(route) {
  const jobs = [];
  // Freunde bei jedem Öffnen frisch laden – Anfragen können inzwischen angenommen worden sein.
  if (['friends', 'create', 'personen'].includes(route.name)) jobs.push(api('friends').then(applyFriends));
  if (route.name === 'home') jobs.push(api('me').then((d) => { S.user = d.user; }));
  if (route.name === 'friends' && !S.invites) jobs.push(api('invites').then((d) => { S.invites = d.invites; }));
  if (route.name === 'friends') jobs.push(api('invite_permanent', { body: {} }).then((d) => { S.permanentInvite = d.invite; }));
  if (route.name === 'admin') jobs.push(api('admin_users').then((d) => { S.adminUsers = d.users; }));
  if (route.name === 'register' && route.invite && S.inviteInfo?.code !== route.invite) {
    jobs.push(api('invite_info', { params: { code: route.invite } }).then((d) => {
      S.inviteInfo = { code: route.invite, ...d };
      // Event-Link als Einladung: nach der Registrierung direkt ins Event
      if (d.event) rememberAfterLogin(`#/e/${normalizeCode(route.invite)}/ausgaben`);
    }));
  }
  if (!jobs.length) return;
  try {
    await Promise.all(jobs);
    if (S.route !== route) return;
    if (route.name === 'create') renderCreateFriends();
    else if (!isBusyEditing()) render();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function onRoute() {
  let route = parseRoute();
  if (S.user === undefined) {
    const cachedUser = cache.user();
    if (cachedUser) {
      // Sofort mit dem bekannten Konto loslegen, im Hintergrund prüfen (abgemeldet → api() leitet zur Anmeldung).
      S.user = cachedUser;
      savedUserJson = JSON.stringify(cachedUser);
      api('me').then((d) => { S.user = d.user; if (!isBusyEditing() && !S.route.code) render(); }).catch(() => {});
    } else {
      try { await loadUser(); } catch (error) { main.innerHTML = String(viewOffline(error)); return; }
      route = parseRoute();
    }
  }
  // Ohne Anmeldung nur Login, Registrierung und E-Mail-Links; angemeldet keine Login-Seiten.
  if (!S.user && !PUBLIC_ROUTES.includes(route.name)) {
    rememberAfterLogin(location.hash);
    location.replace(S.setupNeeded ? '#/einrichten' : '#/login');
    return;
  }
  if (!S.user && route.name === 'code' && !S.challenge) {
    location.replace('#/login');
    return;
  }
  if (S.user && LOGIN_ROUTES.includes(route.name)) {
    location.replace(takeAfterLogin());
    return;
  }
  if (route.name === 'admin' && S.user?.role !== 'admin') {
    location.replace('#/');
    return;
  }
  const previous = S.route;
  S.route = route;
  if (route.name === 'verify' && previous.token !== route.token) verifyEmail(route.token);
  if (route.name === 'register' && route.invite && normalizeCode(route.invite) !== pendingEventCode()) rememberAfterLogin(null);
  loadFor(route);
  if (route.name !== 'expense') S.form = null;
  if (route.name !== 'personen') { S.renaming = null; S.editingEvent = false; }

  if (route.code) {
    if (S.code !== route.code) {
      Object.assign(S, { code: route.code, data: null, dataJson: '', loadError: null, stale: false, filters: { person: '', category: '' } });
      S.openDetails.clear();
    }
    if (!S.data && !CODE_ALPHABET.test(route.code)) {
      S.loadError = new ApiError('event_not_found', 'Dieser Link enthält keinen gültigen Event-Code.');
    } else if (!S.data && cache.state(route.code)) {
      // Letzten Stand sofort zeigen, aktuellen im Hintergrund holen
      applyState(cache.state(route.code), { fromCache: true });
      refreshEvent(route);
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
  cache.saveUser(S.user);
  const views = {
    home: viewHome, create: viewCreate, wer: viewPicker, ausgaben: viewExpenses, abrechnung: viewSettle, personen: viewPeople, expense: viewExpenseForm,
    login: viewLogin, setup: viewSetup, register: viewRegister, code: viewCode, forgot: viewForgot, verify: viewVerify, reset: viewReset,
    profile: viewProfile, friends: viewFriends, admin: viewAdmin,
  };
  let content;
  if (S.route.code && !S.data) content = S.loadError ? viewLoadError() : viewLoading();
  else content = views[S.route.name]();
  main.innerHTML = String(content);
  renderTabbar();
  if (S.route.name === 'expense' && S.data) updateSplitPreview();
  if (S.route.name === 'create') { renderCreatePeople(); renderCreateFriends(); }
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
        ${isClosed() ? '' : html`<a class="btn btn--primary hide-mobile" href="${eventPath('ausgabe/neu')}">${icon('plus')} Ausgabe hinzufügen</a>`}
      </div>
    </header>`;
}

/** Abrechnung abgeschlossen? Dann lassen sich keine Ausgaben mehr ändern. */
const isClosed = () => Boolean(S.data?.event.closed_at);
const fab = () => (isClosed() ? '' : html`<a class="fab" href="${eventPath('ausgabe/neu')}">${icon('plus')}<span>Ausgabe hinzufügen</span></a>`);

// ---------- Start / Events

function viewHome() {
  const events = S.user.events;
  return html`
    <div class="topbar">
      <a class="chip" href="#/freunde">${icon('people')}<span>Freunde</span>${S.user.friend_requests ? html`<span class="count" aria-label="${S.user.friend_requests} offene Anfragen">${S.user.friend_requests}</span>` : ''}</a>
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
        <p class="hint" id="hint-person">Du (${S.user.name}) bist automatisch dabei. Mit Enter hinzufügen. Für Leute ohne Konto – sie wählen ihren Namen, wenn sie den Link öffnen.</p>
        <p class="field-error" id="err-participants"></p>
        <ul class="chips" id="people-chips" aria-label="Hinzugefügte Teilnehmende"></ul>
      </div>
      <div id="create-friends"></div>
      <div class="form-actions">
        <a class="btn" href="#/">Abbrechen</a>
        <button class="btn btn--primary" type="submit">Event erstellen</button>
      </div>
    </form>`;
}

/** Freundesauswahl im Formular „Neues Event“ – eigener Bereich, damit Eingaben beim Nachladen erhalten bleiben. */
function renderCreateFriends() {
  const box = document.getElementById('create-friends');
  if (!box) return;
  const friends = S.friends?.friends ?? [];
  box.innerHTML = String(friends.length ? html`
    <fieldset class="field">
      <legend>Freunde direkt dazuholen</legend>
      <div class="chips chips--select">${friends.map((f) => html`
        <label class="chip chip--check"><input type="checkbox" name="friends" value="${f.id}" ${S.createFriends.has(f.id) ? raw('checked') : ''}><span>${f.name}</span></label>`)}</div>
      <p class="hint">Das Event erscheint sofort bei ihnen – ohne Link. Steht der Name schon oben, wird er mit dem Konto verknüpft.</p>
    </fieldset>` : '');
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

const passwordField = (id, label, autocomplete, hint = 'Mindestens 10 Zeichen.') => html`
  <div class="field"><label for="${id}">${label}</label>
    <input id="${id}" name="password" type="password" autocomplete="${autocomplete}" minlength="10" aria-describedby="hint-${id} err-password">
    ${hint ? html`<p class="hint" id="hint-${id}">${hint}</p>` : ''}<p class="field-error" id="err-password"></p></div>`;

const nameEmailFields = () => html`
  <div class="field"><label for="f-name">Dein Name</label>
    <input id="f-name" name="name" maxlength="24" autocomplete="nickname" placeholder="z. B. Tim Müller" aria-describedby="hint-name err-name">
    <p class="hint" id="hint-name">So finden dich deine Freunde. 3–24 Zeichen.</p><p class="field-error" id="err-name"></p></div>
  <div class="field"><label for="f-email">E-Mail-Adresse</label>
    <input id="f-email" name="email" type="email" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" aria-describedby="hint-email err-email">
    <p class="hint" id="hint-email">Nur für Codes und „Passwort vergessen“. Deine Freunde sehen sie nicht.</p><p class="field-error" id="err-email"></p></div>`;

function viewLogin() {
  const eventCode = pendingEventCode();
  return html`
    ${authHead('Anmelden', 'Teilt Ausgaben mit euren Freunden – alle Events an einem Ort, auf jedem Gerät.')}
    ${eventCode ? html`
    <div class="card invited" role="status">
      <h2>Du wurdest zu einem Event eingeladen</h2>
      <p>Neu bei FriendSplit? Leg kurz ein Konto an – danach bist du direkt im Event und wählst deinen Namen.</p>
      <a class="btn btn--primary btn--large" href="#/registrieren/${formatCode(eventCode)}">Konto erstellen</a>
      <p class="muted small">Schon ein Konto? Dann unten anmelden.</p>
    </div>` : ''}
    <form id="login-form" class="form card" novalidate>
      <div class="form-error" role="alert" hidden></div>
      <div class="field"><label for="f-login">Name oder E-Mail-Adresse</label>
        <input id="f-login" name="login" autocomplete="username" autocapitalize="off" spellcheck="false" aria-describedby="err-login"><p class="field-error" id="err-login"></p></div>
      <div class="field"><label for="f-password">Passwort</label>
        <input id="f-password" name="password" type="password" autocomplete="current-password" aria-describedby="err-password"><p class="field-error" id="err-password"></p></div>
      <div class="form-actions form-actions--split">
        <a href="#/passwort-vergessen">Passwort vergessen?</a>
        <button class="btn btn--primary" type="submit">Anmelden</button>
      </div>
    </form>
    ${eventCode ? '' : html`<p class="center muted small">Neu hier? FriendSplit ist nur mit Einladung. Einen Einladungs- oder Event-Link bekommst du von jemandem, der schon dabei ist.<br>
      <a href="#/registrieren">Ich habe einen Einladungscode</a></p>`}`;
}

function viewSetup() {
  return html`
    ${authHead('FriendSplit einrichten', 'Es gibt noch kein Konto. Lege das erste Konto an – es bekommt Admin-Rechte und kann Freunde einladen.')}
    <form id="setup-form" class="form card" novalidate>
      <div class="form-error" role="alert" hidden></div>
      <div class="field"><label for="f-setup-code">Einrichtungscode</label>
        <input id="f-setup-code" name="code" type="password" autocomplete="off" aria-describedby="hint-setup-code err-code">
        <p class="hint" id="hint-setup-code">Das GitHub-Secret SETUP_CODE – oder, falls nicht gesetzt, das Datenbank-Passwort.</p><p class="field-error" id="err-code"></p></div>
      ${nameEmailFields()}
      ${passwordField('f-password', 'Passwort', 'new-password')}
      <div class="form-actions"><button class="btn btn--primary" type="submit">Konto anlegen</button></div>
    </form>
    <p class="center"><a href="#/login">Es gibt schon ein Konto? Anmelden</a></p>`;
}

function viewRegister() {
  const invite = S.route.invite ? formatCode(normalizeCode(S.route.invite)) : '';
  const info = S.inviteInfo?.code === S.route.invite ? S.inviteInfo : null;
  return html`
    ${authHead('Konto erstellen', 'Mit deinem Konto siehst du alle deine Events auf jedem Gerät und kannst Freunde direkt dazuholen.')}
    ${info?.valid && info.event ? html`<div class="banner banner--pos" role="status"><span>${info.from ? html`<strong>${info.from}</strong> lädt dich` : 'Du bist'} zum Event <strong>„${info.event}“</strong> ${info.from ? 'ein' : 'eingeladen'}. Leg dein Konto an – danach bist du direkt im Event und wählst deinen Namen.</span></div>`
      : info?.valid ? html`<div class="banner banner--pos" role="status"><span><strong>${info.from}</strong> ${info.group ? 'lädt eure Gruppe' : 'lädt dich'} zu FriendSplit ein. Danach könnt ihr euch als Freunde verbinden.</span></div>` : ''}
    ${info && !info.valid ? html`<div class="banner banner--warn" role="status"><span>Diese Einladung ist schon benutzt, voll oder abgelaufen. Bitte um einen neuen Link.</span></div>` : ''}
    <form id="register-form" class="form card" novalidate>
      <div class="form-error" role="alert" hidden></div>
      <div class="field"><label for="f-invite">${info?.event ? 'Event-Code' : 'Einladungscode'}</label>
        <input id="f-invite" name="invite" value="${invite}" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="z. B. ABCD-EFGH-JKLM" aria-describedby="err-invite"><p class="field-error" id="err-invite"></p></div>
      ${nameEmailFields()}
      ${passwordField('f-password', 'Passwort', 'new-password')}
      <div class="form-actions"><button class="btn btn--primary" type="submit">Registrieren</button></div>
    </form>
    <p class="center">Schon registriert? <a href="#/login">Anmelden</a></p>`;
}

function viewCode() {
  const c = S.challenge;
  return html`
    ${authHead(c.purpose === 'verify' ? 'E-Mail bestätigen' : 'Neues Gerät bestätigen',
      c.purpose === 'verify'
        ? `Wir haben dir einen 6-stelligen Code an ${c.email} geschickt. Damit bestätigst du deine E-Mail-Adresse und bist angemeldet.`
        : `Du meldest dich auf einem neuen Gerät an. Zur Sicherheit haben wir dir einen 6-stelligen Code an ${c.email} geschickt. Dieses Gerät merken wir uns danach 90 Tage.`)}
    <form id="code-form" class="form card" novalidate>
      <div class="form-error" role="alert" hidden></div>
      <div class="field"><label for="f-code">Code aus der E-Mail</label>
        <input id="f-code" name="code" class="input-code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123456" aria-describedby="hint-code err-code">
        <p class="hint" id="hint-code">Gilt 15 Minuten. Schau auch im Spam-Ordner nach.</p><p class="field-error" id="err-code"></p></div>
      <div class="form-actions form-actions--split">
        <button class="btn btn--ghost" type="button" data-action="resend-code">Code erneut senden</button>
        <button class="btn btn--primary" type="submit">Bestätigen</button>
      </div>
    </form>
    <p class="center"><a href="#/login" data-action="cancel-code">Abbrechen</a></p>`;
}

function viewForgot() {
  if (S.resetSent) {
    return html`${authHead('E-Mail ist unterwegs')}
      <div class="card notice" role="status"><p>Falls es ein Konto zu <strong>${S.resetSent}</strong> gibt, haben wir dir einen Link an die hinterlegte E-Mail-Adresse geschickt. Er ist 60 Minuten gültig.</p>
        <p class="muted small">Nichts angekommen? Der Admin kann dir auch direkt einen Link geben.</p></div>
      <p class="center"><a href="#/login">Zur Anmeldung</a></p>`;
  }
  return html`
    ${authHead('Passwort vergessen', 'Gib deinen Namen oder deine E-Mail-Adresse ein. Wir schicken dir einen Link, mit dem du ein neues Passwort festlegst.')}
    <form id="forgot-form" class="form card" novalidate>
      <div class="form-error" role="alert" hidden></div>
      <div class="field"><label for="f-login">Name oder E-Mail-Adresse</label>
        <input id="f-login" name="login" autocomplete="username" autocapitalize="off" spellcheck="false" aria-describedby="err-login"><p class="field-error" id="err-login"></p></div>
      <div class="form-actions form-actions--split"><a href="#/login">Zurück</a><button class="btn btn--primary" type="submit">Link senden</button></div>
    </form>`;
}

/** Link aus der E-Mail „neue Adresse bestätigen“ */
async function verifyEmail(token) {
  S.verifying = { state: 'busy' };
  try {
    const result = await api('confirm_email_change', { body: { token } });
    S.user = result.user;
    S.verifying = null;
    toast(`Deine E-Mail-Adresse ist jetzt ${result.user.email}.`);
    go('#/profil');
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
      <div class="row row--center"><a class="btn btn--primary" href="${S.user ? '#/profil' : '#/login'}">${S.user ? 'Zum Profil' : 'Zur Anmeldung'}</a></div>
    </section>`;
}

function viewReset() {
  return html`
    ${authHead('Neues Passwort', 'Lege ein neues Passwort fest. Danach bist du angemeldet und auf allen anderen Geräten abgemeldet.')}
    <form id="reset-form" class="form card" novalidate>
      <div class="form-error" role="alert" hidden></div>
      ${passwordField('f-password', 'Neues Passwort', 'new-password', 'Mindestens 10 Zeichen.')}
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

    <nav class="card profile-links" aria-label="Konto">
      <a class="profile-link" href="#/freunde">${icon('people')}<span>Freunde und Einladungen</span>${u.friend_requests ? html`<span class="count">${u.friend_requests}</span>` : ''}</a>
      ${u.role === 'admin' ? html`<a class="profile-link" href="#/admin">${icon('user')}<span>Nutzer verwalten (Admin)</span></a>` : ''}
    </nav>

    <section class="card section" aria-labelledby="name-heading">
      <h2 id="name-heading">Name</h2>
      <form id="name-form" class="inline-form" novalidate>
        <div class="field field--grow"><label for="f-name">Dein Name</label>
          <input id="f-name" name="name" maxlength="24" value="${u.name}" autocomplete="nickname" aria-describedby="hint-name err-name">
          <p class="hint" id="hint-name">So finden dich deine Freunde, und so heißt du in neuen Events. In bestehenden Events änderst du deinen Namen unter „Teilnehmende“.</p>
          <p class="field-error" id="err-name"></p></div>
        <button class="btn btn--primary" type="submit">Speichern</button>
      </form>
    </section>

    <section class="card section" aria-labelledby="paypal-heading">
      <h2 id="paypal-heading">PayPal</h2>
      <form id="profile-form" class="form" novalidate>
        <div class="field"><label for="f-paypal">Deine PayPal-E-Mail-Adresse</label>
          <input id="f-paypal" name="paypal" maxlength="200" value="${paypalValue(u)}" placeholder="z. B. name@gmail.com"
            type="text" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" aria-describedby="hint-paypal err-paypal">
          <p class="hint" id="hint-paypal">Die Adresse, mit der du bei PayPal angemeldet bist. Wer dir Geld schuldet, sieht sie in der Abrechnung und im PDF und kann dir direkt etwas senden. Gilt in allen deinen Events. Ein PayPal.me-Link geht auch.</p>
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
            <input id="f-new-pw" name="new_password" type="password" autocomplete="new-password" minlength="10" aria-describedby="hint-new-pw err-new_password">
            <p class="hint" id="hint-new-pw">Mindestens 10 Zeichen. Andere Geräte werden danach abgemeldet.</p>
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

// ---------- Freunde und Einladungen

function viewFriends() {
  const f = S.friends;
  const back = html`<header class="form-head"><a class="btn-icon" href="#/" aria-label="Zurück">${icon('back')}</a><h1 tabindex="-1">Freunde</h1></header>`;
  if (!f) return html`${back}<div class="state-msg" role="status"><span class="spinner" aria-hidden="true"></span> Freunde werden geladen …</div>`;
  const statusLabel = { friend: '✓ Freunde', outgoing: 'Angefragt', incoming: 'Fragt dich an' };
  return html`
    ${back}
    ${f.incoming.length ? html`
    <section class="section" aria-labelledby="req-heading">
      <h2 id="req-heading">Freundschaftsanfragen</h2>
      <ul class="list">${f.incoming.map((p) => html`
        <li class="card person-row">${avatar(p.id, p.name)}<span class="person-row__name">${p.name}</span>
          <button class="btn btn--small btn--primary" data-action="friend-accept" data-id="${p.id}">Annehmen</button>
          <button class="btn btn--small btn--ghost" data-action="friend-remove" data-id="${p.id}" data-kind="decline">Ablehnen</button></li>`)}</ul>
    </section>` : ''}

    <section class="section" aria-labelledby="friends-heading">
      <h2 id="friends-heading">Deine Freunde (${f.friends.length})</h2>
      ${f.friends.length === 0 ? html`<p class="muted">Noch keine Freunde. Lade jemanden ein oder suche unten nach Namen.</p>` : html`
      <ul class="list">${f.friends.map((p) => html`
        <li class="card person-row">${avatar(p.id, p.name)}<span class="person-row__name">${p.name}${p.paypal ? html` <span class="paypal-chip paypal-chip--set">✓ PayPal</span>` : ''}</span>
          <button class="btn-icon btn-icon--danger" data-action="friend-remove" data-id="${p.id}" data-name="${p.name}" data-kind="remove" aria-label="Freundschaft mit ${p.name} beenden" title="Entfernen">${icon('trash')}</button></li>`)}</ul>`}
      ${f.outgoing.length ? html`<p class="muted small">Angefragt: ${f.outgoing.map((p, i) => html`${i ? ', ' : ''}${p.name} <button class="linkish" data-action="friend-remove" data-id="${p.id}" data-kind="cancel">zurückziehen</button>`)}</p>` : ''}
    </section>

    <section class="card section invite-card" aria-labelledby="invite-heading">
      <h2 id="invite-heading">Freunde einladen</h2>
      <p class="muted small">FriendSplit ist nur mit Einladung. Wer sich über deinen Link registriert, bekommt automatisch eine Freundschaftsanfrage von dir.</p>
      ${S.permanentInvite ? html`
      <div class="permalink">
        <p class="permalink__title"><strong>Dein Einladungslink</strong> · gilt dauerhaft, für beliebig viele Personen – ideal für eure WhatsApp-Gruppe</p>
        <code class="permalink__url">${S.permanentInvite.link}</code>
        <div class="row">
          <button class="btn btn--primary" data-action="invite-share" data-link="${S.permanentInvite.link}">${icon('share')} Link teilen</button>
          <button class="btn" data-action="invite-copy" data-link="${S.permanentInvite.link}">${icon('copy')} Kopieren</button>
        </div>
        <p class="muted small">${S.permanentInvite.members.length
          ? `${plural(S.permanentInvite.members.length, 'Person hat', 'Personen haben')} sich darüber registriert: ${joinNames(S.permanentInvite.members)}.`
          : 'Noch niemand hat sich darüber registriert.'}
          <button class="linkish" data-action="invite-renew">Neuen Link erzeugen</button></p>
      </div>` : html`<p class="muted small"><span class="spinner" aria-hidden="true"></span> Link wird geladen …</p>`}

      <details class="account-box">
        <summary>Link nur für eine Person oder Gruppe (14 Tage)</summary>
        <form id="invite-form" class="inline-form" novalidate>
          <div class="field field--grow"><label for="f-invite-note">Für wen? <span class="opt">(optional)</span></label>
            <input id="f-invite-note" name="note" maxlength="100" placeholder="z. B. Sam oder WG"></div>
          <label class="check"><input type="checkbox" name="group"> Gruppenlink (bis 30 Personen)</label>
          <button class="btn btn--primary" type="submit">${icon('plus')} Link erstellen</button>
        </form>
      </details>
      ${temporaryInvites().length ? html`<ul class="list invites">${temporaryInvites().map((i) => html`
        <li class="invite ${i.open ? '' : 'invite--used'}">
          <div><strong>${i.note || (i.group ? 'Gruppenlink' : 'Einladung')}</strong> <code>${i.code}</code>
            <p class="muted small">${i.open ? `${i.group ? `${i.uses} von ${i.max_uses} genutzt · ` : ''}gültig bis ${formatDate(i.expires_at.slice(0, 10))}` : 'verbraucht oder abgelaufen'}${i.members.length ? ` · ${joinNames(i.members)}` : ''}</p></div>
          <div class="row">
            ${i.open ? html`<button class="btn btn--small" data-action="invite-share" data-link="${i.link}">${icon('share')} Teilen</button>` : ''}
            <button class="btn-icon btn-icon--danger" data-action="invite-delete" data-code="${i.code}" aria-label="Einladung ${i.code} löschen" title="Löschen">${icon('trash')}</button>
          </div></li>`)}</ul>` : ''}
    </section>

    <section class="card section" aria-labelledby="search-heading">
      <h2 id="search-heading">Freunde finden</h2>
      <div class="field"><label for="f-search">Name suchen</label>
        <input id="f-search" type="search" value="${S.search.q}" autocomplete="off" placeholder="mind. 2 Buchstaben" aria-describedby="search-results"></div>
      <ul class="list" id="search-results" aria-live="polite">${searchResults(statusLabel)}</ul>
    </section>`;
}

/** Einladungen mit Ablaufdatum (der Dauerlink steht separat oben). */
const temporaryInvites = () => (S.invites ?? []).filter((i) => !i.permanent);

function searchResults(statusLabel = { friend: '✓ Freunde', outgoing: 'Angefragt', incoming: 'Fragt dich an' }) {
  const { q, results } = S.search;
  if (q.trim().length < 2) return '';
  if (!results.length) return html`<li class="muted small">Niemand gefunden. Ist die Person schon registriert? Sonst lade sie ein.</li>`;
  return html`${results.map((r) => html`
    <li class="person-row">${avatar(r.id, r.name)}<span class="person-row__name">${r.name}</span>
      ${r.status === 'none' ? html`<button class="btn btn--small btn--primary" data-action="friend-request" data-id="${r.id}">Anfragen</button>`
        : r.status === 'incoming' ? html`<button class="btn btn--small btn--primary" data-action="friend-accept" data-id="${r.id}">Annehmen</button>`
        : html`<span class="muted small">${statusLabel[r.status]}</span>`}</li>`)}`;
}

let searchTimer = null;
function onSearchInput(value) {
  S.search.q = value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    if (value.trim().length < 2) { S.search.results = []; updateSearch(); return; }
    try {
      const { results } = await api('search', { params: { q: value.trim() } });
      if (S.search.q === value) { S.search.results = results; updateSearch(); }
    } catch (error) { toast(error.message, 'error'); }
  }, 250);
}
function updateSearch() {
  const list = document.getElementById('search-results');
  if (list) list.innerHTML = String(searchResults());
}

/** Freunde-Antwort vom Server übernehmen (Anfragen-Zähler im Profil mitziehen). */
function applyFriends(data) {
  S.friends = data;
  if (S.user) S.user.friend_requests = data.incoming.length;
  const status = {};
  data.friends.forEach((p) => { status[p.id] = 'friend'; });
  data.incoming.forEach((p) => { status[p.id] = 'incoming'; });
  data.outgoing.forEach((p) => { status[p.id] = 'outgoing'; });
  S.search.results = S.search.results.map((r) => ({ ...r, status: status[r.id] ?? 'none' }));
}

// ---------- Admin

function viewAdmin() {
  const users = S.adminUsers;
  const head = html`<header class="form-head"><a class="btn-icon" href="#/profil" aria-label="Zurück">${icon('back')}</a><h1 tabindex="-1">Nutzer verwalten</h1></header>`;
  if (!users) return html`${head}<div class="state-msg" role="status"><span class="spinner" aria-hidden="true"></span> Wird geladen …</div>`;
  return html`
    ${head}
    <p class="muted small">${plural(users.length, 'Konto', 'Konten')}. Kommen E-Mails nicht an, erzeuge einen Passwort-Link (24 Stunden gültig) und gib ihn direkt weiter.</p>
    <ul class="list">${users.map((u) => html`
      <li class="card admin-user ${u.blocked ? 'admin-user--blocked' : ''}">
        <div class="admin-user__head">${avatar(u.id, u.name)}
          <div><strong>${u.name}</strong>${u.role === 'admin' ? html` <span class="badge badge--soft">Admin</span>` : ''}${u.blocked ? html` <span class="badge badge--danger">gesperrt</span>` : ''}${u.verified ? '' : html` <span class="badge badge--muted">unbestätigt</span>`}
            <p class="muted small">${u.email}</p></div></div>
        <p class="small muted">Seit ${formatDate(u.created_at.slice(0, 10))}${u.invited_by ? ` · eingeladen von ${u.invited_by}` : ''} · zuletzt angemeldet ${u.last_login_at ? relativeTime(u.last_login_at) : 'nie'} · ${plural(u.events, 'Event', 'Events')} · ${plural(u.friends, 'Freund', 'Freunde')}</p>
        ${u.id === S.user.id ? '' : html`<div class="row">
          <button class="btn btn--small" data-action="admin-reset-link" data-id="${u.id}" data-name="${u.name}">Passwort-Link</button>
          <button class="btn btn--small" data-action="admin-block" data-id="${u.id}" data-name="${u.name}" data-blocked="${u.blocked ? '' : '1'}">${u.blocked ? 'Entsperren' : 'Sperren'}</button>
          <button class="btn btn--small btn--ghost btn--danger-ghost" data-action="admin-delete" data-id="${u.id}" data-name="${u.name}">Löschen</button></div>`}
      </li>`)}</ul>`;
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
          ${isClosed() ? '' : html`<div class="row">
            <a class="btn btn--small" href="${eventPath(`ausgabe/${e.id}`)}">${icon('edit')} Bearbeiten</a>
            <button class="btn btn--small btn--danger-ghost" data-action="delete-expense" data-id="${e.id}">${icon('trash')} Löschen</button>
          </div>`}
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
  if (isClosed()) {
    return html`<section class="empty"><div class="empty__icon" aria-hidden="true">🔒</div><h1 tabindex="-1">Abrechnung ist abgeschlossen</h1>
      <p>Ausgaben lassen sich nicht mehr ändern. Unter „Abrechnung“ kannst du sie wieder öffnen.</p><a class="btn btn--primary" href="${eventPath('abrechnung')}">Zur Abrechnung</a></section>`;
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
    ${closingCard()}

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
                  : person(pay.to)?.paypal_email
                    ? html`<span class="paypal-mail">
                        <button class="btn btn--small btn--paypal ${pay.from === me ? 'btn--primary' : ''}" data-action="paypal-email" data-to="${pay.to}" data-amount="${pay.amount_cents}"
                          aria-label="${euro(pay.amount_cents)} per PayPal an ${personName(pay.to)} senden: E-Mail kopieren und PayPal öffnen">PayPal: ${euro(pay.amount_cents)} senden</button>
                        <span class="muted small">an ${person(pay.to).paypal_email} ·
                          <a href="${paypalInstantLink(person(pay.to).paypal_email, pay.amount_cents, `FriendSplit: ${S.data.event.name}`)}" target="_blank" rel="noopener noreferrer"
                            title="Öffnet PayPal mit Empfänger und Betrag. Achtung: Waren & Dienstleistungen – der Empfänger zahlt Gebühren.">Sofort bezahlen (mit Gebühren für ${pay.to === me ? 'dich' : personName(pay.to)})</a></span>
                      </span>`
                    : pay.to === me
                      ? html`<a class="btn btn--small btn--ghost" href="#/profil">PayPal im Profil hinterlegen</a>`
                      : html`<span class="muted small">${personName(pay.to)} hat kein PayPal hinterlegt</span>`}
                <button class="btn btn--small" data-action="settle" data-from="${pay.from}" data-to="${pay.to}" data-amount="${pay.amount_cents}">✓ Als bezahlt markieren</button>
              </div>
            </li>`)}</ol>
            <p class="muted small">„PayPal senden“ öffnet PayPal – bei einem PayPal.me-Link mit dem Betrag schon eingetragen, bei einer E-Mail-Adresse wird die Adresse kopiert: in PayPal einfügen, Betrag eingeben, „Freunde & Familie“ wählen (kostenlos). Danach hier „Als bezahlt markieren“.</p>`}
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

/** Abschluss: Abrechnung abschließen, danach PDF teilen und per WhatsApp senden. */
function closingCard() {
  const { event, expenses } = S.data;
  if (!expenses.length) return '';
  if (!event.closed_at) {
    return html`
    <section class="card closing" aria-labelledby="closing-heading">
      <h2 id="closing-heading">Abrechnung abschließen</h2>
      <p class="muted small">Sind alle Ausgaben eingetragen? Dann schließt die Abrechnung ab. Danach lassen sich keine Ausgaben mehr ändern, Zahlungen könnt ihr weiter als bezahlt markieren. Ihr bekommt ein PDF mit allen Infos und den PayPal-QR-Codes und könnt es per WhatsApp schicken.</p>
      <button class="btn btn--primary btn--large" data-action="close-event">✓ Abrechnung abschließen</button>
    </section>`;
  }
  return html`
    <section class="card closing closing--done" aria-labelledby="closing-heading">
      <h2 id="closing-heading">✓ Abgerechnet</h2>
      <p class="muted small">Abgeschlossen am ${formatDateTime(event.closed_at)}${event.closed_by ? ` von ${personName(event.closed_by)}` : ''}. Ausgaben sind gesperrt.</p>
      <div class="row">
        <button class="btn btn--primary" data-action="pdf-share">${icon('share')} PDF teilen</button>
        <button class="btn btn--whatsapp" data-action="whatsapp">${icon('whatsapp')} Per WhatsApp senden</button>
        <button class="btn" data-action="pdf-download">PDF speichern</button>
      </div>
      <button class="linkish small" data-action="reopen-event">Wieder öffnen, um Ausgaben zu ändern</button>
    </section>`;
}

/** Text für WhatsApp: Ergebnis, Zahlungen mit PayPal-Links und der Event-Link. */
function whatsappText() {
  const { event, summary, participants } = S.data;
  const lines = [`💸 *Abrechnung „${event.name}“*`, `Gesamt: ${euro(summary.total_cents)} · ${plural(participants.length, 'Person', 'Personen')}`, ''];
  if (!summary.plan.length) {
    lines.push('✅ Alles ausgeglichen – niemand schuldet jemandem etwas.');
  } else {
    lines.push('*So gleichen wir aus:*');
    for (const pay of summary.plan) {
      lines.push(`• ${personName(pay.from)} → ${personName(pay.to)}: *${euro(pay.amount_cents)}*`);
      const to = person(pay.to);
      if (to?.paypal) lines.push(`  PayPal: ${paypalLink(to.paypal, pay.amount_cents)}`);
      else if (to?.paypal_email) lines.push(`  PayPal an: ${to.paypal_email} (Freunde & Familie)`);
    }
  }
  lines.push('', `Alle Details: ${eventLink(event.code)}`);
  return lines.join('\n');
}

async function makePdf() {
  const { settlementPdf } = await import('./pdf.js');
  return settlementPdf(S.data, { link: eventLink(S.data.event.code) });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------- Teilnehmende

/** PayPal-Status einer Person: eigener Link → Profil, andere mit Konto → nur Anzeige, Platzhalter → bearbeitbar. */
function paypalChip(p, me) {
  const set = hasPaypal(p) ? 'paypal-chip--set' : '';
  const label = hasPaypal(p) ? '✓ PayPal' : '+ PayPal';
  const shown = paypalValue(p);
  if (p.id === me) return html`<a class="paypal-chip ${set}" href="#/profil" title="Im Profil ändern">${label}</a>`;
  if (p.linked) return hasPaypal(p) ? html`<span class="paypal-chip ${set}" title="${shown}">✓ PayPal</span>` : '';
  return html`<button class="paypal-chip ${set}" data-action="edit-paypal" data-id="${p.id}"
    aria-label="${hasPaypal(p) ? `PayPal von ${p.name} ändern (${shown})` : `PayPal für ${p.name} hinterlegen`}"
    title="${hasPaypal(p) ? shown : 'PayPal hinterlegen'}">${label}</button>`;
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
            <div class="field"><label for="f-paypal">PayPal-E-Mail-Adresse von ${p.name}</label>
              <input id="f-paypal" name="paypal" maxlength="200" value="${paypalValue(p)}" placeholder="z. B. name@gmail.com"
                type="text" inputmode="email" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="hint-paypal err-paypal">
              <p class="hint" id="hint-paypal">${p.name} hat noch kein Konto. Trag die PayPal-E-Mail-Adresse (oder einen PayPal.me-Link) von ${p.name} ein, damit die anderen in der Abrechnung direkt per PayPal zahlen können. Sobald ${p.name} sich anmeldet, gilt das Profil.</p>
              <p class="field-error" id="err-paypal"></p></div>
            <div class="form-actions">
              ${canScanQr() ? html`<label class="btn">📷 QR-Code scannen<input type="file" id="f-paypal-qr" accept="image/*" capture="environment" class="visually-hidden"></label>` : ''}
              ${hasPaypal(p) ? html`<button class="btn btn--ghost btn--danger-ghost" type="button" data-action="remove-paypal" data-id="${p.id}">Entfernen</button>` : ''}
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
      ${(() => {
        const inEvent = new Set(participants.map((p) => p.user_id).filter(Boolean));
        const addable = (S.friends?.friends ?? []).filter((f) => !inEvent.has(f.id));
        return addable.length ? html`
        <div class="add-friends">
          <h3>Freunde dazuholen</h3>
          <div class="chips">${addable.map((f) => html`
            <button class="chip" data-action="add-friend" data-id="${f.id}" data-name="${f.name}">${icon('plus')} ${f.name}</button>`)}</div>
        </div>` : '';
      })()}
      <form id="add-person-form" class="inline-form add-person" novalidate>
        <div class="field field--grow">
          <label for="f-new-person">Person ohne Konto hinzufügen</label>
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
    if (['conflict', 'expense_not_found', 'person_not_found', 'settlement_not_found', 'not_member', 'person_taken', 'already_member', 'event_closed'].includes(error.code)) {
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
    Object.assign(S, { user: null, data: null, code: null, dataJson: '', friends: null, invites: null, permanentInvite: null, adminUsers: null, search: { q: '', results: [] } });
    cache.clear();
    go('#/login');
    toast('Du bist abgemeldet.');
  },
  'resend-code': async (el) => {
    setBusy(el, true, 'Sendet …');
    try {
      toast((await api('resend_code', { body: { pending: S.challenge.pending } })).message);
    } catch (error) { toast(error.message, 'error'); }
    setBusy(el, false);
  },
  'cancel-code': () => { S.challenge = null; go('#/login'); },
  'friend-request': (el) => friendAction('friend_request', el, 'Anfrage geschickt'),
  'friend-accept': (el) => friendAction('friend_accept', el, 'Ihr seid jetzt Freunde'),
  'friend-remove': async (el) => {
    const { kind, name } = el.dataset;
    if (kind === 'remove' && !await confirmDialog({ title: `${name} entfernen?`, text: `Ihr seid danach keine Freunde mehr. Gemeinsame Events bleiben bestehen.`, confirm: 'Entfernen', danger: true })) return;
    friendAction('friend_remove', el, { remove: 'Freundschaft beendet', decline: 'Anfrage abgelehnt', cancel: 'Anfrage zurückgezogen' }[kind]);
  },
  'invite-share': async (el) => {
    const url = el.dataset.link;
    if (navigator.share) {
      try { await navigator.share({ title: 'FriendSplit', text: `${S.user.name} lädt dich zu FriendSplit ein – damit teilen wir unsere Ausgaben:`, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    copyText(url, 'Einladungslink kopiert');
  },
  'paypal-email': async (el) => {
    const to = person(el.dataset.to);
    const amount = euro(Number(el.dataset.amount));
    // Erst kopieren (braucht den Klick), dann PayPal öffnen – beides im selben Tipp.
    const copied = navigator.clipboard?.writeText(to.paypal_email).then(() => true, () => false) ?? Promise.resolve(false);
    window.open(PAYPAL_SEND, '_blank', 'noopener');
    toast((await copied)
      ? `E-Mail von ${to.name} kopiert. In PayPal einfügen, ${amount} eingeben und „Freunde & Familie“ wählen.`
      : `In PayPal an ${to.paypal_email} senden: ${amount}, „Freunde & Familie“ wählen.`);
  },
  'close-event': async (el) => {
    const ok = await confirmDialog({ title: 'Abrechnung abschließen?', text: 'Danach lassen sich keine Ausgaben mehr hinzufügen, ändern oder löschen – bis jemand die Abrechnung wieder öffnet. Zahlungen könnt ihr weiterhin als bezahlt markieren.', confirm: 'Abschließen' });
    if (!ok) return;
    if (await mutate('close_event', {}, { success: 'Abrechnung abgeschlossen – jetzt PDF teilen oder per WhatsApp senden', button: el })) {
      document.getElementById('closing-heading')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  },
  'reopen-event': async (el) => {
    const ok = await confirmDialog({ title: 'Abrechnung wieder öffnen?', text: 'Dann lassen sich Ausgaben wieder ändern. Ein schon verschicktes PDF ist danach eventuell nicht mehr aktuell.', confirm: 'Wieder öffnen' });
    if (ok) await mutate('reopen_event', {}, { success: 'Abrechnung ist wieder offen', button: el });
  },
  'pdf-share': async (el) => {
    setBusy(el, true, 'PDF wird erstellt …');
    try {
      const { blob, filename } = await makePdf();
      const file = new File([blob], filename, { type: 'application/pdf' });
      if (navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file], title: filename, text: `Abrechnung „${S.data.event.name}“` }); } catch (e) { if (e.name !== 'AbortError') throw e; }
      } else {
        downloadBlob(blob, filename);
        toast('PDF gespeichert – Teilen ist in diesem Browser nicht möglich.');
      }
    } catch (error) {
      toast(`PDF konnte nicht erstellt werden: ${error.message}`, 'error');
    }
    setBusy(el, false);
  },
  'pdf-download': async (el) => {
    setBusy(el, true, 'PDF wird erstellt …');
    try {
      const { blob, filename } = await makePdf();
      downloadBlob(blob, filename);
      toast('PDF gespeichert');
    } catch (error) {
      toast(`PDF konnte nicht erstellt werden: ${error.message}`, 'error');
    }
    setBusy(el, false);
  },
  whatsapp: () => {
    window.open(`https://wa.me/?text=${encodeURIComponent(whatsappText())}`, '_blank', 'noopener');
  },
  'invite-copy': (el) => copyText(el.dataset.link, 'Einladungslink kopiert'),
  'invite-renew': async () => {
    if (!await confirmDialog({ title: 'Neuen Einladungslink erzeugen?', text: 'Der bisherige Link funktioniert danach nicht mehr. Wer schon registriert ist, bleibt es natürlich.', confirm: 'Neuen Link erzeugen' })) return;
    try {
      S.permanentInvite = (await api('invite_permanent', { body: { renew: true } })).invite;
      render();
      toast('Neuer Einladungslink erzeugt – der alte gilt nicht mehr');
    } catch (error) { toast(error.message, 'error'); }
  },
  'invite-delete': async (el) => {
    try {
      S.invites = (await api('invite_delete', { body: { code: el.dataset.code } })).invites;
      render();
      toast('Einladung gelöscht');
    } catch (error) { toast(error.message, 'error'); }
  },
  'add-friend': async (el) => {
    await mutate('add_friends', { friends: [el.dataset.id] }, { success: `${el.dataset.name} ist jetzt dabei`, button: el });
  },
  'admin-reset-link': async (el) => {
    try {
      const { link } = await api('admin_reset_link', { body: { id: el.dataset.id } });
      await copyText(link, `Passwort-Link für ${el.dataset.name} kopiert (24 Stunden gültig)`);
    } catch (error) { toast(error.message, 'error'); }
  },
  'admin-block': async (el) => {
    const block = el.dataset.blocked === '1';
    if (block && !await confirmDialog({ title: `${el.dataset.name} sperren?`, text: 'Die Person wird abgemeldet und kann sich nicht mehr anmelden, bis du sie entsperrst.', confirm: 'Sperren', danger: true })) return;
    try {
      S.adminUsers = (await api('admin_block', { body: { id: el.dataset.id, blocked: block } })).users;
      render();
      toast(block ? `${el.dataset.name} ist gesperrt` : `${el.dataset.name} ist entsperrt`);
    } catch (error) { toast(error.message, 'error'); }
  },
  'admin-delete': async (el) => {
    if (!await confirmDialog({ title: `Konto von ${el.dataset.name} löschen?`, text: 'Konto, E-Mail-Adresse und Freundschaften werden endgültig gelöscht. In Events bleibt die Person als Name ohne Konto stehen.', confirm: 'Endgültig löschen', danger: true })) return;
    try {
      S.adminUsers = (await api('admin_delete', { body: { id: el.dataset.id } })).users;
      render();
      toast(`Konto von ${el.dataset.name} gelöscht`);
    } catch (error) { toast(error.message, 'error'); }
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
    const result = await mutate('set_paypal', { person_id: el.dataset.id, paypal: '' }, { success: 'PayPal entfernt', button: el });
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

async function friendAction(action, el, success) {
  setBusy(el, true, '…');
  try {
    applyFriends(await api(action, { body: { id: el.dataset.id } }));
    render();
    toast(success);
  } catch (error) {
    setBusy(el, false);
    toast(error.message, 'error');
  }
}

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

/** Prüfungen für Name, E-Mail und Passwort beim Anlegen eines Kontos (wie auf dem Server). */
function accountChecks(d) {
  return {
    name: !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{1,22}[\p{L}\p{N}]$/u.test(d.name.trim().replace(/\s+/g, ' ')) && '3–24 Zeichen: Buchstaben, Ziffern, Leerzeichen, Punkt oder Bindestrich.',
    email: !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email.trim()) && 'Bitte gib eine gültige E-Mail-Adresse ein.',
    password: d.password.length < 10 && 'Das Passwort muss mindestens 10 Zeichen lang sein.',
  };
}

/** Gemeinsamer Ablauf für Anmelden, Einrichten und Registrieren. */
async function authForm(form, action, check, busyLabel) {
  clearErrors(form);
  const data = Object.fromEntries(new FormData(form));
  const errors = Object.fromEntries(Object.entries(check(data)).filter(([, v]) => v));
  if (Object.keys(errors).length) return showFieldErrors(form, errors);
  const button = form.querySelector('[type="submit"]');
  setBusy(button, true, busyLabel);
  try {
    afterAuth(await api(action, { body: data }));
  } catch (error) {
    setBusy(button, false);
    if (error.fields) showFieldErrors(form, error.fields);
    else showFormError(form, error.message, []);
    if (form.elements.password) form.elements.password.value = '';
  }
}

const forms = {
  'login-form': (form) => authForm(form, 'login', (d) => ({
    login: !d.login.trim() && 'Bitte gib deinen Namen oder deine E-Mail-Adresse ein.',
    password: !d.password && 'Bitte gib dein Passwort ein.',
  }), 'Anmelden …'),

  'setup-form': (form) => authForm(form, 'setup_account', (d) => ({
    code: !d.code.trim() && 'Bitte gib den Einrichtungscode ein.',
    ...accountChecks(d),
  }), 'Wird angelegt …'),

  'register-form': (form) => authForm(form, 'register', (d) => ({
    invite: normalizeCode(d.invite).length !== 12 && 'Der Einladungscode hat 12 Zeichen, z. B. ABCD-EFGH-JKLM.',
    ...accountChecks(d),
  }), 'Registriert …'),

  'code-form': async (form) => {
    clearErrors(form);
    const code = form.elements.code.value.replace(/\D/g, '');
    if (code.length !== 6) return showFieldErrors(form, { code: 'Der Code hat 6 Ziffern.' });
    const button = form.querySelector('[type="submit"]');
    setBusy(button, true, 'Prüft …');
    try {
      afterAuth(await api('verify_code', { body: { pending: S.challenge.pending, code } }));
      toast(`Willkommen, ${S.user.name}!`);
    } catch (error) {
      setBusy(button, false);
      if (error.code === 'code_expired') { S.challenge = null; toast(error.message, 'error'); go('#/login'); return; }
      if (error.fields) showFieldErrors(form, error.fields);
      else showFormError(form, error.message, []);
      form.elements.code.select();
    }
  },

  'forgot-form': async (form) => {
    clearErrors(form);
    const login = form.elements.login.value.trim();
    if (!login) return showFieldErrors(form, { login: 'Bitte gib deinen Namen oder deine E-Mail-Adresse ein.' });
    const button = form.querySelector('[type="submit"]');
    setBusy(button, true, 'Sendet …');
    try {
      await api('request_password_reset', { body: { login } });
      S.resetSent = login;
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
    if (password.length < 10) return showFieldErrors(form, { password: 'Das Passwort muss mindestens 10 Zeichen lang sein.' });
    const button = form.querySelector('[type="submit"]');
    setBusy(button, true);
    try {
      afterAuth(await api('reset_password', { body: { token: S.route.token, password } }));
      S.resetSent = null;
      toast('Neues Passwort gespeichert – du bist angemeldet.');
    } catch (error) {
      setBusy(button, false);
      if (error.fields) showFieldErrors(form, error.fields);
      else showFormError(form, error.code === 'invalid_token' ? html`${error.message} <a href="#/passwort-vergessen">Neuen Link anfordern</a>` : error.message, []);
    }
  },

  'invite-form': async (form) => {
    const button = form.querySelector('[type="submit"]');
    setBusy(button, true, 'Erstellt …');
    try {
      const result = await api('invite_create', { body: { note: form.elements.note.value.trim(), group: form.elements.group.checked } });
      S.invites = result.invites;
      render();
      await actions['invite-share']({ dataset: { link: result.invite.link } });
    } catch (error) {
      setBusy(button, false);
      toast(error.message, 'error');
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
    if (data.new_password.length < 10) errors.new_password = 'Das neue Passwort muss mindestens 10 Zeichen lang sein.';
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
      cache.clear();
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
      toast(paypal ? 'PayPal gespeichert' : 'PayPal entfernt');
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
      const friends = [...form.querySelectorAll('input[name="friends"]:checked')].map((i) => i.value);
      delete data.friends;
      const result = await api('create_event', { body: { ...data, participants: S.createPeople, friends } });
      S.createPeople = [];
      S.createFriends.clear();
      S.user.events.unshift({ code: result.code, name: data.name.trim(), date: data.date || null });
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
      toast(paypal ? 'PayPal gespeichert' : 'PayPal entfernt');
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
  if (input.id === 'f-search') onSearchInput(input.value);
  if (input.getAttribute('aria-invalid')) {
    input.removeAttribute('aria-invalid');
    const errId = input.getAttribute('aria-describedby')?.split(' ').find((id) => id.startsWith('err-'));
    if (errId) document.getElementById(errId).textContent = '';
  }
  if (input.closest('#expense-form')) updateSplitPreview();
});

document.addEventListener('change', (event) => {
  const { id, value } = event.target;
  if (event.target.name === 'friends' && event.target.closest('#create-form')) {
    if (event.target.checked) S.createFriends.add(value); else S.createFriends.delete(value);
  }
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
