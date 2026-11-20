//! Metadata lookup: `yt-dlp -J --flat-playlist <url>`.

use crate::tools;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

#[derive(Serialize, Default)]
pub struct Entry {
    pub index: usize,
    pub id: String,
    pub title: String,
    pub duration: Option<f64>,
    pub url: String,
    pub thumbnail: Option<String>,
}

#[derive(Serialize, Default)]
pub struct MediaInfo {
    /// "video" or "playlist"
    pub kind: String,
    pub id: String,
    pub title: String,
    pub uploader: Option<String>,
    pub thumbnail: Option<String>,
    pub duration: Option<f64>,
    pub webpage_url: String,
    /// Direct, browser-playable stream used for the live preview.
    pub preview_url: Option<String>,
    pub preview_has_audio: bool,
    pub heights: Vec<u32>,
    pub entries: Vec<Entry>,
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_string)
}

fn best_thumb(v: &Value) -> Option<String> {
    if let Some(t) = s(v, "thumbnail") {
        return Some(t);
    }
    v.get("thumbnails")
        .and_then(Value::as_array)
        .and_then(|a| a.last())
        .and_then(|t| s(t, "url"))
}

/// Pick a progressive (audio+video) https stream, ideally mp4 ≤ 720p,
/// falling back to a video-only mp4 so the user can still scrub visually.
fn pick_preview(formats: &[Value]) -> (Option<String>, bool) {
    let mut best: Option<(i64, String, bool)> = None;
    for f in formats {
        let proto = s(f, "protocol").unwrap_or_default();
        if !proto.starts_with("http") || proto.contains("m3u8") || proto.contains("dash") {
            continue;
        }
        let Some(url) = s(f, "url") else { continue };
        let v = s(f, "vcodec").unwrap_or_default();
        let a = s(f, "acodec").unwrap_or_default();
        if v == "none" || v.is_empty() {
            continue;
        }
        let ext = s(f, "ext").unwrap_or_default();
        let h = f.get("height").and_then(Value::as_i64).unwrap_or(0);
        let has_audio = a != "none" && !a.is_empty();
        let browser_ok = ext == "mp4" && (v.starts_with("avc") || v.starts_with("h264"));
        if !browser_ok || h > 720 {
            continue;
        }
        // Score: audio matters most, then resolution.
        let score = (has_audio as i64) * 10_000 + h;
        if best.as_ref().map_or(true, |b| score > b.0) {
            best = Some((score, url, has_audio));
        }
    }
    match best {
        Some((_, u, a)) => (Some(u), a),
        None => (None, false),
    }
}

pub fn parse(v: &Value) -> MediaInfo {
    let is_playlist = s(v, "_type").as_deref() == Some("playlist") || v.get("entries").is_some();
    let mut info = MediaInfo {
        kind: if is_playlist { "playlist" } else { "video" }.into(),
        id: s(v, "id").unwrap_or_default(),
        title: s(v, "title").unwrap_or_else(|| "Untitled".into()),
        uploader: s(v, "uploader").or_else(|| s(v, "channel")),
        thumbnail: best_thumb(v),
        duration: v.get("duration").and_then(Value::as_f64),
        webpage_url: s(v, "webpage_url").or_else(|| s(v, "original_url")).unwrap_or_default(),
        ..Default::default()
    };

    if is_playlist {
        if let Some(arr) = v.get("entries").and_then(Value::as_array) {
            for (i, e) in arr.iter().enumerate() {
                let id = s(e, "id").unwrap_or_default();
                let url = s(e, "url")
                    .filter(|u| u.starts_with("http"))
                    .unwrap_or_else(|| format!("https://www.youtube.com/watch?v={id}"));
                info.entries.push(Entry {
                    index: i + 1,
                    title: s(e, "title").unwrap_or_else(|| format!("Item {}", i + 1)),
                    duration: e.get("duration").and_then(Value::as_f64),
                    thumbnail: best_thumb(e),
                    id,
                    url,
                });
            }
        }
        if info.thumbnail.is_none() {
            info.thumbnail = info.entries.first().and_then(|e| e.thumbnail.clone());
        }
    } else if let Some(formats) = v.get("formats").and_then(Value::as_array) {
        let (url, audio) = pick_preview(formats);
        info.preview_url = url;
        info.preview_has_audio = audio;
        let mut hs: Vec<u32> = formats
            .iter()
            .filter(|f| s(f, "vcodec").map_or(false, |c| c != "none"))
            .filter_map(|f| f.get("height").and_then(Value::as_u64).map(|h| h as u32))
            .collect();
        hs.sort_unstable_by(|a, b| b.cmp(a));
        hs.dedup();
        info.heights = hs;
    }
    info
}

pub fn last_error(stderr: &str) -> String {
    stderr
        .lines()
        .rev()
        .find(|l| l.contains("ERROR"))
        .map(|l| l.trim().trim_start_matches("ERROR:").trim().to_string())
        .unwrap_or_else(|| {
            let t = stderr.trim();
            if t.is_empty() { "yt-dlp failed without an error message".into() } else { t.lines().last().unwrap_or(t).to_string() }
        })
}

pub async fn fetch(url: &str, playlist: bool) -> Result<MediaInfo, String> {
    let bin = tools::yt_dlp()?;
    let mut cmd = tools::command(&bin);
    cmd.args(["-J", "--flat-playlist", "--no-warnings"])
        .arg(if playlist { "--yes-playlist" } else { "--no-playlist" })
        .arg("--")
        .arg(url);
    let out = tokio::time::timeout(Duration::from_secs(120), cmd.output())
        .await
        .map_err(|_| "Timed out while reading video info".to_string())?
        .map_err(|e| format!("Could not start yt-dlp: {e}"))?;
    if !out.status.success() {
        return Err(last_error(&String::from_utf8_lossy(&out.stderr)));
    }
    let v: Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("Unexpected yt-dlp output: {e}"))?;
    Ok(parse(&v))
}
