import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { FsEntry, Hit, Instance, InstanceSettings, MrVersion, Settings, ToastFn, VersionEntry } from "./types";
import { MemoryForm } from "./GameForm";
import { EMPTY_FACETS, Facets } from "./Facets";
import type { FacetState } from "./Facets";
import { Icon, Modal, ProjectIcon, Select, Seg, Switch, st, useMounted, Pager } from "./ui";
import { compact, fmtSize, joinPath, loaderName, prettyName } from "./settings";
import { t } from "./i18n";

export type ManageTab = "mods" | "resourcepacks" | "shaderpacks" | "worlds" | "screenshots" | "settings" | "journal";
type Kind = "mod" | "resourcepack" | "shader";
type Ident = { file: string; title: string; icon?: string | null; projectId: string; versionId: string; versionName: string };
type World = { folder: string; icon?: string | null; modified: number };

const TABS: { id: ManageTab; label: string; icon: string }[] = [
  { id: "mods", label: "Моды", icon: "package" },
  { id: "resourcepacks", label: "Ресурс-паки", icon: "image" },
  { id: "shaderpacks", label: "Шейдеры", icon: "palette" },
  { id: "worlds", label: "Миры", icon: "globe" },
  { id: "screenshots", label: "Скриншоты", icon: "image" },
  { id: "settings", label: "Настройки", icon: "sliders" },
  { id: "journal", label: "Журнал", icon: "terminal" },
];

const SEARCH_PAGE = 20;

export function Manage({ inst, settings, versions, logs, initialTab, onClose, onChanged, onClearLogs, toast }: {
  inst: Instance;
  settings: Settings;
  versions: VersionEntry[];
  logs: string[];
  initialTab: ManageTab;
  onClose: () => void;
  onChanged: () => void;
  onClearLogs: () => void;
  toast: ToastFn;
}) {
  const [tab, setTab] = useState<ManageTab>(initialTab);
  return (
    <Modal title={t("Управление: {n}", { n: inst.name })} onClose={onClose} size="xl">
      <div className="manage">
        <div className="manage-tabs">
          {TABS.map((x) => (
            <button key={x.id} className={"manage-tab" + (tab === x.id ? " active" : "")} onClick={() => setTab(x.id)}>
              <Icon name={x.icon} size={16} /> {t(x.label)}
            </button>
          ))}
          <button className="manage-tab folder" onClick={() => invoke("instance_open_dir", { id: inst.id }).catch((e) => toast(String(e), "err"))}>
            <Icon name="folder" size={16} /> {t("Папка сборки")}
          </button>
        </div>
        <div className="manage-body" key={tab}>
          {tab === "mods" && <Content inst={inst} kind="mod" dir="mods" versions={versions} toast={toast} />}
          {tab === "resourcepacks" && <Content inst={inst} kind="resourcepack" dir="resourcepacks" versions={versions} toast={toast} />}
          {tab === "shaderpacks" && <Content inst={inst} kind="shader" dir="shaderpacks" versions={versions} toast={toast} />}
          {tab === "worlds" && <Worlds inst={inst} toast={toast} />}
          {tab === "screenshots" && <Shots inst={inst} toast={toast} />}
          {tab === "settings" && <InstSettings inst={inst} settings={settings} versions={versions} onChanged={onChanged} toast={toast} />}
          {tab === "journal" && <Journal inst={inst} logs={logs} onClear={onClearLogs} />}
        </div>
      </div>
    </Modal>
  );
}

type Upd = { file: string; versionId: string; versionName: string };
type DirCache = { entries: FsEntry[]; ids: Record<string, Ident>; upds: Record<string, Upd>; updsSig: string; updsAt: number };

const dirCache = new Map<string, DirCache>();
const identStore: Record<string, Ident | null> = (() => {
  try {
    return JSON.parse(localStorage.getItem("its.ident2") || "{}");
  } catch {
    return {};
  }
})();
const saveIdents = () => {
  try {
    if (Object.keys(identStore).length > 4000) for (const k of Object.keys(identStore).slice(0, 1500)) delete identStore[k];
    localStorage.setItem("its.ident2", JSON.stringify(identStore));
  } catch {}
};
const sigOf = (key: string, e: FsEntry) => `${key}|${e.name}|${e.size}|${e.modified}`;

async function loadDir(inst: Instance, rel: string): Promise<DirCache> {
  const key = `${inst.id}|${rel}`;
  const entries = await invoke<FsEntry[]>("instance_list_dir", { id: inst.id, rel });
  const files = entries.filter((e) => !e.isDir);
  const need = files.filter((e) => !(sigOf(key, e) in identStore)).map((e) => e.name);
  if (need.length) {
    const r = await invoke<Ident[]>("instance_identify", { id: inst.id, rel, names: need }).catch(() => [] as Ident[]);
    const byName = Object.fromEntries(r.map((x) => [x.file, x]));
    for (const e of files) if (need.includes(e.name)) identStore[sigOf(key, e)] = byName[e.name] ?? null;
    saveIdents();
  }
  const ids: Record<string, Ident> = {};
  for (const e of files) {
    const v = identStore[sigOf(key, e)];
    if (v) ids[e.name] = v;
  }
  const prev = dirCache.get(key);
  const c: DirCache = { entries, ids, upds: prev?.upds ?? {}, updsSig: prev?.updsSig ?? "", updsAt: prev?.updsAt ?? 0 };
  dirCache.set(key, c);
  return c;
}

async function refreshUpds(inst: Instance, rel: string, kind: Kind): Promise<Record<string, Upd>> {
  const key = `${inst.id}|${rel}`;
  const c = dirCache.get(key);
  if (!c) return {};
  const sig = c.entries.filter((e) => !e.isDir).map((e) => sigOf(key, e)).join(";") + inst.mcVersion + inst.loader;
  if (c.updsSig === sig && Date.now() - c.updsAt < 600000) return c.upds;
  const r = await invoke<Upd[]>("instance_updates", { id: inst.id, rel, kind });
  c.upds = Object.fromEntries(r.map((x) => [x.file, x]));
  c.updsSig = sig;
  c.updsAt = Date.now();
  return c.upds;
}

export function clearCache(id: string) {
  for (const k of [...dirCache.keys()]) if (k.startsWith(id + "|")) dirCache.delete(k);
}

export async function prefetchInstance(inst: Instance) {
  for (const d of ["mods", "resourcepacks", "shaderpacks"]) {
    try {
      await loadDir(inst, d);
    } catch {}
  }
}

const versionsCache = new Map<string, MrVersion[]>();

async function projectVersions(pid: string): Promise<MrVersion[]> {
  let all = versionsCache.get(pid);
  if (!all) {
    all = await invoke<MrVersion[]>("modrinth_versions", { projectId: pid });
    versionsCache.set(pid, all);
  }
  return all;
}

const compatible = (v: MrVersion, inst: Instance, kind: Kind) =>
  v.game_versions.includes(inst.mcVersion) &&
  (kind !== "mod" || inst.loader === "vanilla" || v.loaders.some((l) => l === inst.loader || (inst.loader === "quilt" && l === "fabric")));

const dirOf = (kind: Kind) => (kind === "mod" ? "mods" : kind === "resourcepack" ? "resourcepacks" : "shaderpacks");

function VersionPicker({ inst, kind, ident, file, onDone, toast }: { inst: Instance; kind: Kind; ident: Ident; file: string; onDone: () => void; toast: ToastFn }) {
  const [open, setOpen] = useState(false);
  const [mounted, closing] = useMounted(open, 160);
  const [list, setList] = useState<MrVersion[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [up, setUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [open]);

  async function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (open) return setOpen(false);
    const r = ref.current?.getBoundingClientRect();
    setUp(!!r && window.innerHeight - r.bottom < 300 && r.top > window.innerHeight - r.bottom);
    setOpen(true);
    if (list) return;
    try {
      setList((await projectVersions(ident.projectId)).filter((v) => compatible(v, inst, kind)));
    } catch (err) {
      toast(String(err), "err");
      setOpen(false);
    }
  }

  async function pick(v: MrVersion) {
    setBusy(v.id);
    try {
      await invoke("instance_update", { id: inst.id, rel: dirOf(kind), file, versionId: v.id });
      setOpen(false);
      onDone();
    } catch (err) {
      toast(String(err), "err");
    }
    setBusy(null);
  }

  return (
    <div className="vpick" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button className="icon-btn sm" title={t("Сменить версию")} onClick={toggle}><Icon name="swap" size={15} /></button>
      {mounted && (
        <div className={"vpick-pop" + (up ? " up" : "") + (closing ? " closing" : "")}>
          <div className="facet-title">{t("Версии для {v}", { v: inst.mcVersion })}</div>
          {!list && [0, 1, 2].map((i) => <div key={i} className="skel" style={{ height: 34, marginBottom: 6 }} />)}
          {list?.length === 0 && <div className="muted small" style={{ padding: 8 }}>{t("Нет версий для {v}", { v: inst.mcVersion })}</div>}
          <div className="vpick-list">
            {list?.map((v) => {
              const cur = v.id === ident.versionId;
              const k = ({ release: "ok", beta: "warn", alpha: "bad" } as Record<string, string>)[v.version_type] ?? "";
              return (
                <button key={v.id} className={"vpick-row" + (cur ? " cur" : "")} disabled={cur || busy !== null} onClick={() => pick(v)}>
                  <span className="grow ellipsis">{v.version_number}</span>
                  <span className={"chip " + k}>{v.version_type}</span>
                  {busy === v.id ? <span className="spinner sm" /> : cur && <Icon name="check" size={14} />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function UpdateAll({ inst, kind, items, onConfirm, onClose }: {
  inst: Instance;
  kind: Kind;
  items: { file: string; ident: Ident; upd: Upd }[];
  onConfirm: (sel: Record<string, string>) => void;
  onClose: () => void;
}) {
  const [opts, setOpts] = useState<Record<string, MrVersion[]>>({});
  const [chosen, setChosen] = useState<Record<string, string>>(() => Object.fromEntries(items.map((i) => [i.file, i.upd.versionId])));
  const [off, setOff] = useState<string[]>([]);
  useEffect(() => {
    items.forEach(async (i) => {
      try {
        const list = (await projectVersions(i.ident.projectId)).filter((v) => compatible(v, inst, kind));
        const cur = list.findIndex((v) => v.id === i.ident.versionId);
        setOpts((o) => ({ ...o, [i.file]: cur < 0 ? list : list.slice(0, cur) }));
      } catch {}
    });
  }, [items, inst, kind]);
  const active = items.filter((i) => !off.includes(i.file));
  return (
    <Modal title={t("Обновление: {n}", { n: active.length })} onClose={onClose} size="wide">
      <div className="upd-list">
        {items.map((i, n) => {
          const list = opts[i.file] ?? [];
          return (
            <div key={i.file} className={"upd-row" + (off.includes(i.file) ? " off" : "")} style={st(Math.min(n, 10))}>
              <ProjectIcon url={i.ident.icon} title={i.ident.title} size={36} />
              <div className="grow">
                <div className="fm-name ellipsis">{i.ident.title}</div>
                <div className="muted small ellipsis">{i.ident.versionName || "?"} → {list.find((v) => v.id === chosen[i.file])?.version_number ?? i.upd.versionName}</div>
              </div>
              {list.length > 1 && (
                <div className="upd-select">
                  <Select value={chosen[i.file]} onChange={(v) => setChosen((c) => ({ ...c, [i.file]: v }))} options={list.map((v) => ({ value: v.id, label: `${v.version_number} (${v.version_type})` }))} />
                </div>
              )}
              <input type="checkbox" className="switch" checked={!off.includes(i.file)} onChange={() => setOff((o) => (o.includes(i.file) ? o.filter((x) => x !== i.file) : [...o, i.file]))} />
            </div>
          );
        })}
      </div>
      <div className="row end">
        <button className="btn ghost" onClick={onClose}>{t("Отмена")}</button>
        <button className="btn primary" disabled={!active.length} onClick={() => onConfirm(Object.fromEntries(active.map((i) => [i.file, chosen[i.file]])))}>
          <Icon name="refresh" size={16} /> {t("Обновить")} ({active.length})
        </button>
      </div>
    </Modal>
  );
}

function Content({ inst, kind, dir, versions, toast }: { inst: Instance; kind: Kind; dir: string; versions: VersionEntry[]; toast: ToastFn }) {
  const first = dirCache.get(`${inst.id}|${dir}`);
  const [mode, setMode] = useState<"installed" | "modrinth">("installed");
  const [sub, setSub] = useState("");
  const [entries, setEntries] = useState<FsEntry[] | null>(first?.entries ?? null);
  const [ids, setIds] = useState<Record<string, Ident>>(first?.ids ?? {});
  const [upds, setUpds] = useState<Record<string, Upd>>(first?.upds ?? {});
  const [queue, setQueue] = useState<string[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [packs, setPacks] = useState<Set<string>>(new Set());
  const picks = useRef<Record<string, string>>({});
  const busyRef = useRef(false);
  const wasBusy = useRef(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [q, setQ] = useState("");
  const [locked, setLocked] = useState(true);
  const [fMc, setFMc] = useState("");
  const [fLoader, setFLoader] = useState("");
  const [facets, setFacets] = useState(EMPTY_FACETS);
  const rel = joinPath(dir, sub);

  const load = useCallback(async () => {
    const c0 = dirCache.get(`${inst.id}|${rel}`);
    if (c0) {
      setEntries(c0.entries);
      setIds(c0.ids);
      setUpds(c0.upds);
    } else setEntries(null);
    try {
      const c = await loadDir(inst, rel);
      setEntries(c.entries);
      setIds(c.ids);
      refreshUpds(inst, rel, kind).then(setUpds).catch(() => {});
      if (kind === "resourcepack") invoke<string[]>("instance_packs", { id: inst.id }).then((l) => setPacks(new Set(l))).catch(() => {});
    } catch (e) {
      toast(String(e), "err");
      setEntries([]);
    }
  }, [inst, rel, kind, toast]);
  useEffect(() => {
    if (mode === "installed") load();
  }, [load, mode]);

  useEffect(() => {
    if (mode !== "installed") return;
    let un: (() => void) | undefined;
    let dead = false;
    getCurrentWebview()
      .onDragDropEvent(async (ev) => {
        const p = ev.payload;
        if (p.type === "enter" || p.type === "over") setDragging(true);
        else if (p.type === "leave") setDragging(false);
        else if (p.type === "drop") {
          setDragging(false);
          try {
            const n = await invoke<number>("instance_import", { id: inst.id, rel, paths: p.paths });
            toast(t("Добавлено файлов: {n}", { n }), "ok");
            load();
          } catch (e) {
            toast(String(e), "err");
          }
        }
      })
      .then((f) => (dead ? f() : (un = f)))
      .catch(() => {});
    return () => {
      dead = true;
      un?.();
    };
  }, [mode, inst.id, rel, load, toast]);

  async function toggle(e: FsEntry) {
    try {
      if (kind === "resourcepack") await invoke("instance_set_pack", { id: inst.id, file: e.name, enabled: !packs.has(e.name) });
      else await invoke("instance_toggle_mod", { id: inst.id, rel: joinPath(rel, e.name) });
      load();
    } catch (err) {
      toast(String(err), "err");
    }
  }
  async function remove(e: FsEntry) {
    setConfirm(null);
    try {
      await invoke("instance_delete", { id: inst.id, rel: joinPath(rel, e.name) });
      load();
    } catch (err) {
      toast(String(err), "err");
    }
  }
  const enqueue = (files: string[], chosen?: Record<string, string>) => {
    if (chosen) picks.current = { ...picks.current, ...chosen };
    setQueue((q) => [...q, ...files.filter((f) => !q.includes(f))]);
  };
  useEffect(() => {
    if (busyRef.current) return;
    if (!queue.length) {
      if (wasBusy.current) {
        wasBusy.current = false;
        toast(t("Обновлено"), "ok");
        load();
      }
      return;
    }
    busyRef.current = true;
    wasBusy.current = true;
    const f = queue[0];
    (async () => {
      try {
        await invoke("instance_update", { id: inst.id, rel, file: f, versionId: picks.current[f] ?? upds[f]?.versionId });
      } catch (err) {
        toast(String(err), "err");
      }
      delete picks.current[f];
      busyRef.current = false;
      setQueue((q) => q.slice(1));
    })();
  }, [queue]);

  const needle = q.toLowerCase();
  const present = new Set((entries ?? []).map((e) => e.name));
  const list = (entries ?? []).filter(
    (e) =>
      !e.name.toLowerCase().endsWith(".part") &&
      !(kind === "resourcepack" && e.name.toLowerCase().endsWith(".rpo")) &&
      !(kind === "shader" && !e.isDir && e.name.toLowerCase().endsWith(".txt")) &&
      `${ids[e.name]?.title ?? ""} ${e.name}`.toLowerCase().includes(needle)
  );
  const crumbs = sub ? sub.split("/") : [];
  const updFiles = Object.keys(upds).filter((f) => present.has(f));
  const installed = new Set(Object.values(ids).map((x) => x.projectId));
  const lockLabel = [inst.mcVersion, kind === "mod" && inst.loader !== "vanilla" ? loaderName(inst.loader) : ""].filter(Boolean).join(" · ");
  const mc = locked ? inst.mcVersion : fMc || null;
  const loader = kind !== "mod" ? null : locked ? (inst.loader === "vanilla" ? null : inst.loader === "quilt" ? "quilt,fabric" : inst.loader) : fLoader || null;

  return (
    <>
      <div className="content-bar">
        <Seg<"installed" | "modrinth"> value={mode} onChange={setMode} options={[{ value: "installed", label: t("Установленные") }, { value: "modrinth", label: t("Найти на Modrinth") }]} />
        <div className="search grow">
          <Icon name="search" size={16} />
          <input placeholder={t("Поиск…")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {mode === "installed" && updFiles.length > 0 && (
          <button className="btn sm primary" onClick={() => setShowAll(true)}>
            <Icon name="refresh" size={14} /> {t("Обновить всё")} ({updFiles.length})
          </button>
        )}
        {mode === "modrinth" && (
          <>
            <Facets kind={kind} value={facets} onChange={setFacets} />
            <button className={"btn sm lock" + (locked ? " on" : "")} title={locked ? t("Нажми, чтобы разблокировать версию и загрузчик") : t("Нажми, чтобы заблокировать версию и загрузчик")} onClick={() => setLocked(!locked)}>
              <Icon name={locked ? "lock" : "unlock"} size={14} /> {locked ? lockLabel : t("Версия и загрузчик")}
            </button>
          </>
        )}
      </div>

      {showAll && (
        <UpdateAll
          inst={inst}
          kind={kind}
          items={updFiles.map((f) => ({ file: f, ident: ids[f], upd: upds[f] })).filter((x) => x.ident)}
          onClose={() => setShowAll(false)}
          onConfirm={(sel) => { setShowAll(false); enqueue(Object.keys(sel), sel); }}
        />
      )}

      {mode === "modrinth" ? (
        <>
          {!locked && (
            <div className="filters" style={{ marginTop: 0 }}>
              <div className="filter-mc"><Select value={fMc} onChange={setFMc} searchable options={[{ value: "", label: t("Любая версия") }, ...versions.filter((v) => v.type === "release").map((v) => ({ value: v.id, label: v.id }))]} /></div>
              {kind === "mod" && (
                <Seg<string> value={fLoader} onChange={setFLoader} options={[{ value: "", label: t("Все") }, ...["fabric", "forge", "neoforge", "quilt"].map((l) => ({ value: l, label: loaderName(l) }))]} />
              )}
            </div>
          )}
          <Remote inst={inst} kind={kind} q={q} mc={mc} loader={loader} facets={facets} installed={installed} toast={toast} />
        </>
      ) : (
        <>
          {sub && (
            <div className="crumbs">
              <button className="icon-btn sm" onClick={() => setSub(crumbs.slice(0, -1).join("/"))} title={t("Вверх")}><Icon name="up" size={15} /></button>
              <span className="muted">{dir}/{sub}</span>
            </div>
          )}
          <div className={"fm-list" + (dragging ? " drop" : "")}>
            {entries === null && [0, 1, 2].map((i) => <div key={i} className="skel" style={{ height: 52 }} />)}
            {entries && list.length === 0 && <div className="fm-empty">{entries.length === 0 ? t("Здесь пусто. Перетащи файлы в окно или найди их на Modrinth.") : t("Ничего не найдено")}</div>}
            {list.map((e, i) => {
              const off = e.name.endsWith(".disabled");
              const id = ids[e.name];
              const upd = upds[e.name];
              const canToggle = kind === "mod" ? !e.isDir && (off || e.name.endsWith(".jar")) : kind === "resourcepack" && sub === "" && (e.isDir || /\.zip$/i.test(e.name));
              return (
                <div key={e.name} className={"fm-row" + (off ? " off" : "") + (e.isDir ? " dir" : "")} style={st(Math.min(i, 12))} onClick={() => e.isDir && setSub(joinPath(sub, e.name))}>
                  {e.isDir ? <span className="fm-ico"><Icon name="folder" size={22} /></span> : <ProjectIcon url={id?.icon} title={id?.title || prettyName(e.name)} size={38} />}
                  <div className="grow">
                    <div className="fm-name ellipsis">{id?.title || prettyName(e.name)} {id && <span className="chip accent mr">Modrinth</span>}</div>
                    {!e.isDir && <div className="muted small ellipsis">{id?.versionName ? `${id.versionName} · ` : ""}{e.name.replace(/\.disabled$/, "")} · {fmtSize(e.size)}</div>}
                  </div>
                  {upd && (
                    <button className="btn sm primary queued" disabled={queue.includes(e.name)} title={t("Версия для {v}", { v: inst.mcVersion }) + ": " + upd.versionName} onClick={(ev) => { ev.stopPropagation(); enqueue([e.name]); }}>
                      {queue[0] === e.name ? <span className="spinner sm dark" /> : <Icon name={queue.includes(e.name) ? "clock" : "refresh"} size={13} />} {queue[0] === e.name ? t("Обновление…") : queue.includes(e.name) ? t("В очереди") : t("Обновить")}
                    </button>
                  )}
                  {id && !e.isDir && <OpenMr kind={kind} id={id.projectId} />}
                  {id && !e.isDir && <VersionPicker inst={inst} kind={kind} ident={id} file={e.name} onDone={load} toast={toast} />}
                  {canToggle && <input type="checkbox" className="switch" title={(kind === "mod" ? !off : packs.has(e.name)) ? t("Включён") : t("Выключен")} checked={kind === "mod" ? !off : packs.has(e.name)} onClick={(ev) => ev.stopPropagation()} onChange={() => toggle(e)} />}
                  {confirm === e.name ? (
                    <span className="fm-confirm" onClick={(ev) => ev.stopPropagation()}>
                      <button className="btn danger-solid sm" onClick={() => remove(e)}>{t("Удалить")}</button>
                      <button className="btn ghost sm" onClick={() => setConfirm(null)}>{t("Отмена")}</button>
                    </span>
                  ) : (
                    <button className="mini-btn" title={t("Удалить")} onClick={(ev) => { ev.stopPropagation(); setConfirm(e.name); }}><Icon name="trash" size={15} /></button>
                  )}
                </div>
              );
            })}
            {dragging && <div className="fm-drop">{t("Отпусти, чтобы добавить файлы")}</div>}
          </div>
        </>
      )}
    </>
  );
}

function OpenMr({ kind, id }: { kind: Kind; id: string }) {
  return (
    <button className="mini-btn link" title={t("Открыть на Modrinth")} onClick={(ev) => { ev.stopPropagation(); invoke("open_url", { url: `https://modrinth.com/${kind}/${id}` }).catch(() => {}); }}>
      <Icon name="external" size={15} />
    </button>
  );
}

function Remote({ inst, kind, q, mc, loader, facets, installed, toast }: {
  inst: Instance;
  kind: Kind;
  q: string;
  mc: string | null;
  loader: string | null;
  facets: FacetState;
  installed: Set<string>;
  toast: ToastFn;
}) {
  const [hits, setHits] = useState<Hit[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const top = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (offset: number) => {
      setLoading(true);
      setHits([]);
      try {
        const r = await invoke<{ hits: Hit[]; total_hits: number }>("modrinth_search", {
          kind, query: q, offset, mcVersion: mc, loader, sort: q ? "relevance" : "downloads",
          categories: facets.inc, exclude: facets.exc, environment: kind === "mod" ? facets.env || null : null,
        });
        setHits(r.hits);
        setPage(Math.floor(offset / SEARCH_PAGE));
        setTotal(r.total_hits);
      } catch (e) {
        toast(String(e), "err");
      }
      setLoading(false);
    },
    [kind, q, mc, loader, facets, toast]
  );
  useEffect(() => {
    const id = setTimeout(() => load(0), q ? 350 : 0);
    return () => clearTimeout(id);
  }, [load, q]);

  async function install(h: Hit) {
    setBusy(h.project_id);
    try {
      const file = await invoke<string>("modrinth_install_project", { instanceId: inst.id, projectId: h.project_id, kind, mcVersion: mc, loader });
      setDone((d) => new Set(d).add(h.project_id));
      toast(t("Установлено: {f}", { f: file }), "ok");
    } catch (e) {
      toast(String(e), "err");
    }
    setBusy(null);
  }

  const pager = total > SEARCH_PAGE && (
    <Pager
      page={page}
      pages={Math.min(Math.ceil(total / SEARCH_PAGE), 500)}
      onChange={(p) => {
        top.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        load(p * SEARCH_PAGE);
      }}
    />
  );

  return (
    <div className="fm-list" ref={top}>
      {pager}
      {hits.map((h, i) => {
        const has = installed.has(h.project_id) || done.has(h.project_id);
        return (
          <div key={h.project_id} className="fm-row" style={st(Math.min(i, 12))}>
            <ProjectIcon url={h.icon_url} title={h.title} size={42} />
            <div className="grow">
              <div className="fm-name ellipsis">{h.title} <span className="muted small">{t("от {a}", { a: h.author })}</span></div>
              <div className="muted small ellipsis">{h.description}</div>
            </div>
            <span className="chip"><Icon name="download" size={11} /> {compact(h.downloads)}</span>
            <OpenMr kind={kind} id={h.slug || h.project_id} />
            <button className={"btn sm" + (has ? "" : " primary")} disabled={busy !== null || has} onClick={() => install(h)}>
              {busy === h.project_id ? <span className="spinner sm dark" /> : has ? <><Icon name="check" size={14} /> {t("Установлено")}</> : t("Установить")}
            </button>
          </div>
        );
      })}
      {loading && [0, 1, 2].map((i) => <div key={"s" + i} className="skel" style={{ height: 56 }} />)}
      {!loading && hits.length === 0 && <div className="fm-empty">{t("Ничего не найдено")}</div>}
      {pager}
    </div>
  );
}

function Worlds({ inst, toast }: { inst: Instance; toast: ToastFn }) {
  const [list, setList] = useState<World[] | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const load = useCallback(() => {
    invoke<World[]>("instance_worlds", { id: inst.id }).then(setList).catch((e) => { toast(String(e), "err"); setList([]); });
  }, [inst.id, toast]);
  useEffect(load, [load]);
  async function remove(w: World) {
    setConfirm(null);
    try {
      await invoke("instance_delete", { id: inst.id, rel: `saves/${w.folder}` });
      load();
    } catch (e) {
      toast(String(e), "err");
    }
  }
  return (
    <div className="fm-list">
      {list === null && [0, 1, 2].map((i) => <div key={i} className="skel" style={{ height: 64 }} />)}
      {list?.length === 0 && <div className="fm-empty">{t("Миров пока нет. Они появятся после первой игры.")}</div>}
      {list?.map((w, i) => (
        <div key={w.folder} className="fm-row world" style={st(Math.min(i, 12))}>
          {w.icon ? <img className="world-icon" src={w.icon} alt="" /> : <div className="world-icon empty-icon"><Icon name="globe" size={24} /></div>}
          <div className="grow">
            <div className="fm-name ellipsis">{w.folder}</div>
            <div className="muted small">{w.modified ? new Date(w.modified * 1000).toLocaleString() : ""}</div>
          </div>
          {confirm === w.folder ? (
            <span className="fm-confirm">
              <button className="btn danger-solid sm" onClick={() => remove(w)}>{t("Удалить")}</button>
              <button className="btn ghost sm" onClick={() => setConfirm(null)}>{t("Отмена")}</button>
            </span>
          ) : (
            <button className="mini-btn" title={t("Удалить")} onClick={() => setConfirm(w.folder)}><Icon name="trash" size={15} /></button>
          )}
        </div>
      ))}
    </div>
  );
}

function Shot({ inst, name, onOpen, onDelete }: { inst: Instance; name: string; onOpen: (src: string, name: string) => void; onDelete: (name: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      invoke<string>("instance_read_image", { id: inst.id, rel: `screenshots/${name}` }).then(setSrc).catch(() => {});
    });
    io.observe(el);
    return () => io.disconnect();
  }, [inst.id, name]);
  return (
    <div className="shot" ref={ref} onClick={() => src && onOpen(src, name)}>
      {src ? <img src={src} alt={name} /> : <div className="skel" style={{ width: "100%", height: "100%" }} />}
      <button className="mini-btn shot-del" title={t("Удалить")} onClick={(e) => { e.stopPropagation(); onDelete(name); }}><Icon name="trash" size={14} /></button>
    </div>
  );
}

function Shots({ inst, toast }: { inst: Instance; toast: ToastFn }) {
  const [list, setList] = useState<FsEntry[] | null>(null);
  const [big, setBig] = useState<{ src: string; name: string } | null>(null);
  const load = useCallback(() => {
    invoke<FsEntry[]>("instance_list_dir", { id: inst.id, rel: "screenshots" })
      .then((l) => setList(l.filter((e) => /\.(png|jpe?g)$/i.test(e.name)).sort((a, b) => b.modified - a.modified)))
      .catch((e) => { toast(String(e), "err"); setList([]); });
  }, [inst.id, toast]);
  useEffect(load, [load]);
  async function remove(name: string) {
    try {
      await invoke("instance_delete", { id: inst.id, rel: `screenshots/${name}` });
      load();
    } catch (e) {
      toast(String(e), "err");
    }
  }
  return (
    <>
      {list?.length === 0 && <div className="fm-empty">{t("Скриншотов пока нет. Делай их клавишей F2 в игре.")}</div>}
      <div className="shots">
        {list === null && [0, 1, 2, 3].map((i) => <div key={i} className="shot"><div className="skel" style={{ width: "100%", height: "100%" }} /></div>)}
        {list?.map((e) => <Shot key={e.name} inst={inst} name={e.name} onOpen={(src, name) => setBig({ src, name })} onDelete={remove} />)}
      </div>
      {big && (
        <Modal title={big.name} onClose={() => setBig(null)} size="xl">
          <img className="shot-big" src={big.src} alt={big.name} />
        </Modal>
      )}
    </>
  );
}

function VersionCard({ inst, versions, onChanged, toast }: { inst: Instance; versions: VersionEntry[]; onChanged: () => void; toast: ToastFn }) {
  const [snap, setSnap] = useState(false);
  const [mc, setMc] = useState(inst.mcVersion);
  const [loader, setLoader] = useState(inst.loader);
  const [lv, setLv] = useState(inst.loaderVersion);
  const [lvs, setLvs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const mcList = versions.filter((v) => snap || v.type === "release" || v.id === inst.mcVersion).map((v) => v.id);
  if (!mcList.includes(mc)) mcList.unshift(mc);

  useEffect(() => {
    if (loader === "vanilla") return setLvs([]);
    let dead = false;
    invoke<string[]>("loader_versions", { loader, mc })
      .then((l) => {
        if (dead) return;
        setLvs(l);
        setLv((cur) => (l.includes(cur) ? cur : l[0] ?? ""));
      })
      .catch(() => !dead && setLvs([]));
    return () => { dead = true; };
  }, [loader, mc]);

  const dirty = mc !== inst.mcVersion || loader !== inst.loader || (loader !== "vanilla" && lv !== inst.loaderVersion);
  async function apply() {
    setBusy(true);
    try {
      await invoke("instance_change", { id: inst.id, mcVersion: mc, loader, loaderVersion: loader === "vanilla" ? null : lv || null });
      clearCache(inst.id);
      toast(t("Версия изменена"), "ok");
      onChanged();
    } catch (e) {
      toast(String(e), "err");
    }
    setBusy(false);
  }
  return (
    <section className="card section">
      <h3>{t("Версия и загрузчик")}</h3>
      <div className="field">
        {t("Версия Minecraft")}
        <Select value={mc} onChange={setMc} searchable options={mcList.map((v) => ({ value: v, label: v }))} />
      </div>
      <Switch checked={snap} onChange={setSnap} label={t("Показывать снапшоты")} />
      <div className="field" style={{ marginTop: 12 }}>
        {t("Загрузчик")}
        <Seg value={loader} onChange={setLoader} options={["vanilla", "fabric", "quilt", "forge", "neoforge"].map((l) => ({ value: l, label: loaderName(l) }))} />
      </div>
      {loader !== "vanilla" && (
        <div className="field">
          {t("Версия загрузчика")}
          <Select value={lv} onChange={setLv} searchable options={(lvs.length ? lvs : [lv]).map((v) => ({ value: v, label: v || "—" }))} />
        </div>
      )}
      <div className="row end">
        <button className="btn primary" disabled={!dirty || busy} onClick={apply}>
          {busy ? <span className="spinner sm dark" /> : <Icon name="check" size={16} />} {t("Применить")}
        </button>
      </div>
    </section>
  );
}

function RenameCard({ inst, onChanged, toast }: { inst: Instance; onChanged: () => void; toast: ToastFn }) {
  const [name, setName] = useState(inst.name);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      setName(await invoke<string>("instance_rename", { id: inst.id, name }));
      onChanged();
    } catch (e) {
      toast(String(e), "err");
    }
    setBusy(false);
  }
  return (
    <section className="card section">
      <h3>{t("Название")}</h3>
      <div className="row">
        <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && name !== inst.name && save()} />
        <button className="btn primary" disabled={busy || !name.trim() || name === inst.name} onClick={save}>{t("Сохранить")}</button>
      </div>
    </section>
  );
}

function DetachCard({ inst, onChanged, toast }: { inst: Instance; onChanged: () => void; toast: ToastFn }) {
  const [detached, setDetached] = useState(!!inst.packDetached);
  async function change(v: boolean) {
    setDetached(v);
    try {
      await invoke("instance_set_detached", { id: inst.id, detached: v });
      onChanged();
    } catch (e) {
      setDetached(!v);
      toast(String(e), "err");
    }
  }
  return (
    <section className="card section">
      <h3>{t("Обновления сборки")}</h3>
      <Switch checked={!detached} onChange={(v) => change(!v)} label={t("Следить за обновлениями с Modrinth")} />
    </section>
  );
}

function InstSettings({ inst, settings, versions, onChanged, toast }: { inst: Instance; settings: Settings; versions: VersionEntry[]; onChanged: () => void; toast: ToastFn }) {
  const [s, setS] = useState<InstanceSettings>(inst.settings ?? {});
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const id = setTimeout(() => invoke("instance_set_settings", { id: inst.id, settings: s }).then(onChanged).catch(() => {}), 400);
    return () => clearTimeout(id);
  }, [s, inst.id, onChanged]);
  const value = { ...settings.game, minMem: s.minMem ?? settings.game.minMem, maxMem: s.maxMem ?? settings.game.maxMem, jvmArgs: s.jvmArgs ?? settings.game.jvmArgs };
  return (
    <>
      <RenameCard inst={inst} onChanged={onChanged} toast={toast} />
      <VersionCard inst={inst} versions={versions} onChanged={onChanged} toast={toast} />
      {inst.sourceProject && <DetachCard inst={inst} onChanged={onChanged} toast={toast} />}
      <section className="card section">
        <Switch
          checked={!!s.override}
          onChange={(v) => setS(v ? { minMem: value.minMem, maxMem: value.maxMem, jvmArgs: value.jvmArgs, override: true } : { ...s, override: false })}
          label={t("Использовать отдельные настройки для этого экземпляра")}
        />
      </section>
      <fieldset className="plain" disabled={!s.override}>
        <MemoryForm value={value} onChange={(p) => setS((x) => ({ ...x, ...p, override: true }))} />
      </fieldset>
    </>
  );
}

function Journal({ inst, logs, onClear }: { inst: Instance; logs: string[]; onClear: () => void }) {
  const [file, setFile] = useState("");
  const ref = useRef<HTMLPreElement>(null);
  const load = useCallback(() => {
    invoke<string>("instance_read_log", { id: inst.id }).then(setFile).catch((e) => setFile(String(e)));
  }, [inst.id]);
  useEffect(() => {
    if (!logs.length) load();
  }, [logs.length, load]);
  useEffect(() => {
    ref.current?.scrollTo(0, ref.current.scrollHeight);
  }, [logs.length, file]);
  const lines = logs.length ? logs.slice(-1500) : file.split("\n").slice(-1500);
  return (
    <>
      <div className="content-bar">
        <span className="grow" />
        <button className="btn sm" onClick={load}><Icon name="refresh" size={14} /> {t("Обновить")}</button>
        <button className="btn sm" onClick={() => navigator.clipboard.writeText(lines.join("\n"))}><Icon name="copy" size={14} /> {t("Копировать")}</button>
        <button className="btn sm" onClick={() => { onClear(); setFile(""); }}><Icon name="trash" size={14} /> {t("Очистить")}</button>
      </div>
      <pre className="logs" ref={ref}>
        {lines.map((l, i) => (
          <div key={i} className={/\b(ERROR|FATAL)\b|Exception/.test(l) ? "ln err" : /\bWARN\b/.test(l) ? "ln warn" : "ln"}>{l}</div>
        ))}
      </pre>
    </>
  );
}
