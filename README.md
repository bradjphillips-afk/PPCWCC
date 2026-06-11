# The Sweep — live World Cup leaderboard

A free, always-on public leaderboard for your 2026 World Cup sweep. A GitHub Action fetches finished
matches every 30 minutes, scores all players, and writes `data/standings.json`. GitHub Pages serves
`index.html`, which anyone in the world can open — no login, no Claude account, always current.

You keep running the **draw** in your Claude artifact. This repo just keeps the public table live.

```
index.html              ← the public leaderboard (GitHub Pages serves this)
score.mjs               ← the scoring engine (runs in the Action)
draw.json               ← your locked-in draw (paste from Claude)
manual.json             ← awards + transfer-window choices (edit later)
data/standings.json     ← generated automatically; don't edit by hand
.github/workflows/score.yml ← the every-30-min schedule
```

## One-time setup (about 10 minutes)

### 1. Get a free API key
- Sign up at **https://www.api-football.com/** (or via RapidAPI). The free plan = 100 requests/day; this uses ~2 per run, well within it.
- Copy your API key.

### 2. Create the repo
- Make a new GitHub repo (public is fine, and required for free Pages).
- Upload these files, keeping the folder structure (especially `.github/workflows/score.yml`).

### 3. Add the key as a secret
- Repo → **Settings → Secrets and variables → Actions → New repository secret**
- Name: `API_FOOTBALL_KEY`  — Value: your key.

### 4. Paste your draw
- In the Claude commissioner console, run the draw, then click **Export for live site** and copy the JSON.
- Replace the entire contents of `draw.json` with it. Commit.

### 5. Turn on GitHub Pages
- Repo → **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main` / `/ (root)` → Save.
- After a minute your public link appears, like `https://YOURNAME.github.io/REPO/`. **That's the link you send the group.**

### 6. Run it once
- Repo → **Actions** → "Update Sweep standings" → **Run workflow** (manual trigger).
- It will fetch results and write `data/standings.json`. Refresh your Pages link — the table is live.

From here it updates itself every hour, 24/7. Nothing to do.

## The two things you set by hand (when the time comes)
Everything except these updates automatically. Edit `manual.json` and commit:

- **Golden awards** (announced at the end): fill in `awards.boot` / `glove` / `ball` with the team that won it.
- **Resurrection Window** (after the groups): under `windows`, add an entry per player who acts, e.g.
  ```json
  "windows": {
    "Sarah": { "captain": "Spain" },
    "Tom":   { "lifeboatDrop": "Haiti", "lifeboatAdopt": "Morocco" }
  }
  ```
  (Captain doubles that team's points; Lifeboat swaps a dead team for an adopted one and adds +15 if it reaches the semis.)
- **Adjustments** (corrections, the −12 captain penalty, etc.): `"adjust": { "Tom": -12 }`.

Delete the `_example` / `_note` lines once you add real entries.

## Notes & honesty
- **Cards are automatic.** Each match's yellows/reds are fetched once when it finishes and cached in `data/cards.json` (never re-fetched), so it stays inside the free 100/day budget. A second yellow is counted as a yellow **and** a red (i.e. −1 −4); change `score.mjs` if you'd rather score it differently.
- **Refresh is hourly** (the cron in `score.yml`). With cards that's ~60 calls/day, comfortably free. Want every few minutes? Upgrade the API plan — only the key changes, not the code.
- Scheduled Actions can run a few minutes late — normal for GitHub's free tier.
- Team names in `draw.json` must match the app's canonical spellings (USA, South Korea, Türkiye, Côte d'Ivoire, Czechia, Bosnia & Herzegovina, DR Congo, Cape Verde, Curaçao). The export button already uses them.
- The scoring rules are identical to the Claude artifact's Rules tab.
