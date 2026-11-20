//! Building yt-dlp arguments and running download jobs with live progress.

use crate::{info, tools};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, oneshot};

pub const PROGRESS_EVENT: &str = "job-update";
const P_TAG: &str = "[[HP]]";

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub start: f64,
    pub end: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub url: String,
    /// Display title (informational; the UI keeps its own copy).
    #[serde(default)]
    #[allow(dead_code)]
    pub title: Option<String>,
    /// "video" | "audio"
    pub mode: String,
    #[serde(default)]
    pub playlist: bool,
    #[serde(default)]
    pub playlist_items: Option<String>,
    /// "best" or a max height like "1080"
    #[serde(default = "d_best")]
    pub quality: String,
    /// "mp4" | "mkv" | "webm"
    #[serde(default = "d_mp4")]
    pub container: String,
    /// "mp3" | "m4a" | "opus" | "flac" | "wav"
    #[serde(default = "d_mp3")]
    pub audio_format: String,
    /// "best" or kbps like "320"
    #[serde(default = "d_best")]
    pub audio_bitrate: String,
    #[serde(default)]
    pub sections: Vec<Section>,
    #[serde(default)]
    pub precise_cuts: bool,
    #[serde(default)]
    pub embed_thumbnail: bool,
    #[serde(default)]
    pub embed_metadata: bool,
    #[serde(default)]
    pub embed_subs: bool,
    #[serde(default)]
    pub sub_langs: Option<String>,
    pub output_dir: String,
}

fn d_best() -> String { "best".into() }
fn d_mp4() -> String { "mp4".into() }
fn d_mp3() -> String { "mp3".into() }

/// Seconds -> "HH:MM:SS.mmm" for --download-sections.
pub fn ts(secs: f64) -> String {
    let secs = secs.max(0.0);
    let ms = (secs * 1000.0).round() as u64;
    format!("{:02}:{:02}:{:02}.{:03}", ms / 3_600_000, (ms / 60_000) % 60, (ms / 1000) % 60, ms % 1000)
}

pub fn build_args(req: &DownloadRequest, ffmpeg_dir: Option<PathBuf>) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    let mut push = |s: &str| a.push(s.to_string());

    push("--newline");
    push("--progress");
    push("--no-mtime");
    push("--windows-filenames");
    push("--concurrent-fragments");
    push("4");
    push("--progress-template");
    a.push(format!(
        "download:{P_TAG}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s"
    ));

    if let Some(dir) = ffmpeg_dir {
        a.push("--ffmpeg-location".into());
        a.push(dir.display().to_string());
    }

    a.push("-P".into());
    a.push(req.output_dir.clone());

    // Scope
    let clipping = !req.playlist && !req.sections.is_empty();
    if req.playlist {
        a.push("--yes-playlist".into());
        a.push("--ignore-errors".into());
        if let Some(items) = req.playlist_items.as_ref().filter(|s| !s.trim().is_empty()) {
            a.push("--playlist-items".into());
            a.push(items.trim().to_string());
        }
    } else {
        a.push("--no-playlist".into());
    }

    // Output template
    let base = if req.playlist {
        "%(playlist_title|Playlist)s/%(playlist_index)03d - %(title)s"
    } else {
        "%(title)s"
    };
    let tmpl = if clipping {
        format!("{base} [%(section_start>%H-%M-%S)s - %(section_end>%H-%M-%S)s].%(ext)s")
    } else {
        format!("{base}.%(ext)s")
    };
    a.push("-o".into());
    a.push(tmpl);

    // Format
    let audio_fmt = req.audio_format.as_str();
    if req.mode == "audio" {
        a.push("-f".into());
        a.push("ba/b".into());
        a.push("-x".into());
        a.push("--audio-format".into());
        a.push(audio_fmt.to_string());
        a.push("--audio-quality".into());
        a.push(match req.audio_bitrate.as_str() {
            "best" | "" => "0".to_string(),
            k => format!("{k}K"),
        });
    } else {
        a.push("-f".into());
        a.push("bv*+ba/b".into());
        let mut sort: Vec<String> = Vec::new();
        if let Ok(h) = req.quality.parse::<u32>() {
            sort.push(format!("res:{h}"));
        }
        match req.container.as_str() {
            "mp4" => sort.push("ext:mp4:m4a".into()),
            "webm" => sort.push("ext:webm:webm".into()),
            _ => {}
        }
        if !sort.is_empty() {
            a.push("-S".into());
            a.push(sort.join(","));
        }
        a.push("--merge-output-format".into());
        a.push(req.container.clone());
        if req.embed_subs && req.container != "webm" {
            a.push("--embed-subs".into());
            a.push("--sub-langs".into());
            a.push(req.sub_langs.clone().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "en.*".into()));
        }
    }

    if req.embed_metadata {
        a.push("--embed-metadata".into());
    }
    let thumb_ok = if req.mode == "audio" {
        matches!(audio_fmt, "mp3" | "m4a" | "opus" | "flac")
    } else {
        req.container != "webm"
    };
    if req.embed_thumbnail && thumb_ok {
        a.push("--embed-thumbnail".into());
        a.push("--convert-thumbnails".into());
        a.push("jpg".into());
    }

    // Clip sections
    if clipping {
        for s in &req.sections {
            if s.end > s.start {
                a.push("--download-sections".into());
                a.push(format!("*{}-{}", ts(s.start), ts(s.end)));
            }
        }
        if req.precise_cuts {
            a.push("--force-keyframes-at-cuts".into());
        }
    }

    a.push("--".into());
    a.push(req.url.clone());
    a
}

// ───────────────────────────── progress parsing ─────────────────────────────

#[derive(Serialize, Clone, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobUpdate {
    pub id: u64,
    /// queued | downloading | processing | done | error | cancelled
    pub status: String,
    pub percent: Option<f64>,
    pub downloaded: Option<f64>,
    pub total: Option<f64>,
    pub speed: Option<f64>,
    pub eta: Option<f64>,
    pub item_index: Option<u32>,
    pub item_count: Option<u32>,
    pub stage: Option<String>,
    pub filename: Option<String>,
    pub error: Option<String>,
}

fn num(s: &str) -> Option<f64> {
    let s = s.trim();
    if s.is_empty() || s == "NA" || s == "None" { None } else { s.parse().ok() }
}

/// Apply one line of yt-dlp output to the job state. Returns true if something changed.
pub fn apply_line(st: &mut JobUpdate, line: &str) -> bool {
    let line = line.trim_end_matches(['\r', '\n']);
    if let Some(rest) = line.split_once(P_TAG).map(|(_, r)| r) {
        let p: Vec<&str> = rest.split('|').collect();
        let get = |i: usize| p.get(i).and_then(|v| num(v));
        st.status = "downloading".into();
        st.stage = None;
        st.downloaded = get(0);
        st.total = get(1).or(get(2));
        st.speed = get(3);
        st.eta = get(4);
        st.percent = match (st.downloaded, st.total) {
            (Some(d), Some(t)) if t > 0.0 => Some((d / t * 100.0).clamp(0.0, 100.0)),
            _ => None,
        };
        return true;
    }
    let l = line.trim();
    if let Some(r) = l.strip_prefix("[download] Downloading item ").or_else(|| l.strip_prefix("[download] Downloading video ")) {
        if let Some((i, n)) = r.split_once(" of ") {
            st.item_index = i.trim().parse().ok();
            st.item_count = n.trim().parse().ok();
            st.percent = Some(0.0);
            return true;
        }
    }
    if let Some(p) = l.strip_prefix("[download] Destination: ") {
        st.filename = PathBuf::from(p).file_name().map(|f| f.to_string_lossy().to_string());
        return true;
    }
    if l.starts_with("[download] ") && l.ends_with("has already been downloaded") {
        st.stage = Some("Already downloaded".into());
        st.percent = Some(100.0);
        return true;
    }
    let stage = if l.starts_with("[Merger]") {
        Some("Merging audio & video")
    } else if l.starts_with("[ExtractAudio]") {
        Some("Converting audio")
    } else if l.starts_with("[EmbedThumbnail]") || l.starts_with("[ThumbnailsConvertor]") {
        Some("Embedding artwork")
    } else if l.starts_with("[Metadata]") {
        Some("Writing metadata")
    } else if l.starts_with("[EmbedSubtitle]") {
        Some("Embedding subtitles")
    } else if l.starts_with("[Fixup") || l.starts_with("[VideoRemuxer]") || l.starts_with("[VideoConvertor]") {
        Some("Finalizing")
    } else if l.starts_with("[info]") && l.contains("time ranges") {
        Some("Cutting clip")
    } else {
        None
    };
    if let Some(s) = stage {
        st.status = "processing".into();
        st.stage = Some(s.into());
        return true;
    }
    false
}

// ───────────────────────────── job registry ─────────────────────────────

#[derive(Default)]
pub struct Jobs {
    next: AtomicU64,
    cancel: Mutex<HashMap<u64, oneshot::Sender<()>>>,
}

impl Jobs {
    pub fn cancel(&self, id: u64) -> bool {
        self.cancel.lock().unwrap().remove(&id).map(|tx| tx.send(()).is_ok()).unwrap_or(false)
    }
}

pub fn start(app: AppHandle, jobs: &Jobs, req: DownloadRequest) -> Result<u64, String> {
    let bin = tools::yt_dlp()?;
    if !PathBuf::from(&req.output_dir).is_dir() {
        std::fs::create_dir_all(&req.output_dir).map_err(|e| format!("Cannot use folder: {e}"))?;
    }
    let ffdir = tools::ffmpeg_dir();
    if ffdir.is_none() && (req.mode == "audio" || !req.sections.is_empty()) {
        return Err("ffmpeg is required for audio extraction and clips, but it was not found.".into());
    }
    let args = build_args(&req, ffdir);
    let id = jobs.next.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = oneshot::channel();
    jobs.cancel.lock().unwrap().insert(id, tx);

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = run(&app2, id, bin, args, rx).await;
        let mut fin = JobUpdate { id, ..Default::default() };
        match result {
            Ok(true) => { fin.status = "done".into(); fin.percent = Some(100.0); }
            Ok(false) => fin.status = "cancelled".into(),
            Err(e) => { fin.status = "error".into(); fin.error = Some(e); }
        }
        let _ = app2.emit(PROGRESS_EVENT, fin);
        if let Some(jobs) = tauri::Manager::try_state::<Jobs>(&app2) {
            jobs.cancel.lock().unwrap().remove(&id);
        }
    });
    Ok(id)
}

/// Ok(true) = finished, Ok(false) = cancelled.
async fn run(app: &AppHandle, id: u64, bin: PathBuf, args: Vec<String>, mut cancel: oneshot::Receiver<()>) -> Result<bool, String> {
    let mut child = tools::command(&bin)
        .args(&args)
        .spawn()
        .map_err(|e| format!("Could not start yt-dlp: {e}"))?;

    let (ltx, mut lrx) = mpsc::unbounded_channel::<(bool, String)>();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    for (is_err, reader) in [(false, Box::new(stdout) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), (true, Box::new(stderr))] {
        let tx = ltx.clone();
        tokio::spawn(async move {
            let mut r = BufReader::new(reader);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match r.read_until(b'\n', &mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => { let _ = tx.send((is_err, String::from_utf8_lossy(&buf).into_owned())); }
                }
            }
        });
    }
    drop(ltx);

    let mut st = JobUpdate { id, status: "downloading".into(), ..Default::default() };
    let mut stderr_log = String::new();
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let _ = app.emit(PROGRESS_EVENT, st.clone());

    loop {
        tokio::select! {
            _ = &mut cancel => {
                let _ = child.kill().await;
                return Ok(false);
            }
            msg = lrx.recv() => match msg {
                Some((is_err, line)) => {
                    if is_err {
                        if stderr_log.len() < 64 * 1024 { stderr_log.push_str(&line); }
                        continue;
                    }
                    let is_progress = line.contains(P_TAG);
                    if apply_line(&mut st, &line) {
                        // Throttle progress spam; always send stage changes.
                        if !is_progress || last_emit.elapsed() >= Duration::from_millis(120) {
                            last_emit = Instant::now();
                            let _ = app.emit(PROGRESS_EVENT, st.clone());
                        }
                    }
                }
                None => break,
            }
        }
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;
    if status.success() {
        Ok(true)
    } else {
        Err(info::last_error(&stderr_log))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> DownloadRequest {
        DownloadRequest {
            url: "https://youtu.be/x".into(), title: None, mode: "video".into(), playlist: false,
            playlist_items: None, quality: "1080".into(), container: "mp4".into(),
            audio_format: "mp3".into(), audio_bitrate: "best".into(), sections: vec![],
            precise_cuts: false, embed_thumbnail: true, embed_metadata: true, embed_subs: false,
            sub_langs: None, output_dir: "/tmp/out".into(),
        }
    }

    #[test]
    fn timestamps() {
        assert_eq!(ts(0.0), "00:00:00.000");
        assert_eq!(ts(3725.5), "01:02:05.500");
    }

    #[test]
    fn video_args() {
        let a = build_args(&req(), None);
        let j = a.join(" ");
        assert!(j.contains("-S res:1080,ext:mp4:m4a"));
        assert!(j.contains("--merge-output-format mp4"));
        assert!(j.contains("--no-playlist"));
        assert_eq!(a.last().unwrap(), "https://youtu.be/x");
    }

    #[test]
    fn clip_args() {
        let mut r = req();
        r.sections = vec![Section { start: 61.0, end: 90.25 }];
        r.precise_cuts = true;
        let j = build_args(&r, None).join(" ");
        assert!(j.contains("--download-sections *00:01:01.000-00:01:30.250"));
        assert!(j.contains("--force-keyframes-at-cuts"));
        assert!(j.contains("section_start"));
    }

    #[test]
    fn audio_playlist_args() {
        let mut r = req();
        r.mode = "audio".into();
        r.playlist = true;
        r.playlist_items = Some("1,3-5".into());
        r.audio_bitrate = "320".into();
        let j = build_args(&r, None).join(" ");
        assert!(j.contains("-x --audio-format mp3 --audio-quality 320K"));
        assert!(j.contains("--playlist-items 1,3-5"));
        assert!(j.contains("%(playlist_index)03d"));
    }

    /// Prints the yt-dlp argv for a JSON request in $HEARTH_REQ (used for end-to-end checks).
    #[test]
    #[ignore]
    fn print_args() {
        let r: DownloadRequest = serde_json::from_str(&std::env::var("HEARTH_REQ").unwrap()).unwrap();
        let dir = std::env::var("HEARTH_FF").ok().map(PathBuf::from);
        for a in build_args(&r, dir) { println!("ARG\t{a}"); }
    }

    #[test]
    fn parse_progress() {
        let mut st = JobUpdate::default();
        assert!(apply_line(&mut st, "[[HP]]500|1000|NA|2048.5|12\n"));
        assert_eq!(st.percent, Some(50.0));
        assert_eq!(st.speed, Some(2048.5));
        assert!(apply_line(&mut st, "[[HP]]10|NA|40|NA|NA"));
        assert_eq!(st.percent, Some(25.0));
        assert!(apply_line(&mut st, "[download] Downloading item 3 of 12"));
        assert_eq!((st.item_index, st.item_count), (Some(3), Some(12)));
        assert!(apply_line(&mut st, "[Merger] Merging formats into \"a.mp4\""));
        assert_eq!(st.status, "processing");
        assert!(!apply_line(&mut st, "[youtube] abc: Downloading webpage"));
    }
}
