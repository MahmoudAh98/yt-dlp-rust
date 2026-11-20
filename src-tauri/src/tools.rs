//! Locating and running the external tools (yt-dlp, ffmpeg).
//!
//! Lookup order for each tool:
//!   1. The app's bundled `tools/` resource folder (what the CI build ships)
//!   2. Next to the app executable (portable installs)
//!   3. Anything on the system PATH

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use tokio::process::Command;

#[cfg(windows)]
const EXE: &str = ".exe";
#[cfg(not(windows))]
const EXE: &str = "";

static BUNDLED: OnceLock<PathBuf> = OnceLock::new();

/// Called once at startup with `<resource_dir>/tools`.
pub fn set_bundled_dir(dir: PathBuf) {
    let _ = BUNDLED.set(dir);
}

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(Path::to_path_buf)
}

/// Find a tool by base name ("yt-dlp", "ffmpeg").
pub fn locate(name: &str) -> Option<PathBuf> {
    let file = format!("{name}{EXE}");
    let candidates = BUNDLED.get().cloned().into_iter().chain(exe_dir());
    for dir in candidates {
        let p = dir.join(&file);
        if p.is_file() {
            return Some(p);
        }
    }
    which::which(name).ok()
}

pub fn yt_dlp() -> Result<PathBuf, String> {
    locate("yt-dlp").ok_or_else(|| {
        "yt-dlp was not found. Reinstall Hearth or install yt-dlp and add it to your PATH.".into()
    })
}

/// Directory that contains ffmpeg (+ ffprobe), passed to yt-dlp via --ffmpeg-location.
pub fn ffmpeg_dir() -> Option<PathBuf> {
    locate("ffmpeg").and_then(|p| p.parent().map(Path::to_path_buf))
}

/// Build a Command with sane defaults: no console window on Windows, UTF-8 output.
pub fn command(program: &Path) -> Command {
    let mut cmd = Command::new(program);
    cmd.env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

#[derive(Serialize)]
pub struct ToolStatus {
    pub ytdlp: Option<String>,
    pub ytdlp_path: Option<String>,
    pub ffmpeg: Option<String>,
    pub ffmpeg_path: Option<String>,
}

async fn first_line(program: &Path, arg: &str) -> Option<String> {
    let out = command(program).arg(arg).output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .map(|s| s.trim().to_string())
}

pub async fn status() -> ToolStatus {
    let y = locate("yt-dlp");
    let f = locate("ffmpeg");
    let ytdlp = match &y {
        Some(p) => first_line(p, "--version").await,
        None => None,
    };
    let ffmpeg = match &f {
        Some(p) => first_line(p, "-version").await.map(|l| {
            // "ffmpeg version 7.1-... Copyright ..." -> "7.1-..."
            l.split_whitespace().nth(2).unwrap_or("found").to_string()
        }),
        None => None,
    };
    ToolStatus {
        ytdlp,
        ytdlp_path: y.map(|p| p.display().to_string()),
        ffmpeg,
        ffmpeg_path: f.map(|p| p.display().to_string()),
    }
}
