import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = 'https://flights.airhaifa.com/he';
const DESTINATIONS = [
  { code: 'LCA', url: BASE + '/flights-to-larnaca' },
  { code: 'PFO', url: BASE + '/flights-to-paphos' }
];
const DATES = [
  ['2027-07-18', '2027-07-22'], ['2027-07-19', '2027-07-23'],
  ['2027-07-25', '2027-07-29'], ['2027-07-26', '2027-07-30'],
  ['2027-08-01', '2027-08-05'], ['2027-08-02', '2027-08-06'],
  ['2027-08-08', '2027-08-12'], ['2027-08-09', '2027-08-13']
];
const OUT = 'results';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const dmy = iso => { const [y, m, d] = iso.split('-'); return d + '/' + m + '/' + y; };

async function clickFirst(locator, timeout = 2500) {
  try {
    const el = locator.first();
    if (await el.count() && await el.isVisible()) {
      await el.click({ timeout });
      return true;
    }
  } catch {}
  return false;
}

async function chooseRoute(page, label, code) {
  const field = page.getByRole('button', { name: label }).first();
  if (!(await field.count())) return false;
  const current = await field.innerText().catch(() => '');
  const expected = code === 'HFA' ? /חיפה|Haifa|HFA/i :
    code === 'LCA' ? /לרנקה|Larnaca|LCA/i : /פאפוס|Paphos|PFO/i;
  if (expected.test(current)) return true;
  if (!(await clickFirst(field))) return false;
  await wait(350);
  const option = code === 'HFA' ? /חיפה.*HFA|Haifa.*HFA|HFA.*חיפה/i :
    code === 'LCA' ? /לרנקה.*LCA|Larnaca.*LCA|LCA.*לרנקה/i :
    /פאפוס.*PFO|Paphos.*PFO|PFO.*פאפוס/i;
  return await clickFirst(page.getByText(option)) ||
    await clickFirst(page.getByRole('option', { name: option }));
}

async function selectDate(page, which, iso) {
  const label = which === 'departure' ? /תאריך יציאה|departure date/i : /תאריך חזרה|return date/i;
  const selectors = which === 'departure'
    ? ['input[aria-label*="departure" i]', 'input[aria-label*="יציאה"]', 'input[placeholder*="יציאה"]', 'input[name*="departure" i]', '[data-testid*="departure-date"]']
    : ['input[aria-label*="return" i]', 'input[aria-label*="חזרה"]', 'input[placeholder*="חזרה"]', 'input[name*="return" i]', '[data-testid*="return-date"]'];
  let field = null;
  for (const selector of selectors) {
    const candidate = page.locator(selector).first();
    if (await candidate.count() && await candidate.isVisible().catch(() => false)) {
      field = candidate;
      break;
    }
  }
  if (!field) {
    const labelled = page.getByLabel(label).first();
    if (await labelled.count() && await labelled.isVisible().catch(() => false)) field = labelled;
  }
  if (field) {
    try {
      const tag = await field.evaluate(el => el.tagName.toLowerCase());
      const type = await field.getAttribute('type');
      const readonly = await field.getAttribute('readonly');
      if (tag === 'input' && readonly === null) {
        for (const value of (type === 'date' ? [iso] : [dmy(iso), iso])) {
          try {
            await field.fill(value, { timeout: 1800 });
            if (await field.inputValue() === value) return 'input';
          } catch {}
        }
      }
      await clickFirst(field);
    } catch {}
  } else {
    if (!(await clickFirst(page.getByText(label)))) return 'field_missing';
  }
  await wait(300);
  const [year, month, day] = iso.split('-');
  for (const selector of ['[data-date="' + iso + '"]', '[aria-label*="' + iso + '"]', '[title*="' + iso + '"]']) {
    if (await clickFirst(page.locator(selector))) return 'calendar';
  }
  const monthNames = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  const target = new RegExp('(?:' + Number(day) + '\\s*(?:ב)?' + monthNames[Number(month) - 1] +
    '\\s*' + year + '|' + ['January','February','March','April','May','June','July','August','September','October','November','December'][Number(month)-1] +
    '\\s*' + Number(day) + ',?\\s*' + year + ')', 'i');
  for (let monthStep = 0; monthStep < 14; monthStep++) {
    const cells = page.locator('button,[role="gridcell"],[role="option"]');
    const count = Math.min(await cells.count(), 350);
    for (let i = 0; i < count; i++) {
      const cell = cells.nth(i);
      if (!(await cell.isVisible().catch(() => false)) || await cell.isDisabled().catch(() => false)) continue;
      const text = await cell.innerText().catch(() => '');
      const aria = await cell.getAttribute('aria-label').catch(() => '');
      if (target.test(text + ' ' + aria) && await clickFirst(cell)) return 'calendar';
    }
    let moved = false;
    for (const selector of ['button[aria-label*="next" i]', 'button[title*="next" i]', 'button[aria-label*="הבא"]', '[data-action="next"]']) {
      if (await clickFirst(page.locator(selector), 1200)) { moved = true; break; }
    }
    if (!moved) break;
    await wait(150);
  }
  return 'calendar_date_missing';
}

async function diagnostics(page) {
  return page.evaluate(() => ({
    url: location.href, title: document.title,
    inputs: [...document.querySelectorAll('input,select')].map(e => ({
      tag: e.tagName, type: e.type, placeholder: e.placeholder,
      aria: e.getAttribute('aria-label'), value: e.value, name: e.name
    })),
    buttons: [...document.querySelectorAll('button')].slice(0, 90).map(e => ({
      text: (e.innerText || '').trim().slice(0, 90), aria: e.getAttribute('aria-label')
    })),
    body: document.body.innerText.slice(0, 7000)
  }));
}

function extractPrices(text) {
  const matches = [...text.matchAll(/(€|EUR|₪|\$)\s?([0-9]{1,4}(?:[.,][0-9]{1,2})?)/g)];
  const prices = matches.map(m => ({
    currency: m[1], amount: Number(m[2].replace(',', '.')), shown: m[0]
  })).filter(p => p.amount > 0 && p.amount < 10000);
  return [...new Map(prices.map(p => [p.currency + p.amount, p])).values()];
}

async function searchOne(browser, destination, outbound, returning) {
  const page = await browser.newPage({ locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
  const result = {
    destination: destination.code, origin: 'HFA', outbound, return: returning,
    passengers: '1 adult', status: 'started', prices: [], page: destination.url
  };
  try {
    await page.goto(destination.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
    for (const consent of [/אישור/, /קבל הכל/, /מסכים/, /Accept all/i]) {
      await clickFirst(page.getByRole('button', { name: consent }));
    }
    result.origin_selected = await chooseRoute(page, /מאיפה|מוצא|from/i, 'HFA');
    result.destination_selected = await chooseRoute(page, /לאן|יעד|to/i, destination.code);
    result.outbound_selection = await selectDate(page, 'departure', outbound);
    result.return_selection = await selectDate(page, 'return', returning);
    if (['field_missing', 'calendar_date_missing'].includes(result.outbound_selection) ||
        ['field_missing', 'calendar_date_missing'].includes(result.return_selection)) {
      result.status = 'date_selection_failed';
      result.diagnostics = await diagnostics(page);
      await page.screenshot({ path: OUT + '/' + destination.code + '-' + outbound + '-date-failed.png', fullPage: true }).catch(() => {});
      return result;
    }
    const searchButton = page.getByRole('button', { name: /חיפוש טיסה|Search flights|Search/i });
    if (!(await clickFirst(searchButton, 7000))) {
      result.status = 'search_button_missing';
      result.diagnostics = await diagnostics(page);
      return result;
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    await wait(8000);
    const body = await page.locator('body').innerText().catch(() => '');
    result.page = page.url();
    result.prices = extractPrices(body);
    result.excerpt = body.slice(0, 7000);
    result.status = /captcha|verify you are human|robot check|אני לא רובוט/i.test(body) ? 'captcha' :
      /לא נמצאו טיסות|אין טיסות|no flights|no results/i.test(body) ? 'no_flights_or_dates' :
      result.prices.length ? 'price_candidates_found' : 'results_price_not_parsed';
    if (result.status !== 'price_candidates_found') {
      await page.screenshot({ path: OUT + '/' + destination.code + '-' + outbound + '-result.png', fullPage: true }).catch(() => {});
    }
  } catch (error) {
    result.status = 'error';
    result.error = String(error?.message || error).slice(0, 700);
    result.diagnostics = await diagnostics(page).catch(() => null);
    await page.screenshot({ path: OUT + '/' + destination.code + '-' + outbound + '-error.png', fullPage: true }).catch(() => {});
  } finally {
    await page.close().catch(() => {});
  }
  return result;
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const results = [];
  try {
    for (const destination of DESTINATIONS) {
      for (const [outbound, returning] of DATES) {
        console.log(destination.code + ': ' + outbound + ' -> ' + returning);
        const row = await searchOne(browser, destination, outbound, returning);
        results.push(row);
        console.log(row.status + ': ' + JSON.stringify(row.prices));
        await wait(1500);
      }
    }
  } finally {
    await browser.close();
  }
  const candidates = results.flatMap(row => row.prices.map(price => ({
    ...price, destination: row.destination, outbound: row.outbound, return: row.return
  }))).sort((a, b) => a.amount - b.amount);
  const report = {
    generated_at: new Date().toISOString(), origin: 'HFA',
    destinations: ['LCA', 'PFO'], passengers: '1 adult',
    baggage_included: false, coupon_applied: false, date_pairs: DATES,
    cheapest_visible_candidate: candidates[0] || null,
    warning: 'A visible price may be a one-way or starting fare, not the full round-trip total. Verify both legs, baggage, seats and taxes on Air Haifa. No booking or payment is performed.',
    results
  };
  await fs.writeFile(OUT + '/results.json', JSON.stringify(report, null, 2));
  const csvRows = ['destination,outbound,return,status,currency,amount,page'];
  for (const row of results) {
    const prices = row.prices.length ? row.prices : [{ currency: '', amount: '' }];
    for (const price of prices) {
      csvRows.push([row.destination, row.outbound, row.return, row.status, price.currency, price.amount, row.page]
        .map(value => '"' + String(value ?? '').replaceAll('"', '""') + '"').join(','));
    }
  }
  await fs.writeFile(OUT + '/results.csv', csvRows.join('\n'));
  const counts = Object.fromEntries([...new Set(results.map(row => row.status))]
    .map(status => [status, results.filter(row => row.status === status).length]));
  const lines = [
    '# Air Haifa – Summer 2027', '',
    'Generated: ' + report.generated_at,
    'Passengers: 1 adult. No baggage or coupon included.', '',
    'Searches attempted: ' + results.length,
    'Statuses: ' + JSON.stringify(counts),
    candidates[0] ? 'Lowest visible candidate: ' + candidates[0].shown + ' – ' + candidates[0].destination + ', ' + candidates[0].outbound + ' to ' + candidates[0].return : 'No visible price candidate extracted.',
    '', report.warning, '',
    '| Destination | Dates | Status | Visible prices |',
    '|---|---|---|---|',
    ...results.map(row => '| ' + row.destination + ' | ' + row.outbound + ' → ' + row.return + ' | ' +
      row.status + ' | ' + (row.prices.map(price => price.shown).join(', ') || '—') + ' |')
  ];
  const markdown = lines.join('\n');
  await fs.writeFile(OUT + '/summary.md', markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, markdown + '\n');
  }
  console.log('Completed ' + results.length + ' searches; visible price candidates: ' + candidates.length);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
