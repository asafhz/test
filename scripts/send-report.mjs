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
  Number.isFinite(Number(row.base_fare_total ?? row.total_price)) &&
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
  const total = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 2 }).format(Number(row.base_fare_total ?? row.total_price));
  const baggage = row.baggage || {};
  const baggageLine = `כבודה (הערכה נפרדת): ${Number(baggage.checked_bags || 0)} מזוודות · ${Number(baggage.trolleys || 0)} טרולי · ${Number(baggage.estimated_cost || 0)} ${escapeHtml(baggage.currency || 'USD')} לשני הכיוונים`; 
  return `
    <div style="border:1px solid #dce2ea;border-radius:12px;padding:16px;margin:0 0 14px;background:#fff;box-sizing:border-box;width:100%">
      <h3 style="margin:0 0 14px;font-size:18px;line-height:1.35;color:#172033">חיפה ← ${destination}</h3>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;font-size:14px;table-layout:fixed">
        <tr>
          <td width="34%" style="padding:10px 0;border-bottom:1px solid #edf0f4;color:#64748b;vertical-align:top">המראה</td>
          <td dir="rtl" style="padding:10px 0;border-bottom:1px solid #edf0f4;text-align:right;font-weight:600;line-height:1.5;overflow-wrap:anywhere">${formatDate(row.outbound)}<br>${escapeHtml(row.outbound_departure_time)}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #edf0f4;color:#64748b;vertical-align:top">חזרה</td>
          <td dir="rtl" style="padding:10px 0;border-bottom:1px solid #edf0f4;text-align:right;font-weight:600;line-height:1.5;overflow-wrap:anywhere">${formatDate(row.return)}<br>${escapeHtml(row.return_departure_time)}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #edf0f4;color:#64748b;vertical-align:top">נוסעים</td>
          <td style="padding:10px 0;border-bottom:1px solid #edf0f4;text-align:right;overflow-wrap:anywhere">${escapeHtml(row.passengers || report?.passengers || 'לא צוין')}</td>
        </tr>
        <tr>
          <td style="padding:12px 0 4px;color:#64748b;vertical-align:top">מחיר טיסות לפני פרטי נוסעים</td>
          <td style="padding:12px 0 4px;text-align:right;font-size:21px;line-height:1.3;font-weight:700;color:#0f172a;overflow-wrap:anywhere">${total} ${escapeHtml(row.currency)}</td>
        </tr>
      </table>
      <div style="margin:16px 0 0">
        <a href="${escapeHtml(row.booking_url)}" style="display:block;box-sizing:border-box;width:100%;background:#155eef;color:#fff;text-align:center;text-decoration:none;padding:14px 16px;border-radius:8px;font-size:16px;line-height:1.3;font-weight:700">מעבר להזמנה</a>
      </div>
    </div>`;
};

const settings = [
  report?.passengers ? 'נוסעים: ' + report.passengers : null,
  report?.baggage ? 'כבודה מחושבת בנפרד (הערכה לפי מחירון)' : 'כבודה לא כלולה במחיר הטיסות',
  report?.coupon_applied ? 'קופון הוחל' : 'ללא קופון'
].filter(Boolean).join(' · ');

const body = offers.length
  ? offers.map(offerCard).join('')
  : `<div style="border:1px solid #f0c36d;background:#fff8e6;border-radius:10px;padding:16px;line-height:1.6">
      <strong>לא נמצאו כרגע הצעות מאומתות לשליחה.</strong><br>
      הסריקה האחרונה לא סיפקה יחד את זמני ההמראה והחזרה, המחיר הכולל וקישור ההזמנה הישיר. מחירי "החל מ-" מדפי היעד לא יוצגו כהצעות, כדי לא להטעות.
    </div>`;

const html = `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <title>טיסות אייר חיפה · קיץ 2027</title>
  <style>
    body { margin:0 !important; padding:0 !important; width:100% !important; background:#f4f6fa; }
    table { border-collapse:collapse; }
    a { -webkit-text-size-adjust:100%; }
    @media screen and (max-width:600px) {
      .email-shell { width:100% !important; }
      .email-padding { padding:16px 12px !important; }
      .email-title { font-size:21px !important; }
      .flight-card { padding:14px !important; }
      .booking-link { width:100% !important; box-sizing:border-box !important; display:block !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;width:100%;background:#f4f6fa;font-family:Arial,sans-serif;color:#172033;-webkit-text-size-adjust:100%">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#f4f6fa">
    <tr><td align="center" style="padding:0">
      <table role="presentation" class="email-shell" width="680" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:680px">
        <tr><td class="email-padding" dir="rtl" style="padding:24px 16px">
          <h2 class="email-title" style="margin:0 0 8px;font-size:24px;line-height:1.3">טיסות אייר חיפה · קיץ 2027</h2>
          <p style="margin:0 0 18px;color:#64748b;font-size:13px;line-height:1.6;overflow-wrap:anywhere">${escapeHtml(settings || 'הגדרות חיפוש לא זמינות')}</p>
          ${body}
          <p style="font-size:12px;color:#64748b;line-height:1.7;margin:18px 0 0">
            כל הצעה מוצגת רק לאחר אימות פרטי הטיסות. המחיר הכולל הוא עבור הרכב הנוסעים שמופיע בכרטיס; יש לבדוק באתר חברת התעופה את תנאי הכבודה, שינוי וביטול לפני התשלום.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

const textBody = offers.length
  ? offers.map(row => [
      'חיפה → ' + row.destination,
      'המראה: ' + row.outbound + ' ' + row.outbound_departure_time,
      'חזרה: ' + row.return + ' ' + row.return_departure_time,
      'מחיר טיסות לפני פרטי נוסעים: ' + (row.base_fare_total ?? row.total_price) + ' ' + row.currency,\n      'כבודה (הערכה נפרדת): ' + (row.baggage?.estimated_cost ?? 'לא חושב') + ' ' + (row.baggage?.currency || ''),
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
