# StreamScore: user's guide

StreamScore lists movies available on **Netflix, Amazon Prime Video and Disney+** and lets you sort and
filter them by **Metascore** (Metacritic) and **Rotten Tomatoes**. It runs as a web page and as an Android
app. This guide covers what lies where, how to use it, and what is saved where. (`README.md` holds the
technical notes.)

- Web app: https://pythdom.github.io/streamscore/
- Android app: download the latest `.apk` from https://github.com/PythDom/streamscore/releases
- Source and data: https://github.com/PythDom/streamscore

## 1. The big picture

```
 TMDB + OMDb (free APIs)                     your phone / browser
        |                                          ^
        | every night, 03:23 UTC                   | opens the page, loads the catalogue
        v                                          |
 GitHub Action "Update catalogue"  ------>  GitHub repo (data/catalog-US.json, catalog-BE.json)
   builds the list of movies and their              |
   scores, within OMDb's daily limit                +--> GitHub Pages publishes it as the web app
                                                    +--> the Android app is the same page in a wrapper
```

Why the nightly build exists: TMDB (the movie list source) can only sort by popularity or votes, never by
critic score. So once a day the build collects every movie on the three services together with its scores,
and the app can then sort **all** of them by score instantly.

## 2. First use

1. Open the web app (or the Android app). The Settings window opens by itself the first time.
2. Enter, in Settings (the gear in the top-right corner):
   - **OMDb API key**: free, from https://www.omdbapi.com/apikey.aspx (it is activated by email).
   - **TMDB API key (v3 auth)**: free, from https://www.themoviedb.org/settings/api.
   - **Streaming region**: two letters. The catalogue exists for **US** and **BE**. Any other region
     works in a slower "live" mode (see section 5).
3. Press **Save**.

You can close Settings without keys and still browse the catalogue. The keys are needed for searching and
for movie synopses.

## 3. Using the app

### The list
Each card shows the poster, the title and year, the services carrying it, and two scores in the corner of
the poster:

| Badge | Meaning |
| --- | --- |
| Number on green / gold / red | **Metascore**: 61 and above is green, 40-60 gold, below 40 red |
| Tomato badge with a percentage | **Rotten Tomatoes** score: 60% and above is "fresh" |
| A dash instead of a number | No score available (yet) |

Click a card to open its details: synopsis, genres, both scores, the services, and links to the movie's
Metacritic and Rotten Tomatoes search pages.

### Filters

| Control | What it does |
| --- | --- |
| Netflix, Amazon Prime Video, Disney+ | Show movies on any ticked service. With none ticked, no service restriction is applied. |
| Only selected services | Hides search results that are not on a ticked service (the catalogue list already follows the ticks). |
| Hide seen | Hides movies you marked as Seen. |
| Hide "don't want to see" | Hides movies you marked that way. |
| Only rated on Rotten Tomatoes / Metascore | Hides movies that have no such score. Tick both to keep only movies with both. |
| Genre | Keeps one genre. Only movies whose scores have already been looked up have genres. |

### Sorting
**Sort** offers Metascore, Rotten Tomatoes, Average score (of the two) in both directions, Title A-Z and
Newest first. Movies without the score you sort on always go last, and ties are ordered by the other score
and then the title, so the order is stable.

### Seen and "Don't want to see"
Each card, and the detail window, has two small toggles. They are your personal marks: they dim the poster
and can be hidden with the two "Hide" filters above. They are saved on your device only (section 6).

### Searching
Use the small menu left of the search box to choose what you search for:

- **Title**: searches OMDb for any movie, on the services or not. "Load more" fetches the next results.
- **Director** or **Actor**: finds the best-matching person (TMDB) and lists their 30 most popular movies.

Clear the search with the x to return to the catalogue.

### "Load more"
In the catalogue it simply reveals the next 48 movies of the already sorted list, with no waiting. In a
search it fetches the next page of results.

## 4. The nightly catalogue

- **What it contains**: every movie on Netflix, Prime Video or Disney+ in the US and in Belgium that has at
  least 100 votes on TMDB, with Metascore, Rotten Tomatoes and genres. About 6,500 US titles and 4,800
  Belgian ones.
- **How scores arrive**: OMDb's free tier allows 1,000 lookups a day, so each night's build looks up at most
  900 titles, most-voted first. The first complete fill takes about nine days. A line under the filters
  tells you how far along it is ("scores checked for X of Y"). Titles still waiting simply show a dash.
- **Afterwards**: only new arrivals are looked up. A movie missing a score is rechecked every 14 days (a
  score can appear later); a complete one is refreshed after 120 days.
- **Run it now**: GitHub, repository **Actions**, **Update catalogue**, **Run workflow**. You can lower the
  OMDb budget if you also use the same OMDb key in the app that day.
- **Add a region** (for example GB): edit `REGIONS` in `.github/workflows/update-catalog.yml` to
  `US,BE,GB`. Titles shared with other regions are not looked up twice. Set the same region in the app's
  Settings.
- **Tuning**: `MIN_VOTES` (default 100) and `OMDB_BUDGET` (default 900) are described at the top of
  `scripts/build-catalog.mjs`.

## 5. The Android app

- **Install**: download `StreamScore-<version>.apk` from the Releases page and open it. Android may ask you
  to allow installs from your browser.
- **It is the web app in a wrapper.** It always loads the live site, so web changes (new features, new
  catalogue) appear without installing anything. A new APK is only needed when the wrapper itself changes
  (for example the icon).
- **Update**: install the new APK **over** the old one. Do not uninstall first.
- **Storage is separate from Chrome**, so clearing Chrome's data does not erase your keys or marks.
- Links to Metacritic and Rotten Tomatoes open in your phone's browser; the back button moves within the app.

If the catalogue is missing for your region (or not built yet), the app falls back to **live mode**: it
fetches movies page by page, 20 at a time, which is slower, and sorting then only covers what is loaded.

## 6. What is saved where

### On your phone or browser (never uploaded anywhere)

| Saved item | Browser storage name | Notes |
| --- | --- | --- |
| OMDb and TMDB keys, region | `streamscore_omdb_key`, `streamscore_tmdb_key`, `streamscore_region` | Sent only to OMDb / TMDB when the app makes requests. |
| Seen / "don't want to see" marks | `streamscore_flags_v1` | Per device. They do not follow you to another phone or browser. |
| Cache of OMDb answers | `streamscore_omdb_cache_v1` | Saves daily lookups. Complete entries are kept; incomplete ones are rechecked after 7 days. |

The Android app keeps the same items in its own private storage. They are lost if you uninstall the app or
clear its data, and they are not included in Google backups. On a new phone you enter the keys again and
your marks start empty.

### On GitHub (repository `PythDom/streamscore`, public)

| Item | Where | Notes |
| --- | --- | --- |
| The web app and Android project | `index.html`, `css/`, `js/`, `assets/`, `android/` | Contains no keys. |
| Catalogue | `data/catalog-US.json`, `data/catalog-BE.json` | Public movie data, rewritten by the nightly build. |
| Lookup progress | `data/scores.json` | Remembers which titles have scores, shared by regions. |
| APK files | **Releases** (`apk-1.N`) | One new release per Android build. |
| `TMDB_API_KEY`, `OMDB_API_KEY` | Repository **secrets** | Used only by the nightly build. Their values cannot be read back; replace them with `gh secret set NAME --repo PythDom/streamscore`. |
| `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD` | Repository **secrets** | Used to sign the APK. |

### On your PC

| Item | Where | Notes |
| --- | --- | --- |
| Working copy of the project | `D:\Codes\streamscore` | Keep it out of Google Drive (Drive corrupts `.git`). |
| APK signing key | `D:\Codes\StreamScore-signing` | **Back this up.** Without it, new APK versions can no longer be installed over the old one. A copy also lives in the GitHub secrets. |
| Local preview setting | `G:\My Drive\Config\.claude\launch.json` | Runs the app on http://localhost:5180 for testing. |

## 7. Maintaining it

- **Change the app**: edit files in `D:\Codes\streamscore`, then `git pull`, `git push`. The nightly build also
  commits to the repository, so always pull first or the push is rejected.
- **A change can take a few minutes to appear**: GitHub Pages and browsers keep files for about 10 minutes. A
  hard refresh (Ctrl+Shift+R) shows the newest version.
- **Try changes locally**: run `serve.ps1` in the project folder (it serves port 5173 by default; pass
  `-Port 5180` for another) and open the address it prints.
- **New APK**: pushing a change inside `android/`, or running **Build Android APK** from the Actions tab,
  builds, signs and publishes a new release.
- **Check the nightly build**: the **Actions** tab, **Update catalogue**. "No changes" in the log is normal on
  a quiet day.

## 8. Troubleshooting

| What you see | Why | What to do |
| --- | --- | --- |
| A dash instead of a score | The movie has no score, or it was not looked up yet, or OMDb has not synced it. OMDb sometimes has a Metascore but no Rotten Tomatoes score. | Use the Metacritic / Rotten Tomatoes links in the details. The nightly build rechecks automatically. |
| A banner about OMDb's daily limit | The free 1,000 lookups per day are used up. | Wait for tomorrow, or use another OMDb key in Settings. Browsing the catalogue still works. |
| "Scores checked for X of Y" | The catalogue is still filling in. | Nothing, it grows every night. |
| No catalogue line, 20 movies at a time | There is no catalogue for the region in Settings (live mode). | Set US or BE, or add your region (section 4). |
| Keys disappeared | The app's data was cleared or the app was uninstalled. | Enter the keys again in Settings. |
| Director or actor not found | Spelling, or the person has no movie credits. | Try the full name. |
| `git push` rejected | The nightly build committed first. | `git pull`, then push again. |

## 9. Limits to know about

- Only **Netflix, Prime Video and Disney+**, only titles included in a **subscription** (not rental or
  purchase), and only the regions in the catalogue.
- Scores come from OMDb, which sometimes lags Metacritic or lacks Rotten Tomatoes. Per-critic scores (for
  example one named critic's own rating) are not available from any API used here.
- The catalogue is public, like the rest of the repository.
- Scores are from [OMDb](https://www.omdbapi.com/); streaming availability is from JustWatch via
  [TMDB](https://www.themoviedb.org/). This product uses the TMDB API but is not endorsed or certified by TMDB.
