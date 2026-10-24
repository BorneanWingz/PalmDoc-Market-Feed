# PalmDoc Market Feed

PalmDoc Market Feed is a small public data service for the PalmDoc oil-palm field toolkit. It retrieves market data from the Malaysian Palm Oil Board (MPOB), normalizes the results into stable JSON files, and publishes them from this repository for the app to consume.

## Public feeds

### CPO Daily Price

<https://raw.githubusercontent.com/BorneanWingz/PalmDoc-Market-Feed/main/market/cpo-latest.json>

```json
{
  "source": "MPOB Malaysia CPO Daily Price",
  "date": "2026-10-07",
  "price": 4399.5,
  "currency": "MYR",
  "unit": "RM/tonne"
}
```

Full CPO history: <https://raw.githubusercontent.com/BorneanWingz/PalmDoc-Market-Feed/main/market/cpo-history.json>

### OER — Oil Extraction Rate (monthly, by state)

<https://raw.githubusercontent.com/BorneanWingz/PalmDoc-Market-Feed/main/market/oer-latest.json>

National and per-state Oil Extraction Rate (OER), CPO processed, FFB processed, and mill count. Data spans January 2000 to present, sourced from [MPOB Prestasi Sawit Malaysia](https://prestasisawit.mpob.gov.my/en/oer).

```json
{
  "period": "2026-09",
  "malaysia": { "oerCpo": 20.26, "oerPeninsular": 20.01, "oerSabah": 21.25, "oerSarawak": 19.96, "millCount": 449 },
  "states": [{ "stateCode": "01", "stateName": "Johor", "oerCpo": 20.32, "ffbProcessed": 1552014.0 }]
}
```

Full OER history: <https://raw.githubusercontent.com/BorneanWingz/PalmDoc-Market-Feed/main/market/oer-history.json>

### FFB Daily Reference Price (by region, mill gate)

<https://raw.githubusercontent.com/BorneanWingz/PalmDoc-Market-Feed/main/market/ffb-latest.json>

Daily Fresh Fruit Bunch (FFB) reference price for 6 regions (North, South, Central, East Coast, Sabah, Sarawak). Data spans January 2012 to present, sourced from [MPOB daily FFB PDFs](https://price.mpob.gov.my/pdf/daily/ffb/).

```json
{
  "date": "2026-10-23",
  "unit": "RM per 1% OER",
  "regions": { "north": 47.87, "south": 48.25, "central": 48.17, "eastCoast": 48.13, "sabah": 43.11, "sarawak": 43.53 }
}
```

Full FFB history: <https://raw.githubusercontent.com/BorneanWingz/PalmDoc-Market-Feed/main/market/ffb-history.json>

#### FFB price conversion formula

> **Price/mt = MPOB Price_1% × Graded_OER%**

Multiply the daily FFB reference price (RM per 1% OER) by the monthly OER percentage for the relevant region/state to get the FFB price in RM/tonne.

**Note on pre-July 2020 data:** The PDF title has always read "RM/1% OER", but numeric values changed regime in July 2020. Pre-July 2020 values are effectively RM/tonne (total FFB price); post-July 2020 values are true RM per 1% OER. Each monthly record carries a `unit` field so consumers can distinguish.

The OER data needed for the conversion is published separately in `oer-history.json`.

## How updates work

- **CPO price**: The GitHub Actions workflow in `.github/workflows/update-cpo-price.yml` runs six times daily at 08:31 and 16:31 Malaysia time, and can also be started manually. Scheduled runs skip weekends and public holidays.
- **OER & FFB**: The workflow in `.github/workflows/update-oer-ffb.yml` runs at 09:00 and 17:00 Malaysia time. OER is monthly data (published mid-month); FFB is daily. Both scrapers use incremental caching — existing months are loaded from the repo and only new months are fetched, so each run only downloads what's missing.

All workflows commit JSON only when contents change. GitHub may start scheduled runs a few minutes late.

To refresh feeds locally:

```sh
node scripts/fetch-cpo-price.mjs
node scripts/fetch-oer.mjs
node scripts/fetch-ffb-price.mjs
```

The scripts use Node.js's built-in `fetch` and `zlib` — no npm dependencies required.

## Fail-safe design

If MPOB changes its page/PDF format or is temporarily unavailable, the scheduled workflow **fails rather than publishing a fabricated value**. The last successfully published snapshot remains available. Existing history is never overwritten with fewer records — only new months/days are added.

## Data sources and limitations

- **CPO**: [MPOB BEPI daily local CPO price](https://bepi.mpob.gov.my/admin2/price_local_daily_view_cpo_msia.php?more=Y&jenis=6M)
- **OER**: [MPOB Prestasi Sawit — OER](https://prestasisawit.mpob.gov.my/en/oer) (monthly, by state, from Jan 2000)
- **FFB**: [MPOB daily FFB reference price PDFs](https://price.mpob.gov.my/pdf/daily/ffb/) (daily, by region, from Jan 2012)
- These feeds are convenience snapshots of MPOB's published data, not real-time exchange quotes.
- Refer to MPOB for authoritative figures. This feed is provided for informational purposes only and is not financial advice.

## Repository contents

- `market/cpo-latest.json` — latest CPO daily price snapshot.
- `market/cpo-history.json` — full CPO daily price history.
- `market/oer-latest.json` — latest OER monthly snapshot (national + per-state).
- `market/oer-history.json` — full OER history (Jan 2000 → present, 320+ months).
- `market/ffb-latest.json` — latest FFB daily price snapshot (6 regions).
- `market/ffb-history.json` — full FFB history (Jan 2012 → present, 178+ months).
- `scripts/fetch-cpo-price.mjs` — fetches and parses MPOB CPO daily price.
- `scripts/fetch-oer.mjs` — fetches and parses MPOB OER by month and state.
- `scripts/fetch-ffb-price.mjs` — fetches and parses MPOB daily FFB reference PDFs.
- `config/non-trading-days.json` — public holidays on which scheduled updates are skipped.
- `.github/workflows/update-cpo-price.yml` — CPO refresh workflow.
- `.github/workflows/update-oer-ffb.yml` — OER + FFB refresh workflow.
