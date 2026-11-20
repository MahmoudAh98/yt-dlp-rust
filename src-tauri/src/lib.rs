mod download;
mod info;
mod tools;

use download::{DownloadRequest, Jobs};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
async fn tool_status() -> tools::ToolStatus {
    tools::status().await
}

#[tauri::command]
async fn fetch_info(url: String, playlist: bool) -> Result<info::MediaInfo, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("Paste a link first".into());
    }
    info::fetch(url, playlist).await
}

#[tauri::command]
fn start_download(app: AppHandle, jobs: State<'_, Jobs>, request: DownloadRequest) -> Result<u64, String> {
    download::start(app, &jobs, request)
}

#[tauri::command]
fn cancel_download(jobs: State<'_, Jobs>, id: u64) -> bool {
    jobs.cancel(id)
}

#[tauri::command]
fn default_dir(app: AppHandle) -> String {
    app.path()
        .download_dir()
        .or_else(|_| app.path().home_dir())
        .map(|p| p.display().to_string())
        .unwrap_or_default()
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("Choose download folder")
        .blocking_pick_folder()
        .map(|p| p.to_string())
}

#[tauri::command]
fn open_folder(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
async fn update_ytdlp() -> Result<String, String> {
    let bin = tools::yt_dlp()?;
    let out = tools::command(&bin).arg("-U").output().await.map_err(|e| e.to_string())?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    let last = text.lines().filter(|l| !l.trim().is_empty()).last().unwrap_or("Done").trim().to_string();
    if out.status.success() { Ok(last) } else { Err(last) }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Jobs::default())
        .setup(|app| {
            if let Ok(dir) = app.path().resource_dir() {
                tools::set_bundled_dir(dir.join("tools"));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            tool_status,
            fetch_info,
            start_download,
            cancel_download,
            default_dir,
            pick_folder,
            open_folder,
            update_ytdlp
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hearth");
}
