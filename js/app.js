(() => {
  const els = {
    searchInput: document.getElementById('search-input'),
    searchClear: document.getElementById('search-clear'),
    settingsBtn: document.getElementById('settings-btn'),
    settingsModal: document.getElementById('settings-modal'),
    omdbKeyInput: document.getElementById('omdb-key-input'),
    tmdbKeyInput: document.getElementById('tmdb-key-input'),
    regionInput: document.getElementById('region-input'),
    saveSettings: document.getElementById('save-settings'),
    providerFilters: document.getElementById('provider-filters'),
    hideUnavailable: document.getElementById('hide-unavailable'),
    genreSelect: document.getElementById('genre-select'),
    sortSelect: document.getElementById('sort-select'),
    results: document.getElementById('results'),
    status: document.getElementById('status'),
    loadMore: document.getElementById('load-more'),
    detailModal: document.getElementById('detail-modal'),
    detailContent: document.getElementById('detail-content'),
  };

  const state = {
    mode: 'browse', // 'browse' | 'search'
    query: '',
    page: 1,
    totalPages: 1,
    movies: [], // normalized movie objects currently rendered
    loading: false,
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

  async function loadPage({ append = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    setStatus(append ? 'Loading more…' : 'Loading…');
    els.loadMore.hidden = true;
    try {
      const { movies, totalPages } =
        state.mode === 'search'
          ? await fetchSearchPage(state.query, state.page)
          : await fetchBrowsePage(state.page);

      state.totalPages = totalPages;
      state.movies = append ? state.movies.concat(movies) : movies;

      if (state.movies.length === 0) {
        setStatus(
          state.mode === 'search'
            ? `No results for "${state.query}".`
            : 'No movies found for the selected streaming services.'
        );
      } else {
        setStatus('');
      }
      renderList();
      els.loadMore.hidden = state.page >= state.totalPages;
    } catch (err) {
      console.error(err);
      setStatus(errorMessage(err));
    } finally {
      state.loading = false;
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

  function passesFilters(movie) {
    if (els.hideUnavailable.checked) {
      const selected = selectedProviders();
      const hasSelectedBadge =
        movie.badges && selected.some((key) => movie.badges[key]);
      if (!hasSelectedBadge) return false;
    }
    const genre = els.genreSelect.value;
    if (genre && !(movie.genres || []).includes(genre)) return false;
    return true;
  }

  function visibleMovies() {
    const list = state.movies.filter(passesFilters);
    const mode = els.sortSelect.value;
    switch (mode) {
      case 'metascore-asc':
        list.sort((a, b) => (a.metascore ?? -1) - (b.metascore ?? -1));
        break;
      case 'title-asc':
        list.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case 'year-desc':
        list.sort((a, b) => (b.year || '0') - (a.year || '0'));
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
      </div>
    `;
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

    const activeBadges = movie.badges
      ? Object.entries(movie.badges)
          .filter(([, on]) => on)
          .map(([key]) => `<span class="badge badge-${key}">${badgeLabel(key)}</span>`)
          .join('')
      : '';

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
          <a class="metacritic-link" href="${metacriticUrl}" target="_blank" rel="noopener">View on Metacritic →</a>
        </div>
      </div>
    `;
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
        state.query = value;
      }
      resetAndLoad();
    }, 350);
  });

  els.searchClear.addEventListener('click', () => {
    els.searchInput.value = '';
    els.searchClear.hidden = true;
    state.mode = 'browse';
    state.query = '';
    resetAndLoad();
  });

  els.providerFilters.addEventListener('change', (e) => {
    if (e.target === els.hideUnavailable) {
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
