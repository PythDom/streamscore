(() => {
  const els = {
    searchInput: document.getElementById('search-input'),
    searchType: document.getElementById('search-type'),
    searchClear: document.getElementById('search-clear'),
    settingsBtn: document.getElementById('settings-btn'),
    settingsModal: document.getElementById('settings-modal'),
    omdbKeyInput: document.getElementById('omdb-key-input'),
    tmdbKeyInput: document.getElementById('tmdb-key-input'),
    regionInput: document.getElementById('region-input'),
    saveSettings: document.getElementById('save-settings'),
    providerFilters: document.getElementById('provider-filters'),
    hideUnavailable: document.getElementById('hide-unavailable'),
    hideSeen: document.getElementById('hide-seen'),
    hideSkip: document.getElementById('hide-skip'),
    onlyRt: document.getElementById('only-rt'),
    onlyMeta: document.getElementById('only-meta'),
    genreSelect: document.getElementById('genre-select'),
    durationSelect: document.getElementById('duration-select'),
    companyInput: document.getElementById('company-input'),
    companyList: document.getElementById('company-list'),
    sortSelect: document.getElementById('sort-select'),
    results: document.getElementById('results'),
    status: document.getElementById('status'),
    quotaBanner: document.getElementById('quota-banner'),
    catalogInfo: document.getElementById('catalog-info'),
    loadMore: document.getElementById('load-more'),
    detailModal: document.getElementById('detail-modal'),
    detailContent: document.getElementById('detail-content'),
  };

  const state = {
    mode: 'browse', // 'browse' | 'search'
    searchType: 'title', // 'title' | 'director' | 'actor'
    query: '',
    page: 1,
    totalPages: 1,
    movies: [], // normalized movie objects currently rendered
    requestSeq: 0, // bumped on every loadPage call; guards against stale responses
    omdbQuotaExceeded: false,
    catalog: null, // pre-built catalogue for the region (see scripts/build-catalog.mjs), or null
    catalogMeta: null,
    shown: 0, // how many catalogue cards are currently revealed
  };

  const CATALOG_PAGE_SIZE = 48;
  const POSTER_BASE = 'https://image.tmdb.org/t/p/w342';
  const SERVICE_KEYS = ['netflix', 'prime', 'disney'];

  let searchDebounce = null;

  // Static list matching OMDb/IMDb's genre vocabulary (the source of
  // movie.genres), rather than deriving options from whatever happens to be
  // loaded, so the dropdown doesn't reshuffle as you browse.
  const GENRE_OPTIONS = [
    'Action', 'Adventure', 'Animation', 'Biography', 'Comedy', 'Crime',
    'Documentary', 'Drama', 'Family', 'Fantasy', 'History', 'Horror',
    'Music', 'Musical', 'Mystery', 'Romance', 'Sci-Fi', 'Sport',
    'Thriller', 'War', 'Western',
  ];

  function populateGenreOptions() {
    for (const genre of GENRE_OPTIONS) {
      const option = document.createElement('option');
      option.value = genre;
      option.textContent = genre;
      els.genreSelect.appendChild(option);
    }
  }

  // ---- Normalization -------------------------------------------------

  function normalizeFromTmdb(tmdbMovie) {
    return {
      id: `tmdb-${tmdbMovie.id}`,
      tmdbId: tmdbMovie.id,
      title: tmdbMovie.title,
      year: (tmdbMovie.release_date || '').slice(0, 4),
      poster: tmdbMovie.poster_path
        ? `https://image.tmdb.org/t/p/w342${tmdbMovie.poster_path}`
        : null,
      overview: tmdbMovie.overview,
      metascore: null,
      rtScore: null,
      genres: [],
      runtime: null,
      companies: [],
      plot: null,
      badges: null,
    };
  }

  function normalizeFromOmdbSearch(item) {
    return {
      id: `omdb-${item.imdbID}`,
      tmdbId: null,
      imdbId: item.imdbID,
      title: item.Title,
      year: (item.Year || '').slice(0, 4),
      poster: item.Poster && item.Poster !== 'N/A' ? item.Poster : null,
      overview: null,
      metascore: null,
      rtScore: null,
      genres: [],
      runtime: null,
      companies: [],
      plot: null,
      badges: null,
    };
  }

  // Catalogue entries already carry scores, genres, services, runtime and companies (as indexes into the
  // file's list of company names), so they need no per-movie requests.
  function normalizeFromCatalog(c, companyNames) {
    const services = c.s || [];
    return {
      id: `tmdb-${c.id}`,
      tmdbId: c.id,
      imdbId: c.i || undefined,
      title: c.t,
      year: c.y ? String(c.y) : '',
      poster: c.p ? POSTER_BASE + c.p : null,
      overview: null,
      metascore: c.m ?? null,
      rtScore: c.r ?? null,
      genres: c.g || [],
      runtime: c.d ?? null,
      companies: (c.k || []).map((i) => companyNames[i]).filter(Boolean),
      plot: null,
      badges: Object.fromEntries(SERVICE_KEYS.map((k) => [k, services.includes(k)])),
    };
  }

  // ---- Enrichment ------------------------------------------------------

  async function enrichMetascore(movie) {
    try {
      // Prefer an exact IMDb-id match (via TMDB's own external_ids) over
      // fuzzy title+year matching, which trips up on subtitle differences,
      // punctuation, and festival-vs-wide-release year mismatches.
      if (!movie.imdbId && movie.tmdbId) {
        movie.imdbId = await StreamScoreAPI.getImdbId(movie.tmdbId);
      }
      const record = movie.imdbId
        ? await StreamScoreAPI.omdbLookupById(movie.imdbId)
        : await StreamScoreAPI.omdbLookupByTitle(movie.title, movie.year);
      if (record) {
        movie.metascore = StreamScoreAPI.metascoreValue(record);
        movie.rtScore = StreamScoreAPI.rottenTomatoesValue(record);
        movie.genres = StreamScoreAPI.genresOf(record);
        movie.runtime = movie.runtime ?? StreamScoreAPI.runtimeOf(record); // TMDB's value wins when we have it
        movie.plot = record.Plot && record.Plot !== 'N/A' ? record.Plot : movie.overview;
        movie.imdbId = movie.imdbId || record.imdbID;
        if (!movie.poster && record.Poster && record.Poster !== 'N/A') {
          movie.poster = record.Poster;
        }
      }
    } catch (e) {
      if (e && e.code === 'OMDB_QUOTA') state.omdbQuotaExceeded = true;
      // Leave metascore as null; card still renders without it.
    }
    return movie;
  }

  async function enrichStreamingBadges(movie) {
    if (!movie.tmdbId) {
      // Resolve a TMDB id by title so we can check streaming providers.
      try {
        const res = await StreamScoreAPI.searchTmdb(movie.title, 1);
        const match = (res.results || []).find(
          (r) => (r.release_date || '').slice(0, 4) === movie.year
        ) || (res.results || [])[0];
        if (match) movie.tmdbId = match.id;
      } catch (e) {
        // ignore
      }
    }
    if (movie.tmdbId) {
      try {
        const { badges, link } = await StreamScoreAPI.getStreamingBadges(movie.tmdbId);
        movie.badges = badges;
        movie.watchLink = link;
      } catch (e) {
        movie.badges = {};
      }
    } else {
      movie.badges = {};
    }
    return movie;
  }

  // Runtime and production companies from TMDB. For movies that came from TMDB this is the same call that
  // already supplied the IMDb id (cached), so it costs nothing extra.
  async function enrichDetails(movie) {
    if (!movie.tmdbId) return movie;
    try {
      const details = await StreamScoreAPI.getTmdbDetails(movie.tmdbId);
      if (details.runtime > 0) movie.runtime = details.runtime;
      movie.companies = (details.production_companies || []).map((c) => c.name).filter(Boolean);
    } catch (e) {
      // The filters just won't match this movie.
    }
    return movie;
  }

  // ---- Fetch orchestration ---------------------------------------------

  // Only the netflix/prime/disney checkboxes carry a value attribute; the
  // other chips in the same container (hide/only filters) must not count.
  function selectedProviders() {
    return Array.from(
      els.providerFilters.querySelectorAll('input[type=checkbox][value]:checked')
    ).map((cb) => cb.value);
  }

  function ratedOnlyActive() {
    return els.onlyRt.checked || els.onlyMeta.checked;
  }

  async function fetchBrowsePage(page) {
    const providers = selectedProviders();
    let data;
    if (providers.length > 0) {
      data = await StreamScoreAPI.discoverByProviders(providers, page);
    } else if (ratedOnlyActive()) {
      // No service ticked: don't restrict by service at all.
      data = await StreamScoreAPI.discoverMostVoted(page);
    } else {
      return { movies: [], totalPages: 0 };
    }
    const movies = (data.results || []).map(normalizeFromTmdb);
    await Promise.all(movies.map(enrichMetascore));
    await Promise.all(movies.map(enrichStreamingBadges));
    await Promise.all(movies.map(enrichDetails));
    return { movies, totalPages: data.total_pages || 1 };
  }

  async function fetchSearchPage(query, page) {
    const results = await StreamScoreAPI.omdbSearch(query, page);
    const movies = results.map(normalizeFromOmdbSearch);
    await Promise.all(movies.map(enrichMetascore));
    await Promise.all(movies.map(enrichStreamingBadges));
    await Promise.all(movies.map(enrichDetails));
    return { movies, totalPages: movies.length > 0 ? page + 1 : page };
  }

  // OMDb's search only matches on movie title, so director/actor search goes
  // through TMDB instead: find the person, then pull their filmography.
  // Credits come back in one shot (no pagination), so this is always a
  // single "page". Capped at the 30 most popular titles: each one costs ~2
  // OMDb calls to enrich, and OMDb's free tier only allows 1,000/day —
  // a prolific actor's full credit list would burn a big chunk of that in
  // one search.
  async function fetchPersonMovies(query, type) {
    const person = await StreamScoreAPI.searchPerson(query);
    if (!person) return { movies: [], totalPages: 0 };

    const credits = await StreamScoreAPI.getPersonMovieCredits(person.id);
    const rawList =
      type === 'director'
        ? (credits.crew || []).filter((c) => c.job === 'Director')
        : credits.cast || [];

    const seen = new Set();
    const deduped = rawList.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
    // Sort by TMDB popularity, not recency: a prolific career's most recent
    // credits skew toward small/festival/upcoming titles that Metacritic
    // hasn't scored, while popularity surfaces the well-known work that
    // actually has Metascore/Rotten Tomatoes coverage.
    deduped.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));

    const movies = deduped.slice(0, 30).map(normalizeFromTmdb);
    await Promise.all(movies.map(enrichMetascore));
    await Promise.all(movies.map(enrichStreamingBadges));
    await Promise.all(movies.map(enrichDetails));
    return { movies, totalPages: 1 };
  }

  async function loadPage({ append = false } = {}) {
    // A generation counter, not a busy-flag: if the user changes the search
    // (type, text, or provider filters) while a fetch is still in flight,
    // that older fetch's results are discarded when it resolves instead of
    // blocking the newer request from starting.
    const requestId = ++state.requestSeq;
    state.omdbQuotaExceeded = false;
    setStatus(append ? 'Loading more…' : 'Loading…');
    els.loadMore.hidden = true;
    try {
      let movies, totalPages;
      if (state.mode === 'search' && state.searchType === 'title') {
        ({ movies, totalPages } = await fetchSearchPage(state.query, state.page));
      } else if (state.mode === 'search') {
        ({ movies, totalPages } = await fetchPersonMovies(state.query, state.searchType));
      } else {
        ({ movies, totalPages } = await fetchBrowsePage(state.page));
      }

      if (requestId !== state.requestSeq) return; // superseded by a newer request

      state.totalPages = totalPages;
      state.movies = append ? state.movies.concat(movies) : movies;

      renderList(); // may itself call setStatus() for the "no matches" case

      if (state.movies.length === 0) {
        const personLabel = state.searchType === 'director' ? 'director' : 'actor';
        setStatus(
          state.mode !== 'search'
            ? 'Select a streaming service, or turn on an "Only rated on…" filter, to browse movies.'
            : state.searchType === 'title'
              ? `No results for "${state.query}".`
              : `No ${personLabel} found matching "${state.query}".`
        );
      }
      updateQuotaBanner();
      els.loadMore.hidden = state.page >= state.totalPages;
    } catch (err) {
      if (requestId !== state.requestSeq) return; // superseded; ignore its error too
      console.error(err);
      setStatus(errorMessage(err));
    }
  }

  function errorMessage(err) {
    const msg = String((err && err.message) || err);
    if (msg.includes('401') || msg.includes('403')) {
      return 'One of your API keys was rejected. Check Settings (⚙) and re-enter it.';
    }
    return `Something went wrong: ${msg}`;
  }

  function setStatus(msg) {
    els.status.textContent = msg;
    els.status.hidden = !msg;
  }

  function updateQuotaBanner() {
    if (state.omdbQuotaExceeded) {
      els.quotaBanner.textContent =
        "OMDb's free daily limit (1,000 requests) has been reached, so Metascores, Rotten Tomatoes scores, and synopses can't load right now — that's why titles below are missing scores even if they're well-known. It resets in 24 hours, or you can switch to a different OMDb key in Settings (⚙).";
      els.quotaBanner.hidden = false;
    } else {
      els.quotaBanner.hidden = true;
    }
  }

  // ---- Rendering ---------------------------------------------------------

  function metascoreClass(score) {
    if (score == null) return 'ms-none';
    if (score >= 61) return 'ms-good';
    if (score >= 40) return 'ms-mixed';
    return 'ms-bad';
  }

  function rtClass(score) {
    if (score == null) return 'rt-none';
    return score >= 60 ? 'rt-fresh' : 'rt-rotten';
  }

  // Mean of whichever of Metascore/Rotten Tomatoes are available; null if
  // neither is (e.g. an unreleased title with no critic scores at all).
  function avgScore(movie) {
    const scores = [movie.metascore, movie.rtScore].filter((s) => s != null);
    if (scores.length === 0) return null;
    return scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  // Stable per-movie key for the local "Seen" / "Don't want to see" flags —
  // imdbId when we have it (true unique identifier), else the synthetic
  // source-specific id assigned at normalization time.
  function movieKey(movie) {
    return movie.imdbId || movie.id;
  }

  // True while the list on screen is the pre-built catalogue (browsing, not searching).
  function isCatalogMode() {
    return state.mode === 'browse' && state.catalog !== null && state.movies === state.catalog;
  }

  // Everything that doesn't depend on the movie is read once per render, not once per movie
  // (the catalogue holds thousands of entries).
  function filterContext() {
    return {
      selected: selectedProviders(),
      catalogMode: isCatalogMode(),
      hideUnavailable: els.hideUnavailable.checked,
      genre: els.genreSelect.value,
      hideSeen: els.hideSeen.checked,
      hideSkip: els.hideSkip.checked,
      onlyRt: els.onlyRt.checked,
      onlyMeta: els.onlyMeta.checked,
      maxRuntime: Number(els.durationSelect.value) || 0,
      company: els.companyInput.value.trim().toLowerCase(),
      flags: els.hideSeen.checked || els.hideSkip.checked ? StreamScoreAPI.getAllFlags() : null,
    };
  }

  function passesFilters(movie, ctx) {
    // With no service ticked there is no service restriction to apply. In catalogue mode the ticked
    // services themselves are the restriction; in live mode they were already applied by the fetch.
    if (ctx.selected.length > 0 && (ctx.catalogMode || ctx.hideUnavailable)) {
      const onSelected = movie.badges && ctx.selected.some((key) => movie.badges[key]);
      if (!onSelected) return false;
    }
    if (ctx.genre && !(movie.genres || []).includes(ctx.genre)) return false;
    // A movie whose length or company is unknown can't satisfy a filter on it.
    if (ctx.maxRuntime && !(movie.runtime > 0 && movie.runtime <= ctx.maxRuntime)) return false;
    if (ctx.company && !(movie.companies || []).some((name) => name.toLowerCase().includes(ctx.company))) return false;
    if (ctx.flags) {
      const f = ctx.flags[movieKey(movie)] || {};
      if (ctx.hideSeen && f.seen) return false;
      if (ctx.hideSkip && f.skip) return false;
    }
    if (ctx.onlyRt && movie.rtScore == null) return false;
    if (ctx.onlyMeta && movie.metascore == null) return false;
    return true;
  }

  // Higher/lower score first; titles without a score always go last, and ties fall back to the other
  // score, then the title, so the order is stable (many titles share a score).
  function byScore(get, dir) {
    return (a, b) => {
      const x = get(a);
      const y = get(b);
      if ((x == null) !== (y == null)) return x == null ? 1 : -1;
      if (x != null && x !== y) return dir * (x - y);
      return (avgScore(b) ?? -1) - (avgScore(a) ?? -1) || a.title.localeCompare(b.title);
    };
  }

  const COMPARATORS = {
    'metascore-desc': byScore((m) => m.metascore, -1),
    'metascore-asc': byScore((m) => m.metascore, 1),
    'rtscore-desc': byScore((m) => m.rtScore, -1),
    'rtscore-asc': byScore((m) => m.rtScore, 1),
    'avg-desc': byScore(avgScore, -1),
    'avg-asc': byScore(avgScore, 1),
    'title-asc': (a, b) => a.title.localeCompare(b.title),
    'year-desc': (a, b) => (b.year || '0') - (a.year || '0') || a.title.localeCompare(b.title),
  };

  function visibleMovies() {
    const ctx = filterContext();
    const list = state.movies.filter((m) => passesFilters(m, ctx));
    return list.sort(COMPARATORS[els.sortSelect.value] || COMPARATORS['metascore-desc']);
  }

  function badgeLabel(key) {
    return { netflix: 'Netflix', prime: 'Prime Video', disney: 'Disney+' }[key] || key;
  }

  // Catalogue mode reveals the (already globally sorted) list CATALOG_PAGE_SIZE cards at a time; any
  // change of sort or filter goes back to the top, except when keepShown is set (Load more, Seen toggles).
  function renderList({ keepShown = false } = {}) {
    const catalogMode = isCatalogMode();
    if (catalogMode && !keepShown) state.shown = CATALOG_PAGE_SIZE;
    const all = visibleMovies();
    const list = catalogMode ? all.slice(0, state.shown) : all;
    els.results.innerHTML = '';
    for (const movie of list) {
      els.results.appendChild(renderCard(movie));
    }
    if (all.length === 0 && state.movies.length > 0) {
      setStatus('No movies match the current filters.');
    } else if (state.movies.length > 0) {
      setStatus('');
    }
    if (catalogMode) els.loadMore.hidden = all.length <= state.shown;
    updateCatalogInfo(all.length);
  }

  function updateCatalogInfo(matching) {
    if (!isCatalogMode()) {
      els.catalogInfo.hidden = true;
      return;
    }
    const meta = state.catalogMeta;
    const parts = [`Catalogue ${meta.region}: ${matching} of ${meta.total} movies match`];
    if (meta.checked < meta.total) {
      parts.push(`scores checked for ${meta.checked} of ${meta.total}, filling in daily`);
    }
    if (meta.generatedAt) parts.push(`updated ${meta.generatedAt}`);
    els.catalogInfo.textContent = parts.join(' · ');
    els.catalogInfo.hidden = false;
  }

  function renderCard(movie) {
    const card = document.createElement('article');
    card.className = 'card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `${movie.title} details`);

    const activeBadges = movie.badges
      ? Object.entries(movie.badges)
          .filter(([, on]) => on)
          .map(([key]) => `<span class="badge badge-${key}">${badgeLabel(key)}</span>`)
          .join('')
      : '';

    const key = movieKey(movie);
    const flags = StreamScoreAPI.getMovieFlags(key);
    if (flags.seen) card.classList.add('is-seen');
    if (flags.skip) card.classList.add('is-skip');

    card.innerHTML = `
      <div class="poster-wrap">
        ${
          movie.poster
            ? `<img class="poster" src="${movie.poster}" alt="${escapeHtml(movie.title)} poster" loading="lazy" />`
            : `<div class="poster poster-placeholder">${escapeHtml(movie.title)}</div>`
        }
        <div class="score-stack">
          <span class="metascore ${metascoreClass(movie.metascore)}" title="${
      movie.metascore == null ? 'No Metascore available here yet' : 'Metascore'
    }">${movie.metascore ?? '–'}</span>
          ${
            movie.rtScore != null
              ? `<span class="rtscore ${rtClass(movie.rtScore)}" title="Rotten Tomatoes">🍅 ${movie.rtScore}%</span>`
              : ''
          }
        </div>
      </div>
      <div class="card-body">
        <h3 class="card-title">${escapeHtml(movie.title)}</h3>
        <div class="card-year">${escapeHtml(movie.year || '')}</div>
        <div class="badge-row">${activeBadges}</div>
        <div class="card-actions">
          <label class="flag-toggle flag-seen">
            <input type="checkbox" class="seen-checkbox" ${flags.seen ? 'checked' : ''} /> Seen
          </label>
          <label class="flag-toggle flag-skip">
            <input type="checkbox" class="skip-checkbox" ${flags.skip ? 'checked' : ''} /> Don't want to see
          </label>
        </div>
      </div>
    `;
    card.querySelector('.card-actions').addEventListener('click', (e) => e.stopPropagation());
    card.querySelector('.seen-checkbox').addEventListener('change', (e) => {
      StreamScoreAPI.setMovieFlag(key, 'seen', e.target.checked);
      renderList({ keepShown: true });
    });
    card.querySelector('.skip-checkbox').addEventListener('change', (e) => {
      StreamScoreAPI.setMovieFlag(key, 'skip', e.target.checked);
      renderList({ keepShown: true });
    });
    card.addEventListener('click', () => openDetail(movie));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') openDetail(movie);
    });
    return card;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  async function openDetail(movie) {
    els.detailModal.hidden = false;
    els.detailContent.innerHTML = '<p class="hint">Loading…</p>';

    // Fetch a full plot/synopsis if we don't already have one.
    if (!movie.plot) await enrichMetascore(movie);
    if (!movie.badges) await enrichStreamingBadges(movie);

    const metacriticUrl = `https://www.metacritic.com/search/${encodeURIComponent(
      movie.title
    )}/`;
    const rottenTomatoesUrl = `https://www.rottentomatoes.com/search?search=${encodeURIComponent(
      movie.title
    )}`;

    const activeBadges = movie.badges
      ? Object.entries(movie.badges)
          .filter(([, on]) => on)
          .map(([key]) => `<span class="badge badge-${key}">${badgeLabel(key)}</span>`)
          .join('')
      : '';

    const detailKey = movieKey(movie);
    const detailFlags = StreamScoreAPI.getMovieFlags(detailKey);

    els.detailContent.innerHTML = `
      <div class="detail-layout">
        ${
          movie.poster
            ? `<img class="detail-poster" src="${movie.poster}" alt="${escapeHtml(movie.title)} poster" />`
            : ''
        }
        <div class="detail-info">
          <h2>${escapeHtml(movie.title)} <span class="detail-year">(${escapeHtml(
      movie.year || ''
    )})</span></h2>
          <div class="card-actions detail-actions">
            <label class="flag-toggle flag-seen">
              <input type="checkbox" id="detail-seen-checkbox" ${detailFlags.seen ? 'checked' : ''} /> Seen
            </label>
            <label class="flag-toggle flag-skip">
              <input type="checkbox" id="detail-skip-checkbox" ${detailFlags.skip ? 'checked' : ''} /> Don't want to see
            </label>
          </div>
          <div class="score-row">
            <span class="metascore metascore-lg ${metascoreClass(movie.metascore)}">${
      movie.metascore ?? '–'
    }</span>
            ${
              movie.rtScore != null
                ? `<span class="rtscore rtscore-lg ${rtClass(movie.rtScore)}" title="Rotten Tomatoes">🍅 ${movie.rtScore}%</span>`
                : ''
            }
          </div>
          ${
            movie.metascore == null
              ? `<p class="hint">No Metascore available here yet — often because it's a very recent release and OMDb (our data source) hasn't synced Metacritic's latest score. <a href="${metacriticUrl}" target="_blank" rel="noopener">Check Metacritic directly</a> for the current score.</p>`
              : ''
          }
          ${
            movie.rtScore == null
              ? `<p class="hint">No Rotten Tomatoes score available here yet. <a href="${rottenTomatoesUrl}" target="_blank" rel="noopener">Check Rotten Tomatoes directly</a> for the current score.</p>`
              : ''
          }
          ${
            movie.genres && movie.genres.length
              ? `<div class="genre-row">${movie.genres
                  .map((g) => `<span class="genre-tag">${escapeHtml(g)}</span>`)
                  .join('')}</div>`
              : ''
          }
          ${
            movie.runtime || (movie.companies && movie.companies.length)
              ? `<p class="meta-line">${[movie.runtime ? `${movie.runtime} min` : '', (movie.companies || []).join(', ')]
                  .filter(Boolean)
                  .map(escapeHtml)
                  .join(' · ')}</p>`
              : ''
          }
          <p class="synopsis">${escapeHtml(movie.plot || movie.overview || 'No synopsis available.')}</p>
          <div class="badge-row">${
            activeBadges || '<span class="hint">Not currently streaming on Netflix, Prime Video, or Disney+ in your region.</span>'
          }</div>
          <div class="external-links">
            <a class="metacritic-link" href="${metacriticUrl}" target="_blank" rel="noopener">View on Metacritic →</a>
            <a class="metacritic-link" href="${rottenTomatoesUrl}" target="_blank" rel="noopener">View on Rotten Tomatoes →</a>
          </div>
        </div>
      </div>
    `;
    document.getElementById('detail-seen-checkbox').addEventListener('change', (e) => {
      StreamScoreAPI.setMovieFlag(detailKey, 'seen', e.target.checked);
      renderList({ keepShown: true });
    });
    document.getElementById('detail-skip-checkbox').addEventListener('change', (e) => {
      StreamScoreAPI.setMovieFlag(detailKey, 'skip', e.target.checked);
      renderList({ keepShown: true });
    });
  }

  function closeModals() {
    els.detailModal.hidden = true;
    els.settingsModal.hidden = true;
  }

  // ---- Settings ------------------------------------------------------

  function openSettings() {
    const keys = StreamScoreAPI.getKeys();
    els.omdbKeyInput.value = keys.omdb;
    els.tmdbKeyInput.value = keys.tmdb;
    els.regionInput.value = keys.region;
    els.settingsModal.hidden = false;
  }

  function saveSettingsAndReload() {
    StreamScoreAPI.saveKeys({
      omdb: els.omdbKeyInput.value,
      tmdb: els.tmdbKeyInput.value,
      region: els.regionInput.value,
    });
    closeModals();
    loadCatalogForRegion().then(resetAndLoad); // the region may have changed
  }

  // ---- Catalogue ---------------------------------------------------------

  // The pre-built catalogue (scripts/build-catalog.mjs) lets browsing sort and filter by score across
  // every movie at once. Without one (not built yet, or no file for this region) the live paging below
  // still works exactly as before.
  async function loadCatalogForRegion() {
    state.catalog = null;
    state.catalogMeta = null;
    els.companyList.replaceChildren();
    const data = await StreamScoreAPI.loadCatalog(StreamScoreAPI.getKeys().region);
    if (!data || !Array.isArray(data.movies) || data.movies.length === 0) return;
    const companyNames = data.companies || [];
    state.catalog = data.movies.map((c) => normalizeFromCatalog(c, companyNames));
    state.catalogMeta = {
      region: data.region,
      generatedAt: data.generatedAt,
      total: data.total ?? data.movies.length,
      checked: data.checked ?? 0,
    };
    populateCompanySuggestions(state.catalog);
  }

  // The Company box matches any part of a name; the suggestions are just the 150 companies behind the
  // most movies in the catalogue.
  function populateCompanySuggestions(movies) {
    const counts = new Map();
    for (const movie of movies) {
      for (const name of movie.companies) counts.set(name, (counts.get(name) || 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 150);
    els.companyList.replaceChildren(
      ...top.map(([name]) => {
        const option = document.createElement('option');
        option.value = name;
        return option;
      })
    );
  }

  function showCatalog() {
    state.requestSeq++; // drop any live request still in flight
    state.movies = state.catalog;
    state.omdbQuotaExceeded = false;
    updateQuotaBanner();
    setStatus('');
    renderList();
  }

  // ---- Event wiring ------------------------------------------------------

  function resetAndLoad() {
    if (state.mode === 'browse' && state.catalog) {
      showCatalog();
      return;
    }
    if (!StreamScoreAPI.hasKeys()) {
      setStatus('Add your OMDb and TMDB API keys in Settings (⚙) to get started.');
      els.results.innerHTML = '';
      els.loadMore.hidden = true;
      return;
    }
    state.page = 1;
    state.movies = [];
    loadPage({ append: false });
  }

  const SEARCH_PLACEHOLDERS = {
    title: 'Search movies…',
    director: "Search by director's name…",
    actor: "Search by actor's name…",
  };

  els.searchInput.addEventListener('input', () => {
    const value = els.searchInput.value.trim();
    els.searchClear.hidden = value.length === 0;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      if (value.length === 0) {
        state.mode = 'browse';
        state.query = '';
      } else {
        state.mode = 'search';
        state.searchType = els.searchType.value;
        state.query = value;
      }
      resetAndLoad();
    }, 350);
  });

  els.searchType.addEventListener('change', () => {
    els.searchInput.placeholder = SEARCH_PLACEHOLDERS[els.searchType.value];
    const value = els.searchInput.value.trim();
    if (value.length === 0) return;
    state.mode = 'search';
    state.searchType = els.searchType.value;
    state.query = value;
    resetAndLoad();
  });

  els.searchClear.addEventListener('click', () => {
    els.searchInput.value = '';
    els.searchClear.hidden = true;
    state.mode = 'browse';
    state.query = '';
    resetAndLoad();
  });

  els.providerFilters.addEventListener('change', (e) => {
    const clientSideToggles = [els.hideUnavailable, els.hideSeen, els.hideSkip];
    if (clientSideToggles.includes(e.target)) {
      renderList();
      return;
    }
    if (e.target === els.onlyRt || e.target === els.onlyMeta) {
      // Live mode only: with no service ticked these chips change what gets fetched; with services
      // ticked (or in catalogue mode) they only narrow what's already loaded.
      if (!isCatalogMode() && state.mode === 'browse' && selectedProviders().length === 0) {
        resetAndLoad();
      } else {
        renderList();
      }
      return;
    }
    // A netflix/prime/disney checkbox changed. The catalogue filters locally; live browsing refetches.
    if (isCatalogMode() || state.mode !== 'browse') {
      renderList();
    } else {
      resetAndLoad();
    }
  });

  els.sortSelect.addEventListener('change', () => renderList());
  els.genreSelect.addEventListener('change', () => renderList());
  els.durationSelect.addEventListener('change', () => renderList());
  let companyDebounce = null;
  els.companyInput.addEventListener('input', () => {
    clearTimeout(companyDebounce);
    companyDebounce = setTimeout(() => renderList(), 200);
  });

  els.loadMore.addEventListener('click', () => {
    if (isCatalogMode()) {
      state.shown += CATALOG_PAGE_SIZE;
      renderList({ keepShown: true });
      return;
    }
    state.page += 1;
    loadPage({ append: true });
  });

  els.settingsBtn.addEventListener('click', openSettings);
  els.saveSettings.addEventListener('click', saveSettingsAndReload);

  document.querySelectorAll('[data-close]').forEach((btn) =>
    btn.addEventListener('click', closeModals)
  );
  [els.detailModal, els.settingsModal].forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModals();
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModals();
  });

  // ---- Init ------------------------------------------------------

  populateGenreOptions();

  if (!StreamScoreAPI.hasKeys()) {
    openSettings();
  }
  setStatus('Loading…');
  loadCatalogForRegion().then(resetAndLoad);
})();
