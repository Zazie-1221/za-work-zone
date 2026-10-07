import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/zone/model";
import {
  archivePackage,
  createProjectPackage,
  currentExternalRows,
  downloadPackageZip,
  fitSelected,
  freeSpace,
  importFolderFiles,
  listPackageBackups,
  openProjectPackage,
  openZipFile,
  packageSession,
  packExternal,
  restorePackageBackup,
  type BackupRow,
} from "@/lib/zone/package-fs";
import { useZone } from "@/lib/zone/store";

export function PackageBar({ onStatus }: { onStatus: (message: string) => void }) {
  const workspace = useZone((s) => s.workspaces.find((item) => item.id === s.activeWorkspaceId) ?? s.workspaces[0]);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [openMenu, setOpenMenu] = useState(false);
  const [packing, setPacking] = useState(false);
  const [history, setHistory] = useState(false);
  const [backups, setBackups] = useState<BackupRow[]>([]);
  const [rows, setRows] = useState(currentExternalRows);
  const [picked, setPicked] = useState<string[]>([]);
  const [free, setFree] = useState<number | null>(null);
  const zipRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const session = packageSession();
  const active = Boolean(workspace?.packageId && session?.packageId === workspace.packageId);
  const readonly = Boolean(active && session?.readonly);

  useEffect(() => {
    if (!openMenu) return;
    const onPointer = (event: PointerEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpenMenu(false);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [openMenu]);

  function refreshPack() {
    const list = currentExternalRows();
    setRows(list);
    setPicked(list.filter((row) => !row.missing).map((row) => row.id));
    void freeSpace().then(setFree);
  }

  async function run(task: () => Promise<string>) {
    if (busy) return;
    setBusy(true);
    try {
      onStatus(await task());
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "这一步没有完成。");
    } finally {
      setBusy(false);
    }
  }

  const fit = fitSelected(rows, picked, free);
  const big = rows.some((row) => picked.includes(row.id) && row.big);

  return (
    <section ref={boxRef} className="zone-pkg flex flex-col gap-1">
      <p className="zone-label px-1 text-xs text-faint">项目包</p>
      {active ? (
        <p className="px-1 text-xs text-faint">
          {workspace?.archived ? "已归档 · " : ""}
          {readonly ? "只读 · " : ""}
          {session?.mode === "browser" ? "项目包在浏览器里。导出 zip 可以拷走，再拖回来。" : "项目包文件夹"}
        </p>
      ) : null}
      <div className="flex gap-1">
        <Button
          variant="quiet"
          className="min-w-0 flex-1"
          disabled={busy}
          onClick={() => {
            setName("");
            setNaming(true);
            setOpenMenu(false);
          }}
        >
          新建项目包
        </Button>
        <Button
          variant="quiet"
          className="min-w-0 flex-1"
          disabled={busy}
          aria-expanded={openMenu}
          onClick={() => setOpenMenu((value) => !value)}
        >
          打开项目包
        </Button>
      </div>
      {naming ? (
        <form
          className="flex flex-col gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            const title = name.trim() || "未命名项目";
            setNaming(false);
            void run(() => createProjectPackage(title));
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="项目名称"
            aria-label="项目名称"
            className="h-11 rounded-md bg-raised px-3 text-sm text-paper outline-none placeholder:text-faint"
          />
          <div className="flex gap-1">
            <Button type="submit" variant="primary" className="min-w-0 flex-1" disabled={busy}>
              建立
            </Button>
            <Button variant="ghost" onClick={() => setNaming(false)}>
              取消
            </Button>
          </div>
        </form>
      ) : null}
      {openMenu ? (
        <div className="flex flex-col gap-1 rounded-md border border-line bg-raised p-1">
          <Button
            variant="quiet"
            onClick={() => {
              setOpenMenu(false);
              const picker = (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
              if (typeof picker === "function") {
                void run(() => openProjectPackage());
                return;
              }
              dirRef.current?.click();
            }}
          >
            选择文件夹
          </Button>
          <Button
            variant="quiet"
            onClick={() => {
              setOpenMenu(false);
              zipRef.current?.click();
            }}
          >
            打开 zip
          </Button>
        </div>
      ) : null}
      {active ? (
        <div className="flex flex-wrap gap-1">
          <Button variant="quiet" disabled={busy} onClick={() => void run(() => downloadPackageZip())}>
            导出 zip
          </Button>
          <Button
            variant="quiet"
            disabled={busy || readonly}
            onClick={() => {
              const next = !packing;
              setPacking(next);
              if (next) refreshPack();
            }}
          >
            打包外部引用
          </Button>
          <Button variant="ghost" disabled={busy || readonly} onClick={() => void run(() => archivePackage(!workspace?.archived))}>
            {workspace?.archived ? "重新打开" : "归档"}
          </Button>
          <Button
            variant="ghost"
            disabled={busy || readonly}
            onClick={() => {
              const next = !history;
              setHistory(next);
              if (next) void listPackageBackups().then(setBackups);
            }}
          >
            备份
          </Button>
        </div>
      ) : null}
      {history && active ? (
        <div className="flex flex-col gap-1 rounded-md bg-raised p-2">
          <p className="text-xs text-muted">恢复前会先把现在的清单再存一份。删掉阶段之后，可以从这里找回来。</p>
          {backups.length === 0 ? <p className="text-xs text-faint">还没有备份。打开项目，或改动之后，会自动留下。</p> : null}
          {backups.map((row) => (
            <button
              key={row.name}
              type="button"
              className="flex h-11 items-center rounded-sm px-2 text-left text-sm hover:bg-panel"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const message = await restorePackageBackup(row.name);
                  setBackups(await listPackageBackups());
                  return message;
                })
              }
            >
              {row.daily ? "每日 · " : ""}
              {row.label}
            </button>
          ))}
        </div>
      ) : null}
      {packing && active ? (
        <div className="flex flex-col gap-1 rounded-md bg-raised p-2">
          {rows.length === 0 ? <p className="text-xs text-muted">没有外部引用。</p> : null}
          <ul className="flex flex-col gap-1">
            {rows.map((row) => (
              <li key={row.id} className="flex min-h-11 items-center gap-2 text-sm">
                {row.missing ? (
                  <span className="min-w-0 flex-1 truncate text-[#e15b4a]">
                    {row.name} · 找不到
                  </span>
                ) : (
                  <label className="flex min-w-0 flex-1 items-center gap-2">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={picked.includes(row.id)}
                      onChange={() =>
                        setPicked((list) => (list.includes(row.id) ? list.filter((id) => id !== row.id) : [...list, row.id]))
                      }
                    />
                    <span className="min-w-0">
                      <span className="block truncate">{row.name}</span>
                      <span className="block truncate text-xs text-faint">
                        {formatBytes(row.size) || "大小未知"}
                        {row.big ? " · 超过 500 MB" : ""}
                        {" · "}
                        {row.where}
                      </span>
                    </span>
                  </label>
                )}
              </li>
            ))}
          </ul>
          <p className="text-xs text-faint">
            合计 {formatBytes(fit.total) || "0 B"}
            {free != null ? ` · 大约还能放 ${formatBytes(free)}` : ""}
          </p>
          {big ? <p className="text-xs text-[#e15b4a]">有超过 500 MB 的文件，复制会比较久。</p> : null}
          {fit.short ? <p className="text-xs text-[#e15b4a]">空间不够，先空出一些再复制。</p> : null}
          <Button
            variant="primary"
            disabled={busy || readonly || fit.short || picked.length === 0}
            onClick={() =>
              void run(async () => {
                const message = await packExternal(picked);
                refreshPack();
                setPacking(false);
                return message;
              })
            }
          >
            复制进项目包
          </Button>
        </div>
      ) : null}
      <input
        ref={zipRef}
        type="file"
        accept=".zip,application/zip"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          void run(() => openZipFile(file));
        }}
      />
      <input
        ref={dirRef}
        type="file"
        className="sr-only"
        multiple
        onChange={(event) => {
          const list = [...(event.target.files ?? [])];
          event.target.value = "";
          if (list.length === 0) return;
          void run(async () => (await importFolderFiles(list)) ?? "这不是项目包。");
        }}
        {...{ webkitdirectory: "" }}
      />
    </section>
  );
}
