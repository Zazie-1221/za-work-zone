//! 把用户的文件真正放进项目文件夹：复制（保留原件）或移动（先复制并核对，再删原件）。
//! 只处理单个文件；目标重名自动加 -2、-3 后缀；失败时不留半截文件，也绝不先删原件。

use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IngestResult {
    /// 文件现在的完整路径（复制/移动之后的新位置）。
    pub path: String,
    /// 最终文件名（重名时带后缀）。
    pub name: String,
    pub size: u64,
    /// 原件已经不在原处（移动成功）。
    pub moved: bool,
    /// 原件还在，且这次本该移走（删除失败、被占用等）。
    pub original_left: bool,
    /// 这个文件本来就在目标文件夹里，没有动它。
    pub in_place: bool,
    pub note: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Copy,
    Move,
}

impl Mode {
    pub fn parse(value: &str) -> Result<Mode, String> {
        match value {
            "copy" => Ok(Mode::Copy),
            "move" => Ok(Mode::Move),
            other => Err(format!("不认识的导入方式：{other}")),
        }
    }
}

pub fn normalize(path: &str) -> String {
    let trimmed = path.trim();
    if cfg!(windows) {
        trimmed.replace('/', "\\")
    } else {
        trimmed.to_string()
    }
}

fn label(path: &Path) -> String {
    path.file_name().and_then(|item| item.to_str()).unwrap_or("文件").to_string()
}

fn explain(err: &std::io::Error, what: &str, path: &Path) -> String {
    match err.kind() {
        std::io::ErrorKind::NotFound => format!("{what}：找不到 {}。", label(path)),
        std::io::ErrorKind::PermissionDenied => format!("{what}：没有权限（{}）。", label(path)),
        _ => format!("{what}：{} {err}", label(path)),
    }
}

/// 在 dir 里占一个没人用的名字（create_new 保证不会覆盖已有文件），重名依次试 -2、-3……
fn reserve(dir: &Path, name: &str) -> Result<(PathBuf, File), String> {
    let (stem, ext) = match name.rfind('.') {
        Some(dot) if dot > 0 => (&name[..dot], &name[dot..]),
        _ => (name, ""),
    };
    for n in 1..10_000u32 {
        let candidate = if n == 1 { name.to_string() } else { format!("{stem}-{n}{ext}") };
        let target = dir.join(&candidate);
        match OpenOptions::new().write(true).create_new(true).open(&target) {
            Ok(file) => return Ok((target, file)),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(explain(&err, "没法在项目文件夹里建文件", &target)),
        }
    }
    Err(format!("项目文件夹里重名太多：{name}"))
}

fn same_content(a: &Path, b: &Path) -> std::io::Result<bool> {
    let (mut fa, mut fb) = (File::open(a)?, File::open(b)?);
    if fa.metadata()?.len() != fb.metadata()?.len() {
        return Ok(false);
    }
    let (mut ba, mut bb) = (vec![0u8; 1 << 20], vec![0u8; 1 << 20]);
    loop {
        let na = read_full(&mut fa, &mut ba)?;
        let nb = read_full(&mut fb, &mut bb)?;
        if na != nb || ba[..na] != bb[..nb] {
            return Ok(false);
        }
        if na == 0 {
            return Ok(true);
        }
    }
}

fn read_full(file: &mut File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = file.read(&mut buf[filled..])?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}

/// 把 src 复制到已占好的 target，并逐字节核对；不一致就报错（调用方负责清掉 target）。
pub fn copy_verified(src: &Path, target: &Path) -> Result<u64, String> {
    let mut from = File::open(src).map_err(|err| explain(&err, "读不了原文件", src))?;
    let modified = from.metadata().ok().and_then(|meta| meta.modified().ok());
    let mut to = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(target)
        .map_err(|err| explain(&err, "写不了目标", target))?;
    let copied = std::io::copy(&mut from, &mut to).map_err(|err| explain(&err, "复制中断", target))?;
    to.flush().map_err(|err| explain(&err, "复制中断", target))?;
    to.sync_all().map_err(|err| explain(&err, "复制中断", target))?;
    if let Some(time) = modified {
        let _ = to.set_modified(time);
    }
    drop(to);
    drop(from);
    let expected = fs::metadata(src).map_err(|err| explain(&err, "核对原文件", src))?.len();
    let got = fs::metadata(target).map_err(|err| explain(&err, "核对副本", target))?.len();
    if copied != expected || got != expected {
        return Err(format!("{} 复制后大小对不上，已撤销。", label(src)));
    }
    match same_content(src, target) {
        Ok(true) => Ok(copied),
        Ok(false) => Err(format!("{} 复制后内容对不上，已撤销。", label(src))),
        Err(err) => Err(explain(&err, "核对副本", target)),
    }
}

/// 复制并核对，成功后才删原件；跨盘移动走这条路。删不掉时返回 Ok(false)，副本保留。
pub fn move_by_copy(src: &Path, target: &Path) -> Result<(u64, Option<String>), String> {
    let size = copy_verified(src, target)?;
    match fs::remove_file(src) {
        Ok(()) => Ok((size, None)),
        Err(err) => {
            let why = match err.kind() {
                std::io::ErrorKind::PermissionDenied => "没有权限删除，可能被别的程序占用".to_string(),
                _ => err.to_string(),
            };
            Ok((size, Some(why)))
        }
    }
}

fn canonical_parent(path: &Path) -> Option<PathBuf> {
    path.parent().and_then(|parent| fs::canonicalize(parent).ok())
}

pub fn ingest(src: &str, dest_dir: &str, mode: Mode) -> Result<IngestResult, String> {
    let src_path = PathBuf::from(normalize(src));
    let dest_dir = PathBuf::from(normalize(dest_dir));
    let meta = fs::metadata(&src_path).map_err(|err| explain(&err, "没放进来", &src_path))?;
    if meta.is_dir() {
        return Err(format!("{} 是文件夹，只能记录路径。", label(&src_path)));
    }
    let name = label(&src_path);
    fs::create_dir_all(&dest_dir).map_err(|err| explain(&err, "建不了项目里的文件夹", &dest_dir))?;

    if let (Some(a), Ok(b)) = (canonical_parent(&src_path), fs::canonicalize(&dest_dir)) {
        if a == b {
            return Ok(IngestResult {
                path: src_path.display().to_string(),
                name,
                size: meta.len(),
                moved: false,
                original_left: false,
                in_place: true,
                note: Some("本来就在项目文件夹里".into()),
            });
        }
    }

    let (target, handle) = reserve(&dest_dir, &name)?;
    drop(handle);
    let final_name = label(&target);
    let undo = |target: &Path| {
        let _ = fs::remove_file(target);
    };

    if mode == Mode::Move {
        // 同一个盘：直接改名，瞬间完成。改名失败（跨盘、被占用……）就退回复制+核对+删原件。
        if fs::rename(&src_path, &target).is_ok() {
            return Ok(IngestResult {
                path: target.display().to_string(),
                name: final_name,
                size: meta.len(),
                moved: true,
                original_left: false,
                in_place: false,
                note: None,
            });
        }
        return match move_by_copy(&src_path, &target) {
            Ok((size, left)) => Ok(IngestResult {
                path: target.display().to_string(),
                name: final_name,
                size,
                moved: left.is_none(),
                original_left: left.is_some(),
                in_place: false,
                note: left.map(|why| format!("已复制进来，但原文件没删掉：{why}")),
            }),
            Err(err) => {
                undo(&target);
                Err(err)
            }
        };
    }

    match copy_verified(&src_path, &target) {
        Ok(size) => Ok(IngestResult {
            path: target.display().to_string(),
            name: final_name,
            size,
            moved: false,
            original_left: false,
            in_place: false,
            note: None,
        }),
        Err(err) => {
            undo(&target);
            Err(err)
        }
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SettleResult {
    /// 原文件已经删掉（移动完成）。
    pub removed: bool,
    pub note: Option<String>,
}

/// 项目里已经有这份文件的副本、原文件还在，而用户现在选的是“移动进来”：
/// 逐字节核对副本和原文件一样，才删原文件；不一样就什么都不动。
pub fn settle_move(src: &str, kept: &str) -> Result<SettleResult, String> {
    let src_path = PathBuf::from(normalize(src));
    let kept_path = PathBuf::from(normalize(kept));
    let meta = fs::metadata(&src_path).map_err(|err| explain(&err, "没移走原文件", &src_path))?;
    if meta.is_dir() {
        return Err(format!("{} 是文件夹，只能记录路径。", label(&src_path)));
    }
    if !kept_path.is_file() {
        return Err(format!("项目里的那份 {} 找不到了，原文件没动", label(&kept_path)));
    }
    if let (Ok(a), Ok(b)) = (fs::canonicalize(&src_path), fs::canonicalize(&kept_path)) {
        if a == b {
            return Ok(SettleResult { removed: false, note: Some("它就是项目里的那个文件，没有动".into()) });
        }
    }
    match same_content(&src_path, &kept_path) {
        Ok(true) => match fs::remove_file(&src_path) {
            Ok(()) => Ok(SettleResult { removed: true, note: None }),
            Err(err) => Err(match err.kind() {
                std::io::ErrorKind::PermissionDenied => format!("没有权限删除 {}，可能被别的程序占用", label(&src_path)),
                _ => explain(&err, "没删掉原文件", &src_path),
            }),
        },
        Ok(false) => Ok(SettleResult {
            removed: false,
            note: Some("原文件和项目里的副本内容不一样（原文件改过），没有删它".into()),
        }),
        Err(err) => Err(explain(&err, "核对副本", &kept_path)),
    }
}
/// 读文件的一段并转成 base64，给“边读边写进项目包”用，避免整个大文件进内存。
pub fn read_chunk(path: &str, offset: u64, len: usize) -> Result<String, String> {
    use std::io::{Seek, SeekFrom};
    let path = PathBuf::from(normalize(path));
    let len = len.min(8 * 1024 * 1024);
    let mut file = File::open(&path).map_err(|err| explain(&err, "读不了", &path))?;
    file.seek(SeekFrom::Start(offset)).map_err(|err| explain(&err, "读不了", &path))?;
    let mut buf = vec![0u8; len];
    let n = read_full(&mut file, &mut buf).map_err(|err| explain(&err, "读不了", &path))?;
    buf.truncate(n);
    Ok(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, buf))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "za-ingest-{tag}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn text(path: impl AsRef<Path>) -> String {
        fs::read_to_string(path).unwrap()
    }

    #[test]
    fn copy_keeps_the_original_and_handles_spaces() {
        let base = scratch("copy");
        let src_dir = base.join("my files");
        fs::create_dir_all(&src_dir).unwrap();
        let src = src_dir.join("shubiao new.3dm");
        fs::write(&src, "model-bytes").unwrap();
        let dest = base.join("store dir").join("03 建模");
        let done = ingest(src.to_str().unwrap(), dest.to_str().unwrap(), Mode::Copy).unwrap();
        assert!(src.exists(), "copy must keep the original");
        assert_eq!(text(&done.path), "model-bytes");
        assert_eq!(done.name, "shubiao new.3dm");
        assert!(done.path.contains("03 建模"));
        assert!(!done.moved && !done.original_left && !done.in_place);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn move_removes_the_original() {
        let base = scratch("move");
        let src = base.join("a b.ksp");
        fs::write(&src, "scene").unwrap();
        let dest = base.join("proj").join("渲染");
        let done = ingest(src.to_str().unwrap(), dest.to_str().unwrap(), Mode::Move).unwrap();
        assert!(!src.exists(), "move must remove the original");
        assert_eq!(text(&done.path), "scene");
        assert!(done.moved && !done.original_left);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn name_collisions_get_a_suffix_and_never_overwrite() {
        let base = scratch("collide");
        let dest = base.join("proj");
        fs::create_dir_all(&dest).unwrap();
        fs::write(dest.join("x y.png"), "old").unwrap();
        let src = base.join("in").join("x y.png");
        fs::create_dir_all(src.parent().unwrap()).unwrap();
        fs::write(&src, "new").unwrap();
        let first = ingest(src.to_str().unwrap(), dest.to_str().unwrap(), Mode::Copy).unwrap();
        let second = ingest(src.to_str().unwrap(), dest.to_str().unwrap(), Mode::Copy).unwrap();
        assert_eq!(first.name, "x y-2.png");
        assert_eq!(second.name, "x y-3.png");
        assert_eq!(text(dest.join("x y.png")), "old");
        assert_eq!(text(&first.path), "new");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_file_already_in_the_folder_is_left_alone() {
        let base = scratch("inplace");
        let dest = base.join("proj");
        fs::create_dir_all(&dest).unwrap();
        let src = dest.join("keep.txt");
        fs::write(&src, "same").unwrap();
        let done = ingest(src.to_str().unwrap(), dest.to_str().unwrap(), Mode::Move).unwrap();
        assert!(done.in_place);
        assert!(src.exists());
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 1);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn missing_files_and_folders_fail_without_leaving_anything() {
        let base = scratch("fail");
        let dest = base.join("proj");
        assert!(ingest(base.join("gone.txt").to_str().unwrap(), dest.to_str().unwrap(), Mode::Copy).is_err());
        let folder = base.join("a folder");
        fs::create_dir_all(&folder).unwrap();
        assert!(ingest(folder.to_str().unwrap(), dest.to_str().unwrap(), Mode::Move).is_err());
        assert!(folder.exists());
        assert!(!dest.exists() || fs::read_dir(&dest).unwrap().count() == 0);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn cross_volume_move_copies_verifies_then_deletes() {
        let base = scratch("xvol");
        let src = base.join("big one.bin");
        let body: Vec<u8> = (0..3_500_000u32).map(|n| (n % 251) as u8).collect();
        fs::write(&src, &body).unwrap();
        let target = base.join("target.bin");
        fs::write(&target, b"").unwrap();
        let (size, left) = move_by_copy(&src, &target).unwrap();
        assert_eq!(size, body.len() as u64);
        assert!(left.is_none());
        assert!(!src.exists());
        assert_eq!(fs::read(&target).unwrap(), body);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_failed_copy_never_touches_the_original() {
        let base = scratch("keep");
        let src = base.join("precious.3dm");
        fs::write(&src, "do-not-lose").unwrap();
        // target inside a missing directory: the copy cannot even start.
        let target = base.join("nowhere").join("precious.3dm");
        assert!(move_by_copy(&src, &target).is_err());
        assert_eq!(text(&src), "do-not-lose");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn chunks_reassemble_the_file() {
        let base = scratch("chunk");
        let src = base.join("c d.bin");
        let body: Vec<u8> = (0..100_000u32).map(|n| (n % 199) as u8).collect();
        fs::write(&src, &body).unwrap();
        let mut got = Vec::new();
        let mut offset = 0u64;
        loop {
            let part = read_chunk(src.to_str().unwrap(), offset, 30_000).unwrap();
            let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, part).unwrap();
            if bytes.is_empty() {
                break;
            }
            offset += bytes.len() as u64;
            got.extend(bytes);
        }
        assert_eq!(got, body);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn settle_move_removes_the_original_only_when_the_kept_copy_matches() {
        let base = scratch("settle");
        let src = base.join("orig dir").join("a b.3dm");
        fs::create_dir_all(src.parent().unwrap()).unwrap();
        fs::write(&src, "same-bytes").unwrap();
        let kept = base.join("store").join("a b.3dm");
        fs::create_dir_all(kept.parent().unwrap()).unwrap();
        fs::write(&kept, "same-bytes").unwrap();
        let done = settle_move(src.to_str().unwrap(), kept.to_str().unwrap()).unwrap();
        assert!(done.removed);
        assert!(!src.exists());
        assert!(kept.exists());

        // 内容不一样：两个都不动。
        fs::write(&src, "edited-later").unwrap();
        let done = settle_move(src.to_str().unwrap(), kept.to_str().unwrap()).unwrap();
        assert!(!done.removed && done.note.is_some());
        assert!(src.exists() && kept.exists());

        // 副本不见了：报错，原文件不动。
        fs::remove_file(&kept).unwrap();
        assert!(settle_move(src.to_str().unwrap(), kept.to_str().unwrap()).is_err());
        assert!(src.exists());
        let _ = fs::remove_dir_all(&base);
    }
    /// Manual real cross-drive check: ZA_XVOL_SRC=<file on C:> ZA_XVOL_DEST=<dir on D:> cargo test real_cross_drive -- --ignored
    #[test]
    #[ignore]
    fn real_cross_drive() {
        let src = std::env::var("ZA_XVOL_SRC").expect("set ZA_XVOL_SRC");
        let dest = std::env::var("ZA_XVOL_DEST").expect("set ZA_XVOL_DEST");
        let done = ingest(&src, &dest, Mode::Move).unwrap();
        assert!(!Path::new(&src).exists());
        assert!(Path::new(&done.path).exists());
    }
}
