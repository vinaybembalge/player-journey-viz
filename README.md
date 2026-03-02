# Player Journey Visualization — LILA BLACK

Web tool for Level Design to explore player behavior on maps: journeys, events (kills, deaths, loot, storm), and heatmaps.

## Prerequisites

- **Node.js** 18+ (for the frontend)
- **Python** 3.9+ with `pyarrow` and `pandas` (for data preprocessing)

## Setup and run locally

1. **Generate data** (run once; reads parquet from `player_data/`, writes to `public/`):

   ```bash
   pip install -r requirements.txt
   python scripts/build_data.py
   ```

2. **Install and run the app**:

   ```bash
   npm install
   npm run dev
   ```

   Open **http://localhost:5173** and pick Map, Date, then a Match. Use the timeline slider or Play to scrub through the match. Toggle heatmaps (Kill zones, Death zones, High traffic) as needed.

3. **Production build**:

   ```bash
   npm run build
   npm run preview
   ```

   Preview serves the `dist/` folder at **http://localhost:4173**.

## Deploy (shareable link)

The app is static (HTML, JS, CSS, and JSON data). Serve the **`dist/`** folder from any static host.

- **Vercel**: Push the repo, connect the project, set **Build Command** to `npm run build`, **Output Directory** to `dist`. Ensure `public/` is committed (it contains `meta.json`, `matches/`, `heatmaps/`, `minimaps/`) so the build has data without running Python on Vercel.
- **Netlify**: Same idea — Build command `npm run build`, Publish directory `dist`. Commit `public/` so the built site includes the data.
- **GitHub Pages**: Run `npm run build` locally, push the contents of `dist/` to the `gh-pages` branch (or use a GitHub Action that runs `python scripts/build_data.py` then `npm run build` and deploys `dist/`).

After deploy, site URL (e.g. **https://player-journey-viz.vercel.app/** ).

## Project layout

- `player_data/` — Raw parquet files and minimaps (from the assignment zip).
- `scripts/build_data.py` — Preprocesses parquet → JSON and heatmaps, copies minimaps into `public/`.
- `public/` — Generated and static assets: `meta.json`, `matches/*.json`, `heatmaps/*.json`, `minimaps/`.
- `src/` — Vite app: `main.js`, `style.css`.
- `index.html`, `vite.config.js`, `package.json` — Frontend entry and config.
