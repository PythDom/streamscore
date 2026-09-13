// Thin wrappers around the OMDb and TMDB HTTP APIs.
// Both APIs are browser/CORS-friendly, so no backend is needed.

const StreamScoreAPI = (() => {
  const TMDB_BASE = 'https://api.themoviedb.org/3';
  const OMDB_BASE = 'https://www.omdbapi.com/';

  // Display name -> exact TMDB provider_name(s) to match. Exact matching
  // (not substring) matters here: TMDB also lists variants like "Netflix
  // Kids" and "Amazon Prime Video with Ads" that a substring match would
  // wrongly grab instead of the plain subscription service.
  const PROVIDER_MATCH = {
    netflix: ['netflix'],
    prime: ['amazon prime video'],
    disney: ['disney plus'],
  };

  let providerIdCache = null; // { netflix: 8, prime: 119, disney: 337 }

  function getKeys() {
    return {
      omdb: localStorage.getItem('streamscore_omdb_key') || '',
      tmdb: localStorage.getItem('streamscore_tmdb_key') || '',
      region: (localStorage.getItem('streamscore_region') || 'US').toUpperCase(),
    };
  }

  function saveKeys({ omdb, tmdb, region }) {
    localStorage.setItem('streamscore_omdb_key', omdb.trim());
    localStorage.setItem('streamscore_tmdb_key', tmdb.trim());
    localStorage.setItem('streamscore_region', (region || 'US').trim().toUpperCase());
    providerIdCache = null;
  }

  function hasKeys() {
    const { omdb, tmdb } = getKeys();
    return Boolean(omdb && tmdb);
  }

  async function tmdbFetch(path, params = {}) {
    const { tmdb } = getKeys();
    const url = new URL(TMDB_BASE + path);
    url.searchParams.set('api_key', tmdb);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TMDB error ${res.status}`);
    return res.json();
  }

  async function omdbFetch(params = {}) {
    const { omdb } = getKeys();
    const url = new URL(OMDB_BASE);
    url.searchParams.set('apikey', omdb);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OMDb error ${res.status}`);
    return res.json();
  }

  // Resolve TMDB's numeric provider ids for netflix/prime/disney in the
  // user's region, since ids can differ slightly by market.
  async function loadProviderIds() {
    if (providerIdCache) return providerIdCache;
    const { region } = getKeys();
    const data = await tmdbFetch('/watch/providers/movie', {
      watch_region: region,
      language: 'en-US',
    });
    const ids = {};
    for (const [key, needles] of Object.entries(PROVIDER_MATCH)) {
      const match = (data.results || []).find((p) =>
        needles.some((n) => p.provider_name.toLowerCase() === n)
      );
      if (match) ids[key] = match.provider_id;
    }
    providerIdCache = ids;
    return ids;
  }

  // Discover movies available (subscription/flatrate) on the given provider
  // keys ('netflix' | 'prime' | 'disney'), sorted by TMDB popularity.
  async function discoverByProviders(providerKeys, page = 1) {
    const ids = await loadProviderIds();
    const { region } = getKeys();
    const wantedIds = providerKeys.map((k) => ids[k]).filter(Boolean);
    if (wantedIds.length === 0) return { results: [], total_pages: 0 };
    return tmdbFetch('/discover/movie', {
      watch_region: region,
      with_watch_providers: wantedIds.join('|'),
      with_watch_monetization_types: 'flatrate',
      sort_by: 'popularity.desc',
      page,
    });
  }

  async function searchTmdb(query, page = 1) {
    return tmdbFetch('/search/movie', { query, page, include_adult: false });
  }

  // Best-matching person (TMDB sorts by popularity), for director/actor search.
  async function searchPerson(query) {
    const data = await tmdbFetch('/search/person', { query, include_adult: false });
    return (data.results && data.results[0]) || null;
  }

  // { cast, crew } filmography for a person. Used to power director/actor
  // search, since OMDb's search endpoint only matches on movie title.
  async function getPersonMovieCredits(personId) {
    return tmdbFetch(`/person/${personId}/movie_credits`);
  }

  // TMDB's own IMDb id for a movie, when known. Matching OMDb by this exact
  // id is far more reliable than fuzzy title+year matching (subtitles,
  // punctuation, and festival-vs-wide release years all trip up the latter).
  async function getImdbId(tmdbId) {
    const data = await tmdbFetch(`/movie/${tmdbId}/external_ids`);
    return data.imdb_id || null;
  }

  // Which of netflix/prime/disney carry this TMDB movie id, in the user's region.
  async function getStreamingBadges(tmdbId) {
    const ids = await loadProviderIds();
    const data = await tmdbFetch(`/movie/${tmdbId}/watch/providers`);
    const { region } = getKeys();
    const regionData = (data.results || {})[region];
    const flatrate = (regionData && regionData.flatrate) || [];
    const flatrateIds = new Set(flatrate.map((p) => p.provider_id));
    const badges = {};
    for (const key of Object.keys(ids)) {
      badges[key] = flatrateIds.has(ids[key]);
    }
    return { badges, link: regionData && regionData.link };
  }

  // Look up full OMDb details (Metascore, Plot, etc.) by title + year.
  async function omdbLookupByTitle(title, year) {
    const params = { t: title, type: 'movie' };
    if (year) params.y = year;
    const data = await omdbFetch(params);
    return data.Response === 'True' ? data : null;
  }

  async function omdbLookupById(imdbId) {
    const data = await omdbFetch({ i: imdbId, plot: 'full' });
    return data.Response === 'True' ? data : null;
  }

  async function omdbSearch(query, page = 1) {
    const data = await omdbFetch({ s: query, type: 'movie', page });
    return data.Response === 'True' ? data.Search : [];
  }

  function metascoreValue(omdbRecord) {
    const raw = omdbRecord && omdbRecord.Metascore;
    if (!raw || raw === 'N/A') return null;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? null : n;
  }

  function rottenTomatoesValue(omdbRecord) {
    const entry = (omdbRecord && omdbRecord.Ratings) || [];
    const rt = entry.find((r) => r.Source === 'Rotten Tomatoes');
    if (!rt) return null;
    const n = parseInt(rt.Value, 10);
    return Number.isNaN(n) ? null : n;
  }

  function genresOf(omdbRecord) {
    const raw = omdbRecord && omdbRecord.Genre;
    if (!raw || raw === 'N/A') return [];
    return raw.split(',').map((g) => g.trim()).filter(Boolean);
  }

  return {
    getKeys,
    saveKeys,
    hasKeys,
    loadProviderIds,
    discoverByProviders,
    searchTmdb,
    searchPerson,
    getPersonMovieCredits,
    getImdbId,
    getStreamingBadges,
    omdbLookupByTitle,
    omdbLookupById,
    omdbSearch,
    metascoreValue,
    rottenTomatoesValue,
    genresOf,
  };
})();
