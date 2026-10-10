#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

const TARGET_URL = 'https://bepi.mpob.gov.my/admin2/price_local_daily_view_cpo_msia.php?more=Y&jenis=6M';
const OUT_PATH = path.resolve(process.cwd(), 'market', 'cpo-latest.json');

const toIsoDate = (rawDate) => {
  const parsed = new Date(rawDate);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Unable to parse date: ${rawDate}`);
  }
  return parsed.toISOString().slice(0, 10);
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
