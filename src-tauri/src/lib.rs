mod capture;
mod clip;
mod clip_export;
mod db;
mod dock;
mod ingest;

use arboard::{Clipboard, ImageData};
use capture::PathFact;
use clip::{hold_writes, ignored_list, PAUSED};
use image::ImageEncoder;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, State, WindowEvent};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutEvent, ShortcutState,
};

struct PauseItem(CheckMenuItem<tauri::Wry>);

static HIDE_GEN: AtomicU64 = AtomicU64::new(0);

fn show_window(app: &tauri::AppHandle) {
    HIDE_GEN.fetch_add(1, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = window.emit("window-shown", ());
    }
}

fn hide_animated(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let gen = HIDE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = window.emit("window-will-hide", ());
    let win = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(220));
        if HIDE_GEN.load(Ordering::SeqCst) != gen {
            return;
        }
        let _ = win.hide();
    });
}

fn toggle_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        match window.is_visible() {
            Ok(true) => hide_animated(app),
            _ => show_window(app),
        }
    }
}

fn on_shortcut(app: &tauri::AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    if event.state != ShortcutState::Pressed {
        return;
    }
    if shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, Code::KeyA) {
        capture::grab_explorer(app);
        return;
    }
    toggle_window(app);
}

/// 呼出窗口的全局快捷键候选，按顺序试：`Alt+Space` 是默认，被别的软件占了（或注册
/// 失败）就退到 `Ctrl+Alt+Space`。第二个值是托盘菜单里给人看的写法。
const SHORTCUT_CANDIDATES: [(&str, &str); 2] = [
    ("alt+space", "Alt+Space"),
    ("ctrl+alt+space", "Ctrl+Alt+Space"),
];

/// 装好全局快捷键插件并按候选顺序注册呼出热键，返回托盘菜单里显示的那行字：
/// 真正生效的组合，或者两个都没成时的失败说明（失败不静默）。
///
/// `Ctrl+Alt+A`（读取资源管理器里选中的文件）是附加功能，被占用不该连累呼出键，
/// 所以它失败只打印，不参与 fallback。
fn register_shortcuts(app: &tauri::AppHandle) -> String {
    // 插件的 setup 会 manage 全局快捷键状态，得先装好，后面才拿得到 global_shortcut()。
    if let Err(err) = app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(on_shortcut)
            .build(),
    ) {
        eprintln!("全局快捷键插件加载失败：{err}");
        return "Shortcut registration failed".to_string();
    }

    if let Err(err) = app.global_shortcut().register("ctrl+alt+a") {
        eprintln!("Ctrl+Alt+A 未注册（跳过，不影响呼出键）：{err}");
    }

    for (accelerator, label) in SHORTCUT_CANDIDATES {
        match app.global_shortcut().register(accelerator) {
            Ok(()) => return format!("Shortcut: {label}"),
            Err(err) => eprintln!("全局快捷键 {label} 未注册（可能已被占用）：{err}"),
        }
    }

    "Shortcut registration failed".to_string()
}

fn toggle_pause(app: &tauri::AppHandle) {
    let next = !PAUSED.load(std::sync::atomic::Ordering::SeqCst);
    PAUSED.store(next, std::sync::atomic::Ordering::SeqCst);
    if let Some(item) = app.try_state::<PauseItem>() {
        let _ = item.0.set_checked(next);
    }
    let _ = app.emit("clipboard-paused", serde_json::json!({ "paused": next }));
}

#[tauri::command]
fn state_load(db: State<db::Db>) -> Result<Option<String>, String> {
    db::load(&db)
}

// async: 整份状态写 SQLite，不占主线程（同步命令会在主线程上跑）。
#[tauri::command]
async fn state_save(db: State<'_, db::Db>, value: String) -> Result<(), String> {
    db::save(&db, &value)
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    open::that(&path).map_err(|err| err.to_string())
}

/// 把路径整理成资源管理器认得的写法：斜杠改反斜杠，去掉 \\?\ 前缀。
fn normalize_win_path(path: &str) -> String {
    let p = path.trim().replace('/', "\\");
    if let Some(rest) = p.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{rest}")
    } else if let Some(rest) = p.strip_prefix("\\\\?\\") {
        rest.to_string()
    } else {
        p
    }
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let normalized = normalize_win_path(&path);
    let target = Path::new(&normalized);
    // 文件还在就选中它；文件没了但文件夹还在，就只打开文件夹。
    let (select, folder) = if target.exists() {
        (true, target.to_path_buf())
    } else if let Some(parent) = target.parent().filter(|p| !p.as_os_str().is_empty() && p.is_dir()) {
        (false, parent.to_path_buf())
    } else {
        return Err("文件已不在，点重新定位".into());
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("explorer");
        // raw_arg：整段自己加引号，避免 Rust 把 /select,路径 整体包进引号，让 explorer 解析失败。
        if select {
            cmd.raw_arg(format!("/select,\"{}\"", folder.display()));
        } else {
            cmd.raw_arg(format!("\"{}\"", folder.display()));
        }
        cmd.spawn().map_err(|err| err.to_string())?;
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        let dir = if select { folder.parent().map(Path::to_path_buf).unwrap_or(folder) } else { folder };
        open::that(dir).map_err(|err| err.to_string())
    }
}


#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    hold_writes();
    let mut clipboard = Clipboard::new().map_err(|err| err.to_string())?;
    clipboard.set_text(text).map_err(|err| err.to_string())
}

#[tauri::command]
async fn copy_image(data_url: String, original_path: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let image = if let Some(ref path) = original_path {
            let path = Path::new(path);
            if path.is_file() {
                image::open(path).map_err(|err| format!("读不了原图：{err}"))?
            } else {
                let bytes = decode_data_url(&data_url)?;
                image::load_from_memory(&bytes).map_err(|err| err.to_string())?
            }
        } else {
            let bytes = decode_data_url(&data_url)?;
            image::load_from_memory(&bytes).map_err(|err| err.to_string())?
        };
        let rgba = image.to_rgba8();
        hold_writes();
        let mut clipboard = Clipboard::new().map_err(|err| err.to_string())?;
        clipboard
            .set_image(ImageData {
                width: rgba.width() as usize,
                height: rgba.height() as usize,
                bytes: std::borrow::Cow::Owned(rgba.into_raw()),
            })
            .map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
fn pick_file() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("重新定位")
        .pick_file()
        .map(|path| path.display().to_string())
}

#[tauri::command]
async fn missing_paths(paths: Vec<String>) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .filter(|path| !path.is_empty() && !Path::new(path).exists())
            .collect()
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
fn file_size(path: String) -> Option<u64> {
    std::fs::metadata(path).ok().map(|meta| meta.len())
}

#[tauri::command]
fn image_thumb(path: String) -> Option<String> {
    let lower = path.to_lowercase();
    if ![".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]
        .iter()
        .any(|ext| lower.ends_with(ext))
    {
        return None;
    }
    let meta = std::fs::metadata(&path).ok()?;
    if meta.len() > 20 * 1024 * 1024 {
        return None;
    }
    let image = image::open(&path).ok()?;
    let thumb = image.thumbnail(128, 128).to_rgba8();
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(thumb.as_raw(), thumb.width(), thumb.height(), image::ExtendedColorType::Rgba8)
        .ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, png)
    ))
}

#[tauri::command]
fn set_clipboard_paused(app: tauri::AppHandle, paused: bool) {
    PAUSED.store(paused, std::sync::atomic::Ordering::SeqCst);
    if let Some(item) = app.try_state::<PauseItem>() {
        let _ = item.0.set_checked(paused);
    }
}

#[tauri::command]
fn set_ignored_apps(names: Vec<String>) {
    if let Ok(mut list) = ignored_list().lock() {
        *list = names
            .into_iter()
            .map(|name| name.trim().to_lowercase())
            .filter(|name| name.len() > 1)
            .collect();
    }
}

fn decode_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    let encoded = data_url.split_once(',').map(|(_, data)| data).unwrap_or(data_url);
    base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded).map_err(|err| err.to_string())
}

#[tauri::command]
fn take_pending_sends() -> Vec<String> {
    capture::take_pending()
}

#[tauri::command]
fn probe_paths(paths: Vec<String>) -> Vec<PathFact> {
    paths.iter().map(|path| capture::probe_one(path)).collect()
}

#[tauri::command]
fn read_user_file(path: String) -> Result<String, String> {
    capture::read_user_file(&path)
}

#[tauri::command]
async fn remove_user_file(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || capture::remove_user_file(&path))
        .await
        .map_err(|err| err.to_string())?
}

/// 原生选文件夹（项目的存放位置）。挂在主窗口上，免得被置顶窗口盖住。
#[tauri::command]
async fn pick_folder(window: tauri::WebviewWindow, title: Option<String>) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title(title.unwrap_or_else(|| "选择文件夹".to_string()))
            .set_parent(&window)
            .pick_folder()
            .map(|path| path.display().to_string())
    })
    .await
    .ok()
    .flatten()
}

/// 原生多选文件，返回真实路径（浏览器的文件框拿不到路径，复制/移动靠它）。
#[tauri::command]
async fn pick_files(window: tauri::WebviewWindow) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title("选择要放进项目的文件")
            .set_parent(&window)
            .pick_files()
            .map(|paths| paths.into_iter().map(|path| path.display().to_string()).collect())
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

/// 把一个文件真正复制/移动进项目文件夹。放后台线程，大文件不会卡住界面。
#[tauri::command]
async fn ingest_file(src: String, dest_dir: String, mode: String) -> Result<ingest::IngestResult, String> {
    let mode = ingest::Mode::parse(&mode)?;
    tauri::async_runtime::spawn_blocking(move || ingest::ingest(&src, &dest_dir, mode))
        .await
        .map_err(|err| err.to_string())?
}

/// 项目里已有副本、原文件还在时，核对内容一致后移走原文件。
#[tauri::command]
async fn settle_move(src: String, kept: String) -> Result<ingest::SettleResult, String> {
    tauri::async_runtime::spawn_blocking(move || ingest::settle_move(&src, &kept))
        .await
        .map_err(|err| err.to_string())?
}
#[tauri::command]
async fn read_file_chunk(path: String, offset: u64, len: usize) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ingest::read_chunk(&path, offset, len))
        .await
        .map_err(|err| err.to_string())?
}

/// 放进回收站。async + 后台线程：原先是同步命令，还要起一个 PowerShell（实测 3 秒多），整段时间界面都在等。
#[tauri::command]
async fn trash_paths(paths: Vec<String>) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || trash_blocking(paths))
        .await
        .map_err(|err| err.to_string())?
}

fn trash_blocking(paths: Vec<String>) -> Result<usize, String> {
    let mut done = 0usize;
    let mut first_err: Option<String> = None;
    for path in paths {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            continue;
        }
        match trash_one(trimmed) {
            Ok(()) => done += 1,
            Err(err) => {
                if first_err.is_none() {
                    first_err = Some(err);
                }
            }
        }
    }
    match first_err {
        Some(err) if done == 0 => Err(err),
        _ => Ok(done),
    }
}

fn trash_one(path: &str) -> Result<(), String> {
    if !Path::new(path).exists() {
        return Err(format!("找不到 {path}"));
    }
    #[cfg(windows)]
    {
        return recycle_native(path);
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("回收站只在 Windows 上可用。".into())
    }
}

/// 直接调系统的 SHFileOperation 进回收站，不再起 PowerShell。
/// FOF_ALLOWUNDO = 进回收站；FOF_WANTNUKEWARNING = 文件大到进不了回收站时要警告，不会悄悄永久删除。
#[cfg(windows)]
fn recycle_native(path: &str) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FOF_WANTNUKEWARNING, FO_DELETE,
        SHFILEOPSTRUCTW,
    };
    let normalized = normalize_win_path(path);
    // pFrom 要求以两个 \0 结尾。
    let mut wide: Vec<u16> = normalized.encode_utf16().collect();
    wide.push(0);
    wide.push(0);
    let flags = (FOF_ALLOWUNDO.0 | FOF_NOCONFIRMATION.0 | FOF_NOERRORUI.0 | FOF_SILENT.0 | FOF_WANTNUKEWARNING.0) as u16;
    let mut op = SHFILEOPSTRUCTW {
        hwnd: HWND::default(),
        wFunc: FO_DELETE,
        pFrom: PCWSTR(wide.as_ptr()),
        pTo: PCWSTR::null(),
        fFlags: flags,
        ..Default::default()
    };
    let code = unsafe { SHFileOperationW(&mut op) };
    if code != 0 || op.fAnyOperationsAborted.as_bool() || Path::new(&normalized).exists() {
        return Err(format!("没有放进回收站：{path}"));
    }
    Ok(())
}

#[tauri::command]
// async: reg/powershell child processes take seconds; a sync command would block the main thread (and all IPC) meanwhile.
async fn shell_menu_set(enabled: bool) -> Result<(), String> {
    capture::set_shell_menu(enabled)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let send_paths = capture::parse_send_args(&std::env::args().skip(1).collect::<Vec<_>>());
    if capture::try_handoff(&send_paths) {
        return;
    }
    if !capture::claim_port() {
        let _ = capture::try_handoff(&send_paths);
        return;
    }
    let boot_paths = send_paths;
    tauri::Builder::default()
        .setup(move |app| {
            capture::serve(app.handle().clone(), show_window);
            capture::enqueue(boot_paths.clone());
            let handle = app.handle().clone();
            if !boot_paths.is_empty() {
                let _ = handle.emit("paths-incoming", ());
            }
            let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
            let store = db::open(dir)?;
            // 右键菜单自检：注册表 /「发送到」里若还指着开发版 exe，启动时改回已安装的位置。
            // 放后台线程，读注册表和 .lnk 不挡启动。
            let persisted = db::load(&store).ok().flatten();
            let shell_menu = capture::shell_menu_enabled(persisted.as_deref());
            app.manage(store);
            std::thread::spawn(move || {
                if let Err(err) = capture::repair_shell_menu(shell_menu) {
                    eprintln!("右键菜单自检失败：{err}");
                }
            });

            // 快捷键先注册，托盘菜单里才能显示真正生效的那一个。
            let shortcut_status = register_shortcuts(app.handle());
            let shortcut_item =
                MenuItem::with_id(app, "shortcut", shortcut_status.as_str(), false, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "显示", true, None::<&str>)?;
            let pause = CheckMenuItem::with_id(app, "pause", "暂停剪贴板记录", true, false, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let sep_before_shortcut = PredefinedMenuItem::separator(app)?;
            let sep_after_shortcut = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(
                app,
                &[
                    &show,
                    &pause,
                    &sep_before_shortcut,
                    &shortcut_item,
                    &sep_after_shortcut,
                    &quit,
                ],
            )?;
            app.manage(PauseItem(pause));
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?;
            TrayIconBuilder::new()
                .icon(icon)
                .tooltip("ZAのWork-Zone")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_window(app),
                    "pause" => toggle_pause(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            clip::start(app.handle().clone());
            dock::start_hit_poller(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                hide_animated(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            state_load,
            state_save,
            open_path,
            reveal_path,
            copy_text,
            copy_image,
            clip_export::clip_write_temp,
            clip_export::clip_save_as,
            clip_export::clip_start_drag,
            clip_export::clip_keep_original,
            clip_export::clip_forget_original,
            clip_export::clip_cleanup,
            pick_file,
            missing_paths,
            file_size,
            image_thumb,
            set_clipboard_paused,
            set_ignored_apps,
            take_pending_sends,
            probe_paths,
            read_user_file,
            remove_user_file,
            pick_folder,
            pick_files,
            ingest_file,
            settle_move,
            read_file_chunk,
            trash_paths,
            shell_menu_set,
            dock::zone_window_layout,
            dock::zone_set_hit,
            dock::zone_drag_begin,
            dock::zone_dock_snap,
            dock::zone_fullscreen_active
        ])
        .run(tauri::generate_context!())
        .expect("ZAのWork-Zone 启动失败");
}

#[cfg(test)]
mod reveal_tests {
    use super::normalize_win_path;

    #[test]
    fn normalizes_slashes_and_verbatim_prefix() {
        assert_eq!(normalize_win_path("C:/a b/c d.3dm"), "C:\\a b\\c d.3dm");
        assert_eq!(normalize_win_path("\\\\?\\C:\\a b\\c.txt"), "C:\\a b\\c.txt");
        assert_eq!(normalize_win_path("\\\\?\\UNC\\srv\\share\\f.txt"), "\\\\srv\\share\\f.txt");
    }

    /// Manual: ZA_REVEAL_TEST=<file> cargo test reveal_real_file -- --ignored
    #[test]
    #[ignore]
    fn reveal_real_file() {
        let path = std::env::var("ZA_REVEAL_TEST").expect("set ZA_REVEAL_TEST");
        super::reveal_path(path).unwrap();
        std::thread::sleep(std::time::Duration::from_secs(3));
    }

    #[test]
    fn missing_file_and_folder_is_an_error() {
        let err = super::reveal_path("Z:\\no such dir\\x y.txt".into()).unwrap_err();
        assert!(!err.is_empty());
    }
}

#[cfg(all(test, windows))]
mod trash_tests {
    #[test]
    fn recycles_files_with_spaces_and_reports_missing() {
        let dir = std::env::temp_dir().join(format!("za trash test {}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a b.txt");
        std::fs::write(&file, "x").unwrap();
        let started = std::time::Instant::now();
        let done = super::trash_blocking(vec![file.display().to_string(), "".into()]).unwrap();
        assert_eq!(done, 1);
        assert!(!file.exists());
        assert!(started.elapsed() < std::time::Duration::from_secs(2), "recycling should not need a child process");
        assert!(super::trash_blocking(vec![file.display().to_string()]).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
