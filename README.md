# Hearth

A warm, minimal desktop app for downloading from YouTube, built with **Rust + Tauri 2** and powered by **yt-dlp** and **ffmpeg**.

- **Full video**, in Best / 4K / 1440p / 1080p / 720p / 480p / 360p, as MP4, MKV or WebM
- **Whole playlists**: tick or untick items, filter by title, and files are numbered automatically
- **Clips**: drag handles on a live preview, press <kbd>I</kbd>/<kbd>O</kbd> at the playhead, or type times like `1:23.5`. You can add several clips per video, with optional frame-accurate cuts.
- **Audio only** as MP3, M4A, Opus, FLAC or WAV, at Best or 320/256/192/128 kbps
- Embedded artwork, metadata and subtitles
- Live progress, speed and ETA, with cancel and "show in folder"
- Custom title bar, Linen (light) and Ember (dark) themes, and a one-click yt-dlp update

yt-dlp and ffmpeg ship **inside** the installers, so users don't need to install anything else.

---

## Project layout

```
hearth/
├─ .github/workflows/build.yml   ← CI: builds Windows / macOS / Linux installers
├─ scripts/fetch-tools.sh        ← downloads yt-dlp + ffmpeg for a target platform
├─ ui/                           ← front-end (plain HTML/CSS/JS, no build step)
│  ├─ index.html
│  ├─ styles.css
│  └─ app.js
├─ src-tauri/                    ← Rust backend
│  ├─ src/lib.rs                 ← Tauri commands
│  ├─ src/info.rs                ← metadata + live-preview stream lookup
│  ├─ src/download.rs            ← yt-dlp argument builder, job runner, progress parser
│  ├─ src/tools.rs               ← locating bundled / system yt-dlp & ffmpeg
│  ├─ tauri.conf.json
│  ├─ capabilities/default.json
│  ├─ icons/
│  └─ tools/                     ← yt-dlp + ffmpeg land here (git-ignored)
├─ app-icon.png                  ← source icon (regenerate with `npm run icon`)
└─ package.json                  ← only holds the Tauri CLI
```

---

## 1. Push to GitHub (this also triggers the build)

```bash
cd hearth
git init
git add .
git commit -m "Initial commit: Hearth downloader"
git branch -M main

# create an empty repo on github.com first (no README), then:
git remote add origin https://github.com/<your-user>/hearth.git
git push -u origin main
```

Or with the GitHub CLI: `gh repo create hearth --private --source=. --push`

## 2. Get the built app (artifacts)

- **Automatically:** every push to `main` runs **Actions → Build Hearth**.
- **Manually:** go to **Actions → Build Hearth → Run workflow**. Tick *"Also publish a GitHub Release"* if you want a draft release.
- **Release:** push a tag to get a public release with all installers attached:
  ```bash
  git tag v1.0.0 && git push origin v1.0.0
  ```

When the run finishes, open it and scroll to **Artifacts**:

| Artifact | Contains |
|---|---|
| `hearth-windows-x64` | `.msi` and `-setup.exe` installers |
| `hearth-macos-arm64` | `.dmg` for Apple Silicon |
| `hearth-macos-x64` | `.dmg` for Intel Macs |
| `hearth-linux-x64` | `.deb`, `.rpm`, `.AppImage` |

The first build takes about 15 minutes. Later builds are faster because of the Rust cache.

> **macOS note:** the app is unsigned. After you drag it to Applications, run
> `xattr -cr /Applications/Hearth.app` once, or right-click the app → **Open**.
> **Windows note:** SmartScreen may warn you because the app is unsigned. Click **More info → Run anyway**.

---

## 3. Run locally (optional)

Prerequisites: [Rust](https://rustup.rs), Node 18+. On Linux you also need:
`sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev libxdo-dev libssl-dev patchelf`

```bash
npm install
npm run tools        # downloads yt-dlp + ffmpeg into src-tauri/tools (use Git Bash on Windows)
npm run dev          # launches the app with hot reload of ui/
npm run build        # builds installers for your machine
```

Run the backend tests with `cd src-tauri && cargo test`.

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| <kbd>Ctrl</kbd>+<kbd>V</kbd> (anywhere) | Paste link and fetch |
| <kbd>Space</kbd> / <kbd>K</kbd> | Play / pause preview |
| <kbd>J</kbd> / <kbd>L</kbd> | Back / forward 5 s |
| <kbd>←</kbd> / <kbd>→</kbd> | Back / forward 1 s |
| <kbd>I</kbd> / <kbd>O</kbd> | Set clip start / end at the playhead |
| <kbd>Enter</kbd> | Add the current range as a clip |
| <kbd>M</kbd> | Mute |

## Troubleshooting

- **"Sign in to confirm you're not a bot" or other errors after YouTube changes:** click the engine chip (top right) to update yt-dlp.
- **No live preview:** some videos don't expose a browser-playable stream. The timeline and typed times still work. On Linux, install `gstreamer1.0-plugins-good gstreamer1.0-libav` for H.264 playback.
- **Clip starts a little early or late:** turn on *Frame-accurate cuts*. It re-encodes at the cut points.
- **Installers are large (~150 MB):** that's the bundled static ffmpeg + ffprobe. To make them smaller, swap in an LGPL or shared build in `scripts/fetch-tools.sh`.

## Customising

- **Colours and shapes:** edit the CSS variables at the top of `ui/styles.css` (`[data-theme="linen"]` and `[data-theme="ember"]`).
- **yt-dlp options:** see `build_args()` in `src-tauri/src/download.rs`.
- **App name and identifier:** see `src-tauri/tauri.conf.json`.
- **Icon:** replace `app-icon.png` (1024×1024) and run `npm run icon`.

## Legal

Only download content you have the right to download. Respect YouTube's Terms of Service and the creators' copyrights. The bundled ffmpeg builds are GPL-licensed, and yt-dlp is released under the Unlicense.
