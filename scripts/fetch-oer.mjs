#!/usr/bin/env node
/**
 * fetch-oer.mjs — MPOB OER (Oil Extraction Rate) by month and state
 *
 * Scrapes the Prestasi Sawit Malaysia API at
 *   https://prestasisawit.mpob.gov.my/api/oer?year=YYYY&month=MM
 * for every month from January 2000 (earliest available) to the current
 * Malaysia month.  Extracts national OER and per-state OER, CPO processed,
 * FFB processed, and mill count.  Publishes:
 *
 *   market/oer-history.json  — full historical archive (all months)
 *   market/oer-latest.json   — latest available month snapshot
 *
 * FAIL-SAFE:  If the API cannot be fetched, parsed, or validated, the
 * script throws and the GitHub Actions workflow fails rather than
 * publishing fabricated or incomplete data.  The last good snapshot in
 * the repo remains available to consumers.  Existing cached months are
 * never overwritten with fewer records — only new months are added.
 *
 * FFB CONVERSION:  Price/mt = MPOB Price_1% × Graded_OER%
 * The OER data here provides the Graded_OER% used by fetch-ffb-price.mjs.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const PAGE_URL = 'https://prestasisawit.mpob.gov.my/en/oer';
const API_URL = 'https://prestasisawit.mpob.gov.my/api/oer';
const HISTORY_PATH = path.resolve(process.cwd(), 'market', 'oer-history.json');
const LATEST_PATH = path.resolve(process.cwd(), 'market', 'oer-latest.json');
const START_YEAR = Number(process.env.OER_START_YEAR) || 2000;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; PalmDocMarketFeed/1.0; +https://github.com/BorneanWingz/PalmDoc-Market-Feed)',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};
const STATE_MAP = {
  '01': 'Johor', '02': 'Kedah', '03': 'Kelantan', '04': 'Melaka',
  '05': 'Negeri Sembilan', '06': 'Pahang', '07': 'Perak', '08': 'Perlis',
  '09': 'Pulau Pinang', '10': 'Selangor', '11': 'Terengganu',
  '12': 'Wilayah Persekutuan', '13': 'Sabah', '14': 'Sarawak',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 2000;
const REQUEST_DELAY_MS = 1500; // delay between API calls to avoid 429

async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      if (res.status === 429) {
        const delay = BASE_DELAY_MS * 3 ** (attempt - 1); // 2s, 6s, 18s, 54s
        console.warn(`  Rate-limited (429). Waiting ${delay}ms before retry ${attempt}/${retries}…`);
        await sleep(delay);
        continue;
      }
      if (res.status >= 500) throw new Error(`Server error ${res.status} for ${url}`);
      throw new Error(`HTTP ${res.status} for ${url}`);
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(`  Attempt ${attempt}/${retries} failed: ${err.message}. Retrying in ${delay}ms…`);
      await sleep(delay);
    }
  }
}

async function getCsrfToken() {
  const res = await fetchWithRetry(PAGE_URL, { headers: HEADERS });
  const html = await res.text();
  const match = html.match(/csrf-token["\s]+content="([^"]+)"/);
  if (!match) throw new Error('Could not extract CSRF token from the OER page.');
  return match[1];
}

async function fetchMonth(year, month, csrf) {
  const m = String(month).padStart(2, '0');
  const url = `${API_URL}?year=${year}&month=${m}`;
  const res = await fetchWithRetry(url, {
    headers: { ...HEADERS, 'X-CSRF-TOKEN': csrf, 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' },
  });
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('json')) throw new Error(`Expected JSON for ${year}-${m}, got ${ct}.`);
  const data = await res.json();
  const perf = data.performance_data || [];
  const states = data.state_data || [];
  if (perf.length === 0 && states.length === 0) return null;
  if (perf.length === 0) throw new Error(`OER API: no performance_data for ${year}-${m}.`);
  const p = perf[0];
  const period = `${year}-${m}`;
  const stateRows = states.map((s) => ({
    stateCode: s.negeri,
    stateName: STATE_MAP[s.negeri] || `Unknown (${s.negeri})`,
    oerCpo: s.oer_cpo, oerCpko: s.oer_cpko || 0,
    kerPk: s.ker_pk, kerPkc: s.ker_pkc || 0,
    cpoProcessed: s.cpo_proc, ffbProcessed: s.ffb_proc,
  }));
  return {
    period, year, month: m,
    malaysia: {
      oerCpo: p.oer_malaysia, oerPeninsular: p.oer_peninsular,
      oerSabah: p.oer_sabah, oerSarawak: p.oer_sarawak,
      maxLicensee: p.max_pelesen, minLicensee: p.min_pelesen, millCount: p.mill_count,
    },
    states: stateRows,
  };
}


function getKlNow() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit',
  }).format(new Date());
}

async function buildHistory(existing) {
  const klNow = getKlNow();
  const [currentYearStr, currentMonthStr] = klNow.split('-');
  const currentYear = Number(currentYearStr);
  const currentMonth = Number(currentMonthStr);
  const existingMonths = new Map();
  if (existing?.months) {
    for (const m of existing.months) existingMonths.set(m.period, m);
  }
  console.log('Fetching fresh CSRF token…');
  const csrf = await getCsrfToken();
  const months = [];
  let fetched = 0;
  let consecutiveEmpty = 0;
  const MAX_CONSECUTIVE_EMPTY = 3;
  for (let year = START_YEAR; year <= currentYear; year += 1) {
    const maxMonth = year === currentYear ? currentMonth : 12;
    for (let m = 1; m <= maxMonth; m += 1) {
      const period = `${year}-${String(m).padStart(2, '0')}`;
      if (existingMonths.has(period) && year < currentYear) {
        months.push(existingMonths.get(period));
        continue;
      }
      const fetchedMonth = await fetchMonth(year, m, csrf);
      if (!fetchedMonth) {
        consecutiveEmpty += 1;
        if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY && year === currentYear && m >= currentMonth) {
          console.log(`  ${period}: not yet published — stopping.`);
          break;
        }
        continue;
      }
      consecutiveEmpty = 0;
      const myOer = fetchedMonth.malaysia.oerCpo;
      if (!Number.isFinite(myOer) || myOer < 10 || myOer > 30) {
        throw new Error(`Implausible Malaysia OER ${myOer} for ${period}. Refusing to publish.`);
      }
      months.push(fetchedMonth);
      fetched += 1;
      console.log(`  ✓ ${period}: MY OER=${myOer} (${fetchedMonth.states.length} states)`);
      await sleep(REQUEST_DELAY_MS);
    }
  }
  console.log(`Fetched ${fetched} new month(s), ${months.length} total.`);
  return months;
}

async function main() {
  let existing = null;
  try {
    const raw = await fs.readFile(HISTORY_PATH, 'utf8');
    existing = JSON.parse(raw);
    console.log(`Loaded existing history: ${existing.months?.length || 0} months (${existing.from} → ${existing.to}).`);
  } catch {
    console.log('No existing history — fetching from scratch.');
  }
  const months = await buildHistory(existing);
  if (!months.length) throw new Error('No OER data was fetched. Refusing to publish an empty file.');
  const from = months[0].period;
  const to = months.at(-1).period;
  if (existing?.months && months.length < existing.months.length) {
    throw new Error(`Fetched ${months.length} months but had ${existing.months.length}. Refusing to shrink history.`);
  }
  const historyPayload = {
    source: 'MPOB Prestasi Sawit — Oil Extraction Rate (OER)',
    sourceUrl: PAGE_URL, unit: '% OER (CPO per FFB processed)',
    from, to, monthCount: months.length,
    lastUpdated: new Date().toISOString(), months,
  };
  await fs.mkdir(path.dirname(HISTORY_PATH), { recursive: true });
  await fs.writeFile(HISTORY_PATH, `${JSON.stringify(historyPayload)}\n`, 'utf8');
  console.log(`Saved ${months.length} months (${from} → ${to}) to oer-history.json`);
  const latest = months.at(-1);
  const latestPayload = {
    source: 'MPOB Prestasi Sawit — Oil Extraction Rate (OER)',
    sourceUrl: PAGE_URL, period: latest.period,
    year: latest.year, month: latest.month,
    malaysia: latest.malaysia, states: latest.states,
    lastUpdated: new Date().toISOString(),
  };
  await fs.writeFile(LATEST_PATH, `${JSON.stringify(latestPayload, null, 2)}\n`, 'utf8');
  console.log(`Saved latest OER snapshot: ${latest.period} (MY OER=${latest.malaysia.oerCpo}%)`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}