#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

const TARGET_URL = 'https://bepi.mpob.gov.my/admin2/price_local_daily_view_cpo_msia.php?more=Y&jenis=6M';
const OUT_PATH = path.resolve(process.cwd(), 'market', 'cpo-latest.json');

const toIsoDate = (rawDate) => {
  const match = rawDate.trim().match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  const month = match ? ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(match[1].toLowerCase()) + 1 : 0;
  if (!match || !month) {
    throw new Error(`Unable to parse date: ${rawDate}`);
  }
  return `${match[3]}-${String(month).padStart(2, '0')}-${match[2].padStart(2, '0')}`;
};

const BASE_URL = 'https://bepi.mpob.gov.my/admin2/price_local_daily_view_cpo_msia.php?more=Y&jenis=1Y&tahun=';
const HISTORY_START_YEAR = 2024;
const HISTORY_PATH = path.resolve(process.cwd(), 'market', 'cpo-history.json');
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; PalmDocMarketFeed/1.0; +https://github.com/BorneanWingz/PalmDoc-Market-Feed)',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

const parseSeries = (html) => {
  const categoryMatch = html.match(/categories\s*:\s*\[(.*?)\]/s);
  const dataMatch = html.match(/data\s*:\s*\[(.*?)\]/s);
  if (!categoryMatch || !dataMatch) {
    throw new Error('Unable to find the MPOB categories/data arrays in the page source.');
  }
  const dates = [...categoryMatch[1].matchAll(/'([^']+)'/g)].map((match) => toIsoDate(match[1]));
  const values = [...dataMatch[1].matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  if (!dates.length || dates.length !== values.length) {
    throw new Error(`MPOB date/price counts do not match (${dates.length} vs ${values.length}).`);
  }
  return dates.map((date, index) => [date, Number(values[index].toFixed(2))]);
};

const fetchYear = async (year) => {
  const response = await fetch(`${BASE_URL}${year}`, { headers: HEADERS });
  if (!response.ok) {
    throw new Error(`MPOB request for ${year} failed with status ${response.status}`);
  }
  return parseSeries(await response.text());
};

const buildHistory = async () => {
  const currentYear = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric' }).format(new Date()));
  const byDate = new Map();
  for (let year = HISTORY_START_YEAR; year <= currentYear; year += 1) {
    for (const [date, price] of await fetchYear(year)) {
      if (date >= `${HISTORY_START_YEAR}-01-01`) byDate.set(date, price);
    }
  }
  return [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
};

const parseLatestPrice = (html) => {
  const categoryMatch = html.match(/categories\s*:\s*\[(.*?)\]/s);
  const dataMatch = html.match(/data\s*:\s*\[(.*?)\]/s);

  if (!categoryMatch || !dataMatch) {
    throw new Error('Unable to find the MPOB categories/data arrays in the page source.');
  }

  const dates = [...categoryMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const values = [...dataMatch[1].matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));

  if (!dates.length || !values.length) {
    throw new Error('MPOB page parsed but no dates/prices were found.');
  }

  const date = dates.at(-1);
  const price = values.at(-1);
  if (!date || !Number.isFinite(price)) {
    throw new Error('Could not determine the latest date and price from the MPOB data.');
  }

  return { date: toIsoDate(date), price: Number(price.toFixed(2)) };
};

// Scheduled runs skip weekends and the public holidays listed in config/non-trading-days.json.
// Manual runs (workflow_dispatch or local) always fetch.
const getNonTradingReason = async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).format(new Date());
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kuala_Lumpur', weekday: 'short' }).format(new Date());
  if (weekday === 'Sat' || weekday === 'Sun') return `${today} is a weekend`;
  const raw = await fs.readFile(path.resolve(process.cwd(), 'config', 'non-trading-days.json'), 'utf8');
  const holiday = JSON.parse(raw).holidays.find((entry) => entry.date === today);
  return holiday ? `${today} is a public holiday (${holiday.name})` : null;
};

const main = async () => {
  if (process.env.GITHUB_EVENT_NAME === 'schedule') {
    const reason = await getNonTradingReason();
    if (reason) {
      console.log(`Skipping update: ${reason}.`);
      return;
    }
  }

  const response = await fetch(TARGET_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; PalmDocMarketFeed/1.0; +https://github.com/BorneanWingz/PalmDoc-Market-Feed)',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!response.ok) {
    throw new Error(`MPOB request failed with status ${response.status}`);
  }

  const html = await response.text();
  const { date, price } = parseLatestPrice(html);

  const points = await buildHistory();
  const lastPoint = points.at(-1);
  if (!lastPoint || lastPoint[0] !== date || lastPoint[1] !== price) {
    throw new Error('History does not end at the latest price; refusing to publish.');
  }
  await fs.mkdir(path.dirname(HISTORY_PATH), { recursive: true });
  await fs.writeFile(
    HISTORY_PATH,
    `${JSON.stringify({ source: 'MPOB Malaysia CPO Daily Price', currency: 'MYR', unit: 'RM/tonne', from: points[0][0], to: lastPoint[0], lastUpdated: new Date().toISOString(), points })}\n`,
    'utf8',
  );
  console.log(`Saved ${points.length} daily prices (${points[0][0]} to ${lastPoint[0]})`);

  const payload = {
    source: 'MPOB Malaysia CPO Daily Price',
    sourceUrl: TARGET_URL,
    date,
    price,
    currency: 'MYR',
    unit: 'RM/tonne',
    lastUpdated: new Date().toISOString(),
  };

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Saved ${payload.date} CPO price: RM ${payload.price.toFixed(2)}/tonne`);
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
