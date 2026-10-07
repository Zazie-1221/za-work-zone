//! 窗口几何：固定大小的全透明窗口 + 命中测试。
//!
//! 窗口永远是展开态的最大尺寸（受屏幕工作区限制），背景全透明；胶囊 / 面板只是窗口里
//! 的一个可见形状，由前端用弹簧动画在两个矩形之间形变。所以收起 / 展开时原生窗口不再
//! 改尺寸、不再跳位置。
//!
//! 透明区域不能挡鼠标：这里有一个 ~60Hz 的轮询线程，按前端报告的「可见形状矩形」判断
//! 光标是否在形状里，在里面才让窗口接收鼠标，否则整个窗口点击穿透。
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager, WebviewWindow};

/// 窗口逻辑宽度（面板 360 + 两侧各 24 的余量，给阴影留地方）。
const WIN_W: f64 = 408.0;
/// 窗口逻辑高度上限；实际取屏幕工作区高度和它的较小值。
const WIN_H_MAX: f64 = 900.0;
/// 形状离停靠边的距离。
const EDGE: f64 = 10.0;
const CAP_W: f64 = 200.0;
const CAP_H: f64 = 44.0;
const PANEL_W: f64 = 360.0;
const PANEL_MIN_H: f64 = 320.0;
/// 命中测试给形状外扩一点，悬停时不至于边缘抖动。
const HIT_SLOP: f64 = 4.0;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    Top,
    Bottom,
    Left,
    Right,
}

/// 停靠位置：贴哪条边，以及胶囊中心沿这条边的相对位置（0 到 1，0.5 是居中）。
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Dock {
    pub edge: Edge,
    pub t: f64,
}

#[derive(Clone, Copy, Debug)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// 窗口内（逻辑像素）的矩形。
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Box2 {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub dock: Dock,
    pub capsule: Box2,
    pub panel: Box2,
    pub win_w: f64,
    pub win_h: f64,
    #[serde(skip)]
    pub height: f64,
}

static LAYOUT: Mutex<Option<Layout>> = Mutex::new(None);

struct HitState {
    rects: Vec<Box2>,
    scale: f64,
}

static HIT: Mutex<HitState> = Mutex::new(HitState { rects: Vec::new(), scale: 1.0 });

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if hi < lo {
        lo
    } else {
        v.max(lo).min(hi)
    }
}

/// 窗口所在显示器的工作区（去掉任务栏），物理像素。
fn work_area(window: &WebviewWindow) -> Result<Rect, String> {
    let monitor = window
        .current_monitor()
        .map_err(|err| err.to_string())?
        .or(window.primary_monitor().map_err(|err| err.to_string())?)
        .ok_or_else(|| "找不到显示器".to_string())?;
    let area = monitor.work_area();
    Ok(Rect {
        x: area.position.x as f64,
        y: area.position.y as f64,
        w: area.size.width as f64,
        h: area.size.height as f64,
    })
}

/// 按停靠位置算窗口矩形（物理像素）和窗口内的胶囊 / 面板矩形（逻辑像素）。
/// 展开方向朝屏幕内侧：顶部向下、底部向上、左 / 右边向内；窗口永远不超出工作区。
fn compute(dock: Dock, scale: f64, area: Rect, height: f64) -> (Rect, Layout) {
    let aw = area.w / scale;
    let ah = area.h / scale;
    let win_w = WIN_W.min(aw);
    let win_h = WIN_H_MAX.min(ah);
    let pw = PANEL_W.min(win_w - 2.0 * EDGE);
    let ph = clamp(height, PANEL_MIN_H, win_h - 2.0 * EDGE);
    let t = clamp(dock.t, 0.0, 1.0);

    let (wx, wy, cap_x, cap_y, panel_x, panel_y);
    match dock.edge {
        Edge::Top | Edge::Bottom => {
            let cx = t * aw;
            wx = clamp(cx - win_w / 2.0, 0.0, aw - win_w);
            cap_x = clamp(cx - CAP_W / 2.0 - wx, EDGE, win_w - CAP_W - EDGE);
            panel_x = clamp(cap_x + CAP_W / 2.0 - pw / 2.0, EDGE, win_w - pw - EDGE);
            if dock.edge == Edge::Top {
                wy = 0.0;
                cap_y = EDGE;
                panel_y = EDGE;
            } else {
                wy = ah - win_h;
                cap_y = win_h - CAP_H - EDGE;
                panel_y = win_h - ph - EDGE;
            }
        }
        Edge::Left | Edge::Right => {
            let cy = t * ah;
            wy = clamp(cy - win_h / 2.0, 0.0, ah - win_h);
            cap_y = clamp(cy - CAP_H / 2.0 - wy, EDGE, win_h - CAP_H - EDGE);
            panel_y = clamp(cap_y + CAP_H / 2.0 - ph / 2.0, EDGE, win_h - ph - EDGE);
            if dock.edge == Edge::Left {
                wx = 0.0;
                cap_x = EDGE;
                panel_x = EDGE;
            } else {
                wx = aw - win_w;
                cap_x = win_w - CAP_W - EDGE;
                panel_x = win_w - pw - EDGE;
            }
        }
    }

    let win = Rect {
        x: (area.x + wx * scale).round(),
        y: (area.y + wy * scale).round(),
        w: (win_w * scale).round(),
        h: (win_h * scale).round(),
    };
    let layout = Layout {
        dock: Dock { edge: dock.edge, t },
        capsule: Box2 { x: cap_x, y: cap_y, w: CAP_W, h: CAP_H },
        panel: Box2 { x: panel_x, y: panel_y, w: pw, h: ph },
        win_w,
        win_h,
        height,
    };
    (win, layout)
}

/// 由胶囊当前的屏幕矩形反推停靠位置：离哪条边最近就贴哪条边。
fn dock_from_rect(rect: Rect, area: Rect) -> Dock {
    let top = rect.y - area.y;
    let bottom = area.y + area.h - (rect.y + rect.h);
    let left = rect.x - area.x;
    let right = area.x + area.w - (rect.x + rect.w);
    let min = top.min(bottom).min(left).min(right);
    let cx = rect.x + rect.w / 2.0;
    let cy = rect.y + rect.h / 2.0;
    let edge = if min == top {
        Edge::Top
    } else if min == bottom {
        Edge::Bottom
    } else if min == left {
        Edge::Left
    } else {
        Edge::Right
    };
    let t = match edge {
        Edge::Top | Edge::Bottom => (cx - area.x) / area.w,
        Edge::Left | Edge::Right => (cy - area.y) / area.h,
    };
    Dock { edge, t: clamp(t, 0.0, 1.0) }
}

/// 把窗口的客户区放到 `target`。外框和客户区之间若有一圈差值，一并补上，免得每调一次漂一点。
fn place_inner(window: &WebviewWindow, target: Rect) -> Result<(), String> {
    let inner = window.inner_size().map_err(|err| err.to_string())?;
    let outer = window.outer_size().map_err(|err| err.to_string())?;
    let inner_pos = window.inner_position().map_err(|err| err.to_string())?;
    let outer_pos = window.outer_position().map_err(|err| err.to_string())?;
    let left = (inner_pos.x - outer_pos.x) as f64;
    let top = (inner_pos.y - outer_pos.y) as f64;
    let extra_w = outer.width as f64 - inner.width as f64;
    let extra_h = outer.height as f64 - inner.height as f64;
    let x = (target.x - left).round() as i32;
    let y = (target.y - top).round() as i32;
    let w = (target.w + extra_w).round() as i32;
    let h = (target.h + extra_h).round() as i32;

    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER,
        };
        let hwnd = window.hwnd().map_err(|err| err.to_string())?.0 as isize;
        let flags = SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER;
        unsafe { SetWindowPos(HWND(hwnd as *mut core::ffi::c_void), None, x, y, w, h, flags) }
            .map_err(|err| err.to_string())?;
    }
    #[cfg(not(windows))]
    {
        window
            .set_size(tauri::PhysicalSize::new(w.max(1) as u32, h.max(1) as u32))
            .map_err(|err| err.to_string())?;
        window
            .set_position(tauri::PhysicalPosition::new(x, y))
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn remember(layout: Layout, scale: f64) {
    if let Ok(mut slot) = LAYOUT.lock() {
        *slot = Some(layout);
    }
    if let Ok(mut hit) = HIT.lock() {
        hit.scale = scale;
    }
}

/// 把窗口摆到停靠位置（大小固定，只在换停靠边 / 拖动吸附时调用），返回窗口内的布局。
#[tauri::command]
pub async fn zone_window_layout(window: WebviewWindow, dock: Dock, height: Option<f64>) -> Result<Layout, String> {
    let scale = window.scale_factor().map_err(|err| err.to_string())?;
    let area = work_area(&window)?;
    let (win, layout) = compute(dock, scale, area, height.unwrap_or(760.0));

    // 窗口自己全透明：不要系统毛玻璃，也不要整块窗口矩形的原生阴影。
    static CHROME_OFF: std::sync::Once = std::sync::Once::new();
    CHROME_OFF.call_once(|| {
        let _ = window.set_shadow(false);
        let _ = window.set_effects(None::<tauri::utils::config::WindowEffectsConfig>);
        let _ = window.set_resizable(false);
    });

    place_inner(&window, win)?;
    remember(layout, scale);
    Ok(layout)
}

/// 前端报告当前可见形状的矩形（窗口内逻辑像素）：只有光标在这些矩形里，窗口才接收鼠标。
#[tauri::command]
pub fn zone_set_hit(rects: Vec<Box2>) {
    if let Ok(mut hit) = HIT.lock() {
        hit.rects = rects;
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct SnapResult {
    pub dock: Dock,
    /// 鼠标还按着（拖动中停顿）：窗口还没落地，调用方过一会儿再问。
    pub held: bool,
    /// 窗口因吸附挪过位置时给出新布局。
    pub layout: Option<Layout>,
}

/// 拖动进行中：光标轮询暂停（窗口在光标下移动时“进入/离开”会乱跳，不能因此触发悬停展开）。
static DRAGGING: AtomicBool = AtomicBool::new(false);

/// 拖动窗口：系统自带的 startDragging 会把窗口夹在工作区内，而窗口恒为最大尺寸，
/// 胶囊就拖不到顶边/上半部分。这里起一个线程，按住左键期间让窗口跟着光标走（不夹边），松手后前端再吸附。
#[tauri::command]
pub fn zone_drag_begin(window: WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{HWND, POINT, RECT};
        use windows::Win32::UI::WindowsAndMessaging::{
            GetCursorPos, GetWindowRect, SetWindowPos, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
        };
        let hwnd = window.hwnd().map_err(|err| err.to_string())?;
        let raw = hwnd.0 as isize;
        let mut cursor = POINT::default();
        let mut rect = RECT::default();
        unsafe {
            GetCursorPos(&mut cursor).map_err(|err| err.to_string())?;
            GetWindowRect(HWND(raw as *mut core::ffi::c_void), &mut rect).map_err(|err| err.to_string())?;
        }
        let (dx, dy) = (rect.left - cursor.x, rect.top - cursor.y);
        DRAGGING.store(true, Ordering::Relaxed);
        let notify = window.clone();
        std::thread::spawn(move || {
            while left_button_down() {
                let mut now = POINT::default();
                unsafe {
                    if GetCursorPos(&mut now).is_ok() {
                        let _ = SetWindowPos(
                            HWND(raw as *mut core::ffi::c_void),
                            None,
                            now.x + dx,
                            now.y + dy,
                            0,
                            0,
                            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                        );
                    }
                }
                std::thread::sleep(Duration::from_millis(8));
            }
            DRAGGING.store(false, Ordering::Relaxed);
            let _ = notify.emit("zone-drag-end", ());
        });
    }
    #[cfg(not(windows))]
    {
        let _ = window;
    }
    Ok(())
}
fn left_button_down() -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
        unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 }
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// 拖动结束后调用：按胶囊当前的屏幕位置算停靠边。收起态下顺手把窗口吸附过去（尺寸不变）；
/// 展开态只记录停靠，不动窗口。
#[tauri::command]
pub async fn zone_dock_snap(window: WebviewWindow, collapsed: bool) -> Result<SnapResult, String> {
    let scale = window.scale_factor().map_err(|err| err.to_string())?;
    let area = work_area(&window)?;
    let pos = window.inner_position().map_err(|err| err.to_string())?;
    let current = LAYOUT.lock().map_err(|err| err.to_string())?.ok_or_else(|| "窗口还没有布局".to_string())?;
    let cap = Rect {
        x: pos.x as f64 + current.capsule.x * scale,
        y: pos.y as f64 + current.capsule.y * scale,
        w: current.capsule.w * scale,
        h: current.capsule.h * scale,
    };
    let dock = dock_from_rect(cap, area);
    if left_button_down() {
        return Ok(SnapResult { dock, held: true, layout: None });
    }
    if collapsed {
        let (win, layout) = compute(dock, scale, area, current.height);
        if (win.x - pos.x as f64).abs() > 1.5 || (win.y - pos.y as f64).abs() > 1.5 {
            place_inner(&window, win)?;
            remember(layout, scale);
            return Ok(SnapResult { dock, held: false, layout: Some(layout) });
        }
    }
    Ok(SnapResult { dock, held: false, layout: None })
}

/// 命中测试线程：~60Hz 看光标在不在可见形状里。
/// 在里面：窗口接收鼠标（悬停 / 点击 / 拖拽 / 文件拖放）；在外面：整个窗口点击穿透。
/// 左键按着时不从「接收」翻回「穿透」，免得拖动 / 拖放进行到一半被打断。
/// 进出状态通过 `zone-hover` 事件告诉前端 —— 穿透时前端收不到 pointer 事件，只能靠这个。
pub fn start_hit_poller(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut ignoring: Option<bool> = None;
        let mut was_inside = false;
        // hwnd() 和 is_visible() 都要绕主线程等回复；60Hz 轮询里不能每轮都问，会拖慢启动期的主线程。缓存 hwnd，可见性直接问 Win32。
        let mut hwnd_cache: Option<isize> = None;
        loop {
            std::thread::sleep(Duration::from_millis(16));
            let Some(window) = app.get_webview_window("main") else {
                continue;
            };
            // 前端还没摆好窗口（没有布局）之前不碰穿透状态：启动期给 WebView 初始化让路。
            if LAYOUT.lock().map(|l| l.is_none()).unwrap_or(true) {
                continue;
            }
            if DRAGGING.load(Ordering::Relaxed) {
                if ignoring != Some(false) {
                    let _ = window.set_ignore_cursor_events(false);
                    ignoring = Some(false);
                }
                continue;
            }
            #[cfg(windows)]
            {
                use windows::Win32::Foundation::{HWND, POINT, RECT};
                use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetWindowRect, IsWindowVisible};
                if hwnd_cache.is_none() {
                    hwnd_cache = window.hwnd().ok().map(|h| h.0 as isize);
                }
                let Some(raw) = hwnd_cache else { continue };
                let hwnd = HWND(raw as *mut core::ffi::c_void);
                if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
                    continue;
                }
                let mut cursor = POINT::default();
                let mut rect = RECT::default();
                unsafe {
                    if GetCursorPos(&mut cursor).is_err() {
                        continue;
                    }
                    if GetWindowRect(hwnd, &mut rect).is_err() {
                        continue;
                    }
                }
                let (rects, scale) = match HIT.lock() {
                    Ok(hit) => (hit.rects.clone(), hit.scale.max(0.5)),
                    Err(_) => continue,
                };
                let lx = (cursor.x - rect.left) as f64 / scale;
                let ly = (cursor.y - rect.top) as f64 / scale;
                let inside = rects.iter().any(|b| {
                    lx >= b.x - HIT_SLOP && lx <= b.x + b.w + HIT_SLOP && ly >= b.y - HIT_SLOP && ly <= b.y + b.h + HIT_SLOP
                });
                let want_ignore = !inside;
                let target = if want_ignore && ignoring == Some(false) && left_button_down() {
                    false
                } else {
                    want_ignore
                };
                if ignoring != Some(target) {
                    let _ = window.set_ignore_cursor_events(target);
                    ignoring = Some(target);
                }
                if inside != was_inside {
                    was_inside = inside;
                    let _ = window.emit("zone-hover", inside);
                }
            }
            #[cfg(not(windows))]
            {
                let _ = (&mut ignoring, &mut was_inside, &mut hwnd_cache);
            }
        }
    });
}

/// 前台是不是全屏应用（游戏、全屏视频、演示）：是的话悬停不弹出面板。
#[tauri::command]
pub fn zone_fullscreen_active(window: WebviewWindow) -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{HWND, RECT};
        use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
        use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetForegroundWindow, GetWindowRect};
        unsafe {
            let fg = GetForegroundWindow();
            if fg.0.is_null() {
                return false;
            }
            if let Ok(own) = window.hwnd() {
                if own.0 == fg.0 {
                    return false;
                }
            }
            let mut class = [0u16; 64];
            let len = GetClassNameW(HWND(fg.0), &mut class).max(0) as usize;
            let name = String::from_utf16_lossy(&class[..len.min(64)]);
            if matches!(name.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd") {
                return false;
            }
            let mut rect = RECT::default();
            if GetWindowRect(fg, &mut rect).is_err() {
                return false;
            }
            let monitor = MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);
            let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
            if !GetMonitorInfoW(monitor, &mut info).as_bool() {
                return false;
            }
            let m = info.rcMonitor;
            rect.left <= m.left && rect.top <= m.top && rect.right >= m.right && rect.bottom >= m.bottom
        }
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        false
    }
}