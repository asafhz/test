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
  const index = which === 'departure' ? 0 : 1;
  const fields = page.locator('input[placeholder="DD/MM/YYYY"]');
  const field = fields.nth(index);
  if (!(await field.count())) return 'date_input_missing';
  try {
    await field.click({ timeout: 2500 });
    await wait(250);
    const [year, month, day] = iso.split('-').map(Number);
    const targetValue = dmy(iso);
    const readonly = await field.getAttribute('readonly');
    if (readonly === null) {
      try {
        await field.fill(targetValue, { timeout: 1500 });
        await field.press('Tab').catch(() => {});
        await wait(250);
        if ((await field.inputValue()).trim() === targetValue) return 'input';
      } catch {}
    }
    // Air Haifa's date picker opens two months at a time. Move the left
    // calendar pane back to the requested month before selecting its day.
    const prev = page.locator('button[aria-label*="previous month" i], button[aria-label*="חודש קודם"], button[title*="previous month" i]').first();
    if (!(await prev.count())) return 'previous_month_button_missing';
    // The observed picker opens at October 2027; July/August are 3/2 clicks back.
    const steps = month === 7 ? 3 : month === 8 ? 2 : 0;
    for (let i = 0; i < steps; i++) {
      await prev.click({ timeout: 1500 });
      await wait(180);
    }
    // In the two-month picker, the first exact day button belongs to the
    // left (target) month after the month navigation above.
    const dayButton = page.locator('button').filter({ hasText: new RegExp('^\\s*' + day + '\\s*$') }).first();
    if (await dayButton.count() && await dayButton.isVisible().catch(() => false)) {
      await dayButton.click({ timeout: 2500 });
      await wait(200);
      const value = await field.inputValue().catch(() => '');
      if (value === targetValue || value === iso) return 'calendar';
    }
    return 'calendar_day_not_selected';
  } catch (error) {
    return 'calendar_error: ' + String(error?.message || error).slice(0, 160);
  }
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

function parsePrice(value) {
  if (value == null) return null;
  const raw = String(value).trim().replace(/[^\d.,]/g, '');
  if (!raw) return null;
  const normalized = raw.includes('.') ? raw.replace(/,/g, '') : raw.replace(',', '.');
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 && amount < 10000 ? amount : null;
}

async function readFlightOptions(page) {
  return page.evaluate(() => {
    const buttons = [...document.querySelectorAll('.flightChoice_select')];
    return buttons.map((button, index) => {
      let card = button;
      for (let depth = 0; depth < 10 && card; depth++, card = card.parentElement) {
        const title = card.querySelector('.flightItem_title');
        const priceNode = card.querySelector('[data-flightsprice]') ||
          (card.hasAttribute('data-flightsprice') ? card : null);
        if (title && priceNode) break;
      }
      if (!card) return null;
      const title = card.querySelector('.flightItem_title');
      const titleText = (title?.innerText || '').trim();
      const cardText = (card.innerText || '').trim();
      const priceNode = card.querySelector('[data-flightsprice]') ||
        (card.hasAttribute('data-flightsprice') ? card : null);
      const rawPrice = priceNode?.getAttribute('data-flightsprice') || priceNode?.innerText || '';
      const numericPrice = Number(String(rawPrice).replace(/[^\d.,]/g, '').replace(',', '.'));
      const times = titleText.match(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/g) || [];
      const flightNumber = titleText.match(/\b[A-Z]\d{3,5}\b/)?.[0] || null;
      return {
        index, flight_number: flightNumber,
        departure_time: times[0] || null, arrival_time: times[1] || null,
        price: Number.isFinite(numericPrice) && numericPrice > 0 ? numericPrice : null,
        title: titleText, text: cardText.slice(0, 1000)
      };
    }).filter(Boolean);
  });
}

async function searchOne(browser, destination, outbound, returning) {
  const page = await browser.newPage({ locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
  const result = {
    destination: destination.code, origin: 'HFA', outbound, return: returning,
    passengers: '1 adult', status: 'started', outbound_options: [], return_options: [],
    page: destination.url
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

    const dateValues = await page.locator('input[placeholder="DD/MM/YYYY"]').evaluateAll(nodes => nodes.map(n => n.value));
    result.selected_date_values = dateValues;
    if (dateValues[0] !== dmy(outbound) || dateValues[1] !== dmy(returning)) {
      result.status = 'date_selection_not_verified';
      result.diagnostics = await diagnostics(page);
      return result;
    }

    const searchButton = page.getByRole('button', { name: /חיפוש טיסה|Search flights|Search/i });
    if (!(await clickFirst(searchButton, 7000))) {
      result.status = 'search_button_missing';
      result.diagnostics = await diagnostics(page);
      return result;
    }
    await page.waitForURL(/\/flight-results\/HFA-(LCA|PFO)\//, { timeout: 30000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await wait(5000);
    result.page = page.url();

    const expectedPath = '/flight-results/HFA-' + destination.code + '/' + outbound + '/' + returning + '/1/';
    if (!result.page.includes(expectedPath)) {
      result.status = 'search_url_date_mismatch';
      result.diagnostics = await diagnostics(page);
      return result;
    }

    result.outbound_options = await readFlightOptions(page);
    const outboundChoices = result.outbound_options.filter(x => x.price && x.departure_time && x.arrival_time);
    if (!outboundChoices.length) {
      result.status = 'outbound_flights_not_parsed';
      result.diagnostics = await diagnostics(page);
      return result;
    }
    const cheapestOutbound = [...outboundChoices].sort((a, b) => a.price - b.price)[0];
    result.selected_outbound = cheapestOutbound;
    await page.locator('.flightChoice_select').nth(cheapestOutbound.index).click({ timeout: 7000 });
    await wait(3500);

    await page.waitForFunction(() =>
      !!document.querySelector('.inboundResultsGalleryContainer .resultsGallery_item.selected') &&
      document.querySelectorAll('.flightChoice_select').length > 0,
      { timeout: 20000 }
    ).catch(() => {});
    await wait(1500);

    result.return_options = await readFlightOptions(page);
    const returnChoices = result.return_options.filter(x => x.price && x.departure_time && x.arrival_time);
    if (!returnChoices.length) {
      result.status = 'return_flights_not_parsed';
      result.diagnostics = await diagnostics(page);
      return result;
    }
    const cheapestReturn = [...returnChoices].sort((a, b) => a.price - b.price)[0];
    result.selected_return = cheapestReturn;
    await page.locator('.flightChoice_select').nth(cheapestReturn.index).click({ timeout: 7000 });
    await wait(2500);

    result.total_text = await page.locator('.totalPrice').first().innerText().catch(() => '');
    result.outbound_price = cheapestOutbound.price;
    result.return_price = cheapestReturn.price;
    result.currency = 'EUR';
    result.computed_total = Math.round((cheapestOutbound.price + cheapestReturn.price) * 100) / 100;
    result.total_price = parsePrice(result.total_text);
    result.booking_url = page.url();

    const totalMatchesLegs = result.total_price !== null &&
      Math.abs(result.total_price - result.computed_total) < 0.02;
    if (!cheapestOutbound.flight_number || !cheapestReturn.flight_number ||
        !totalMatchesLegs || !/^https:\/\//i.test(result.booking_url)) {
      result.status = 'total_or_itinerary_not_verified';
      await page.screenshot({ path: OUT + '/' + destination.code + '-' + outbound + '-total-not-verified.png', fullPage: true }).catch(() => {});
      return result;
    }
    result.outbound_departure_time = cheapestOutbound.departure_time;
    result.return_departure_time = cheapestReturn.departure_time;
    result.outbound_arrival_time = cheapestOutbound.arrival_time;
    result.return_arrival_time = cheapestReturn.arrival_time;
    result.status = 'verified_offer';
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
        console.log(row.status + ': ' + JSON.stringify({ outbound: row.selected_outbound, returning: row.selected_return, total: row.total_price, total_text: row.total_text }));
        await wait(1500);
      }
    }
  } finally {
    await browser.close();
  }
  const candidates = results.filter(row => row.status === 'verified_offer').map(row => ({
    destination: row.destination, outbound: row.outbound, return: row.return,
    amount: row.total_price, currency: row.currency,
    outbound_departure_time: row.outbound_departure_time,
    return_departure_time: row.return_departure_time,
    booking_url: row.booking_url
  })).sort((a, b) => a.amount - b.amount);
  const report = {
    generated_at: new Date().toISOString(), origin: 'HFA',
    destinations: ['LCA', 'PFO'], passengers: '1 adult',
    baggage_included: false, coupon_applied: false, date_pairs: DATES,
    cheapest_verified_offer: candidates[0] || null,
    warning: 'An offer is included only when both flight legs are selected and the displayed cart total matches the sum of the two leg prices. Baggage, seats and optional extras are not included. No booking or payment is performed.',
    results
  };
  await fs.writeFile(OUT + '/results.json', JSON.stringify(report, null, 2));
  const csvRows = ['destination,outbound,return,status,outbound_flight,outbound_time,outbound_price,return_flight,return_time,return_price,total_price,currency,booking_url'];
  for (const row of results) {
    csvRows.push([
      row.destination, row.outbound, row.return, row.status,
      row.selected_outbound?.flight_number, row.selected_outbound?.departure_time, row.outbound_price,
      row.selected_return?.flight_number, row.selected_return?.departure_time, row.return_price,
      row.total_price, row.currency, row.booking_url
    ].map(value => '"' + String(value ?? '').replaceAll('"', '""') + '"').join(','));
  }
  await fs.writeFile(OUT + '/results.csv', csvRows.join('\n'));
  const counts = Object.fromEntries([...new Set(results.map(row => row.status))]
    .map(status => [status, results.filter(row => row.status === status).length]));
  const lines = [
    '# Air Haifa – Summer 2027', '',
    'Generated: ' + report.generated_at,
    'Passengers: 1 adult. No baggage or coupon included.', '',
    'Searches attempted: ' + results.length,
    'Verified round-trip offers: ' + candidates.length,
    'Statuses: ' + JSON.stringify(counts),
    candidates[0] ? 'Lowest verified round-trip total: ' + candidates[0].currency + ' ' + candidates[0].amount + ' – ' + candidates[0].destination + ', ' + candidates[0].outbound + ' to ' + candidates[0].return : 'No verified round-trip offer extracted.',
    '', report.warning, '',
    '| Destination | Dates | Status | Outbound | Return | Total |',
    '|---|---|---|---|---|---|',
    ...results.map(row => '| ' + row.destination + ' | ' + row.outbound + ' → ' + row.return + ' | ' +
      row.status + ' | ' + (row.selected_outbound ? row.selected_outbound.departure_time + ' / ' + row.outbound_price : '—') +
      ' | ' + (row.selected_return ? row.selected_return.departure_time + ' / ' + row.return_price : '—') +
      ' | ' + (row.total_price != null ? row.currency + ' ' + row.total_price : '—') + ' |')
  ];
  const markdown = lines.join('\n');
  await fs.writeFile(OUT + '/summary.md', markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, markdown + '\n');
  }
  console.log('Completed ' + results.length + ' searches; visible price candidates: ' + candidates.length);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
