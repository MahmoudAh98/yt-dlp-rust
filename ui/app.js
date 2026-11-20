/* ═══════════════════════════════════════════════════════════════
   Hearth — front-end logic
   ═══════════════════════════════════════════════════════════════ */
"use strict";

const T = window.__TAURI__;
const invoke = (cmd, args) => T.core.invoke(cmd, args);
const $ = (id) => document.getElementById(id);
const icon = (name) => `<svg><use href="#i-${name}"/></svg>`;

/* ───────────── Formatting helpers ───────────── */
function fmtTime(s, withMs = false) {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 10);
  const core = h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
  return withMs ? `${core}.${ms === 10 ? 9 : ms}` : core;
}
function parseTime(str) {
  str = String(str).trim().replace(",", ".");
  if (!str) return NaN;
  if (!/^[\d:.]+$/.test(str)) return NaN;
  const parts = str.split(":").map(Number);
  if (parts.some((p) => isNaN(p)) || parts.length > 3) return NaN;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}
function fmtBytes(b) {
  if (b == null) return "";
  const u = ["B", "KB", "MB", "GB"]; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ───────────── Settings (persisted) ───────────── */
const DEFAULTS = {
  theme: "linen", mode: "video", quality: "best", container: "mp4", audioFormat: "mp3", audioBitrate: "best",
  embedThumb: true, embedMeta: true, embedSubs: false, precise: true, outputDir: "",
};
const settings = (() => {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("hearth.settings") || "{}") }; }
  catch { return { ...DEFAULTS }; }
})();
const save = () => { try { localStorage.setItem("hearth.settings", JSON.stringify(settings)); } catch {} };

/* ───────────── State ───────────── */
const state = {
  info: null,         // MediaInfo from backend
  range: "full",      // "full" | "clip"
  start: 0, end: 0,   // current selection (seconds)
  clips: [],          // [{start,end}]
  selected: new Set(),// playlist indices
  duration: 0,
  jobs: new Map(),    // id -> {el, meta}
  fetching: false,
};

/* ───────────── Toasts ───────────── */
function toast(msg, kind = "info", ms = 3800) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === "ok" ? "check" : "alert")}<span>${esc(msg)}</span>`;
  $("toasts").appendChild(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 300); }, ms);
}

/* ───────────── Window chrome ───────────── */
function setupWindow() {
  const win = T.window?.getCurrentWindow?.();
  if (!win) return;
  $("winMin").onclick = () => win.minimize();
  $("winMax").onclick = () => win.toggleMaximize();
  $("winClose").onclick = () => win.close();
}

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
  $("themeBtn").innerHTML = icon(settings.theme === "linen" ? "moon" : "sun");
}
$("themeBtn").onclick = () => { settings.theme = settings.theme === "linen" ? "ember" : "linen"; applyTheme(); save(); };

/* ───────────── Engine status ───────────── */
async function refreshTools() {
  const chip = $("toolChip");
  try {
    const s = await invoke("tool_status");
    const ok = !!s.ytdlp;
    chip.className = `tool-chip ${ok && s.ffmpeg ? "ok" : "bad"}`;
    $("toolText").textContent = ok ? `yt-dlp ${s.ytdlp}${s.ffmpeg ? "" : " · no ffmpeg"}` : "yt-dlp missing";
    chip.title = `yt-dlp: ${s.ytdlp_path || "not found"}\nffmpeg: ${s.ffmpeg_path || "not found"}\n\nClick to update yt-dlp`;
  } catch (e) {
    chip.className = "tool-chip bad"; $("toolText").textContent = "Engine error";
  }
}
$("toolChip").onclick = async () => {
  const chip = $("toolChip");
  chip.className = "tool-chip busy"; $("toolText").textContent = "Updating yt-dlp…";
  try { toast(await invoke("update_ytdlp"), "ok"); }
  catch (e) { toast(String(e), "err", 6000); }
  refreshTools();
};

/* ───────────── URL + fetch ───────────── */
const urlInput = $("urlInput");
function looksLikeUrl(s) { return /^(https?:\/\/)?([\w-]+\.)+[\w-]+\/?\S*$/i.test(s.trim()); }
function detectPlaylist(url) {
  const hasList = /[?&]list=/.test(url) || /\/playlist\b/.test(url);
  const hasVideo = /[?&]v=|youtu\.be\/|\/shorts\//.test(url);
  $("plSwitch").checked = hasList && !hasVideo ? true : hasList && hasVideo ? $("plSwitch").checked : false;
  $("plSwitchWrap").style.visibility = hasList ? "visible" : "hidden";
}
urlInput.addEventListener("input", () => detectPlaylist(urlInput.value));
urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") fetchInfo(); });
$("fetchBtn").onclick = () => fetchInfo();
$("plSwitch").onchange = () => { if (state.info) fetchInfo(); };
$("pasteBtn").onclick = async () => {
  try {
    const t = await navigator.clipboard.readText();
    if (t) { urlInput.value = t.trim(); detectPlaylist(urlInput.value); fetchInfo(); }
  } catch { urlInput.focus(); toast("Press Ctrl+V to paste"); }
};
document.addEventListener("paste", (e) => {
  if (document.activeElement && ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
  const t = e.clipboardData?.getData("text")?.trim();
  if (t && looksLikeUrl(t)) { urlInput.value = t; detectPlaylist(t); fetchInfo(); }
});

function showStage(id) {
  for (const s of ["emptyState", "loadingState", "videoState", "playlistState"]) $(s).classList.toggle("hidden", s !== id);
}

async function fetchInfo() {
  const url = urlInput.value.trim();
  if (!url) { urlInput.focus(); return; }
  if (state.fetching) return;
  state.fetching = true;
  const btn = $("fetchBtn");
  btn.disabled = true; btn.innerHTML = `<svg class="spin"><use href="#i-refresh"/></svg><span>Fetching</span>`;
  resetVideo();
  showStage("loadingState");
  updateDlButton();
  try {
    const info = await invoke("fetch_info", { url, playlist: $("plSwitch").checked });
    state.info = info;
    if (info.kind === "playlist") renderPlaylist(info); else renderVideo(info);
  } catch (e) {
    state.info = null;
    showStage("emptyState");
    toast(String(e), "err", 7000);
  } finally {
    state.fetching = false;
    btn.disabled = false; btn.innerHTML = `<span>Fetch</span>${icon("arrow")}`;
    updateOptions();
  }
}

/* ───────────── Video + clip editor ───────────── */
const video = $("video"), player = $("player");

function resetVideo() {
  video.pause(); video.removeAttribute("src"); video.load();
  player.classList.remove("playing");
  state.clips = []; renderClips();
}

function renderVideo(info) {
  showStage("videoState");
  $("vTitle").textContent = info.title;
  $("vSub").textContent = [info.uploader, info.heights?.[0] ? `up to ${info.heights[0]}p` : null].filter(Boolean).join(" · ");
  state.duration = info.duration || 0;
  $("vDur").textContent = fmtTime(state.duration);
  $("totTime").textContent = fmtTime(state.duration);
  state.start = 0; state.end = state.duration;

  const poster = $("poster");
  if (info.thumbnail) { poster.src = info.thumbnail; video.poster = info.thumbnail; }
  $("noPreview").classList.add("hidden");
  poster.classList.add("hidden");
  $("bigPlay").classList.remove("hidden");

  if (info.preview_url) {
    video.src = info.preview_url;
    video.muted = false;
  } else {
    previewUnavailable();
  }
  updateMute();
  syncRangeUI();
}

function previewUnavailable() {
  $("poster").classList.remove("hidden");
  $("noPreview").classList.remove("hidden");
  $("bigPlay").classList.add("hidden");
}
video.addEventListener("error", () => { if (video.getAttribute("src")) previewUnavailable(); });
video.addEventListener("loadedmetadata", () => {
  if (!state.duration && isFinite(video.duration)) {
    state.duration = video.duration; state.end = video.duration;
    $("vDur").textContent = fmtTime(state.duration); $("totTime").textContent = fmtTime(state.duration);
    syncRangeUI();
  }
});
video.addEventListener("play", () => { player.classList.add("playing"); $("playBtn").innerHTML = icon("pause"); });
video.addEventListener("pause", () => { player.classList.remove("playing"); $("playBtn").innerHTML = icon("play"); });
video.addEventListener("timeupdate", () => {
  $("curTime").textContent = fmtTime(video.currentTime);
  placeHead();
  if (state.previewingClip && video.currentTime >= state.end) { video.pause(); state.previewingClip = false; }
});
video.addEventListener("progress", () => {
  try {
    const b = video.buffered; if (!b.length || !state.duration) return;
    $("tlBuffer").style.width = `${(b.end(b.length - 1) / state.duration) * 100}%`;
  } catch {}
});

const canPlay = () => !!video.getAttribute("src") && $("noPreview").classList.contains("hidden");
function togglePlay() { if (!canPlay()) return; video.paused ? video.play().catch(() => {}) : video.pause(); }
function seek(t) { t = Math.max(0, Math.min(state.duration, t)); if (canPlay()) video.currentTime = t; state.head = t; placeHead(); $("curTime").textContent = fmtTime(t); }
const now = () => (canPlay() ? video.currentTime : state.head || 0);
function updateMute() { $("muteBtn").innerHTML = icon(video.muted ? "mute" : "vol"); }

$("bigPlay").onclick = togglePlay;
video.onclick = togglePlay;
$("playBtn").onclick = togglePlay;
$("backBtn").onclick = () => seek(now() - 5);
$("fwdBtn").onclick = () => seek(now() + 5);
$("muteBtn").onclick = () => { video.muted = !video.muted; updateMute(); };
$("markIn").onclick = () => setRange(now(), state.end, true);
$("markOut").onclick = () => setRange(state.start, now(), true);
$("previewClip").onclick = () => {
  if (!canPlay()) return toast("Live preview isn’t available for this video");
  state.previewingClip = true; video.currentTime = state.start; video.play().catch(() => {});
};

/* Timeline geometry */
const tl = $("timeline");
const pct = (t) => (state.duration ? (t / state.duration) * 100 : 0);
function timeAt(clientX) {
  const r = tl.getBoundingClientRect();
  return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * state.duration;
}
function placeHead() { $("tlHead").style.left = `${pct(now())}%`; }

function setRange(a, b, switchToClip = false) {
  const MIN = 0.5;
  a = Math.max(0, Math.min(a, state.duration));
  b = Math.max(0, Math.min(b, state.duration));
  if (b - a < MIN) { if (a + MIN <= state.duration) b = a + MIN; else a = Math.max(0, b - MIN); }
  state.start = a; state.end = b;
  if (switchToClip && state.range !== "clip") setSeg("segRange", "clip");
  syncRangeUI();
}

function syncRangeUI() {
  const clip = state.range === "clip";
  tl.classList.toggle("full", !clip);
  $("editor").classList.toggle("disabled", !clip);
  const a = clip ? state.start : 0, b = clip ? state.end : state.duration;
  $("tlRange").style.left = `${pct(a)}%`;
  $("tlRange").style.width = `${pct(b) - pct(a)}%`;
  $("hStart").style.left = `${pct(state.start)}%`;
  $("hEnd").style.left = `${pct(state.end)}%`;
  if (document.activeElement !== $("inStart")) $("inStart").value = fmtTime(state.start, true);
  if (document.activeElement !== $("inEnd")) $("inEnd").value = fmtTime(state.end, true);
  $("clipLen").textContent = fmtTime(state.end - state.start, true);
  placeHead();
  updateSummary();
}

/* Dragging */
function drag(el, onMove) {
  el.addEventListener("pointerdown", (e) => {
    e.stopPropagation(); e.preventDefault();
    el.setPointerCapture(e.pointerId); el.classList.add("drag");
    const move = (ev) => onMove(timeAt(ev.clientX));
    const up = () => { el.classList.remove("drag"); el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
  });
}
drag($("hStart"), (t) => { setRange(Math.min(t, state.end - 0.5), state.end); seek(state.start); });
drag($("hEnd"), (t) => { setRange(state.start, Math.max(t, state.start + 0.5)); seek(state.end); });
tl.addEventListener("pointerdown", (e) => {
  if (!state.duration) return;
  tl.setPointerCapture(e.pointerId);
  seek(timeAt(e.clientX));
  const move = (ev) => seek(timeAt(ev.clientX));
  const up = () => { tl.removeEventListener("pointermove", move); tl.removeEventListener("pointerup", up); };
  tl.addEventListener("pointermove", move); tl.addEventListener("pointerup", up);
});
tl.addEventListener("pointermove", (e) => {
  const r = tl.getBoundingClientRect();
  const h = $("tlHover");
  h.style.left = `${Math.max(0, Math.min(r.width, e.clientX - r.left))}px`;
  h.textContent = fmtTime(timeAt(e.clientX));
});

/* Manual time inputs */
for (const [id, which] of [["inStart", "start"], ["inEnd", "end"]]) {
  const inp = $(id);
  const commit = () => {
    const v = parseTime(inp.value);
    if (isNaN(v)) { inp.classList.add("bad"); return; }
    inp.classList.remove("bad");
    if (which === "start") setRange(v, Math.max(state.end, v + 0.5), true);
    else setRange(Math.min(state.start, v - 0.5), v, true);
    inp.value = fmtTime(which === "start" ? state.start : state.end, true);
    seek(which === "start" ? state.start : state.end);
  };
  inp.addEventListener("change", commit);
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { commit(); inp.blur(); } if (e.key === "Escape") inp.blur(); });
  inp.addEventListener("input", () => inp.classList.toggle("bad", isNaN(parseTime(inp.value))));
}

/* Multiple clips */
$("addClip").onclick = () => {
  if (state.range !== "clip") setSeg("segRange", "clip");
  const c = { start: state.start, end: state.end };
  if (state.clips.some((x) => Math.abs(x.start - c.start) < 0.05 && Math.abs(x.end - c.end) < 0.05)) return toast("That clip is already in the list");
  state.clips.push(c);
  state.clips.sort((a, b) => a.start - b.start);
  renderClips();
};
function renderClips() {
  const list = $("clipList"); list.innerHTML = "";
  const segs = $("tlClips"); segs.innerHTML = "";
  state.clips.forEach((c, i) => {
    const chip = document.createElement("span");
    chip.className = "clip-chip";
    chip.innerHTML = `<i>#${i + 1}</i>${fmtTime(c.start, true)} → ${fmtTime(c.end, true)}<button title="Remove">${icon("x")}</button>`;
    chip.querySelector("button").onclick = () => { state.clips.splice(i, 1); renderClips(); };
    chip.ondblclick = () => { setRange(c.start, c.end, true); seek(c.start); };
    list.appendChild(chip);
    const s = document.createElement("div");
    s.className = "seg"; s.style.left = `${pct(c.start)}%`; s.style.width = `${pct(c.end) - pct(c.start)}%`;
    segs.appendChild(s);
  });
  updateSummary();
}

/* Keyboard shortcuts */
document.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || e.ctrlKey || e.metaKey || e.altKey) return;
  if ($("videoState").classList.contains("hidden")) return;
  const k = e.key.toLowerCase();
  const map = {
    " ": togglePlay, k: togglePlay,
    j: () => seek(now() - 5), l: () => seek(now() + 5),
    arrowleft: () => seek(now() - 1), arrowright: () => seek(now() + 1),
    i: () => $("markIn").click(), o: () => $("markOut").click(),
    m: () => $("muteBtn").click(), enter: () => $("addClip").click(),
  };
  if (map[k]) { e.preventDefault(); map[k](); }
});

/* ───────────── Playlist ───────────── */
function renderPlaylist(info) {
  showStage("playlistState");
  $("plTitle").textContent = info.title;
  $("plThumb").src = info.thumbnail || "";
  const total = info.entries.reduce((a, e) => a + (e.duration || 0), 0);
  $("plSub").textContent = [info.uploader, `${info.entries.length} videos`, total ? fmtTime(total) : null].filter(Boolean).join(" · ");
  state.selected = new Set(info.entries.map((e) => e.index));
  $("plFilter").value = "";
  const ul = $("plList"); ul.innerHTML = "";
  for (const e of info.entries) {
    const li = document.createElement("li");
    li.className = "pl-item"; li.dataset.idx = e.index; li.dataset.title = e.title.toLowerCase();
    li.innerHTML = `<span class="box">${icon("check")}</span><span class="idx">${e.index}</span>
      <img loading="lazy" src="${esc(e.thumbnail || "")}" alt="" onerror="this.style.visibility='hidden'"/>
      <span class="t">${esc(e.title)}</span><span class="d">${e.duration ? fmtTime(e.duration) : ""}</span>`;
    li.onclick = () => {
      state.selected.has(e.index) ? state.selected.delete(e.index) : state.selected.add(e.index);
      li.classList.toggle("off", !state.selected.has(e.index));
      plCount();
    };
    ul.appendChild(li);
  }
  plCount();
}
function plCount() {
  const n = state.selected.size, t = state.info?.entries.length || 0;
  $("plCount").textContent = `${n} of ${t} selected`;
  $("plAll").checked = n === t;
  updateSummary();
}
$("plAll").onchange = () => {
  const on = $("plAll").checked;
  state.selected = new Set(on ? state.info.entries.map((e) => e.index) : []);
  document.querySelectorAll(".pl-item").forEach((li) => li.classList.toggle("off", !on));
  plCount();
};
$("plFilter").oninput = () => {
  const q = $("plFilter").value.toLowerCase();
  document.querySelectorAll(".pl-item").forEach((li) => li.classList.toggle("hidden", q && !li.dataset.title.includes(q)));
};
/** [1,2,3,5,7,8] -> "1-3,5,7-8" */
function compressIndices(arr) {
  const s = [...arr].sort((a, b) => a - b), out = [];
  for (let i = 0; i < s.length; i++) {
    let j = i; while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`); i = j;
  }
  return out.join(",");
}

/* ───────────── Options panel ───────────── */
function setSeg(groupId, value) {
  const g = $(groupId);
  g.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === value));
  if (groupId === "segMode") settings.mode = value;
  if (groupId === "segRange") { state.range = value; syncRangeUI(); }
  updateOptions(); save();
}
function bindGroup(groupId, key, onChange) {
  $(groupId).addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || b.disabled) return;
    if (key) { settings[key] = b.dataset.v; save(); }
    $(groupId).querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    onChange?.(b.dataset.v);
    updateOptions();
  });
}
$("segMode").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setSeg("segMode", b.dataset.v); });
$("segRange").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b && !b.disabled) setSeg("segRange", b.dataset.v); });
bindGroup("chipQuality", "quality");
bindGroup("chipContainer", "container");
bindGroup("chipAudio", "audioFormat");
bindGroup("chipBitrate", "audioBitrate");
for (const [id, key] of [["tThumb", "embedThumb"], ["tMeta", "embedMeta"], ["tSubs", "embedSubs"], ["tPrecise", "precise"]]) {
  $(id).checked = settings[key];
  $(id).onchange = () => { settings[key] = $(id).checked; save(); updateSummary(); };
}
function restoreChips() {
  const pick = (g, v) => $(g).querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  pick("segMode", settings.mode); pick("chipQuality", settings.quality); pick("chipContainer", settings.container);
  pick("chipAudio", settings.audioFormat); pick("chipBitrate", settings.audioBitrate);
}

function updateOptions() {
  const audio = settings.mode === "audio";
  const info = state.info;
  const isPl = info?.kind === "playlist";
  $("fieldQuality").classList.toggle("hidden", audio);
  $("fieldContainer").classList.toggle("hidden", audio);
  $("fieldAudio").classList.toggle("hidden", !audio);
  $("fieldBitrate").classList.toggle("hidden", !audio || ["flac", "wav"].includes(settings.audioFormat));
  $("rowSubs").classList.toggle("hidden", audio || settings.container === "webm");
  $("fieldRange").classList.toggle("hidden", isPl);
  $("rowPrecise").classList.toggle("hidden", isPl || state.range !== "clip");
  $("segRange").querySelector('[data-v="clip"]').disabled = !info || isPl;

  // Disable qualities higher than the source offers.
  const max = info && !isPl && info.heights?.length ? info.heights[0] : Infinity;
  let needReset = false;
  $("chipQuality").querySelectorAll("button").forEach((b) => {
    if (b.dataset.v === "best") return;
    const tooHigh = +b.dataset.v > max * 1.05;
    b.disabled = tooHigh;
    if (tooHigh && b.classList.contains("on")) needReset = true;
  });
  if (needReset) { settings.quality = "best"; restoreChips(); }
  updateDlButton();
  updateSummary();
}

function updateDlButton() {
  const info = state.info;
  const ok = !!info && !state.fetching && (info.kind !== "playlist" || state.selected.size > 0);
  $("dlBtn").disabled = !ok;
  const audio = settings.mode === "audio";
  let label = "Download";
  if (info?.kind === "playlist") label = `Download ${state.selected.size} ${audio ? "tracks" : "videos"}`;
  else if (state.range === "clip") { const n = Math.max(1, state.clips.length); label = `Download ${n} clip${n > 1 ? "s" : ""}`; }
  else if (audio) label = "Download audio";
  $("dlLabel").textContent = label;
}

function updateSummary() {
  updateDlButton();
  if (!state.info) { $("summary").textContent = "Fetch a link to get started"; return; }
  const audio = settings.mode === "audio";
  const parts = [];
  if (audio) {
    parts.push(settings.audioFormat.toUpperCase());
    if (!["flac", "wav"].includes(settings.audioFormat)) parts.push(settings.audioBitrate === "best" ? "best quality" : `${settings.audioBitrate} kbps`);
  } else {
    parts.push(settings.quality === "best" ? "Best quality" : `${settings.quality}p`);
    parts.push(settings.container.toUpperCase());
  }
  if (state.info.kind !== "playlist" && state.range === "clip") {
    const clips = state.clips.length ? state.clips : [{ start: state.start, end: state.end }];
    const total = clips.reduce((a, c) => a + (c.end - c.start), 0);
    parts.push(`${clips.length > 1 ? clips.length + " clips · " : ""}${fmtTime(total)} total`);
  }
  $("summary").textContent = parts.join(" · ");
}

/* Output folder */
function showDir() {
  const p = settings.outputDir || "";
  const parts = p.split(/[\\/]/).filter(Boolean);
  $("dirText").textContent = !p ? "—" : parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : p;
  $("dirText").title = p;
}
$("dirBtn").onclick = async () => {
  const p = await invoke("pick_folder");
  if (p) { settings.outputDir = p; save(); showDir(); }
};

/* ───────────── Downloading ───────────── */
$("dlBtn").onclick = async () => {
  const info = state.info; if (!info) return;
  const isPl = info.kind === "playlist";
  const audio = settings.mode === "audio";
  const clip = !isPl && state.range === "clip";
  const sections = clip ? (state.clips.length ? state.clips : [{ start: state.start, end: state.end }]) : [];
  const all = isPl && state.selected.size === info.entries.length;

  const request = {
    url: info.webpage_url || urlInput.value.trim(),
    title: info.title,
    mode: settings.mode,
    playlist: isPl,
    playlistItems: isPl && !all ? compressIndices(state.selected) : null,
    quality: settings.quality,
    container: settings.container,
    audioFormat: settings.audioFormat,
    audioBitrate: settings.audioBitrate,
    sections,
    preciseCuts: clip && settings.precise,
    embedThumbnail: settings.embedThumb,
    embedMetadata: settings.embedMeta,
    embedSubs: !audio && settings.embedSubs,
    subLangs: "en.*,ar.*",
    outputDir: settings.outputDir,
  };
  try {
    const id = await invoke("start_download", { request });
    addJob(id, {
      title: info.title, thumb: info.thumbnail, dir: settings.outputDir,
      kind: isPl ? `${state.selected.size} items` : clip ? `${sections.length} clip${sections.length > 1 ? "s" : ""}` : audio ? "Audio" : "Video",
      fmt: audio ? settings.audioFormat.toUpperCase() : `${settings.quality === "best" ? "Best" : settings.quality + "p"} ${settings.container.toUpperCase()}`,
    });
    const b = $("dlBtn"); b.animate([{ transform: "scale(1)" }, { transform: "scale(.97)" }, { transform: "scale(1)" }], { duration: 260 });
  } catch (e) { toast(String(e), "err", 7000); }
};

function addJob(id, meta) {
  $("queueEmpty").classList.add("hidden");
  const li = document.createElement("li");
  li.className = "job indet";
  li.innerHTML = `<img src="${esc(meta.thumb || "logo.png")}" alt="" onerror="this.src='logo.png'"/>
    <div class="body"><div class="name" title="${esc(meta.title)}">${esc(meta.title)}</div>
      <div class="sub"><span class="st">Starting…</span></div>
      <div class="bar"><div class="fill"></div></div></div>
    <div class="acts"><button class="icon-btn act" title="Cancel">${icon("x")}</button></div>`;
  $("jobList").prepend(li);
  const job = { el: li, meta, status: "queued" };
  state.jobs.set(id, job);
  li.querySelector(".act").onclick = () => jobAction(id);
}

async function jobAction(id) {
  const job = state.jobs.get(id); if (!job) return;
  if (["downloading", "processing", "queued"].includes(job.status)) await invoke("cancel_download", { id });
  else if (job.status === "done") invoke("open_folder", { path: job.meta.dir }).catch((e) => toast(String(e), "err"));
  else { job.el.remove(); state.jobs.delete(id); if (!state.jobs.size) $("queueEmpty").classList.remove("hidden"); }
}

function onJobUpdate(u) {
  const job = state.jobs.get(u.id); if (!job) return;
  job.status = u.status;
  const el = job.el;
  el.className = `job ${u.status}`;
  const st = el.querySelector(".st");
  const fill = el.querySelector(".fill");
  const act = el.querySelector(".act");
  const item = u.itemCount ? `${u.itemIndex}/${u.itemCount} · ` : "";

  if (u.status === "downloading") {
    if (u.percent == null) el.classList.add("indet");
    fill.style.width = `${u.percent ?? 0}%`;
    const bits = [u.percent != null ? `${u.percent.toFixed(1)}%` : fmtBytes(u.downloaded)];
    if (u.speed) bits.push(`${fmtBytes(u.speed)}/s`);
    if (u.eta != null) bits.push(`${fmtTime(u.eta)} left`);
    st.textContent = item + bits.filter(Boolean).join(" · ");
  } else if (u.status === "processing") {
    el.classList.add("indet");
    st.textContent = item + (u.stage || "Processing…");
  } else if (u.status === "done") {
    st.textContent = `Saved · ${job.meta.kind} · ${job.meta.fmt}`;
    act.innerHTML = icon("folder"); act.title = "Show in folder";
    toast(`Finished: ${job.meta.title}`, "ok");
  } else if (u.status === "error") {
    st.textContent = u.error || "Something went wrong";
    act.innerHTML = icon("trash"); act.title = "Remove";
  } else if (u.status === "cancelled") {
    st.textContent = "Cancelled";
    act.innerHTML = icon("trash"); act.title = "Remove";
  }
}
$("clearDone").onclick = () => {
  for (const [id, j] of state.jobs) if (!["downloading", "processing", "queued"].includes(j.status)) { j.el.remove(); state.jobs.delete(id); }
  if (!state.jobs.size) $("queueEmpty").classList.remove("hidden");
};

/* ───────────── Boot ───────────── */
(async function init() {
  applyTheme();
  setupWindow();
  restoreChips();
  $("plSwitchWrap").style.visibility = "hidden";
  if (!settings.outputDir) { settings.outputDir = await invoke("default_dir").catch(() => ""); save(); }
  showDir();
  updateOptions();
  T.event.listen("job-update", (e) => onJobUpdate(e.payload));
  refreshTools();
  urlInput.focus();
})();
