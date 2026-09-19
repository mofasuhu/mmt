# Metasession Markup Tool (Browser)

A standalone HTML/CSS/JavaScript tool for running an educational metasession-markup workflow in the browser. It is the browser-oriented implementation of a ten-step pipeline that turns slide content and session links into organized CSV, XML, TeX, and media files.

## Pipeline

The browser workflow can run these stages in order:

1. Download Google Slides as PPTX.
2. Extract slide content into CSV, including merged-cell handling.
3. Build metasession XML from the session CSV.
4. Build session TeX from XML.
5. Materialize the session file tree.
6. Copy remote slide content and assign new IDs.
7. Clean wrapped LaTeX.
8. Add verbatim text to slides.
9. Process video assets with ffmpeg.wasm and Canvas.
10. Rename session folders to match the CSV stem.

The UI supports choosing local folders through the File System Access API where available, or working with uploaded files and a `links.csv`-style input. Generated folders can be reviewed before download.

## Requirements

- A current Chrome or Edge browser is recommended for folder access and drag-and-drop.
- Node.js 18+ is useful for the local development/proxy server.
- Google OAuth configuration is only needed for features that read a user's Google Slides or Sheets. Keep OAuth client configuration and all access/refresh tokens on the local machine; do not commit them.

## Run locally

Serve the repository from a local HTTP origin rather than opening `index.html` directly. The included development server can provide the static app and local proxy routes:

```bash
node proxy/dev-server.mjs
```

Then open the local address printed by the server. If you use another static server, local filesystem access still depends on browser permissions and the app's supported origin.

## Inputs and outputs

- Start from `links.csv.example` and create a local `links.csv` with the session URLs needed for a run.
- Choose or mount the slides archive when using local-folder mode.
- The pipeline produces session folders containing CSV, XML, TeX, slide content, and optional video assets.
- `Output/`, `sessions/`, `csvs/`, `xml/`, `tex/`, and `files/` are local working/output areas and are ignored by Git.

The application may call Google APIs for user-authorized Slides or Sheets data. A proxy is optional and should only be configured for an endpoint you control and trust; proxy URLs are deliberately not stored in this repository.

## Project structure

- `index.html` — application shell.
- `css/` — browser UI styles.
- `js/main.js` — UI orchestration.
- `js/pipeline/` — pipeline stages and the run-all coordinator.
- `js/shared/` — CSV handling, APIs, and validators.
- `js/pptx/` — PPTX reading and tag parsing.
- `js/io/` — virtual filesystem, File System Access, and ZIP handling.
- `js/auth/` — Google OAuth and Sheets integration.
- `js/video/` — ffmpeg.wasm and compositing bridge.
- `proxy/` — optional local and edge proxy helpers; review its configuration before deploying.
- `links.csv.example`, `oauth-config.json.example`, and `archive-config.json.example` — safe templates only.

## Security and privacy

This tool can access user-authorized Google content and local educational materials. Never add `credentials.json`, `token*.json`, private CSVs, generated session data, local archive paths, API keys, client secrets, or `.env` files to Git. The real OAuth and archive configuration files were intentionally removed from the public tree; create local copies from the examples and keep them untracked.

Review proxy allowlists and deployment settings before exposing a proxy publicly. Do not deploy shared tokens or private educational content to a public Pages site.

## License

See `LICENSE`.
