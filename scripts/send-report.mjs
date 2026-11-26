import fs from 'node:fs/promises';

const apiKey = process.env.RESEND_API_KEY;
const from = process.env.RESEND_FROM_EMAIL;
const to = process.env.REPORT_EMAIL;

if (!apiKey || !from || !to) {
  console.log('Email skipped: configure RESEND_API_KEY, RESEND_FROM_EMAIL and REPORT_EMAIL in GitHub Actions secrets.');
  process.exit(0);
}

const jsonText = await fs.readFile('results/results.json', 'utf8').catch(() => null);
let report = null;
try { report = jsonText ? JSON.parse(jsonText) : null; } catch {}
const results = Array.isArray(report?.results) ? report.results : [];

// Only send a flight card when the scraper has verified every field needed
// for a booking decision. Generic landing-page "from" prices are not offers.
const offers = results.filter(row =>
  row.status === 'verified_offer' &&
  row.outbound_departure_time &&
  row.return_departure_time &&
  Number.isFinite(Number(row.total_price)) &&
  row.currency &&
  /^https:\/\//i.test(row.booking_url || '')
);

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
}[ch]));
const formatDate = value => {
  if (!value) return 'לא אומת';
  const d = new Date(value + 'T12:00:00');
  return Number.isNaN(d.getTime()) ? escapeHtml(value) :
    new Intl.DateTimeFormat('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
};
const offerCard = row => {
  const destination = row.destination === 'LCA' ? 'לרנקה' : row.destination === 'PFO' ? 'פאפוס' : escapeHtml(row.destination);
  const total = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 2 }).format(Number(row.total_price));
  return `
    <article style="border:1px solid #dce2ea;border-radius:12px;padding:18px;margin:0 0 14px;background:#fff">
      <h3 style="margin:0 0 14px;font-size:18px;color:#172033">חיפה ← ${destination}</h3>
      <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:7px 0;color:#64748b">המראה</td><td dir="rtl" style="padding:7px 0;text-align:left;font-weight:600">${formatDate(row.outbound)} · ${escapeHtml(row.outbound_departure_time)}</td></tr>
        <tr><td style="padding:7px 0;color:#64748b">חזרה</td><td dir="rtl" style="padding:7px 0;text-align:left;font-weight:600">${formatDate(row.return)} · ${escapeHtml(row.return_departure_time)}</td></tr>
        <tr><td style="padding:7px 0;color:#64748b">נוסעים</td><td style="padding:7px 0;text-align:left">${escapeHtml(row.passengers || report?.passengers || 'לא צוין')}</td></tr>
        <tr><td style="padding:7px 0;color:#64748b">מחיר כולל</td><td style="padding:7px 0;text-align:left;font-size:20px;font-weight:700;color:#0f172a">${total} ${escapeHtml(row.currency)}</td></tr>
      </table>
      <p style="margin:14px 0 0"><a href="${escapeHtml(row.booking_url)}" style="display:inline-block;background:#155eef;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600">מעבר להזמנה</a></p>
    </article>`;
};

const settings = [
  report?.passengers ? 'נוסעים: ' + report.passengers : null,
  report?.baggage_included === true ? 'כבודה כלולה במחיר' : 'כבודה לא אומתה / אינה כלולה בחישוב',
  report?.coupon_applied ? 'קופון הוחל' : 'ללא קופון'
].filter(Boolean).join(' · ');

const body = offers.length
  ? offers.map(offerCard).join('')
  : `<div style="border:1px solid #f0c36d;background:#fff8e6;border-radius:10px;padding:16px;line-height:1.6">
      <strong>לא נמצאו כרגע הצעות מאומתות לשליחה.</strong><br>
      הסריקה האחרונה לא סיפקה יחד את זמני ההמראה והחזרה, המחיר הכולל וקישור ההזמנה הישיר. מחירי "החל מ-" מדפי היעד לא יוצגו כהצעות, כדי לא להטעות.
    </div>`;

const html = `<!doctype html><html lang="he" dir="rtl"><body style="margin:0;background:#f4f6fa;font-family:Arial,sans-serif;color:#172033">
  <main style="max-width:680px;margin:0 auto;padding:24px 16px">
    <h2 style="margin:0 0 8px">טיסות אייר חיפה · קיץ 2027</h2>
    <p style="margin:0 0 18px;color:#64748b;font-size:13px">${escapeHtml(settings || 'הגדרות חיפוש לא זמינות')}</p>
    ${body}
    <p style="font-size:12px;color:#64748b;line-height:1.6;margin-top:18px">
      כל הצעה מוצגת רק לאחר אימות פרטי הטיסות. המחיר הכולל הוא עבור הרכב הנוסעים שמופיע בכרטיס; יש לבדוק באתר חברת התעופה את תנאי הכבודה, שינוי וביטול לפני התשלום.
    </p>
  </main></body></html>`;

const textBody = offers.length
  ? offers.map(row => [
      'חיפה → ' + row.destination,
      'המראה: ' + row.outbound + ' ' + row.outbound_departure_time,
      'חזרה: ' + row.return + ' ' + row.return_departure_time,
      'מחיר כולל: ' + row.total_price + ' ' + row.currency,
      'הזמנה: ' + row.booking_url
    ].join('\n')).join('\n\n')
  : 'לא נמצאו הצעות מאומתות. חסרים זמני טיסות, מחיר כולל וקישור הזמנה ישיר. מחירי "החל מ-" לא יוצגו כהצעות.';

const payload = {
  from,
  to: [to],
  subject: offers.length
    ? `אייר חיפה – ${offers.length} הצעות טיסה מאומתות לקיץ 2027`
    : 'אייר חיפה – אין עדיין הצעות מאומתות לקיץ 2027',
  html,
  text: textBody
};

const response = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
  body: JSON.stringify(payload)
});
const responseText = await response.text();
if (!response.ok) {
  console.error('Resend API error (' + response.status + '): ' + responseText);
  process.exit(1);
}
console.log('Email sent via Resend: ' + responseText);
