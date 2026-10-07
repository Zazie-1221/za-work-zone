use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
#[cfg(windows)]
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const PORT: u16 = 47331;
const COPY_CAP: u64 = 32 * 1024 * 1024;
/// 没有带路径的第二次启动（双击、任务栏再点一次）：发给已在运行的实例，把窗口叫回来。
/// 旧版服务端只认 JSON 数组，这条解析出来是空数组 —— 同样是显示窗口，不会吞掉文件。
const SHOW_MESSAGE: &str = r#"{"show":true}"#;
/// NSIS 装到 %LOCALAPPDATA%\ZA Work-Zone\za-work-zone.exe（productName / bin 名见 tauri.conf.json）。
#[cfg(windows)]
const INSTALL_DIR: &str = "ZA Work-Zone";
#[cfg(windows)]
const INSTALL_EXE: &str = "za-work-zone.exe";
/// 右键菜单挂在 HKCU 下，文件一份、文件夹一份，不需要管理员。
#[cfg(windows)]
const MENU_KEYS: [&str; 2] = [
    r"HKCU\Software\Classes\*\shell\ZAWorkZone",
    r"HKCU\Software\Classes\Directory\shell\ZAWorkZone",
];
#[cfg(windows)]
const MENU_LABEL: &str = "发送到 ZAのWork-Zone";
#[cfg(windows)]
const SENDTO_LINK: &str = "发送到 ZAのWork-Zone.lnk";

static PENDING: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
static LISTENER: OnceLock<Mutex<Option<TcpListener>>> = OnceLock::new();

fn pending() -> &'static Mutex<Vec<String>> {
    PENDING.get_or_init(|| Mutex::new(Vec::new()))
}

pub fn parse_send_args(args: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut take = false;
    for arg in args {
        if arg == "--send" {
            take = true;
            continue;
        }
        if take && !arg.starts_with('-') {
            out.push(arg.clone());
        }
    }
    out
}

pub fn try_handoff(paths: &[String]) -> bool {
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], PORT));
    let Ok(stream) = TcpStream::connect_timeout(&address, Duration::from_millis(300)) else {
        return false;
    };
    send_message(stream, paths).is_ok()
}

/// 客户端 → 已在运行的实例，本机回环，格式是「一行 JSON + 换行」。
/// 有路径就发路径数组；没路径就发显示窗口消息，让第二个实例只是把窗口叫回来。
fn send_message(mut stream: TcpStream, paths: &[String]) -> std::io::Result<()> {
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let payload = if paths.is_empty() {
        SHOW_MESSAGE.to_string()
    } else {
        serde_json::to_string(paths).unwrap_or_else(|_| "[]".into())
    };
    stream.write_all(payload.as_bytes())?;
    stream.write_all(b"\n")?;
    Ok(())
}

pub fn claim_port() -> bool {
    match TcpListener::bind(("127.0.0.1", PORT)) {
        Ok(listener) => {
            let _ = listener.set_nonblocking(false);
            let _ = LISTENER.set(Mutex::new(Some(listener)));
            true
        }
        Err(_) => false,
    }
}

pub fn enqueue(paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    if let Ok(mut queue) = pending().lock() {
        queue.extend(paths);
    }
}

pub fn take_pending() -> Vec<String> {
    pending().lock().map(|mut queue| std::mem::take(&mut *queue)).unwrap_or_default()
}

pub fn serve(app: AppHandle, on_show: fn(&AppHandle)) {
    let listener = LISTENER.get().and_then(|slot| slot.lock().ok().and_then(|mut guard| guard.take()));
    let Some(listener) = listener else {
        return;
    };
    std::thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            let _ = conn.set_read_timeout(Some(Duration::from_secs(2)));
            let mut line = String::new();
            if BufReader::new(conn).read_line(&mut line).is_err() {
                continue;
            }
            match parse_message(&line) {
                Incoming::Show => on_show(&app),
                Incoming::Paths(paths) => {
                    enqueue(paths);
                    let _ = app.emit("paths-incoming", ());
                }
            }
        }
    });
}

/// 客户端发来的一行消息。
enum Incoming {
    /// 只是要窗口回来（第二次启动、或「发送到」没带文件）。
    Show,
    /// 一批要送进工作区的路径。
    Paths(Vec<String>),
}

/// 解析客户端消息。空数组（旧版的「显示窗口」写法）和任何解析不出路径的内容
/// 都当成 Show，这样新旧客户端双向都能把窗口叫出来，也不会吞掉文件。
fn parse_message(line: &str) -> Incoming {
    match serde_json::from_str::<Vec<String>>(line.trim()) {
        Ok(paths) if !paths.is_empty() => Incoming::Paths(paths),
        _ => Incoming::Show,
    }
}

pub fn deliver(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    enqueue(paths);
    let _ = app.emit("paths-incoming", ());
}

pub fn reveal_quietly(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        return;
    }
    let _ = window.show();
    let _ = window.unminimize();
}

pub fn grab_explorer(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        match explorer_selection() {
            Ok(paths) => deliver(&app, paths),
            Err(reason) => {
                let _ = app.emit("paths-failed", reason);
            }
        }
        reveal_quietly(&app);
    });
}

fn explain_io(err: &std::io::Error, path: &str) -> String {
    let name = Path::new(path).file_name().and_then(|item| item.to_str()).unwrap_or(path);
    match err.kind() {
        std::io::ErrorKind::NotFound => format!("找不到 {name}。"),
        std::io::ErrorKind::PermissionDenied => format!("没有权限读取 {name}。"),
        _ => format!("无法读取 {name}：{err}"),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathFact {
    pub path: String,
    pub name: String,
    pub exists: bool,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub readable: bool,
    pub reason: Option<String>,
}

pub fn probe_one(path: &str) -> PathFact {
    let name = Path::new(path)
        .file_name()
        .and_then(|item| item.to_str())
        .unwrap_or(path)
        .to_string();
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_dir() => PathFact {
            path: path.to_string(),
            name,
            exists: true,
            is_dir: true,
            size: None,
            readable: true,
            reason: None,
        },
        Ok(meta) => match std::fs::File::open(path) {
            Ok(_) => PathFact {
                path: path.to_string(),
                name,
                exists: true,
                is_dir: false,
                size: Some(meta.len()),
                readable: true,
                reason: None,
            },
            Err(err) => PathFact {
                path: path.to_string(),
                name,
                exists: true,
                is_dir: false,
                size: Some(meta.len()),
                readable: false,
                reason: Some(explain_io(&err, path)),
            },
        },
        Err(err) => PathFact {
            path: path.to_string(),
            name,
            exists: false,
            is_dir: false,
            size: None,
            readable: false,
            reason: Some(explain_io(&err, path)),
        },
    }
}

pub fn read_user_file(path: &str) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|err| explain_io(&err, path))?;
    if meta.is_dir() {
        return Err(format!("{} 是文件夹，只记录路径。", file_label(path)));
    }
    if meta.len() > COPY_CAP {
        return Err(format!("{} 超过 32 MB，改为只记录路径。", file_label(path)));
    }
    let bytes = std::fs::read(path).map_err(|err| explain_io(&err, path))?;
    Ok(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes))
}

pub fn remove_user_file(path: &str) -> Result<(), String> {
    let meta = std::fs::metadata(path).map_err(|err| explain_io(&err, path))?;
    if meta.is_dir() {
        return Err(format!("{} 是文件夹，没有移动。", file_label(path)));
    }
    std::fs::remove_file(path).map_err(|err| match err.kind() {
        std::io::ErrorKind::PermissionDenied => format!("没有权限删除 {}。", file_label(path)),
        _ => format!("没有删掉 {}：{err}", file_label(path)),
    })
}

fn file_label(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|item| item.to_str())
        .unwrap_or(path)
        .to_string()
}

#[cfg(windows)]
pub fn explorer_selection() -> Result<Vec<String>, String> {
    let script = r#"
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ZaFore {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
}
'@
$hwnd = [ZaFore]::GetForegroundWindow()
$cls = New-Object System.Text.StringBuilder 256
[void][ZaFore]::GetClassName($hwnd, $cls, $cls.Capacity)
$name = $cls.ToString()
if ($name -ne 'CabinetWClass' -and $name -ne 'ExploreWClass') { exit 2 }
$shell = New-Object -ComObject Shell.Application
$found = $false
foreach ($w in @($shell.Windows())) {
  try {
    if ([int64]$w.HWND -eq [int64]$hwnd) {
      $found = $true
      foreach ($item in @($w.Document.SelectedItems())) {
        [Console]::Out.WriteLine($item.Path)
      }
    }
  } catch {}
}
if (-not $found) { exit 3 }
"#;
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .map_err(|err| format!("读不到资源管理器选中项：{err}"))?;
    match output.status.code() {
        Some(0) => {
            let text = String::from_utf8_lossy(&output.stdout);
            let paths: Vec<String> = text.lines().map(str::trim).filter(|line| !line.is_empty()).map(str::to_string).collect();
            if paths.is_empty() {
                Err("资源管理器里没有选中文件。".into())
            } else {
                Ok(paths)
            }
        }
        Some(2) => Err("前台窗口不是资源管理器。先点一下资源管理器，再按 Ctrl+Alt+A。".into()),
        Some(3) => Err("没能读到这个资源管理器窗口的选中项。".into()),
        _ => {
            let err = String::from_utf8_lossy(&output.stderr);
            let detail = err.trim();
            if detail.is_empty() {
                Err("读不到资源管理器选中项。".into())
            } else {
                Err(format!("读不到资源管理器选中项。{detail}"))
            }
        }
    }
}

#[cfg(not(windows))]
pub fn explorer_selection() -> Result<Vec<String>, String> {
    Err("Ctrl+Alt+A 只在 Windows 资源管理器里读取选中项。".into())
}

#[cfg(windows)]
pub fn set_shell_menu(enabled: bool) -> Result<(), String> {
    if enabled {
        register_shell_menu()
    } else {
        unregister_shell_menu()
    }
}

#[cfg(not(windows))]
pub fn set_shell_menu(_enabled: bool) -> Result<(), String> {
    Ok(())
}

/// 右键菜单和「发送到」里该指向哪个 exe。
///
/// 开发时 current_exe() 是 target\debug 或 target\release 下的构建产物，写进注册表会把
/// 用户的右键菜单钉在开发版上；所以路径里带 target 目录时，改用已安装的那个 exe。
/// 从安装目录启动时 current_exe() 就是自己，原样用它；安装目录里没有主程序时也退回它。
#[cfg(windows)]
fn resolve_install_exe() -> Result<PathBuf, String> {
    let current = std::env::current_exe().map_err(|err| format!("找不到程序本身：{err}"))?;
    if !looks_like_dev_exe(&current) {
        return Ok(current);
    }
    match installed_exe() {
        Some(installed) if installed.is_file() => Ok(installed),
        _ => Ok(current),
    }
}

/// cargo / tauri 的构建产物一定在 target 目录下（Windows 路径不区分大小写）。
#[cfg(windows)]
fn looks_like_dev_exe(exe: &Path) -> bool {
    exe.components().any(|part| part.as_os_str().eq_ignore_ascii_case("target"))
}

/// 用 LOCALAPPDATA 拼安装目录，不写死用户名。
#[cfg(windows)]
fn installed_exe() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(base).join(INSTALL_DIR).join(INSTALL_EXE))
}

/// 右键菜单执行的那条命令：`"<exe>" --send "%1"`。
#[cfg(windows)]
fn shell_command(exe: &str) -> String {
    format!("\"{exe}\" --send \"%1\"")
}

#[cfg(windows)]
fn register_shell_menu() -> Result<(), String> {
    let exe = resolve_install_exe()?.display().to_string();
    let command = shell_command(&exe);
    for key in MENU_KEYS {
        reg_set(key, MENU_LABEL)?;
        reg_set(&format!(r"{key}\command"), &command)?;
    }
    write_sendto(&exe)
}

#[cfg(windows)]
fn unregister_shell_menu() -> Result<(), String> {
    for key in MENU_KEYS {
        let _ = std::process::Command::new("reg").args(["delete", key, "/f"]).status();
    }
    let _ = std::fs::remove_file(sendto_link());
    Ok(())
}

#[cfg(windows)]
fn reg_set(key: &str, value: &str) -> Result<(), String> {
    let status = std::process::Command::new("reg")
        .args(["add", key, "/ve", "/d", value, "/f"])
        .status()
        .map_err(|err| format!("无法写入右键菜单：{err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("注册「发送到 ZAのWork-Zone」失败。".into())
    }
}

#[cfg(windows)]
fn write_sendto(exe: &str) -> Result<(), String> {
    let script = r#"
$ErrorActionPreference = 'Stop'
$exe = $env:ZA_EXE
if (-not $exe) { exit 1 }
$dir = Join-Path $env:APPDATA 'Microsoft\Windows\SendTo'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$lnk = Join-Path $dir '发送到 ZAのWork-Zone.lnk'
$sh = New-Object -ComObject WScript.Shell
$sc = $sh.CreateShortcut($lnk)
$sc.TargetPath = $exe
$sc.Arguments = '--send'
$sc.WorkingDirectory = Split-Path -Parent $exe
$sc.Save()
"#;
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("ZA_EXE", exe)
        .status()
        .map_err(|err| format!("无法写入「发送到」：{err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("「发送到」快捷方式没有写上。右键菜单仍会逐个送入。".into())
    }
}

/// 读一个 REG_SZ，键不在或值为空就给 None。
#[cfg(windows)]
fn reg_get(key: &str) -> Option<String> {
    let script = format!(
        "$ErrorActionPreference='SilentlyContinue'; \
         (Get-ItemProperty -LiteralPath 'Registry::{key}').'(default)'"
    );
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// 注册表里有没有这个键（reg.exe 比开 PowerShell 快，只看存在性时用它）。
#[cfg(windows)]
fn menu_key_present(key: &str) -> bool {
    std::process::Command::new("reg")
        .args(["query", key])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

/// 「发送到」快捷方式里记的目标 exe。.lnk 是二进制，直接把里面的路径字符串捞出来
/// （UTF-16 和 ANSI 各扫一遍），比去解析 shell link 格式省事。
#[cfg(windows)]
fn sendto_target() -> Option<String> {
    let bytes = std::fs::read(sendto_link()).ok()?;
    if bytes.len() < 4 {
        return None;
    }
    let wide: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    let joined = format!(
        "{}\n{}",
        String::from_utf16_lossy(&wide),
        String::from_utf8_lossy(&bytes)
    );
    joined
        .split(|c| c == '\u{0}' || c == '\n')
        .map(str::trim)
        .find(|part| part.to_ascii_lowercase().ends_with(".exe"))
        .map(str::to_string)
}

/// 忽略大小写和前后引号，比较两个 exe 路径。
#[cfg(windows)]
fn same_exe(a: &str, b: &str) -> bool {
    let trim = |s: &str| s.trim().trim_matches('"').to_string();
    trim(a).eq_ignore_ascii_case(&trim(b))
}

#[cfg(windows)]
fn sendto_link() -> PathBuf {
    let mut dir = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_default();
    dir.push(r"Microsoft\Windows\SendTo");
    dir.push(SENDTO_LINK);
    dir
}

/// 启动时自检：右键菜单 /「发送到」若还指着开发版 exe（或干脆没了），按用户当前的开关修一遍。
/// 该指向谁用和开关同一条规则（resolve_install_exe），所以开发时不会去动用户装好的那份。
#[cfg(windows)]
pub fn repair_shell_menu(enabled: bool) -> Result<(), String> {
    if !enabled {
        // 关着的时候：注册表 / 快捷方式里确实还留着东西才去清，没留就一个进程都不起。
        let present =
            MENU_KEYS.iter().any(|key| menu_key_present(key)) || sendto_link().is_file();
        if present {
            unregister_shell_menu()?;
        }
        return Ok(());
    }

    let target = resolve_install_exe()?.display().to_string();
    let mut healthy = true;
    for key in MENU_KEYS {
        match reg_get(&format!(r"{key}\command")) {
            Some(value) if same_exe(&value, &target) => {}
            _ => {
                healthy = false;
                break;
            }
        }
    }
    if healthy {
        match sendto_target() {
            Some(path) if same_exe(&path, &target) => {}
            _ => healthy = false,
        }
    }
    if healthy {
        return Ok(());
    }
    register_shell_menu()
}

/// 非 Windows 上没有注册表，什么都不用做。
#[cfg(not(windows))]
pub fn repair_shell_menu(_enabled: bool) -> Result<(), String> {
    Ok(())
}

/// 界面存的设置里，右键菜单这一项是不是打开的。
/// 读不出偏好（第一次启动、库坏了、没装过）就当开着 —— 和界面的默认值一致。
pub fn shell_menu_enabled(persisted: Option<&str>) -> bool {
    persisted
        .filter(|value| !value.trim().is_empty())
        .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
        .map(|value| {
            let state = value.get("state").unwrap_or(&value);
            !matches!(state.get("shellMenu"), Some(serde_json::Value::Bool(false)))
        })
        .unwrap_or(true)
}
