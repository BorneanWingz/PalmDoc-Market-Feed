# PalmDoc Market Feed

PalmDoc Market Feed is a small public data service for the PalmDoc oil-palm field toolkit. It retrieves Malaysia's daily crude palm oil (CPO) price from the Malaysian Palm Oil Board (MPOB), normalizes the result into a stable JSON file, and publishes it from this repository for the app to consume.

## Public feed

The latest snapshot is available at:

<https://raw.githubusercontent.com/BorneanWingz/PalmDoc-Market-Feed/main/market/cpo-latest.json>

Example response:

```json
{
  "source": "MPOB Malaysia CPO Daily Price",
  "sourceUrl": "https://bepi.mpob.gov.my/admin2/price_local_daily_view_cpo_msia.php?more=Y&jenis=6M",
  "date": "2026-10-07",
  "price": 4399.5,
  "currency": "MYR",
  "unit": "RM/tonne",
  "lastUpdated": "2026-10-10T15:46:48.481Z"
}
```

The feed is served as a static file; consumers do not need a token or API key. The price date is the date reported by MPOB, while `lastUpdated` is when this repository's feed was generated. MPOB may not publish a new price on weekends, public holidays, or before its daily data is available.

## How updates work

The GitHub Actions workflow in `.github/workflows/update-cpo-price.yml` runs daily at 04:00 UTC (12:00 Malaysia time) and can also be started manually from the Actions tab. It runs `scripts/fetch-cpo-price.mjs` with Node.js 20 and commits the JSON only when its contents change.

To refresh the feed locally:

```sh
node scripts/fetch-cpo-price.mjs
```

The script uses Node.js's built-in `fetch` and requires no npm dependencies.

## Data source and limitations

- Source: [MPOB BEPI daily local CPO price](https://bepi.mpob.gov.my/admin2/price_local_daily_view_cpo_msia.php?more=Y&jenis=6M)
- The feed is a convenience snapshot of MPOB's published data, not a real-time exchange quote.
- If MPOB changes its page format or is temporarily unavailable, the scheduled workflow fails rather than publishing a fabricated value. The last successfully published snapshot remains available.
- Refer to MPOB for the authoritative figure. This feed is provided for informational purposes and is not financial advice.

## Repository contents

- `market/cpo-latest.json` — latest normalized public snapshot.
- `scripts/fetch-cpo-price.mjs` — fetches and parses MPOB's published page.
- `.github/workflows/update-cpo-price.yml` — scheduled and manual refresh workflow.
