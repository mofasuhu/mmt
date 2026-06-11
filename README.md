# Metasession Markup Tool (Browser)

Standalone HTML/CSS/JS port of the Python `run_all.py` pipeline. Run all 10 metasession markup steps in the browser: download Google Slides, extract CSV, build XML/TeX, copy slide content, clean LaTeX, add verbatim, video slides, and rename session folders.

**Repository:** [github.com/farouknagwa/mmt](https://github.com/farouknagwa/mmt)

---

## Table of contents

1. [Clone the repository](#1-clone-the-repository)
2. [First-time upload (publish this project to GitHub)](#2-first-time-upload-publish-this-project-to-github)
3. [Local setup](#3-local-setup)
4. [Using the published page (no clone)](#4-using-the-published-page-no-clone--for-end-users)
5. [One-time setup for the site admin](#5-one-time-setup-for-the-site-admin-github-pages--google-sign-in)
6. [Run the app locally](#6-run-the-app-locally-developers)
7. [Daily workflow](#7-daily-workflow)
8. [What to commit vs ignore](#8-what-to-commit-vs-ignore)
9. [Pipeline steps](#9-pipeline-steps)
10. [Project structure](#10-project-structure)
11. [Security](#11-security)

---

## 1. Clone the repository

If the repo already exists on GitHub and you are on a new machine:

```bash
git clone git@github.com:farouknagwa/mmt.git
cd mmt
```

Use HTTPS instead if you do not have SSH keys configured:

```bash
git clone https://github.com/farouknagwa/mmt.git
cd mmt
```

---

## 2. First-time upload (publish this project to GitHub)

Use this section when you have the project on your computer and want to push it to `git@github.com:farouknagwa/mmt.git` for the first time.

### 2.1 Create the GitHub repo (if empty)

1. Open [github.com/new](https://github.com/new)
2. Repository name: `mmt`
3. Choose **Private** (recommended — the tool uses Google OAuth and Nagwa APIs)
4. Do **not** add a README, `.gitignore`, or license (this project already has them)
5. Click **Create repository**

### 2.2 Initialize git inside this folder

From the project root (`standalone_html-css-js_mmt_1` — or rename the folder to `mmt` before pushing):

```bash
cd /path/to/standalone_html-css-js_mmt_1

git init
git branch -M main
git remote add origin git@github.com:farouknagwa/mmt.git
```

If `origin` already exists with a wrong URL:

```bash
git remote set-url origin git@github.com:farouknagwa/mmt.git
```

### 2.3 Verify secrets will not be committed

This folder may contain local files that **must not** go to GitHub. The `.gitignore` excludes them, but check before the first commit:

```bash
git status
```

You should **not** see:

- `credentials.json`
- `token.json`, `token_read.json`, `token_sheet.json`
- `links.csv` (use `links.csv.example` as a template)
- `Output/` or other generated pipeline data

If any secret file appears as “untracked”, do not `git add .` blindly — fix `.gitignore` first.

### 2.4 Commit and push

```bash
git add .
git commit -m "Initial commit: browser metasession markup tool"
git push -u origin main
```

If the remote repo is not empty (e.g. it has a README), pull first:

```bash
git pull origin main --rebase
git push -u origin main
```

### 2.5 Push updates later

```bash
git add .
git commit -m "Describe your change"
git push
```

---

## 3. Local setup

### Requirements

- **Chrome or Edge** (recommended) — File System Access API, folder drag-and-drop
- **Node.js 18+** — for the local dev server (`node proxy/dev-server.mjs`)
- Google OAuth files (same as the Python tool) placed **next to `index.html`**:

| File | Purpose |
|------|---------|
| `credentials.json` | Google OAuth client |
| `token.json` | Google Drive (step 1 — download slides) |
| `token_read.json` | Drive fallback if `token.json` is expired |
| `token_sheet.json` | Google Sheets (steps 2 & 6) |

These files are loaded automatically; they are **not** uploaded through the UI.

### Session input

Copy the example and add your Google Slides URLs:

```bash
cp links.csv.example links.csv
# Edit links.csv — one URL per row
```

### Optional assets

| Path | Purpose |
|------|---------|
| `assets/fonts/Rubik-Bold.ttf` | Video slide title text |
| `assets/video_play_icon.png` | Play button on video slides |

### Archive folders (local only — not in git)

At run time, pick or drag:

- **CLS archive** — Nagwa `CLS` template tree
- **Slides archive** — e.g. `2024-2025-Slides/All` style remote slide store
- **Output folder** — writable folder for final files (**Browse**, not read-only drop)

---

## 4. Using the published page (no clone — for end users)

If the site is deployed to GitHub Pages (e.g. `https://farouknagwa.github.io/mmt/`):

1. Open the URL in **Chrome or Edge**
2. Click **Sign in with Google** (grants Drive + Sheets access in your browser)
3. Paste your **Google Slides URL** and click **Use this URL** (or drag `links.csv`)
4. **Browse** or drag: **CLS archive**, **Slides archive**, and optionally **Output folder**
5. Click **Run pipeline**
6. Click **Download ZIP** (or **Write to folder** if you picked a writable output folder)

Nothing is installed on the PC. Pipeline output stays in browser memory until you download it.

---

## 5. One-time setup for the site admin (GitHub Pages + Google sign-in)

End users only need the published URL. **You** (repo owner) must configure Google OAuth once:

### 5.1 Create a Web OAuth client

1. [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials
2. **Create credentials** → **OAuth client ID** → type **Web application**
3. **Authorized JavaScript origins** — add:
   - `https://farouknagwa.github.io` (or your Pages domain)
   - `http://127.0.0.1:8788` and `http://localhost:8788` (local dev)
4. Copy the **Client ID** (ends with `.apps.googleusercontent.com`)
5. Enable **Google Drive API** and **Google Sheets API** for the project

### 5.2 Add client ID to the repo

Edit `oauth-config.json` (commit this file — the client ID is public; never commit client secret):

```json
{
  "client_id": "YOUR_WEB_CLIENT_ID.apps.googleusercontent.com",
  "cors_proxy_url": ""
}
```

**CORS proxy is required on GitHub Pages** (browser cannot call Nagwa APIs directly). Deploy once:

```bash
cd proxy
npx wrangler login
npx wrangler deploy
```

Copy the worker URL (e.g. `https://mmt-cors-proxy.your-name.workers.dev`) into `oauth-config.json`:

```json
"cors_proxy_url": "https://mmt-cors-proxy.your-name.workers.dev"
```

Commit, push, wait for Pages to redeploy, then hard-refresh the app.

### 5.3 Enable GitHub Pages (required — do this before the workflow can succeed)

The deploy workflow **will fail** with `Get Pages site failed` / `Not Found` until Pages is turned on manually:

1. Open **https://github.com/farouknagwa/mmt/settings/pages**
2. Under **Build and deployment → Source**, choose **GitHub Actions** (not “Deploy from a branch”)
3. The choice saves automatically — this creates the `github-pages` environment
4. Go to **Actions** → **Deploy static content to Pages** → **Run workflow** (or push to `main` again)

Also check **Settings → Actions → General → Workflow permissions**:

- Select **Read and write permissions**
- Save

After a successful run, the site is at **https://farouknagwa.github.io/mmt/** (allow 2–5 minutes on first deploy).

### 5.4 Share the URL

Send **https://farouknagwa.github.io/mmt/** to your team — no clone or install needed.

---

## 6. Run the app locally (developers)

### Recommended: dev server

```bash
node proxy/dev-server.mjs
```

Open **http://127.0.0.1:8788**

This serves the app and a same-origin `/proxy` for Nagwa APIs if the browser blocks direct fetch.

### Alternative: static server

```bash
npx serve .
```

Nagwa APIs usually work via direct browser fetch (CORS). Clear any stale **CORS proxy URL** in the UI if requests fail.

### In the browser

1. Confirm `links.csv` is loaded (bundled or drag-and-drop)
2. **Browse** or drag **Output**, **CLS archive**, **Slides archive**
3. **Verify Google auth** (optional; also runs at pipeline start)
4. **Run pipeline** (or set **Resume from step**)
5. **Write to folder** or **Download ZIP**

Pipeline output lives in **browser memory** until you click **Write to folder** or **Download ZIP**. Refreshing the tab loses unsaved work.

---

## 7. Daily workflow

Typical session processing:

1. Update `links.csv` with the new Google Slides URL(s)
2. Start dev server → open http://127.0.0.1:8788
3. Select CLS archive, slides archive, and a writable output folder
4. Run pipeline (steps 1–10)
5. **Write to folder** → files appear under your chosen output directory (e.g. `files/{session_id}_.../`)

To re-run only part of the pipeline, set **Resume from step** (same idea as `python run_all.py --step N`).

---

## 8. What to commit vs ignore

| Commit | Do not commit |
|--------|----------------|
| `index.html`, `css/`, `js/`, `proxy/` | `credentials.json`, `token*.json` |
| `README.md`, `.gitignore` | `links.csv` (session URLs) |
| `links.csv.example`, `oauth-config.json` (web client_id only) | `Output/`, `sessions/`, `csvs/`, `xml/`, `tex/`, `files/` |
| `assets/` (fonts, icons) | `terminal log*.txt`, `*.aux`, `*.log` |

---

## 9. Pipeline steps

| Step | Module | Description |
|------|--------|-------------|
| 1 | `downloadWithRename.js` | Download Google Slides as PPTX |
| 2 | `extractCsv.js` / `extractCsvMerged.js` | Parse PPTX → CSV |
| 3 | `xmlBuilder.js` | CSV → metasession XML |
| 4 | `texBuilder.js` | XML → session TeX |
| 5 | `makeFiles.js` | Materialize `files/{session}/` tree |
| 6 | `copySlidesContent.js` | Copy CLS + remote slide content, re-ID |
| 7 | `cleanWrappedSlides.js` | LaTeX cleaning |
| 8 | `addVerbatimToSlides.js` | Inject verbatim text |
| 9 | `videoSlide.js` | Video assets (ffmpeg.wasm + Canvas) |
| 10 | `renameSessionFolders.js` | Rename session folders to CSV stem |

---

## 10. Project structure

```
index.html              # App shell
css/app.css             # UI styles
js/main.js              # UI + orchestration
js/pipeline/            # Pipeline steps + runAll.js
js/shared/              # sessionCsv, APIs, validators
js/pptx/                # PPTX reader + tag parser
js/io/                  # virtualFs, File System Access, ZIP
js/auth/                # Google OAuth + Sheets
js/video/               # ffmpeg bridge, compositing
proxy/dev-server.mjs    # Local static + API proxy server
proxy/worker.js         # Optional CORS proxy for GitHub Pages
links.csv.example       # Template for session URLs
```

---

## 11. Security

- Keep the repository **private** if it contains or ever contained OAuth secrets
- Never commit `credentials.json` or token JSON files
- API keys are embedded like the Python tool; use the CORS proxy only for hosts you trust
- Rotate tokens if they were accidentally pushed (revoke in Google Cloud Console, regenerate locally)

---

## Troubleshooting

| Issue | What to try |
|-------|-------------|
| `Get Pages site failed` / `Not Found` in Actions | **Settings → Pages → Source → GitHub Actions**, then re-run workflow ([§5.3](#53-enable-github-pages-required--do-this-before-the-workflow-can-succeed)) |
| Node.js 20 deprecation warning in Actions | Harmless until mid-2026; workflow uses `deploy-pages@v5` (Node 24) |
| `Failed to fetch` on metasession API | Use `node proxy/dev-server.mjs`, clear CORS proxy URL, hard-refresh |
| Google auth fails | Check files beside `index.html`; click **Verify Google auth** |
| Output folder read-only | Use **Browse** for output, not drag-only |
| No files on disk after run | Click **Write to folder** or **Download ZIP** — pipeline stores in browser memory |
| Step 10 rename skipped | Re-run from step 5; ensure CSV exists in `files/{session_id}/` |
