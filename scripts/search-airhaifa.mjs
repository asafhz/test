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

async function selectTripDates(page, outbound, returning) {
  const expectedOutbound = dmy(outbound);
  const expectedReturn = dmy(returning);

  // The live Air Haifa widget uses dedicated trigger buttons and a two-month
  // calendar. Do not assume its initial month or a fixed number of clicks.
  const departureTrigger = page.locator('button.date-input-17-trigger');
  if (!(await departureTrigger.count())) return { ok: false, reason: 'departure_date_trigger_missing' };
  await departureTrigger.click({ timeout: 7000 });

  const dialog = page.locator('[data-testid="date-container"]');
  await dialog.waitFor({ state: 'visible', timeout: 10000 });

  async function ensureMonthVisible(iso) {
    const targetMonth = iso.slice(0, 7);
    for (let attempt = 0; attempt < 24; attempt++) {
      const headings = await dialog.locator('h2[id^="month-"]').evaluateAll(nodes =>
        nodes.map(node => ({ id: node.id, text: (node.innerText || '').trim() }))
      );
      if (headings.some(item => item.id === 'month-' + targetMonth)) return headings;

      const visibleMonths = headings.map(item => item.id.replace('month-', '')).filter(Boolean).sort();
      if (visibleMonths.length && targetMonth < visibleMonths[0]) {
        const prev = dialog.locator('button[data-att="prev-month"]');
        if (!(await prev.count()) || await prev.isDisabled()) {
          throw new Error('target_month_before_calendar_range:' + targetMonth);
        }
        await prev.click({ timeout: 3000 });
      } else {
        const next = dialog.locator('button[data-att="next-month"]');
        if (!(await next.count()) || await next.isDisabled()) {
          throw new Error('next_month_button_unavailable:' + targetMonth);
        }
        await next.click({ timeout: 3000 });
      }
      await wait(120);
    }
    throw new Error('target_month_not_reached:' + targetMonth);
  }

  async function chooseDay(iso, rangeLabel) {
    await ensureMonthVisible(iso);
    const day = dialog.locator('button[data-att="day-' + iso + '"]');
    await day.waitFor({ state: 'visible', timeout: 7000 });
    if (await day.isDisabled()) throw new Error('date_disabled:' + iso);
    await day.click({ timeout: 5000 });
    await wait(300);
    const label = await day.getAttribute('aria-label').catch(() => '');
    if (rangeLabel && label && !label.includes(rangeLabel)) {
      // aria-label can update asynchronously after the range selection.
      await wait(250);
    }
  }

  await chooseDay(outbound, 'Start of Range');
  await chooseDay(returning, 'End of Range');

  const done = dialog.locator('button[data-att="done"]');
  if (await done.count() && await done.isVisible().catch(() => false)) {
    await done.click({ timeout: 3000 });
  }
  await wait(300);

  const state = await page.evaluate(() => {
    const read = selector => {
      const node = document.querySelector(selector);
      return node ? ((node.value || node.innerText || '').trim()) : '';
    };
    return {
      departureTrigger: read('button.date-input-17-trigger'),
      returnTrigger: read('button.date-input-18-trigger'),
      inputs: [...document.querySelectorAll('input[placeholder="DD/MM/YYYY"]')].map(node => node.value)
    };
  });

  const outboundVerified = state.inputs.includes(expectedOutbound) || state.departureTrigger.includes(expectedOutbound);
  const returnVerified = state.inputs.includes(expectedReturn) || state.returnTrigger.includes(expectedReturn);
  return {
    ok: outboundVerified && returnVerified,
    expected: [expectedOutbound, expectedReturn],
    state
  };
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
    result.date_selection = await selectTripDates(page, outbound, returning);
    result.selected_date_values = result.date_selection.state;
    if (!result.date_selection.ok) {
      result.status = 'date_selection_not_verified';
      result.diagnostics = await diagnostics(page);
      console.log('DATE_SELECTION_DIAGNOSTICS ' + JSON.stringify({
        destination: destination.code, outbound, returning,
        selection: result.date_selection, diagnostics: result.diagnostics
      }));
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
