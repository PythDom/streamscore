// Builds data/catalog-<REGION>.json: every movie on Netflix / Prime Video / Disney+ in a region, with its
// Metascore, Rotten Tomatoes score and genres, so the app can sort by score across the whole catalogue.
//
// OMDb's free tier allows 1,000 calls/day, so scores are filled in over several daily runs (most-voted titles
// first). Progress is kept in data/scores.json, which is shared by all regions: a movie available in two
// regions is only looked up once.
//
// Env: TMDB_API_KEY, OMDB_API_KEY (required); REGIONS (default "US,BE"); OMDB_BUDGET (default 900);
//      MIN_VOTES (default 100, TMDB vote count below which a title is ignored); OUT_DIR (default "data").
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TMDB_KEY = process.env.TMDB_API_KEY;
const OMDB_KEY = process.env.OMDB_API_KEY;
const REGIONS = (process.env.REGIONS || 'US,BE').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const OMDB_BUDGET = Number(process.env.OMDB_BUDGET || 900);
const MIN_VOTES = Number(process.env.MIN_VOTES || 100);
const OUT_DIR = process.env.OUT_DIR || 'data';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const MAX_PAGES = 500; // TMDB discover never goes past page 500
const DAY_MS = 24 * 60 * 60 * 1000;
const RECHECK_INCOMPLETE_DAYS = 14; // a score can appear later (OMDb lags Metacritic / Rotten Tomatoes)
const RECHECK_COMPLETE_DAYS = 120;
const TODAY = new Date().toISOString().slice(0, 10);

// Same exact-name matching as the app: TMDB also lists "Netflix Kids", "... with Ads", etc.
const PROVIDER_NAMES = { netflix: 'netflix', prime: 'amazon prime video', disney: 'disney plus' };
const SERVICE_ORDER = ['netflix', 'prime', 'disney'];

class QuotaError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const redact = (text) => String(text).replace(/(api_?key=)[^&\s]+/gi, '$1***');

async function fetchWithRetry(url, { retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      if (attempt >= retries) throw new Error(`network error: ${redact(err.message)}`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(Number(res.headers.get('retry-after')) * 1000 || 1000 * 2 ** attempt);
      continue;
    }
    return res;
  }
}

async function tmdb(pathname, params = {}) {
  const url = new URL(TMDB_BASE + pathname);
  url.searchParams.set('api_key', TMDB_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`TMDB ${pathname} failed with HTTP ${res.status}`);
  return res.json();
}

async function omdbById(imdbId) {
  const url = new URL('https://www.omdbapi.com/');
  url.searchParams.set('apikey', OMDB_KEY);
  url.searchParams.set('i', imdbId);
  const res = await fetchWithRetry(url);
  let data = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON body; handled below
  }
  if (data && data.Error === 'Request limit reached!') throw new QuotaError('OMDb daily limit reached');
  if (!res.ok) throw new Error(`OMDb failed with HTTP ${res.status}${data && data.Error ? ` (${data.Error})` : ''}`);
  return data;
}

async function pool(items, size, task) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await task(items[next++]);
  });
  await Promise.all(workers);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// ---- 1. Who streams what, per region (TMDB discover, most-voted first) -----------------------------------

async function providerIds(region) {
  const data = await tmdb('/watch/providers/movie', { watch_region: region, language: 'en-US' });
  const ids = {};
  for (const [key, name] of Object.entries(PROVIDER_NAMES)) {
    const match = (data.results || []).find((p) => p.provider_name.toLowerCase() === name);
    if (match) ids[key] = match.provider_id;
  }
  return ids;
}

async function crawlRegion(region) {
  const ids = await providerIds(region);
  const movies = new Map(); // tmdb id -> { id, t, y, p, v, s:Set }
  for (const [service, providerId] of Object.entries(ids)) {
    let count = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await tmdb('/discover/movie', {
        watch_region: region,
        with_watch_providers: providerId,
        with_watch_monetization_types: 'flatrate',
        'vote_count.gte': MIN_VOTES,
        sort_by: 'vote_count.desc',
        include_adult: 'false',
        page,
      });
      for (const m of data.results || []) {
        let entry = movies.get(m.id);
        if (!entry) {
          entry = { id: m.id, t: m.title, y: Number((m.release_date || '').slice(0, 4)) || undefined, p: m.poster_path || undefined, v: m.vote_count || 0, s: new Set() };
          movies.set(m.id, entry);
        }
        entry.s.add(service);
        count++;
      }
      if (page >= (data.total_pages || 1)) break;
    }
    console.log(`${region} ${service}: ${count} titles`);
  }
  if (Object.keys(ids).length === 0) console.log(`${region}: none of the three services found`);
  return movies;
}

// ---- 2. Scores (OMDb), shared across regions --------------------------------------------------------------

function parseOmdb(data) {
  if (!data || data.Response !== 'True') return { m: null, r: null, g: [] };
  const metascore = parseInt(data.Metascore, 10);
  const rt = (data.Ratings || []).find((x) => x.Source === 'Rotten Tomatoes');
  const rtScore = rt ? parseInt(rt.Value, 10) : NaN;
  const genres = data.Genre && data.Genre !== 'N/A' ? data.Genre.split(',').map((g) => g.trim()).filter(Boolean) : [];
  return { m: Number.isNaN(metascore) ? null : metascore, r: Number.isNaN(rtScore) ? null : rtScore, g: genres };
}

// 0 = never checked, 1 = incomplete and due for another look, 2 = complete but old, -1 = up to date.
function checkTier(entry) {
  if (!entry || !entry.c) return 0;
  const age = (Date.now() - Date.parse(entry.c)) / DAY_MS;
  const complete = entry.m != null && entry.r != null;
  if (!complete && age >= RECHECK_INCOMPLETE_DAYS) return 1;
  if (complete && age >= RECHECK_COMPLETE_DAYS) return 2;
  return -1;
}

async function externalImdbId(tmdbId) {
  const data = await tmdb(`/movie/${tmdbId}/external_ids`);
  return data.imdb_id || null;
}

async function fillScores(allMovies, scores) {
  // IMDb ids for everything first (TMDB has no daily quota), so entries keep a stable id in the app.
  const missingIds = allMovies.filter((m) => !scores[m.id] || scores[m.id].i === undefined);
  if (missingIds.length) console.log(`Resolving IMDb ids for ${missingIds.length} titles...`);
  await pool(missingIds, 8, async (m) => {
    scores[m.id] = { ...(scores[m.id] || {}), i: await externalImdbId(m.id) };
  });

  const due = allMovies
    .map((m) => ({ m, tier: checkTier(scores[m.id]) }))
    .filter((x) => x.tier >= 0)
    .sort((a, b) => a.tier - b.tier || b.m.v - a.m.v);
  console.log(`${due.length} titles due for an OMDb check (budget ${OMDB_BUDGET})`);

  let calls = 0;
  let quotaHit = false;
  await pool(due, 4, async ({ m }) => {
    if (quotaHit || calls >= OMDB_BUDGET) return;
    const entry = scores[m.id];
    if (!entry.i) {
      entry.c = TODAY; // no IMDb id to look up; try again after the recheck delay
      return;
    }
    calls++;
    try {
      const parsed = parseOmdb(await omdbById(entry.i));
      // Keep a previously known score if OMDb stops returning it.
      scores[m.id] = { i: entry.i, m: parsed.m ?? entry.m ?? null, r: parsed.r ?? entry.r ?? null, g: parsed.g.length ? parsed.g : entry.g || [], c: TODAY };
    } catch (err) {
      if (err instanceof QuotaError) {
        quotaHit = true;
        return;
      }
      throw err;
    }
  });
  console.log(`OMDb calls: ${calls}${quotaHit ? ' (daily limit reached, resuming next run)' : ''}`);
}

// ---- 3. Output (one movie per line, so daily diffs stay small) --------------------------------------------

function compact(obj) {
  return JSON.stringify(Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null)));
}

async function writeIfChanged(file, text) {
  let existing = null;
  try {
    existing = await readFile(file, 'utf8');
  } catch {
    // first write
  }
  if (existing === text) return false;
  await writeFile(file, text);
  return true;
}

function scoresFileText(scores) {
  const ids = Object.keys(scores).map(Number).sort((a, b) => a - b);
  const lines = ids.map((id) => `"${id}":${compact(scores[id])}`);
  return `{"version":1,"movies":{\n${lines.join(',\n')}\n}}\n`;
}

async function catalogFileText(region, movies, scores, previousText) {
  const list = [...movies.values()].sort((a, b) => a.id - b.id).map((m) => {
    const s = scores[m.id] || {};
    return { id: m.id, i: s.i || undefined, t: m.t, y: m.y, p: m.p, s: SERVICE_ORDER.filter((k) => m.s.has(k)), v: m.v, m: s.m, r: s.r, g: s.g && s.g.length ? s.g : undefined, c: s.c };
  });
  const checked = list.filter((m) => m.c).length;
  const body = `"total":${list.length},"checked":${checked},"movies":[\n${list.map(compact).join(',\n')}\n]}\n`;
  // generatedAt only moves when something else changed, so unchanged days produce no commit.
  const previousBody = previousText ? previousText.slice(previousText.indexOf('"total"')) : null;
  const previousDate = previousText && (previousText.match(/"generatedAt":"([^"]+)"/) || [])[1];
  const generatedAt = previousBody === body && previousDate ? previousDate : TODAY;
  return `{"version":1,"region":"${region}","generatedAt":"${generatedAt}",${body}`;
}

// ---- main -------------------------------------------------------------------------------------------------

async function main() {
  if (!TMDB_KEY || !OMDB_KEY) throw new Error('TMDB_API_KEY and OMDB_API_KEY are required');
  await mkdir(OUT_DIR, { recursive: true });
  const scoresFile = path.join(OUT_DIR, 'scores.json');
  const scores = (await readJson(scoresFile, { movies: {} })).movies || {};

  const perRegion = {};
  for (const region of REGIONS) perRegion[region] = await crawlRegion(region);

  // Sanity check: a partial TMDB answer must not wipe a good catalogue.
  for (const region of REGIONS) {
    const old = await readJson(path.join(OUT_DIR, `catalog-${region}.json`), null);
    if (old && old.total > 100 && perRegion[region].size < old.total * 0.5) {
      throw new Error(`${region}: only ${perRegion[region].size} titles found (previously ${old.total}); refusing to overwrite`);
    }
  }

  const all = new Map();
  for (const movies of Object.values(perRegion)) {
    for (const m of movies.values()) {
      const seen = all.get(m.id);
      if (!seen || m.v > seen.v) all.set(m.id, { id: m.id, v: m.v });
    }
  }
  try {
    await fillScores([...all.values()], scores);
  } finally {
    // Always keep the progress made so far, even if a lookup failed midway.
    if (await writeIfChanged(scoresFile, scoresFileText(scores))) console.log('scores.json updated');
  }

  for (const region of REGIONS) {
    const file = path.join(OUT_DIR, `catalog-${region}.json`);
    let previous = null;
    try {
      previous = await readFile(file, 'utf8');
    } catch {
      // first build
    }
    const text = await catalogFileText(region, perRegion[region], scores, previous);
    const changed = await writeIfChanged(file, text);
    const header = JSON.parse(text);
    console.log(`${region}: ${header.total} titles, scores checked for ${header.checked}${changed ? ' (file updated)' : ' (unchanged)'}`);
  }
}

main().catch((err) => {
  console.error(redact(err.stack || err.message));
  process.exit(1);
});
