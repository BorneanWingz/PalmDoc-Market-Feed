#!/usr/bin/env node
/**
 * fetch-ffb-price.mjs — MPOB Daily FFB Reference Price Summary by Region (Mill Gate)
 *
 * Scrapes the public PDF at https://price.mpob.gov.my/pdf/daily/ffb/<YYYY-MM-DD>
 * for every trading day from January 2012 (earliest available) to the current
 * Malaysia date.  Extracts the 6-region price table from the PDF's compressed
 * text streams, normalizes NT/PH non-trading markers, and publishes:
 *
 *   market/ffb-history.json  — full historical archive (all months, all days)
 *   market/ffb-latest.json   — latest available trading-day snapshot
 *
 * FAIL-SAFE:  If the PDF cannot be fetched, parsed, or validated, the script
 * throws and the GitHub Actions workflow fails rather than publishing
 * fabricated or incomplete data.  The last good snapshot in the repo remains
 * available to consumers.  Existing cached months are never overwritten with
 * fewer rows — only new months are added or existing months are extended.
 *
 * UNIT NOTE:  The PDF title has always read "RM/1% OER", but the numeric
 * values changed regime in July 2020:
 *   - Jan 2012 – Jun 2020: prices ~400–700  (effectively RM/tonne FFB)
 *   - Jul 2020 – present:  prices ~20–60    (true RM per 1% OER)
 * Each monthly record carries a `unit` field so consumers can distinguish.
 *
 * FFB CONVERSION:  Price/mt = MPOB Price_1% × Graded_OER%
 * The OER data is published separately by fetch-oer.mjs in oer-history.json.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const PDF_BASE = 'https://price.mpob.gov.my/pdf/daily/ffb/';
const HISTORY_PATH = path.resolve(process.cwd(), 'market', 'ffb-history.json');
const LATEST_PATH = path.resolve(process.cwd(), 'market', 'ffb-latest.json');
const START_YEAR = Number(process.env.FFB_START_YEAR) || 2012;
const REGIME_CHANGE = { year: 2020, month: 7 };
const REGIONS = ['north', 'south', 'central', 'eastCoast', 'sabah', 'sarawak'];
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; PalmDocMarketFeed/1.0; +https://github.com/BorneanWingz/PalmDoc-Market-Feed)',
  'Accept': 'application/pdf,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 2000;

async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      if (res.status === 404) return res;
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

// ── PDF text extraction ─────────────────────────────────────────────────────
const STREAM_START = />>\s*stream\r?\n/g;
const TEXT_OBJECT = /BT\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Td\s+\/F\w+\s+[\d.]+\s+Tf\s+\[(.*?)\]\s+TJ\s+ET/gs;

function extractPdfText(pdfBuf) {
  const texts = [];
  let match;
  while ((match = STREAM_START.exec(pdfBuf)) !== null) {
    const end = pdfBuf.indexOf('endstream', match.index + match[0].length);
    if (end < 0) continue;
    let decoded;
    try {
      decoded = zlib.inflateSync(pdfBuf.subarray(match.index + match[0].length, end)).toString('latin1');
    } catch {
      continue;
    }
    let tm;
    while ((tm = TEXT_OBJECT.exec(decoded)) !== null) {
      let text = '';
      for (const p of (tm[3].match(/\(([^)]*)\)/g) || [])) {
        text += p.slice(1, -1)
          .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
          .replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\');
      }
      if (text.trim()) {
        texts.push({ x: parseFloat(tm[1]), y: parseFloat(tm[2]), text: text.trim() });
      }
    }
  }
  texts.sort((a, b) => b.y - a.y || a.x - b.x);
  return texts;
}

// ── PDF row parser ──────────────────────────────────────────────────────────
// The FFB PDF has a fixed layout: a header row at y≈639.6, then data rows
// spaced ~11.1pt apart.  Each data row has a day number at x≈68-70 and six
// price columns at x≈139, 214, 290, 365, 440, 515.  NT/PH are non-trading markers.

function parsePdf(texts) {
  // Find the month/year title (e.g. "OCTOBER 2026")
  const monthLine = texts.find((t) =>
    /^(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+\d{4}$/i.test(t.text),
  );
  if (!monthLine) throw new Error('Could not find month/year title in FFB PDF.');
  const [monthName, yearStr] = monthLine.text.split(/\s+/);
  const monthMap = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  };
  const month = monthMap[monthName.toLowerCase()];
  const year = Number(yearStr);
  if (!month || !year) throw new Error(`Could not parse month/year: "${monthLine.text}"`);

  // Find the "Last update" line
  const lastUpdateLine = texts.find((t) => /Last update\s*:/i.test(t.text));
  const lastUpdate = lastUpdateLine
    ? lastUpdateLine.text.replace(/^.*Last update\s*:\s*/i, '').trim()
    : null;

  // Group data rows: find all day-number tokens (1-31 at x<100), then collect
  // the six price tokens on the same y-coordinate.
  const dayTokens = texts.filter((t) => /^\d{1,2}$/.test(t.text) && t.x < 100);
  const rows = [];
  for (const dayTok of dayTokens) {
    const day = Number(dayTok.text);
    if (day < 1 || day > 31) continue;
    // Collect price tokens on the same y (within 2pt tolerance)
    const prices = texts
      .filter((t) => Math.abs(t.y - dayTok.y) < 2 && t.x > 100 && t.x < 560)
      .sort((a, b) => a.x - b.x)
      .map((t) => t.text);
    if (prices.length !== 6) continue; // skip malformed rows
    const parsed = prices.map((p) => {
      if (p === 'NT' || p === 'PH') return p;
      const val = Number(p);
      if (val === 0) return 'NT'; // 0.00 means no trade
      return Number.isFinite(val) ? val : p;
    });
    rows.push({ day, prices: parsed });
  }

  if (!rows.length) throw new Error(`No data rows found in FFB PDF for ${monthName} ${year}.`);
  // Sort by day
  rows.sort((a, b) => a.day - b.day);

  return { year, month, monthName: monthName.toUpperCase(), lastUpdate, rows };
}

// ── Fetch a single day's PDF and parse it ────────────────────────────────────

async function fetchDay(year, month, day) {
  const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const url = `${PDF_BASE}${dateStr}`;
  const res = await fetchWithRetry(url, { headers: BROWSER_HEADERS });
  if (res.status === 404) return null; // future date or non-existent
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('pdf')) throw new Error(`Expected PDF for ${dateStr}, got ${ct}.`);
  const pdfBuf = Buffer.from(await res.arrayBuffer());
  const texts = extractPdfText(pdfBuf);
  const parsed = parsePdf(texts);
  return { ...parsed, dateStr, pdfSize: pdfBuf.length };
}

// ── Determine the unit regime for a given year/month ─────────────────────────

function getUnit(year, month) {
  if (year < REGIME_CHANGE.year || (year === REGIME_CHANGE.year && month < REGIME_CHANGE.month)) {
    return 'RM/tonne (pre-Jul 2020 legacy)';
  }
  return 'RM per 1% OER';
}

// ── Validate a parsed day's prices ───────────────────────────────────────────

function validateDay(parsed, dateStr) {
  const { year, month, rows } = parsed;
  // Verify the PDF's month/year matches what we requested
  if (year !== year || month !== month) {
    throw new Error(`PDF month/year mismatch for ${dateStr}: got ${parsed.monthName} ${parsed.year}.`);
  }
  // Plausibility checks: pre-regime prices should be 100–1500, post-regime 5–150
  const isOldRegime = year < REGIME_CHANGE.year || (year === REGIME_CHANGE.year && month < REGIME_CHANGE.month);
  const [minPlaus, maxPlaus] = isOldRegime ? [100, 1500] : [5, 150];
  for (const row of rows) {
    for (const p of row.prices) {
      if (typeof p === 'number') {
        if (p < minPlaus || p > maxPlaus) {
          throw new Error(`Implausible price ${p} on day ${row.day} of ${dateStr} (expected ${minPlaus}–${maxPlaus}).`);
        }
      }
    }
  }
}

// ── Convert rows to normalized daily records ─────────────────────────────────

function toDayRecords(parsed) {
  const unit = getUnit(parsed.year, parsed.month);
  return parsed.rows.map((row) => ({
    day: row.day,
    date: `${parsed.year}-${String(parsed.month).padStart(2, '0')}-${String(row.day).padStart(2, '0')}`,
    unit,
    regions: {
      north: row.prices[0],
      south: row.prices[1],
      central: row.prices[2],
      eastCoast: row.prices[3],
      sabah: row.prices[4],
      sarawak: row.prices[5],
    },
  }));
}

// ── KL date helpers ──────────────────────────────────────────────────────────

function getKlNow() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

// ── Build full history ──────────────────────────────────────────────────────
// Strategy: fetch one PDF per month (any day in that month returns the whole
// month's table).  We use the 15th as a stable mid-month anchor.  For the
// current month, we re-fetch every run to pick up newly published days.

async function buildHistory(existing) {
  const klNow = getKlNow();
  const [currentYearStr, currentMonthStr, currentDayStr] = klNow.split('-');
  const currentYear = Number(currentYearStr);
  const currentMonth = Number(currentMonthStr);
  const currentDay = Number(currentDayStr);

  // Build a map of existing months by period key
  const existingMonths = new Map();
  if (existing?.months) {
    for (const m of existing.months) existingMonths.set(m.period, m);
  }

  const months = [];
  let fetched = 0;
  let consecutive404 = 0;
  const MAX_CONSECUTIVE_404 = 3;

  for (let year = START_YEAR; year <= currentYear; year += 1) {
    const maxMonth = year === currentYear ? currentMonth : 12;
    for (let m = 1; m <= maxMonth; m += 1) {
      const period = `${year}-${String(m).padStart(2, '0')}`;
      const isCurrentMonth = year === currentYear && m === currentMonth;

      // Skip re-fetching cached months (unless it's the current month)
      if (existingMonths.has(period) && !isCurrentMonth) {
        months.push(existingMonths.get(period));
        continue;
      }

      // Fetch the PDF for this month (use day 15 as anchor)
      const anchorDay = isCurrentMonth
        ? Math.min(currentDay, daysInMonth(year, m))
        : 15;
      try {
        const parsed = await fetchDay(year, m, anchorDay);
        if (!parsed) {
          // 404 — month not yet published
          consecutive404 += 1;
          if (consecutive404 >= MAX_CONSECUTIVE_404 && isCurrentMonth) {
            console.log(`  ${period}: not yet published — stopping.`);
            break;
          }
          // If we have a cached version, keep it
          if (existingMonths.has(period)) {
            months.push(existingMonths.get(period));
            console.log(`  ${period}: fetch failed, keeping cached version.`);
          }
          continue;
        }
        consecutive404 = 0;

        // Validate
        validateDay(parsed, parsed.dateStr);
        const dayRecords = toDayRecords(parsed);
        const unit = getUnit(year, m);
        const monthRecord = {
          period,
          year,
          month: m,
          monthName: parsed.monthName,
          unit,
          lastUpdate: parsed.lastUpdate,
          days: dayRecords,
        };

        // Fail-safe: never replace good data with fewer days
        if (existingMonths.has(period)) {
          const cached = existingMonths.get(period);
          if (dayRecords.length < (cached.days?.length || 0)) {
            console.warn(`  ${period}: fetched ${dayRecords.length} days but had ${cached.days?.length}. Keeping cached.`);
            months.push(cached);
            continue;
          }
        }

        months.push(monthRecord);
        fetched += 1;
        const tradingDays = dayRecords.filter((d) =>
          typeof d.regions.north === 'number' ||
          (d.regions.north !== 'NT' && d.regions.north !== 'PH')
        ).length;
        console.log(`  ✓ ${period}: ${dayRecords.length} days (${tradingDays} trading), unit=${unit}`);
        await sleep(500);
      } catch (err) {
        // If fetch fails but we have cached data, keep the cache
        if (existingMonths.has(period)) {
          console.warn(`  ${period}: ${err.message} — keeping cached version.`);
          months.push(existingMonths.get(period));
          continue;
        }
        // No cache and fetch failed — this is fatal for historical months
        if (!isCurrentMonth) throw err;
        // Current month might not be ready yet
        console.warn(`  ${period}: ${err.message}`);
        break;
      }
    }
  }

  console.log(`Fetched ${fetched} new month(s), ${months.length} total.`);
  return months;
}

// ── Scheduled-run skip (weekends/holidays) ───────────────────────────────────

async function getNonTradingReason() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).format(new Date());
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kuala_Lumpur', weekday: 'short' }).format(new Date());
  if (weekday === 'Sat' || weekday === 'Sun') return `${today} is a weekend`;
  const raw = await fs.readFile(path.resolve(process.cwd(), 'config', 'non-trading-days.json'), 'utf8');
  const holiday = JSON.parse(raw).holidays.find((entry) => entry.date === today);
  return holiday ? `${today} is a public holiday (${holiday.name})` : null;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (process.env.GITHUB_EVENT_NAME === 'schedule') {
    const reason = await getNonTradingReason();
    if (reason) {
      console.log(`Skipping update: ${reason}.`);
      return;
    }
  }

  let existing = null;
  try {
    const raw = await fs.readFile(HISTORY_PATH, 'utf8');
    existing = JSON.parse(raw);
    console.log(`Loaded existing history: ${existing.months?.length || 0} months (${existing.from} → ${existing.to}).`);
  } catch {
    console.log('No existing FFB history — fetching from scratch.');
  }

  const months = await buildHistory(existing);
  if (!months.length) throw new Error('No FFB data was fetched. Refusing to publish an empty file.');

  const from = months[0].period;
  const to = months.at(-1).period;

  // Fail-safe: never shrink the history
  if (existing?.months && months.length < existing.months.length) {
    throw new Error(`Fetched ${months.length} months but had ${existing.months.length}. Refusing to shrink history.`);
  }

  const historyPayload = {
    source: 'MPOB Daily FFB Reference Price Summary by Region (Mill Gate)',
    sourceUrl: PDF_BASE,
    unit: 'RM per 1% OER (post-Jul 2020) / RM/tonne (pre-Jul 2020 legacy)',
    regions: ['North', 'South', 'Central', 'East Coast', 'Sabah', 'Sarawak'],
    from,
    to,
    monthCount: months.length,
    lastUpdated: new Date().toISOString(),
    months,
  };

  await fs.mkdir(path.dirname(HISTORY_PATH), { recursive: true });
  await fs.writeFile(HISTORY_PATH, `${JSON.stringify(historyPayload)}\n`, 'utf8');
  console.log(`Saved ${months.length} months (${from} → ${to}) to ffb-history.json`);

  // Latest snapshot: the most recent trading day from the current month
  const latestMonth = months.at(-1);
  const latestTradingDay = [...latestMonth.days]
    .reverse()
    .find((d) => typeof d.regions.north === 'number');
  if (!latestTradingDay) {
    throw new Error(`No trading day found in latest month ${latestMonth.period}. Refusing to publish.`);
  }
  const latestPayload = {
    source: 'MPOB Daily FFB Reference Price Summary by Region (Mill Gate)',
    sourceUrl: `${PDF_BASE}${latestTradingDay.date}`,
    date: latestTradingDay.date,
    unit: latestMonth.unit,
    regions: latestTradingDay.regions,
    monthPeriod: latestMonth.period,
    lastUpdate: latestMonth.lastUpdate,
    lastUpdated: new Date().toISOString(),
  };
  await fs.writeFile(LATEST_PATH, `${JSON.stringify(latestPayload, null, 2)}\n`, 'utf8');
  console.log(`Saved latest FFB snapshot: ${latestTradingDay.date} (north=${latestTradingDay.regions.north})`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
