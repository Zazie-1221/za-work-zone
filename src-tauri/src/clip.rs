use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub static PAUSED: AtomicBool = AtomicBool::new(false);
pub static WRITING: AtomicBool = AtomicBool::new(false);
static IGNORED: OnceLock<Mutex<Vec<String>>> = OnceLock::new();

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    pub kind: &'static str,
    pub text: Option<String>,
    pub image: Option<String>,
    pub files: Vec<String>,
    pub source_app: Option<String>,
    pub original_path: Option<String>,
}

pub fn ignored_list() -> &'static Mutex<Vec<String>> {
    IGNORED.get_or_init(|| {
        Mutex::new(vec![
            "1password".into(),
            "bitwarden".into(),
            "keepass".into(),
            "keepassxc".into(),
            "lastpass".into(),
            "dashlane".into(),
            "enpass".into(),
        ])
    })
}

pub fn source_blocked(source: &str, ignored: &[String]) -> bool {
    let hay = source.to_lowercase();
    ignored.iter().any(|item| {
        let needle = item.trim().to_lowercase();
        needle.len() > 1 && hay.contains(&needle)
    })
}

pub fn hold_writes() {
    WRITING.store(true, Ordering::SeqCst);
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(500));
        WRITING.store(false, Ordering::SeqCst);
    });
}

fn emit(app: &AppHandle, capture: Capture) {
    if PAUSED.load(Ordering::Relaxed) || WRITING.load(Ordering::Relaxed) {
        return;
    }
    if let Some(source) = capture.source_app.as_deref() {
        let ignored = ignored_list().lock().ok();
        if let Some(list) = ignored {
            if source_blocked(source, &list) {
                return;
            }
        }
    }
    let _ = app.emit("clipboard-capture", capture);
}

fn png_data_url(width: u32, height: u32, bytes: &[u8]) -> Option<String> {
    if width == 0 || height == 0 || bytes.len() < (width as usize) * (height as usize) * 4 {
        return None;
    }
    let image = image::RgbaImage::from_raw(width, height, bytes.to_vec())?;
    let max_edge = 480u32;
    let (w, h) = (image.width(), image.height());
    let fitted = if w > max_edge || h > max_edge {
        let scale = max_edge as f32 / w.max(h) as f32;
        image::imageops::resize(
            &image,
            ((w as f32) * scale).max(1.0) as u32,
            ((h as f32) * scale).max(1.0) as u32,
            image::imageops::FilterType::Triangle,
        )
    } else {
        image
    };
    let mut png = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut png);
    image::ImageEncoder::write_image(
        encoder,
        fitted.as_raw(),
        fitted.width(),
        fitted.height(),
        image::ExtendedColorType::Rgba8,
    )
    .ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, png)
    ))
}

fn read_board(app: &AppHandle, source_app: Option<String>, files: Vec<String>) {
    if !files.is_empty() {
        emit(
            app,
            Capture {
                kind: "files",
                text: Some(files.join("\n")),
                image: None,
                files,
                source_app,
                original_path: None,
            },
        );
        return;
    }
    let mut clipboard = match arboard::Clipboard::new() {
        Ok(clipboard) => clipboard,
        Err(_) => return,
    };
    if let Ok(text) = clipboard.get_text() {
        let text = text.trim().to_string();
        if !text.is_empty() && text.len() <= 100_000 {
            emit(
                app,
                Capture {
                    kind: "text",
                    text: Some(text),
                    image: None,
                    files: Vec::new(),
                    source_app,
                    original_path: None,
                },
            );
            return;
        }
    }
    if let Ok(image) = clipboard.get_image() {
        if image.width.saturating_mul(image.height) > 8_000_000 {
            return;
        }
        let width = image.width as u32;
        let height = image.height as u32;
        let original_path = crate::clip_export::keep_original_rgba(app, width, height, &image.bytes);
        if let Some(data) = png_data_url(width, height, &image.bytes) {
            emit(
                app,
                Capture {
                    kind: "image",
                    text: None,
                    image: Some(data),
                    files: Vec::new(),
                    source_app,
                    original_path,
                },
            );
        }
    }
}

#[cfg(windows)]
mod win {
    use super::{read_board, PAUSED, WRITING};
    use std::sync::OnceLock;
    use tauri::AppHandle;
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Graphics::Gdi::HBRUSH;
    use windows::Win32::System::DataExchange::{AddClipboardFormatListener, CloseClipboard, GetClipboardData, OpenClipboard};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId,
        RegisterClassW, TranslateMessage, HCURSOR, HICON, HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WNDCLASSW,
        WNDCLASS_STYLES,
    };
    use windows::core::{w, PCWSTR, PWSTR};

    const WM_CLIPBOARDUPDATE: u32 = 0x031D;
    static APP: OnceLock<AppHandle> = OnceLock::new();

    unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if msg == WM_CLIPBOARDUPDATE {
            if !PAUSED.load(std::sync::atomic::Ordering::Relaxed)
                && !WRITING.load(std::sync::atomic::Ordering::Relaxed)
            {
                let source = foreground_exe();
                let files = read_files();
                if let Some(app) = APP.get().cloned() {
                    std::thread::spawn(move || read_board(&app, source, files));
                }
            }
            return LRESULT(0);
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    unsafe fn foreground_exe() -> Option<String> {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).ok()?;
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit(['\\', '/']).next().map(str::to_string)
    }

    unsafe fn read_files() -> Vec<String> {
        if OpenClipboard(None).is_err() {
            return Vec::new();
        }
        let mut files = Vec::new();
        if let Ok(handle) = GetClipboardData(15u32) {
            let drop = HDROP(handle.0);
            let count = DragQueryFileW(drop, 0xFFFFFFFF, None);
            for index in 0..count {
                let len = DragQueryFileW(drop, index, None) as usize;
                let mut buf = vec![0u16; len + 1];
                DragQueryFileW(drop, index, Some(&mut buf));
                let end = buf.iter().position(|unit| *unit == 0).unwrap_or(buf.len());
                if let Ok(path) = String::from_utf16(&buf[..end]) {
                    if !path.is_empty() {
                        files.push(path);
                    }
                }
            }
        }
        let _ = CloseClipboard();
        files
    }

    pub fn start(app: AppHandle) {
        let _ = APP.set(app);
        std::thread::Builder::new()
            .name("clipboard".into())
            .spawn(|| unsafe {
                let instance = GetModuleHandleW(PCWSTR::null()).unwrap_or(windows::Win32::Foundation::HMODULE(std::ptr::null_mut()));
                let class = WNDCLASSW {
                    style: WNDCLASS_STYLES(0),
                    lpfnWndProc: Some(wnd_proc),
                    cbClsExtra: 0,
                    cbWndExtra: 0,
                    hInstance: HINSTANCE(instance.0),
                    hIcon: HICON::default(),
                    hCursor: HCURSOR::default(),
                    hbrBackground: HBRUSH::default(),
                    lpszMenuName: PCWSTR::null(),
                    lpszClassName: w!("ZaWorkZoneClip"),
                };
                if RegisterClassW(&class) == 0 {
                    return;
                }
                let hwnd = CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    w!("ZaWorkZoneClip"),
                    PCWSTR::null(),
                    WINDOW_STYLE(0),
                    0,
                    0,
                    0,
                    0,
                    Some(HWND_MESSAGE),
                    None,
                    Some(HINSTANCE(instance.0)),
                    None,
                );
                if let Ok(hwnd) = hwnd {
                    let _ = AddClipboardFormatListener(hwnd);
                    let mut message = MSG::default();
                    while GetMessageW(&mut message, None, 0, 0).as_bool() {
                        let _ = TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
            })
            .ok();
    }
}

#[cfg(not(windows))]
mod other {
    use super::read_board;
    use std::time::Duration;
    use tauri::AppHandle;

    pub fn start(app: AppHandle) {
        std::thread::Builder::new()
            .name("clipboard".into())
            .spawn(move || {
                let mut last = String::new();
                loop {
                    std::thread::sleep(Duration::from_millis(800));
                    let mut clipboard = match arboard::Clipboard::new() {
                        Ok(clipboard) => clipboard,
                        Err(_) => continue,
                    };
                    if let Ok(text) = clipboard.get_text() {
                        let text = text.trim().to_string();
                        if text.is_empty() || text == last {
                            continue;
                        }
                        last = text;
                        read_board(&app, None, Vec::new());
                    }
                }
            })
            .ok();
    }
}

#[cfg(windows)]
pub use win::start;
#[cfg(not(windows))]
pub use other::start;

#[cfg(test)]
mod tests {
    use super::source_blocked;

    #[test]
    fn ignores_password_managers() {
        let list = vec!["1password".into(), "bitwarden".into()];
        assert!(source_blocked("1Password.exe", &list));
        assert!(source_blocked("Bitwarden.exe", &list));
        assert!(!source_blocked("WINWORD.EXE", &list));
        assert!(!source_blocked("a.exe", &["x".into()]));
    }
}
