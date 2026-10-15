# StreamScore

Search movies — by title, director, or actor — browse what's streaming on
Netflix / Amazon Prime Video / Disney+, and sort everything by Metacritic's
Metascore or its average with Rotten Tomatoes — all from a static page with
no backend server. Also lets you filter by genre, mark movies as "Seen" or
"Don't want to see" right from the list, and hide either from view.

## How it works

Metacritic has no public API, so this app doesn't scrape metacritic.com
directly. Instead it combines two free, browser-friendly APIs:

- **[OMDb API](https://www.omdbapi.com/)** — provides the Metascore and a
  synopsis for a given title (OMDb aggregates Metacritic's score).
- **[TMDB API](https://www.themoviedb.org/documentation/api)** — provides the
  "browse by streaming service" list and, per movie, which services
  (Netflix / Prime Video / Disney+) currently carry it in your region. This
  data comes from JustWatch via TMDB.

Each movie's detail view also links out to its Metacritic and Rotten
Tomatoes pages, in case you want to read the original write-ups (or check
Rotten Tomatoes' score — OMDb has it too, but see the caching note below).

Both APIs are called directly from the browser (no server component), and
your API keys are stored only in your browser's `localStorage`. OMDb
responses are also cached in `localStorage`, so re-visiting a title you've
already looked up doesn't cost another request against OMDb's daily quota —
see "Notes / limitations" below.

## Catalogue: sorting by score across everything

TMDB can only sort by popularity or vote count, never by Metascore or
Rotten Tomatoes, so a live list can only be sorted within the pages already
loaded. To sort by score across *every* movie, a scheduled GitHub Action
(`.github/workflows/update-catalog.yml`, daily) runs
`scripts/build-catalog.mjs` and commits one file per region,
`data/catalog-US.json` and `data/catalog-BE.json`: every movie on Netflix,
Prime Video or Disney+ in that region with at least 100 TMDB votes, together
with its Metascore, Rotten Tomatoes score and genres.

The app loads the catalogue for the region set in Settings and browses it
directly: sorting and filtering cover the whole catalogue instantly, and
"Load more" just reveals the next 48 movies of the sorted list (no requests,
no reshuffling). The services you tick restrict the list; with none ticked
you see all three. Searching (title, director, actor) still goes live to
OMDb/TMDB, and if a region has no catalogue the app falls back to live
paging.

- **Secrets:** add `TMDB_API_KEY` and `OMDB_API_KEY` as repository secrets
  (Settings → Secrets and variables → Actions). Ideally use a second free
  OMDb key, so the daily build never competes with the key you use in the
  app. Until both exist the workflow just skips with a warning.
- **First run:** Actions → "Update catalogue" → Run workflow. OMDb's free
  tier allows 1,000 lookups a day, so the build checks up to 900 new titles
  a day, most-voted first, and the catalogue fills in over roughly a week to
  ten days; a line under the filters shows how many titles have scores yet.
  After that, each day only handles new arrivals and the occasional refresh.
- **Regions:** change `REGIONS` in the workflow (a region only costs extra
  lookups for titles it doesn't share with the others) and keep the
  "Streaming region" in Settings in step. Other knobs (`MIN_VOTES`,
  `OMDB_BUDGET`) are described at the top of the script.
- The catalogue only contains movies on those three services; use search for
  anything else.

## Setup

1. Get a free OMDb API key: https://www.omdbapi.com/apikey.aspx (check your
   email to activate it).
2. Get a free TMDB API key (the "API Key (v3 auth)" value):
   https://www.themoviedb.org/settings/api
3. Open the deployed app (or `index.html` locally), click the ⚙ settings
   icon, and paste in both keys plus your two-letter country code (e.g.
   `US`) for streaming availability.

## Running locally

This is a static site — no build step. Serve the folder with any static
file server, for example:

```bash
npx serve .
```

Then open the printed local URL in your browser.

## Deploying to GitHub Pages

1. Push this repository to GitHub.
2. In the repo's **Settings → Pages**, set the source to the `main` branch,
   root folder.
3. Your app will be live at `https://<username>.github.io/streamscore/`.

## Android app

`android/` is a minimal native WebView shell that loads the live GitHub
Pages app, so web changes show up without rebuilding the APK. Its WebView
has its own private storage, so the OMDb/TMDB keys, the OMDb cache and the
Seen flags you enter in the app survive closing and reopening it, and are
not wiped when you clear Chrome's browsing data.

- The APK is built and signed by `.github/workflows/android.yml` (on pushes
  that touch `android/`, or manually from the Actions tab) and published as
  a GitHub Release (`apk-1.<run>`). Download the `.apk` from the latest
  release and install it.
- Install new versions over the old one. Uninstalling the app erases the
  saved keys and Seen flags.
- Signing needs two repository secrets, `ANDROID_KEYSTORE_B64` (the PKCS12
  keystore, base64) and `ANDROID_KEYSTORE_PASSWORD`. Keep a backup of the
  keystore: updates can only be installed over an APK signed with the same
  key.
- Links to Metacritic and Rotten Tomatoes open in the phone's browser.

## Notes / limitations

- "Seen" and "Don't want to see" are per-browser, stored only in your
  `localStorage` — they aren't movie data, so they're never sent to OMDb,
  TMDB, or anywhere else, and won't follow you to a different browser or
  device. Clearing your browser's site data for this app clears them too.
- Streaming availability reflects subscription ("flatrate") access only —
  not rentals or purchases.
- OMDb's free tier is limited to 1,000 requests/day. Normal browsing/search
  is well within that, but a single director/actor search can cost ~60
  requests (2 per movie shown), so it's possible to exhaust the daily quota
  with heavy use. When that happens, a banner at the top of the page says
  so explicitly — Metascore/Rotten Tomatoes/synopsis data just won't load
  until the quota resets (about 24 hours) or you switch to a different key.
- Every OMDb lookup is cached in `localStorage` (checked before any network
  request), so browsing the same movies again — including across sessions —
  costs no additional OMDb requests. A title with both a Metascore and a
  Rotten Tomatoes score is cached indefinitely; a title missing either one
  is re-checked after 7 days, in case OMDb has since filled it in.
- Movies are matched between TMDB and OMDb using TMDB's own IMDb id
  (falling back to title + year only if that's unavailable), so mismatches
  are rare.
- OMDb's Metascore data can lag behind Metacritic's live site by days or
  weeks for very recent releases — a title can show "no score yet" here
  even after Metacritic has published one. The app links out to Metacritic
  directly so you can check the current score.
- OMDb's Rotten Tomatoes coverage is separately incomplete — some movies
  (including recent mainstream releases) have a Metascore but no Rotten
  Tomatoes entry in OMDb's own data at all, not just a delay. The app links
  out to Rotten Tomatoes directly for these.
- Director/actor search uses TMDB (OMDb's search only matches on movie
  title), matching the single best-known person for the name you type and
  showing their 30 most popular movie credits (not most recent — a prolific
  career's newest work tends to be small/festival titles Metacritic hasn't
  scored yet, so popularity surfaces the well-known, actually-scored films).
