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
// Air Haifa publishes indicative Cyprus baggage prices per passenger, per flight.
// Prices vary by flight and are re-priced live during booking; keep them separate
// from the pre-passenger fare total and label the calculation as an estimate.
const BAGGAGE = {
  checkedBags: Math.max(0, Number.parseInt(process.env.CHECKED_BAGS || '1', 10) || 0),
  trolleys: Math.max(0, Number.parseInt(process.env.TROLLEYS || '0', 10) || 0),
  checkedUsdPerFlight: 55,
  trolleyUsdPerFlight: 32,
  currency: 'USD',
  source: 'https://airhaifa.com/travelinfo-he/baggage-information'
};
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
  const placeholder = code === 'HFA' ? 'מאיפה?' : 'לאן?';
  const expectedValue = code === 'HFA' ? /חיפה|Haifa|HFA/i :
    code === 'LCA' ? /לרנקה|Larnaca|LCA/i : /פאפוס|Paphos|PFO/i;
  const city = code === 'HFA' ? 'חיפה' : code === 'LCA' ? 'לרנקה' : 'פאפוס';
  const field = page.locator('input[placeholder="' + placeholder + '"]').first();

  // The current Air Haifa homepage uses INPUT fields, not the old role=button
  // selectors. The previous implementation therefore never selected HFA.
  if (await field.count()) {
    const current = await field.inputValue().catch(() => '');
    if (expectedValue.test(current)) return true;
    await field.click({ timeout: 7000 });
    await field.fill(city, { timeout: 7000 });
    await wait(700);
    const suggestion = page.getByText(expectedValue, { exact: false }).filter({ visible: true }).first();
    if (await suggestion.count()) {
      await suggestion.click({ timeout: 5000 }).catch(async () => {
        await field.press('ArrowDown').catch(() => {});
        await field.press('Enter').catch(() => {});
      });
    } else {
      await field.press('ArrowDown').catch(() => {});
      await field.press('Enter').catch(() => {});
    }
    await wait(350);
    const selected = await field.inputValue().catch(() => '');
    return expectedValue.test(selected);
  }

  // Legacy fallback for alternate widget versions.
  const button = page.getByRole('button', { name: label }).first();
  if (!(await button.count())) return false;
  const current = await button.innerText().catch(() => '');
  if (expectedValue.test(current)) return true;
  if (!(await clickFirst(button))) return false;
  await wait(350);
  return await clickFirst(page.getByText(expectedValue));
}

async function selectTripDates(page, outbound, returning) {
  const expectedOutbound = dmy(outbound);
  const expectedReturn = dmy(returning);
  const inputs = page.locator('input[placeholder="DD/MM/YYYY"]');

  // Current widget exposes two editable date inputs. Use them directly first;
  // unlike the retired month-YYYY/day-YYYY-MM-DD selectors, these are present
  // in the current live page DOM.
  if (await inputs.count() >= 2) {
    const first = inputs.nth(0);
    const second = inputs.nth(1);
    try {
      await first.fill(expectedOutbound, { timeout: 5000 });
      await first.press('Tab').catch(() => {});
      await second.fill(expectedReturn, { timeout: 5000 });
      await second.press('Tab').catch(() => {});
      await wait(500);
      const values = await inputs.evaluateAll(nodes => nodes.map(n => n.value));
      if (values.includes(expectedOutbound) && values.includes(expectedReturn)) {
        return { ok: true, expected: [expectedOutbound, expectedReturn], state: { inputs: values }, method: 'direct-date-inputs' };
      }
    } catch (error) {
      // Continue to calendar interaction if inputs are read-only.
    }
  }

  // Calendar fallback: use current input fields to open the range picker, then
  // inspect actual visible month/day controls instead of relying on old IDs.
  const trigger = page.getByRole('button', { name: /בחירת תאריך יציאה|Departure date/i }).first();
  if (await trigger.count()) await trigger.click({ timeout: 7000 });
  await wait(300);

  const calendarState = await page.evaluate(() => ({
    headings: [...document.querySelectorAll('h1,h2,h3,[class*="month"],[data-att*="month"]')]
      .filter(e => e.offsetWidth || e.offsetHeight).map(e => ({
        tag:e.tagName,id:e.id,text:(e.innerText||'').trim().slice(0,60),att:e.getAttribute('data-att')
      })).slice(0,30),
    dayButtons: [...document.querySelectorAll('button')]
      .filter(e => e.offsetWidth || e.offsetHeight)
      .map(e => ({text:(e.innerText||'').trim(),att:e.getAttribute('data-att'),aria:e.getAttribute('aria-label'),title:e.title,cls:String(e.className||''),disabled:e.disabled}))
      .filter(x => /^\\d{1,2}$/.test(x.text) || (x.att||'').toLowerCase().includes('day')).slice(0,140),
    calendarMarkup: (() => {
      const node = [...document.querySelectorAll('*')].find(e => e.children.length < 5 && (e.innerText||'').trim() === 'נובמבר 2026');
      let p = node;
      for (let i=0; i<5 && p; i++, p=p.parentElement) if (p.querySelectorAll('button').length > 15) return p.outerHTML.slice(0,18000);
      return node?.parentElement?.parentElement?.outerHTML.slice(0,18000) || null;
    })(),
    inputs: [...document.querySelectorAll('input[placeholder="DD/MM/YYYY"]')].map(e=>({value:e.value,readonly:e.readOnly}))
  }));
  return {
    ok: false, reason: 'current_calendar_markup_unrecognized_or_dates_not_committed',
    expected: [expectedOutbound, expectedReturn], state: calendarState
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
    if (!result.origin_selected || !result.destination_selected) {
      result.status = 'route_selection_not_verified';
      result.diagnostics = await diagnostics(page);
      await page.screenshot({ path: OUT + '/' + destination.code + '-' + outbound + '-route-not-verified.png', fullPage: true }).catch(() => {});
      return result;
    }
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

    // Capture the fare from the flight-selection summary, before passenger details.
    // This is intentionally independent from baggage, which is an optional add-on.
    const fareSnapshot = await page.evaluate(() => {
      const total = document.querySelector('.totalPrice');
      const passengerForm = document.querySelector(
        'input[autocomplete="given-name"], input[name*="firstName" i], input[placeholder*="שם פרטי"], input[placeholder*="First name" i]'
      );
      return {
        totalText: (total?.innerText || total?.textContent || '').trim(),
        totalVisible: !!total && !!(total.offsetWidth || total.offsetHeight || total.getClientRects().length),
        passengerFormVisible: !!passengerForm &&
          !!(passengerForm.offsetWidth || passengerForm.offsetHeight || passengerForm.getClientRects().length),
        pageText: (document.body?.innerText || '').slice(0, 3500)
      };
    });
    result.fare_capture_stage = 'after_both_flights_selected_before_passenger_details';
    result.passenger_details_started = fareSnapshot.passengerFormVisible;
    result.total_text = fareSnapshot.totalText;
    result.base_fare_total = parsePrice(fareSnapshot.totalText);
    result.outbound_price = cheapestOutbound.price;
    result.return_price = cheapestReturn.price;
    result.currency = 'EUR';
    result.legs_sum = Math.round((cheapestOutbound.price + cheapestReturn.price) * 100) / 100;
    result.baggage = {
      checked_bags: BAGGAGE.checkedBags,
      trolleys: BAGGAGE.trolleys,
      checked_usd_per_flight_per_bag: BAGGAGE.checkedUsdPerFlight,
      trolley_usd_per_flight_per_bag: BAGGAGE.trolleyUsdPerFlight,
      flights: 2,
      estimated_cost: Math.round((BAGGAGE.checkedBags * BAGGAGE.checkedUsdPerFlight +
        BAGGAGE.trolleys * BAGGAGE.trolleyUsdPerFlight) * 2 * 100) / 100,
      currency: BAGGAGE.currency,
      is_estimate: true,
      pricing_note: 'Official published Cyprus rates; actual price varies by flight and is shown live during booking.',
      source: BAGGAGE.source
    };
    result.estimated_total_with_baggage = null; // Fare is EUR and baggage estimate is USD; never add unlike currencies.
    result.estimated_total_currency = null;
    result.baggage_estimate_separate = result.baggage.estimated_cost;
    result.baggage_estimate_currency = BAGGAGE.currency;
    result.booking_url = page.url();

    if (!cheapestOutbound.flight_number || !cheapestReturn.flight_number ||
        result.base_fare_total === null || !fareSnapshot.totalVisible ||
        fareSnapshot.passengerFormVisible || !/^https:\/\//i.test(result.booking_url)) {
      result.status = 'pre_passenger_fare_not_verified';
      result.fare_snapshot_diagnostics = fareSnapshot;
      await page.screenshot({ path: OUT + '/' + destination.code + '-' + outbound + '-fare-not-verified.png', fullPage: true }).catch(() => {});
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
        console.log(row.status + ': ' + JSON.stringify({ outbound: row.selected_outbound, returning: row.selected_return, base_fare_total: row.base_fare_total, total_text: row.total_text, error: row.error, stage: row.fare_capture_stage }));
        await wait(1500);
      }
    }
  } finally {
    await browser.close();
  }
  const candidates = results.filter(row => row.status === 'verified_offer').map(row => ({
    destination: row.destination, outbound: row.outbound, return: row.return,
    amount: row.base_fare_total, currency: row.currency, baggage_estimate: row.baggage?.estimated_cost, baggage_currency: row.baggage?.currency, estimated_total_with_baggage: row.estimated_total_with_baggage,
    outbound_departure_time: row.outbound_departure_time,
    return_departure_time: row.return_departure_time,
    booking_url: row.booking_url
  })).sort((a, b) => a.amount - b.amount);
  const report = {
    generated_at: new Date().toISOString(), origin: 'HFA',
    destinations: ['LCA', 'PFO'], passengers: '1 adult',
    baggage_included: false, baggage: BAGGAGE, coupon_applied: false, date_pairs: DATES,
    cheapest_verified_offer: candidates[0] || null,
    warning: 'Base fare is captured from the flight-selection summary before passenger details. Baggage is calculated separately as an estimate using published Cyprus rates; live booking prices vary by flight. No booking or payment is performed.',
    results
  };
  await fs.writeFile(OUT + '/results.json', JSON.stringify(report, null, 2));
  const csvRows = ['destination,outbound,return,status,outbound_flight,outbound_time,outbound_price,return_flight,return_time,return_price,base_fare_total,currency,checked_bags,trolleys,baggage_estimate,baggage_currency,estimated_total_with_baggage,booking_url'];
  for (const row of results) {
    csvRows.push([
      row.destination, row.outbound, row.return, row.status,
      row.selected_outbound?.flight_number, row.selected_outbound?.departure_time, row.outbound_price,
      row.selected_return?.flight_number, row.selected_return?.departure_time, row.return_price,
      row.base_fare_total, row.currency, row.baggage?.checked_bags, row.baggage?.trolleys, row.baggage?.estimated_cost, row.baggage?.currency, row.estimated_total_with_baggage, row.booking_url
    ].map(value => '"' + String(value ?? '').replaceAll('"', '""') + '"').join(','));
  }
  await fs.writeFile(OUT + '/results.csv', csvRows.join('\n'));
  const counts = Object.fromEntries([...new Set(results.map(row => row.status))]
    .map(status => [status, results.filter(row => row.status === status).length]));
  const lines = [
    '# Air Haifa – Summer 2027', '',
    'Generated: ' + report.generated_at,
    'Passengers: 1 adult. Base fare before passenger details; baggage estimate shown separately.', '',
    'Searches attempted: ' + results.length,
    'Verified round-trip offers: ' + candidates.length,
    'Statuses: ' + JSON.stringify(counts),
    candidates[0] ? 'Lowest verified base fare: ' + candidates[0].currency + ' ' + candidates[0].amount + ' – ' + candidates[0].destination + ', ' + candidates[0].outbound + ' to ' + candidates[0].return : 'No verified round-trip offer extracted.',
    '', report.warning, '',
    '| Destination | Dates | Status | Outbound | Return | Base fare |',
    '|---|---|---|---|---|---|',
    ...results.map(row => '| ' + row.destination + ' | ' + row.outbound + ' → ' + row.return + ' | ' +
      row.status + ' | ' + (row.selected_outbound ? row.selected_outbound.departure_time + ' / ' + row.outbound_price : '—') +
      ' | ' + (row.selected_return ? row.selected_return.departure_time + ' / ' + row.return_price : '—') +
      ' | ' + (row.base_fare_total != null ? row.currency + ' ' + row.base_fare_total : '—') + ' |')
  ];
  const markdown = lines.join('\n');
  await fs.writeFile(OUT + '/summary.md', markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, markdown + '\n');
  }
  console.log('Completed ' + results.length + ' searches; visible price candidates: ' + candidates.length);
  if (candidates.length === 0) { console.error('No verified offers; marking workflow as failed instead of reporting success.'); process.exitCode = 2; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
