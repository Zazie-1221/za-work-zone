use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const MAX_ORIGINAL_BYTES: u64 = 8 * 1024 * 1024;
const CLIPS_CAP_BYTES: u64 = 500 * 1024 * 1024;
const CLIPS_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

fn decode_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    let encoded = data_url
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(data_url);
    base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded)
        .map_err(|err| err.to_string())
}

fn sanitize_file_stem(name: &str) -> String {
    let stem = name.trim();
    let stem = [".png", ".PNG", ".jpg", ".jpeg", ".JPG", ".JPEG", ".webp", ".gif", ".bmp"]
        .iter()
        .find_map(|ext| stem.strip_suffix(ext))
        .unwrap_or(stem);
    let cleaned: String = stem
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c == ' ' || c == '-');
    if cleaned.is_empty() {
        "clip".into()
    } else {
        cleaned.chars().take(80).collect()
    }
}

fn temp_dir() -> PathBuf {
    std::env::temp_dir().join("ZA-Work-Zone")
}

/// `base` 已清理、不含序号；在 dir 里找 base_NN.ext 的最大 NN，返回下一项路径。
fn numbered_file(dir: &Path, base: &str, ext: &str) -> PathBuf {
    let ext_lower = ext.to_ascii_lowercase();
    let prefix = format!("{base}_");
    let mut max_n = 0u32;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Some(rest) = name.strip_prefix(&prefix) else {
                continue;
            };
            let Some(num_part) = rest.rsplit_once('.') else {
                continue;
            };
            if num_part.1.eq_ignore_ascii_case(&ext_lower) {
                if let Ok(n) = num_part.0.parse::<u32>() {
                    max_n = max_n.max(n);
                }
            }
        }
    }
    let next = max_n.saturating_add(1).max(1);
    dir.join(format!("{base}_{next:02}.{ext_lower}"))
}

fn unique_png_path(dir: &Path, stem: &str) -> PathBuf {
    numbered_file(dir, stem, "png")
}

pub fn clips_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("clips");
    fs::create_dir_all(&dir).map_err(|err| format!("建不了原图文件夹：{err}"))?;
    Ok(dir)
}

fn encode_rgba_png(width: u32, height: u32, bytes: &[u8]) -> Option<Vec<u8>> {
    if width == 0 || height == 0 || bytes.len() < (width as usize) * (height as usize) * 4 {
        return None;
    }
    let image = image::RgbaImage::from_raw(width, height, bytes.to_vec())?;
    let mut png = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut png);
    image::ImageEncoder::write_image(
        encoder,
        image.as_raw(),
        image.width(),
        image.height(),
        image::ExtendedColorType::Rgba8,
    )
    .ok()?;
    Some(png)
}

/// Save full-res clipboard PNG under APPDATA/clips; skip if encoded > 8MB.
pub fn keep_original_rgba(
    app: &AppHandle,
    width: u32,
    height: u32,
    bytes: &[u8],
) -> Option<String> {
    let png = encode_rgba_png(width, height, bytes)?;
    if png.len() as u64 > MAX_ORIGINAL_BYTES {
        return None;
    }
    let dir = clips_dir(app).ok()?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("clip-{stamp}.png"));
    fs::write(&path, &png).ok()?;
    Some(path.display().to_string())
}

/// Keep already-encoded image bytes; skip if > 8MB.
pub fn keep_original_bytes(app: &AppHandle, bytes: &[u8], ext: &str) -> Option<String> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_ORIGINAL_BYTES {
        return None;
    }
    if image::load_from_memory(bytes).is_err() {
        return None;
    }
    let dir = clips_dir(app).ok()?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let ext = match ext.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "jpg",
        "webp" => "webp",
        "gif" => "gif",
        "bmp" => "bmp",
        _ => "png",
    };
    let path = dir.join(format!("clip-{stamp}.{ext}"));
    fs::write(&path, bytes).ok()?;
    Some(path.display().to_string())
}

fn file_mtime(path: &Path) -> SystemTime {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .unwrap_or(UNIX_EPOCH)
}

fn file_len(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

fn cleanup_clips_inner(dir: &Path, pinned: &[String]) -> Result<(u32, u64), String> {
    let pinned_set: std::collections::HashSet<PathBuf> = pinned
        .iter()
        .map(PathBuf::from)
        .map(|p| fs::canonicalize(&p).unwrap_or(p))
        .collect();

    let now = SystemTime::now();
    let mut removed = 0u32;
    let mut entries: Vec<(PathBuf, SystemTime, u64, bool)> = Vec::new();

    if dir.is_dir() {
        for entry in fs::read_dir(dir).map_err(|err| err.to_string())? {
            let entry = entry.map_err(|err| err.to_string())?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let canon = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
            let is_pinned = pinned_set.contains(&canon) || pinned_set.contains(&path);
            let mtime = file_mtime(&path);
            let len = file_len(&path);
            if !is_pinned {
                if let Ok(age) = now.duration_since(mtime) {
                    if age > CLIPS_MAX_AGE {
                        if fs::remove_file(&path).is_ok() {
                            removed += 1;
                            continue;
                        }
                    }
                }
            }
            entries.push((path, mtime, len, is_pinned));
        }
    }

    let mut total: u64 = entries.iter().map(|e| e.2).sum();
    if total > CLIPS_CAP_BYTES {
        let mut victims: Vec<_> = entries.iter().filter(|e| !e.3).cloned().collect();
        victims.sort_by_key(|e| e.1);
        for (path, _, len, _) in victims {
            if total <= CLIPS_CAP_BYTES {
                break;
            }
            if fs::remove_file(&path).is_ok() {
                total = total.saturating_sub(len);
                removed += 1;
            }
        }
    }
    Ok((removed, total))
}

#[tauri::command]
pub fn clip_cleanup(app: AppHandle, pinned_paths: Vec<String>) -> Result<serde_json::Value, String> {
    let dir = clips_dir(&app)?;
    let (removed, total) = cleanup_clips_inner(&dir, &pinned_paths)?;
    Ok(serde_json::json!({
        "removed": removed,
        "bytes": total,
        "dir": dir.display().to_string(),
    }))
}

#[tauri::command]
pub fn clip_keep_original(
    app: AppHandle,
    data_base64: String,
    mime: Option<String>,
) -> Result<Option<String>, String> {
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &data_base64)
        .map_err(|err| err.to_string())?;
    let ext = mime
        .as_deref()
        .unwrap_or("image/png")
        .split('/')
        .nth(1)
        .unwrap_or("png");
    Ok(keep_original_bytes(&app, &bytes, ext))
}

#[tauri::command]
pub fn clip_forget_original(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !path.is_file() {
        return Ok(());
    }
    let is_clips = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        == Some("clips");
    if !is_clips {
        return Err("只能删除 clips 目录里的原图".into());
    }
    let _ = fs::remove_file(&path);
    Ok(())
}

/// Prefer copying original into temp; else decode thumb data URL to PNG.
pub fn write_png(
    data_url: &str,
    preferred_name: &str,
    original_path: Option<&str>,
) -> Result<PathBuf, String> {
    let stem = sanitize_file_stem(preferred_name);
    let dir = temp_dir();
    fs::create_dir_all(&dir).map_err(|err| format!("建不了临时文件夹：{err}"))?;

    if let Some(src) = original_path {
        let src = PathBuf::from(src);
        if src.is_file() {
            let ext = src
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("png");
            let dest = numbered_file(&dir, &stem, ext);
            fs::copy(&src, &dest).map_err(|err| format!("复制原图失败：{err}"))?;
            return Ok(dest);
        }
    }

    let bytes = decode_data_url(data_url)?;
    let image = image::load_from_memory(&bytes).map_err(|err| format!("读不了这张图：{err}"))?;
    let path = unique_png_path(&dir, &stem);
    image
        .save_with_format(&path, image::ImageFormat::Png)
        .map_err(|err| format!("写不了 PNG：{err}"))?;
    Ok(path)
}

#[tauri::command]
pub fn clip_write_temp(
    data_url: String,
    name: String,
    original_path: Option<String>,
) -> Result<String, String> {
    write_png(&data_url, &name, original_path.as_deref()).map(|path| path.display().to_string())
}

#[tauri::command]
pub async fn clip_save_as(
    window: tauri::WebviewWindow,
    data_url: String,
    default_name: String,
    original_path: Option<String>,
) -> Result<Option<String>, String> {
    let stem = sanitize_file_stem(&default_name);

    let (ext, filter_label, filter_exts): (String, String, Vec<String>) =
        if let Some(ref src) = original_path {
            let src_path = Path::new(src);
            if src_path.is_file() {
                let ext = src_path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("png")
                    .to_ascii_lowercase();
                let (label, list) = match ext.as_str() {
                    "jpg" | "jpeg" => ("JPEG 图片".into(), vec!["jpg".into(), "jpeg".into()]),
                    "png" => ("PNG 图片".into(), vec!["png".into()]),
                    other => ("图片".into(), vec![other.to_string()]),
                };
                (ext, label, list)
            } else {
                ("png".into(), "PNG 图片".into(), vec!["png".into()])
            }
        } else {
            ("png".into(), "PNG 图片".into(), vec!["png".into()])
        };
    // 对话框默认名：先给 _01，真正写入时若冲突再递增
    let default_file = format!("{stem}_01.{ext}");

    let picked = tauri::async_runtime::spawn_blocking({
        let default_file = default_file.clone();
        let filter_label = filter_label.clone();
        let filter_exts = filter_exts.clone();
        move || {
            let exts: Vec<&str> = filter_exts.iter().map(|s| s.as_str()).collect();
            rfd::FileDialog::new()
                .set_title("另存为图片")
                .set_file_name(&default_file)
                .add_filter(&filter_label, &exts)
                .set_parent(&window)
                .save_file()
        }
    })
    .await
    .map_err(|err| err.to_string())?;

    let Some(mut path) = picked else {
        return Ok(None);
    };
    if path.extension().and_then(|ext| ext.to_str()).is_none() {
        let fallback = default_file
            .rsplit_once('.')
            .map(|(_, e)| e)
            .unwrap_or("png");
        path = path.with_extension(fallback);
    }

    // 若目标已存在，在同目录按序号递增，避免覆盖
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png");
    let parent = path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from("."));
    let final_path = if path.exists() {
        numbered_file(&parent, &stem, ext)
    } else {
        // 若用户没改默认名（stem_01），也走编号逻辑保证不撞车
        let file_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if file_stem == format!("{stem}_01") || file_stem == stem {
            numbered_file(&parent, &stem, ext)
        } else {
            path.clone()
        }
    };

    if let Some(ref src) = original_path {
        let src = PathBuf::from(src);
        if src.is_file() {
            fs::copy(&src, &final_path).map_err(|err| format!("没能保存：{err}"))?;
            return Ok(Some(final_path.display().to_string()));
        }
    }

    let bytes = decode_data_url(&data_url)?;
    let image = image::load_from_memory(&bytes).map_err(|err| format!("读不了这张图：{err}"))?;
    image
        .save_with_format(&final_path, image::ImageFormat::Png)
        .map_err(|err| format!("没能保存：{err}"))?;
    Ok(Some(final_path.display().to_string()))
}

/// Copy original to temp first, then native file drag (do not drag clips originals away).
#[tauri::command]
pub fn clip_start_drag(
    window: tauri::WebviewWindow,
    data_url: String,
    name: String,
    original_path: Option<String>,
) -> Result<(), String> {
    let path = write_png(&data_url, &name, original_path.as_deref())?;
    let abs = fs::canonicalize(&path).unwrap_or(path);
    let preview = drag::Image::File(abs.clone());
    drag::start_drag(
        &window,
        drag::DragItem::Files(vec![abs]),
        preview,
        |_result, _cursor| {},
        drag::Options::default(),
    )
    .map_err(|err| format!("拖不出去：{err}"))
}
