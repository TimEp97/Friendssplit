// FriendSplit – PDF der Abrechnung, direkt im Browser erzeugt (ohne externe Dienste).
// Kleiner PDF-Schreiber mit den Standardschriften Helvetica/Helvetica-Bold (WinAnsi-Kodierung, also mit
// Umlauten und €) und QR-Codes als Vektorgrafik. Wird erst beim Klick auf „PDF“ geladen.

import qrcode from './qrcode.js';

// Zeichenbreiten (1/1000 em) für die Zeichen 32–255 in WinAnsi – aus den Adobe-Standard-AFM-Dateien.
const WIDTHS = {
  F1: [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,0,556,0,222,556,333,1000,556,556,333,1000,667,333,1000,0,611,0,0,222,222,333,333,350,556,1000,333,1000,500,333,944,0,500,667,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,0,0,333,556,537,278,333,0,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500],
  F2: [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,0,556,0,278,556,500,1000,556,556,333,1000,667,333,1000,0,611,0,0,278,278,500,500,350,556,1000,333,1000,556,333,944,0,500,667,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,0,0,333,611,556,278,333,0,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556],
};

/** Unicode → WinAnsi (cp1252). Unbekannte Zeichen werden ersetzt (Emojis fallen weg). */
const CP1252 = { 0x20ac: 0x80, 0x201a: 0x82, 0x192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x2c6: 0x88, 0x2030: 0x89, 0x160: 0x8a, 0x2039: 0x8b, 0x152: 0x8c, 0x17d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2dc: 0x98, 0x2122: 0x99, 0x161: 0x9a, 0x203a: 0x9b, 0x153: 0x9c, 0x17e: 0x9e, 0x178: 0x9f };
const REPLACE = { '→': '->', '−': '-', '✓': '', '▲': '', '▼': '', ' ': ' ', ' ': ' ' };
function winAnsi(text) {
  const out = [];
  for (const ch of String(text ?? '')) {
    if (REPLACE[ch] !== undefined) { for (const c of REPLACE[ch]) out.push(c.charCodeAt(0)); continue; }
    const cp = ch.codePointAt(0);
    if (cp >= 32 && cp < 127) out.push(cp);
    else if (cp >= 160 && cp <= 255) out.push(cp);
    else if (CP1252[cp]) out.push(CP1252[cp]);
    else if (cp > 0xffff || (cp >= 0x2600 && cp <= 0x27bf) || cp === 0xfe0f || cp === 0x200d) continue; // Emojis
    else out.push(63); // ?
  }
  return out;
}

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 42;
const COLORS = {
  text: [0.13, 0.11, 0.09], muted: [0.42, 0.38, 0.35], accent: [0.357, 0.294, 0.859], line: [0.88, 0.85, 0.81],
  soft: [0.957, 0.933, 0.902], pos: [0.11, 0.48, 0.25], neg: [0.71, 0.14, 0.09], paypal: [0, 0.44, 0.73], white: [1, 1, 1],
};

class Pdf {
  constructor() {
    this.pages = [];
    this.newPage();
  }

  newPage() {
    this.ops = [];
    this.links = [];
    this.pages.push({ ops: this.ops, links: this.links });
    this.y = A4.h - MARGIN;
  }

  /** Platz für die nächsten `height` Punkte sicherstellen, sonst neue Seite. */
  ensure(height) {
    if (this.y - height < MARGIN + 24) this.newPage();
  }

  width(text, size, font = 'F1') {
    return winAnsi(text).reduce((sum, c) => sum + (WIDTHS[font][c - 32] ?? 556), 0) * size / 1000;
  }

  /** Kürzt Text mit „…“, bis er in maxWidth passt. */
  fit(text, size, font, maxWidth) {
    let t = String(text ?? '');
    if (this.width(t, size, font) <= maxWidth) return t;
    while (t.length > 1 && this.width(t + '…', size, font) > maxWidth) t = t.slice(0, -1);
    return t.trimEnd() + '…';
  }

  /** Bricht Text an Wortgrenzen in Zeilen um. */
  wrap(text, size, font, maxWidth) {
    const lines = [];
    for (const para of String(text ?? '').split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (this.width(next, size, font) <= maxWidth || !line) line = next;
        else { lines.push(line); line = word; }
      }
      lines.push(line);
    }
    return lines.map((l) => this.fit(l, size, font, maxWidth));
  }

  text(str, x, y, { size = 10, font = 'F1', color = COLORS.text, align = 'left' } = {}) {
    const bytes = winAnsi(str);
    if (!bytes.length) return;
    const w = this.width(str, size, font);
    const tx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    const escaped = bytes.map((c) => (c === 40 || c === 41 || c === 92 ? '\\' + String.fromCharCode(c)
      : c < 32 || c > 126 ? '\\' + c.toString(8).padStart(3, '0') : String.fromCharCode(c))).join('');
    this.ops.push(`BT /${font} ${n(size)} Tf ${rgb(color)} rg ${n(tx)} ${n(y)} Td (${escaped}) Tj ET`);
  }

  rect(x, y, w, h, color) {
    this.ops.push(`${rgb(color)} rg ${n(x)} ${n(y)} ${n(w)} ${n(h)} re f`);
  }

  roundRect(x, y, w, h, r, { fill = null, stroke = null } = {}) {
    const k = 0.5523 * r;
    const p = [
      `${n(x + r)} ${n(y)} m`, `${n(x + w - r)} ${n(y)} l`, `${n(x + w - r + k)} ${n(y)} ${n(x + w)} ${n(y + r - k)} ${n(x + w)} ${n(y + r)} c`,
      `${n(x + w)} ${n(y + h - r)} l`, `${n(x + w)} ${n(y + h - r + k)} ${n(x + w - r + k)} ${n(y + h)} ${n(x + w - r)} ${n(y + h)} c`,
      `${n(x + r)} ${n(y + h)} l`, `${n(x + r - k)} ${n(y + h)} ${n(x)} ${n(y + h - r + k)} ${n(x)} ${n(y + h - r)} c`,
      `${n(x)} ${n(y + r)} l`, `${n(x)} ${n(y + r - k)} ${n(x + r - k)} ${n(y)} ${n(x + r)} ${n(y)} c h`,
    ].join(' ');
    const paint = fill && stroke ? 'B' : fill ? 'f' : 'S';
    this.ops.push(`${fill ? rgb(fill) + ' rg ' : ''}${stroke ? rgb(stroke) + ' RG 0.8 w ' : ''}${p} ${paint}`);
  }

  line(x1, y1, x2, y2, color = COLORS.line, width = 0.6) {
    this.ops.push(`${rgb(color)} RG ${n(width)} w ${n(x1)} ${n(y1)} m ${n(x2)} ${n(y2)} l S`);
  }

  /** Klickbarer Bereich, der eine Adresse öffnet. */
  link(x, y, w, h, uri) {
    this.links.push({ x, y, w, h, uri });
  }

  /** QR-Code als Vektorgrafik (schwarze Module als Rechtecke). */
  qr(text, x, y, size) {
    // Lange Links mit niedrigerer Fehlerkorrektur – weniger, größere Module, leichter zu scannen
    const code = qrcode(0, text.length > 70 ? 'L' : 'M');
    code.addData(text);
    code.make();
    const count = code.getModuleCount();
    const quiet = 2;
    const cell = size / (count + 2 * quiet);
    this.rect(x, y, size, size, COLORS.white);
    const parts = [];
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (code.isDark(r, c)) parts.push(`${n(x + (c + quiet) * cell)} ${n(y + size - (r + quiet + 1) * cell)} ${n(cell + 0.02)} ${n(cell + 0.02)} re`);
      }
    }
    this.ops.push(`0 0 0 rg ${parts.join(' ')} f`);
    this.link(x, y, size, size, text);
  }

  /** Fertiges PDF als Blob. `footer(page, total)` zeichnet die Fußzeile jeder Seite. */
  toBlob(footer, meta) {
    this.pages.forEach((page, i) => { this.ops = page.ops; this.links = page.links; footer(this, i + 1, this.pages.length); });
    const objects = [];
    const add = (body) => { objects.push(body); return objects.length; };
    const catalog = add(null);
    const pagesObj = add(null);
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids = [];
    for (const page of this.pages) {
      const stream = page.ops.join('\n');
      const content = add(`<< /Length ${latin1Length(stream)} >>\nstream\n${stream}\nendstream`);
      const annots = page.links.map((l) => add(`<< /Type /Annot /Subtype /Link /Rect [${n(l.x)} ${n(l.y)} ${n(l.x + l.w)} ${n(l.y + l.h)}] /Border [0 0 0] /A << /S /URI /URI (${pdfString(l.uri)}) >> >>`));
      kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R${annots.length ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(' ')}]` : ''} >>`));
    }
    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    const info = add(`<< /Title (${pdfString(meta.title)}) /Producer (FriendSplit) /CreationDate (D:${meta.date}) >>`);

    let out = '%PDF-1.4\n%âãÏÓ\n';
    const offsets = [];
    objects.forEach((body, i) => { offsets.push(latin1Length(out)); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
    const xref = latin1Length(out);
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return new Blob([bytes], { type: 'application/pdf' });
  }
}

const n = (v) => (Math.round(v * 100) / 100).toString();
const rgb = (c) => c.map(n).join(' ');
const latin1Length = (s) => s.length; // alle Zeichen im PDF-Text sind < 256 (Inhalte sind oktal kodiert)
/** Zeichenkette für Metadaten/Links (nur ASCII, Klammern und Backslash maskiert). */
const pdfString = (s) => winAnsi(s).map((c) => (c === 40 || c === 41 || c === 92 ? '\\' + String.fromCharCode(c)
  : c > 126 ? '\\' + c.toString(8).padStart(3, '0') : String.fromCharCode(c))).join('');

// ---------------------------------------------------------------- Inhalt der Abrechnung

const euroFormat = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const euro = (cents) => euroFormat.format(Math.abs(cents) / 100);
const signedEuro = (cents) => (cents > 0 ? '+' : cents < 0 ? '-' : '') + euro(cents);
const dateFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const CATEGORY = { getraenke: 'Getränke', essen: 'Essen', tickets: 'Tickets', transport: 'Transport', unterkunft: 'Unterkunft', sonstiges: 'Sonstiges' };

/** PayPal.me-Link, der direkt mit dem Betrag öffnet. */
/** Fertiger Zahlungslink an eine E-Mail-Adresse („Waren & Dienstleistungen“ – Gebühren für den Empfänger). */
export const paypalInstantLink = (email, cents, note) => `https://www.paypal.com/cgi-bin/webscr?${new URLSearchParams({
  cmd: '_xclick', business: email, amount: (cents / 100).toFixed(2), currency_code: 'EUR', ...(note ? { item_name: note } : {}),
})}`;

export const paypalLink = (handle, cents) => `https://www.paypal.me/${encodeURIComponent(handle)}${cents ? `/${(cents / 100).toFixed(2)}EUR` : ''}`;

/**
 * Erzeugt das PDF der Abrechnung.
 * @param {object} data  Gesamtzustand des Events (wie von api('event'))
 * @param {object} opts  { link: Event-Link, appUrl }
 * @returns {{ blob: Blob, filename: string }}
 */
export function settlementPdf(data, { link, appUrl }) {
  const { event, participants, expenses, settlements, summary } = data;
  const name = (id) => participants.find((p) => p.id === id)?.name ?? 'Ehemalige Person';
  const paypalOf = (id) => participants.find((p) => p.id === id)?.paypal ?? null;
  const paypalMailOf = (id) => participants.find((p) => p.id === id)?.paypal_email ?? null;
  const doc = new Pdf();
  const left = MARGIN;
  const right = A4.w - MARGIN;
  const width = right - left;
  const now = new Date();

  // Kopf
  doc.rect(0, A4.h - 6, A4.w, 6, COLORS.accent);
  doc.text('FRIENDSPLIT · ABRECHNUNG', left, doc.y - 10, { size: 8.5, font: 'F2', color: COLORS.accent });
  doc.y -= 34;
  for (const line of doc.wrap(event.name, 22, 'F2', width)) { doc.text(line, left, doc.y, { size: 22, font: 'F2' }); doc.y -= 26; }
  const meta = [event.date && dateFmt.format(new Date(`${event.date}T12:00:00`)), event.location, `${participants.length} Teilnehmende`].filter(Boolean).join('  ·  ');
  doc.text(meta, left, doc.y + 4, { size: 10, color: COLORS.muted });
  doc.y -= 14;
  doc.text(event.closed_at
    ? `Abgeschlossen am ${dateTimeFmt.format(new Date(event.closed_at))} Uhr${event.closed_by ? ` von ${name(event.closed_by)}` : ''}`
    : `Stand ${dateTimeFmt.format(now)} Uhr (noch nicht abgeschlossen)`, left, doc.y, { size: 9, color: COLORS.muted });
  doc.y -= 22;

  // Kennzahlen
  const kpis = [
    ['Gesamtausgaben', euro(summary.total_cents), `${expenses.length} ${expenses.length === 1 ? 'Ausgabe' : 'Ausgaben'}`],
    ['Pro Person (Ø)', euro(participants.length ? Math.round(summary.total_cents / participants.length) : 0), 'bei gleichmäßiger Teilnahme'],
    ['Offener Ausgleich', euro(summary.open_cents), summary.plan.length ? `${summary.plan.length} ${summary.plan.length === 1 ? 'Zahlung' : 'Zahlungen'}` : 'alles ausgeglichen'],
  ];
  const kw = (width - 16) / 3;
  kpis.forEach(([label, value, sub], i) => {
    const x = left + i * (kw + 8);
    doc.roundRect(x, doc.y - 58, kw, 58, 8, { fill: COLORS.soft });
    doc.text(label, x + 12, doc.y - 17, { size: 8.5, color: COLORS.muted });
    doc.text(value, x + 12, doc.y - 36, { size: 16, font: 'F2', color: i === 2 && summary.open_cents ? COLORS.neg : COLORS.text });
    doc.text(sub, x + 12, doc.y - 50, { size: 8, color: COLORS.muted });
  });
  doc.y -= 82;

  const heading = (title) => {
    doc.ensure(50);
    doc.text(title, left, doc.y, { size: 13, font: 'F2' });
    doc.y -= 8;
    doc.line(left, doc.y, right, doc.y, COLORS.line, 0.8);
    doc.y -= 16;
  };

  // So gleicht ihr aus – mit PayPal-QR-Codes
  heading('So gleicht ihr aus');
  if (!summary.plan.length) {
    doc.text('Alles ausgeglichen – niemand schuldet jemandem etwas.', left, doc.y, { size: 10.5, color: COLORS.pos });
    doc.y -= 24;
  }
  for (const pay of summary.plan) {
    const handle = paypalOf(pay.to);
    const mail = handle ? null : paypalMailOf(pay.to);
    const h = handle || mail ? 104 : 46;
    doc.ensure(h + 10);
    const top = doc.y + 8;
    doc.roundRect(left, top - h, width, h, 8, { stroke: COLORS.line });
    doc.text(`${name(pay.from)} zahlt ${name(pay.to)}`, left + 14, top - 22, { size: 12, font: 'F2' });
    doc.text(euro(pay.amount_cents), handle || mail ? right - 112 : right - 14, top - 22, { size: 14, font: 'F2', align: 'right' });
    if (handle) {
      const url = paypalLink(handle, pay.amount_cents);
      doc.text('Per PayPal bezahlen – QR-Code scannen oder Link antippen:', left + 14, top - 42, { size: 9, color: COLORS.muted });
      doc.text(doc.fit(url, 9.5, 'F1', width - 140), left + 14, top - 57, { size: 9.5, color: COLORS.paypal });
      doc.link(left + 14, top - 61, Math.min(doc.width(url, 9.5), width - 140), 13, url);
      doc.text(`PayPal.me/${handle} · Betrag ist schon eingetragen`, left + 14, top - 72, { size: 8.5, color: COLORS.muted });
      doc.qr(url, right - 96, top - h + 8, 88);
    } else if (mail) {
      doc.text('Per PayPal an diese E-Mail-Adresse senden:', left + 14, top - 42, { size: 9, color: COLORS.muted });
      doc.text(doc.fit(mail, 12, 'F2', width - 140), left + 14, top - 58, { size: 12, font: 'F2', color: COLORS.paypal });
      doc.text('In PayPal „Geld senden“ -> E-Mail und Betrag eingeben -> „Freunde & Familie“ (kostenlos).', left + 14, top - 73, { size: 8.5, color: COLORS.muted });
      doc.text('QR-Code: Sofort bezahlen, Betrag schon eingetragen – der Empfänger zahlt PayPal-Gebühren.', left + 14, top - 86, { size: 8, color: COLORS.muted });
      // Kurzer Link (ohne Betreff), damit der QR-Code grob bleibt und sich gut scannen lässt
      doc.qr(paypalInstantLink(mail, pay.amount_cents), right - 96, top - h + 8, 88);
    } else {
      doc.text(`${name(pay.to)} hat kein PayPal hinterlegt – bitte direkt ausgleichen.`, left + 14, top - 38, { size: 9, color: COLORS.muted });
    }
    doc.y = top - h - 10;
  }
  doc.y -= 10;

  // Salden je Person
  heading('Salden je Person');
  const cols = [left + 270, left + 350, left + 430, right]; // rechte Kanten der Zahlenspalten
  ['Bezahlt', 'Anteil', 'Ausgleich', 'Saldo'].forEach((l, i) => doc.text(l, cols[i], doc.y, { size: 8.5, font: 'F2', color: COLORS.muted, align: 'right' }));
  doc.text('Person', left, doc.y, { size: 8.5, font: 'F2', color: COLORS.muted });
  doc.y -= 6; doc.line(left, doc.y, right, doc.y); doc.y -= 13;
  for (const p of participants) {
    doc.ensure(20);
    const b = summary.people[p.id] ?? { paid: 0, share: 0, sent: 0, received: 0, balance: 0 };
    const settled = b.sent - b.received;
    doc.text(doc.fit(p.name, 10, 'F1', 200), left, doc.y, { size: 10 });
    doc.text(euro(b.paid), cols[0], doc.y, { size: 10, align: 'right' });
    doc.text(euro(b.share), cols[1], doc.y, { size: 10, align: 'right' });
    doc.text(settled ? signedEuro(settled) : '–', cols[2], doc.y, { size: 10, align: 'right', color: COLORS.muted });
    doc.text(signedEuro(b.balance), cols[3], doc.y, { size: 10, font: 'F2', align: 'right', color: b.balance > 0 ? COLORS.pos : b.balance < 0 ? COLORS.neg : COLORS.muted });
    doc.y -= 6; doc.line(left, doc.y, right, doc.y, COLORS.soft); doc.y -= 13;
  }
  doc.text('Saldo = bezahlt − eigener Anteil ± erledigte Ausgleichszahlungen. Plus: bekommt Geld zurück, minus: muss beisteuern.', left, doc.y - 2, { size: 8, color: COLORS.muted });
  doc.y -= 30;

  // Alle Ausgaben
  heading(`Alle Ausgaben (${expenses.length})`);
  if (!expenses.length) { doc.text('Keine Ausgaben eingetragen.', left, doc.y, { size: 10, color: COLORS.muted }); doc.y -= 20; }
  const sorted = [...expenses].sort((a, b) => a.spent_at.localeCompare(b.spent_at));
  for (const e of sorted) {
    const involved = e.shares.length === participants.length && participants.length > 2 ? 'alle' : e.shares.map((s) => name(s.person_id)).join(', ');
    const sub = `${CATEGORY[e.category] ?? e.category} · bezahlt von ${name(e.paid_by)} · für ${involved}`;
    const subLines = doc.wrap(sub, 8.5, 'F1', width - 170);
    const noteLines = e.notes ? doc.wrap(`Notiz: ${e.notes}`, 8.5, 'F1', width - 170).slice(0, 3) : [];
    const h = 16 + (subLines.length + noteLines.length) * 11;
    doc.ensure(h + 8);
    doc.text(dateTimeFmt.format(new Date(e.spent_at)).replace(',', ''), left, doc.y, { size: 8.5, color: COLORS.muted });
    doc.text(doc.fit(e.description, 10.5, 'F2', width - 210), left + 90, doc.y, { size: 10.5, font: 'F2' });
    doc.text(euro(e.amount_cents), right, doc.y, { size: 10.5, font: 'F2', align: 'right' });
    let y = doc.y - 12;
    for (const l of subLines) { doc.text(l, left + 90, y, { size: 8.5, color: COLORS.muted }); y -= 11; }
    for (const l of noteLines) { doc.text(l, left + 90, y, { size: 8.5, color: COLORS.muted }); y -= 11; }
    doc.y = y - 2; doc.line(left, doc.y + 6, right, doc.y + 6, COLORS.soft); doc.y -= 8;
  }
  doc.y -= 12;

  // Erledigte Zahlungen
  if (settlements.length) {
    heading('Erledigte Ausgleichszahlungen');
    for (const st of settlements) {
      doc.ensure(18);
      doc.text(`${name(st.from)} hat ${name(st.to)} ${euro(st.amount_cents)} gezahlt`, left, doc.y, { size: 10 });
      if (st.paid_at) doc.text(dateTimeFmt.format(new Date(st.paid_at)), right, doc.y, { size: 8.5, color: COLORS.muted, align: 'right' });
      doc.y -= 17;
    }
  }

  const stamp = dateTimeFmt.format(now);
  const blob = doc.toBlob((d, page, total) => {
    d.line(left, MARGIN - 2, right, MARGIN - 2);
    d.text(`Erstellt mit FriendSplit · ${stamp} Uhr`, left, MARGIN - 14, { size: 7.5, color: COLORS.muted });
    if (page === 1 && link) {
      const label = 'Event online öffnen';
      d.text(label, A4.w / 2, MARGIN - 14, { size: 7.5, color: COLORS.paypal, align: 'center' });
      d.link(A4.w / 2 - d.width(label, 7.5) / 2, MARGIN - 17, d.width(label, 7.5), 10, link);
    }
    d.text(`Seite ${page} von ${total}`, right, MARGIN - 14, { size: 7.5, color: COLORS.muted, align: 'right' });
  }, { title: `Abrechnung ${event.name}`, date: now.toISOString().replace(/[-:T]/g, '').slice(0, 14) });

  const slug = event.name.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'Event';
  return { blob, filename: `Abrechnung-${slug}.pdf` };
}
