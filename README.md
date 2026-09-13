# StreamScore

Search movies — by title, director, or actor — browse what's streaming on
Netflix / Amazon Prime Video / Disney+, and sort everything by Metacritic's
Metascore or its average with Rotten Tomatoes — all from a static page with
no backend server. Also lets you filter by genre or hide anything not
currently on your selected services.

## How it works

Metacritic has no public API, so this app doesn't scrape metacritic.com
directly. Instead it combines two free, browser-friendly APIs:

- **[OMDb API](https://www.omdbapi.com/)** — provides the Metascore and a
  synopsis for a given title (OMDb aggregates Metacritic's score).
- **[TMDB API](https://www.themoviedb.org/documentation/api)** — provides the
  "browse by streaming service" list and, per movie, which services
  (Netflix / Prime Video / Disney+) currently carry it in your region. This
  data comes from JustWatch via TMDB.

Each movie card also links out to Metacritic's own search page for that
title, in case you want to read Metacritic's original write-up.

Both APIs are called directly from the browser (no server component), and
your API keys are stored only in your browser's `localStorage`.

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

## Notes / limitations

- Streaming availability reflects subscription ("flatrate") access only —
  not rentals or purchases.
- OMDb's free tier is limited to 1,000 requests/day. Normal browsing/search
  is well within that, but a single director/actor search can cost ~60
  requests (2 per movie shown), so it's possible to exhaust the daily quota
  with heavy use. When that happens, a banner at the top of the page says
  so explicitly — Metascore/Rotten Tomatoes/synopsis data just won't load
  until the quota resets (about 24 hours) or you switch to a different key.
- Movies are matched between TMDB and OMDb using TMDB's own IMDb id
  (falling back to title + year only if that's unavailable), so mismatches
  are rare.
- OMDb's Metascore data can lag behind Metacritic's live site by days or
  weeks for very recent releases — a title can show "no score yet" here
  even after Metacritic has published one. The app links out to Metacritic
  directly so you can check the current score.
- Director/actor search uses TMDB (OMDb's search only matches on movie
  title), matching the single best-known person for the name you type and
  showing their 30 most popular movie credits (not most recent — a prolific
  career's newest work tends to be small/festival titles Metacritic hasn't
  scored yet, so popularity surfaces the well-known, actually-scored films).
