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
    genreSelect: document.getElementById('genre-select'),
    sortSelect: document.getElementById('sort-select'),
    results: document.getElementById('results'),
    status: document.getElementById('status'),
    quotaBanner: document.getElementById('quota-banner'),
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
  };

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
      plot: null,
      badges: null,
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

  // ---- Fetch orchestration ---------------------------------------------

  function selectedProviders() {
    return Array.from(
      els.providerFilters.querySelectorAll('input[type=checkbox]:checked')
    ).map((cb) => cb.value);
  }

  async function fetchBrowsePage(page) {
    const providers = selectedProviders();
    if (providers.length === 0) return { movies: [], totalPages: 0 };
    const data = await StreamScoreAPI.discoverByProviders(providers, page);
    const movies = (data.results || []).map(normalizeFromTmdb);
    await Promise.all(movies.map(enrichMetascore));
    await Promise.all(movies.map(enrichStreamingBadges));
    return { movies, totalPages: data.total_pages || 1 };
  }

  async function fetchSearchPage(query, page) {
    const results = await StreamScoreAPI.omdbSearch(query, page);
    const movies = results.map(normalizeFromOmdbSearch);
    await Promise.all(movies.map(enrichMetascore));
    await Promise.all(movies.map(enrichStreamingBadges));
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
            ? 'No movies found for the selected streaming services.'
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

  function passesFilters(movie) {
    if (els.hideUnavailable.checked) {
      const selected = selectedProviders();
      const hasSelectedBadge =
        movie.badges && selected.some((key) => movie.badges[key]);
      if (!hasSelectedBadge) return false;
    }
    const genre = els.genreSelect.value;
    if (genre && !(movie.genres || []).includes(genre)) return false;
    const flags = StreamScoreAPI.getMovieFlags(movieKey(movie));
    if (els.hideSeen.checked && flags.seen) return false;
    if (els.hideSkip.checked && flags.skip) return false;
    return true;
  }

  function visibleMovies() {
    const list = state.movies.filter(passesFilters);
    const mode = els.sortSelect.value;
    switch (mode) {
      case 'metascore-asc':
        list.sort((a, b) => (a.metascore ?? -1) - (b.metascore ?? -1));
        break;
      case 'rtscore-desc':
        list.sort((a, b) => (b.rtScore ?? -1) - (a.rtScore ?? -1));
        break;
      case 'rtscore-asc':
        list.sort((a, b) => (a.rtScore ?? -1) - (b.rtScore ?? -1));
        break;
      case 'title-asc':
        list.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case 'year-desc':
        list.sort((a, b) => (b.year || '0') - (a.year || '0'));
        break;
      case 'avg-asc':
        list.sort((a, b) => (avgScore(a) ?? -1) - (avgScore(b) ?? -1));
        break;
      case 'avg-desc':
        list.sort((a, b) => (avgScore(b) ?? -1) - (avgScore(a) ?? -1));
        break;
      case 'metascore-desc':
      default:
        list.sort((a, b) => (b.metascore ?? -1) - (a.metascore ?? -1));
        break;
    }
    return list;
  }

  function badgeLabel(key) {
    return { netflix: 'Netflix', prime: 'Prime Video', disney: 'Disney+' }[key] || key;
  }

  function renderList() {
    const list = visibleMovies();
    els.results.innerHTML = '';
    for (const movie of list) {
      els.results.appendChild(renderCard(movie));
    }
    if (list.length === 0 && state.movies.length > 0) {
      setStatus('No movies match the current filters.');
    } else if (state.movies.length > 0) {
      setStatus('');
    }
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
      renderList();
    });
    card.querySelector('.skip-checkbox').addEventListener('change', (e) => {
      StreamScoreAPI.setMovieFlag(key, 'skip', e.target.checked);
      renderList();
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
      renderList();
    });
    document.getElementById('detail-skip-checkbox').addEventListener('change', (e) => {
      StreamScoreAPI.setMovieFlag(detailKey, 'skip', e.target.checked);
      renderList();
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
    resetAndLoad();
  }

  // ---- Event wiring ------------------------------------------------------

  function resetAndLoad() {
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
    if (e.target === els.hideUnavailable || e.target === els.hideSeen || e.target === els.hideSkip) {
      renderList();
      return;
    }
    // A netflix/prime/disney checkbox changed.
    if (state.mode === 'browse') {
      resetAndLoad();
    } else {
      renderList();
    }
  });

  els.sortSelect.addEventListener('change', renderList);
  els.genreSelect.addEventListener('change', renderList);

  els.loadMore.addEventListener('click', () => {
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
  resetAndLoad();
})();
