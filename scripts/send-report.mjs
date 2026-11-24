import fs from 'node:fs/promises';

const apiKey = process.env.RESEND_API_KEY;
const from = process.env.RESEND_FROM_EMAIL;
const to = process.env.REPORT_EMAIL;

if (!apiKey || !from || !to) {
  console.log('Email skipped: configure RESEND_API_KEY, RESEND_FROM_EMAIL and REPORT_EMAIL in GitHub Actions secrets.');
  process.exit(0);
}

const summary = await fs.readFile('results/summary.md', 'utf8').catch(() => '# Air Haifa search report\n\nThe search did not produce a summary file.');
const csv = await fs.readFile('results/results.csv').catch(() => null);
const json = await fs.readFile('results/results.json', 'utf8').catch(() => null);
let statusLine = 'Search status: unknown';
if (json) {
  try {
    const report = JSON.parse(json);
    const counts = {};
    for (const row of report.results || []) counts[row.status] = (counts[row.status] || 0) + 1;
    statusLine = 'Searches: ' + (report.results || []).length + ' · Statuses: ' + JSON.stringify(counts);
  } catch {}
}

const escapeHtml = value => value.replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
const payload = {
  from,
  to: [to],
  subject: 'Air Haifa – Summer 2027 flight search report',
  html: '<h2>Air Haifa – Summer 2027</h2><p>' + escapeHtml(statusLine) +
    '</p><pre style="white-space:pre-wrap;font-family:Arial,sans-serif">' + escapeHtml(summary) + '</pre>' +
    '<p>Search settings: 1 adult, no baggage, no coupon. Prices are candidates only and must be verified on Air Haifa.</p>',
  attachments: csv ? [{ filename: 'results.csv', content: csv.toString('base64') }] : []
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
