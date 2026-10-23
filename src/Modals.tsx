import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Account, AccountsInfo, DeviceCode, Hit, Instance, MrVersion, ToastFn, VersionEntry } from "./types";
import { Avatar, ElyLogo, Icon, InstanceIcon, Modal, MsLogo, Select, Seg, Switch, st, useMounted } from "./ui";
import { fmtSize, loaderName } from "./settings";
import { Browse } from "./Browse";
import { t } from "./i18n";

const LOADERS = ["vanilla", "fabric", "quilt", "forge", "neoforge"] as const;

function CreateForm({ versions, onCreate }: { versions: VersionEntry[]; onCreate: (name: string, mc: string, loader: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [snap, setSnap] = useState(false);
  const [mc, setMc] = useState("");
  const [loader, setLoader] = useState<string>("vanilla");
  const [busy, setBusy] = useState(false);
  const list = useMemo(() => versions.filter((v) => snap || v.type === "release"), [versions, snap]);
  useEffect(() => {
    if (!list.find((v) => v.id === mc)) setMc(list[0]?.id ?? "");
  }, [list, mc]);
  async function submit() {
    setBusy(true);
    try {
      await onCreate(name.trim() || `Minecraft ${mc}`, mc, loader);
    } catch {
      setBusy(false);
    }
  }
  return (
    <div className="create-form">
      <label className="field">
        {t("Название")}
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={`Minecraft ${mc}`} />
      </label>
      <div className="field">
        {t("Версия Minecraft")}
        <Select value={mc} onChange={setMc} searchable options={list.map((v) => ({ value: v.id, label: v.id }))} />
      </div>
      <Switch checked={snap} onChange={setSnap} label={t("Показывать снапшоты")} />
      <div className="field" style={{ marginTop: 14 }}>
        {t("Загрузчик")}
        <Seg value={loader} onChange={setLoader} options={LOADERS.map((l) => ({ value: l, label: loaderName(l) }))} />
      </div>
      <div className="row end">
        <button className="btn primary" disabled={busy || !mc} onClick={submit}>
          {busy ? <><span className="spinner sm dark" /> {t("Создаю…")}</> : t("Создать")}
        </button>
      </div>
    </div>
  );
}

type PackInfo = { kind: "mrpack" | "curseforge" | "prism" | "plain"; name: string; mcVersion: string; loader: string; loaderVersion: string };
const PACK_KIND: Record<PackInfo["kind"], string> = { mrpack: "Modrinth", curseforge: "CurseForge", prism: "Prism / MultiMC", plain: "ZIP" };

function ImportForm({ versions, busy, toast, onImport }: {
  versions: VersionEntry[];
  busy: boolean;
  toast: ToastFn;
  onImport: (path: string, name: string, mc: string, loader: string) => void;
}) {
  const [path, setPath] = useState<string | null>(null);
  const [info, setInfo] = useState<PackInfo | null>(null);
  const [name, setName] = useState("");
  const [snap, setSnap] = useState(false);
  const [mc, setMc] = useState("");
  const [loader, setLoader] = useState<string>("vanilla");
  const [dragging, setDragging] = useState(false);
  const [checking, setChecking] = useState(false);
  const list = useMemo(() => versions.filter((v) => snap || v.type === "release"), [versions, snap]);
  useEffect(() => {
    if (info?.kind === "plain" && !list.find((v) => v.id === mc)) setMc(list[0]?.id ?? "");
  }, [list, mc, info]);

  const choose = useCallback(async (p: string) => {
    if (!/\.(mrpack|zip)$/i.test(p)) {
      toast(t("Нужен файл .mrpack или .zip"), "err");
      return;
    }
    setChecking(true);
    try {
      const i = await invoke<PackInfo>("inspect_pack", { path: p });
      setPath(p);
      setInfo(i);
      setName(i.name);
    } catch (e) {
      toast(String(e), "err");
    }
    setChecking(false);
  }, [toast]);

  useEffect(() => {
    let un: (() => void) | undefined;
    let dead = false;
    getCurrentWebview()
      .onDragDropEvent((ev) => {
        const p = ev.payload;
        if (p.type === "enter" || p.type === "over") setDragging(true);
        else if (p.type === "leave") setDragging(false);
        else if (p.type === "drop") {
          setDragging(false);
          if (p.paths[0]) choose(p.paths[0]);
        }
      })
      .then((f) => (dead ? f() : (un = f)))
      .catch(() => {});
    return () => {
      dead = true;
      un?.();
    };
  }, [choose]);

  async function browse() {
    try {
      const p = await invoke<string | null>("pick_pack_file");
      if (p) choose(p);
    } catch (e) {
      toast(String(e), "err");
    }
  }

  const fileName = path ? path.split(/[\\/]/).pop() : null;
  return (
    <div className="import-form">
      <div className={"dropzone" + (dragging ? " drop" : "")}>
        <Icon name="package" size={30} />
        <div className="dz-title">{fileName ?? t("Перетащи сюда файл сборки")}</div>
        <div className="muted small">{t("Поддерживаются .mrpack и .zip (Modrinth, CurseForge, Prism / MultiMC)")}</div>
        <button className="btn" disabled={checking || busy} onClick={browse}>
          {checking ? <><span className="spinner sm" /> {t("Проверяю…")}</> : <><Icon name="folder" size={16} /> {t("Выбрать файл…")}</>}
        </button>
      </div>
      {info && (
        <>
          <label className="field" style={{ marginTop: 16 }}>
            {t("Название")}
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={info.name} />
          </label>
          <div className="chips" style={{ marginBottom: 14 }}>
            <span className="chip">{PACK_KIND[info.kind]}</span>
            {info.mcVersion && <span className="chip accent">Minecraft {info.mcVersion}</span>}
            {info.loader && info.loader !== "vanilla" && <span className="chip accent">{loaderName(info.loader)}</span>}
          </div>
          {info.kind === "plain" && (
            <>
              <div className="muted small" style={{ marginBottom: 10 }}>{t("В архиве не указаны версия и загрузчик — выбери их сам")}</div>
              <div className="field">
                {t("Версия Minecraft")}
                <Select value={mc} onChange={setMc} searchable options={list.map((v) => ({ value: v.id, label: v.id }))} />
              </div>
              <Switch checked={snap} onChange={setSnap} label={t("Показывать снапшоты")} />
              <div className="field" style={{ marginTop: 14 }}>
                {t("Загрузчик")}
                <Seg value={loader} onChange={setLoader} options={LOADERS.map((l) => ({ value: l, label: loaderName(l) }))} />
              </div>
            </>
          )}
          <div className="row end">
            <button className="btn primary" disabled={busy || checking || (info.kind === "plain" && !mc)} onClick={() => path && onImport(path, name.trim(), mc, loader)}>
              <Icon name="download" size={16} /> {t("Импортировать")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function NewInstance({ versions, initialTab, busy, toast, onClose, onCreate, onPick, onImport }: {
  versions: VersionEntry[];
  initialTab: "create" | "store";
  busy: boolean;
  toast: ToastFn;
  onClose: () => void;
  onCreate: (name: string, mc: string, loader: string) => Promise<void>;
  onPick: (h: Hit) => void;
  onImport: (path: string, name: string, mc: string, loader: string) => void;
}) {
  const [tab, setTab] = useState<"create" | "store" | "import">(initialTab);
  return (
    <Modal title={t("Новый экземпляр")} onClose={onClose} size={tab === "store" ? "xl" : "wide"}>
      <div style={{ marginBottom: 14 }}>
        <Seg<"create" | "store" | "import"> value={tab} onChange={setTab} options={[{ value: "create", label: t("Свой экземпляр") }, { value: "store", label: t("Сборки Modrinth") }, { value: "import", label: t("Импорт из файла") }]} />
      </div>
      <div className="store-body" key={tab}>
        {tab === "create" ? <CreateForm versions={versions} onCreate={onCreate} /> : tab === "store" ? <Browse toast={toast} busy={busy} versions={versions} onPick={onPick} /> : <ImportForm versions={versions} busy={busy} toast={toast} onImport={onImport} />}
      </div>
    </Modal>
  );
}

const mcSort = (a: string, b: string) => {
  const pa = a.split(".").map((x) => parseInt(x) || 0);
  const pb = b.split(".").map((x) => parseInt(x) || 0);
  for (let i = 0; i < 4; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
  return 0;
};

export function PackVersions({ pack, versions, onClose, onInstall }: { pack: Hit; versions: MrVersion[] | null; onClose: () => void; onInstall: (v: MrVersion) => void }) {
  const [mc, setMc] = useState("");
  const [loader, setLoader] = useState("");
  const [kind, setKind] = useState("");
  const mcs = useMemo(() => [...new Set((versions ?? []).flatMap((v) => v.game_versions))].filter((v) => /^\d+\.\d+/.test(v)).sort(mcSort), [versions]);
  const loaders = useMemo(() => [...new Set((versions ?? []).flatMap((v) => v.loaders))], [versions]);
  const list = (versions ?? []).filter((v) => (!mc || v.game_versions.includes(mc)) && (!loader || v.loaders.includes(loader)) && (!kind || v.version_type === kind));
  return (
    <Modal title={pack.title} onClose={onClose} size="wide">
      <div className="filters" style={{ marginTop: 0, marginBottom: 12 }}>
        <div className="filter-mc"><Select value={mc} onChange={setMc} searchable options={[{ value: "", label: t("Любая версия") }, ...mcs.map((v) => ({ value: v, label: v }))]} /></div>
        {loaders.length > 1 && <Seg value={loader} onChange={setLoader} options={[{ value: "", label: t("Все") }, ...loaders.map((l) => ({ value: l, label: loaderName(l) }))]} />}
        <Seg value={kind} onChange={setKind} options={[{ value: "", label: t("Все") }, { value: "release", label: "Release" }, { value: "beta", label: "Beta" }, { value: "alpha", label: "Alpha" }]} />
      </div>
      {!versions && [0, 1, 2].map((i) => <div key={i} className="skel" style={{ height: 56, marginBottom: 8 }} />)}
      <div className="ver-list">
        {list.map((v, i) => {
          const ok = v.loaders.length === 0 || v.loaders.some((l) => ["fabric", "quilt", "forge", "neoforge"].includes(l));
          const k = ({ release: ["ok", "Release"], beta: ["warn", "Beta"], alpha: ["bad", "Alpha"] } as Record<string, string[]>)[v.version_type] ?? ["", v.version_type];
          return (
            <div key={v.id} className="ver" style={st(Math.min(i, 8))}>
              <div className="ver-main">
                <div className="ver-name">{v.name}</div>
                <div className="chips">
                  <span className={"chip " + k[0]}>{k[1]}</span>
                  <span className="chip">{v.version_number}</span>
                  <span className="chip">{v.game_versions.slice(-2).join(", ")}</span>
                  {v.loaders.map((l) => <span key={l} className="chip accent">{loaderName(l)}</span>)}
                </div>
              </div>
              <button className="btn primary" disabled={!ok} onClick={() => onInstall(v)}>{ok ? t("Установить") : t("Не поддерживается")}</button>
            </div>
          );
        })}
        {versions && list.length === 0 && <div className="fm-empty">{t("Ничего не найдено")}</div>}
      </div>
    </Modal>
  );
}

type Top = { name: string; isDir: boolean; size: number };
const EXPORT_DEFAULT = new Set(["mods", "config", "defaultconfigs", "resourcepacks", "shaderpacks", "datapacks", "kubejs", "scripts", "options.txt"]);

export function ExportModal({ inst, onClose, toast }: { inst: Instance; onClose: () => void; toast: ToastFn }) {
  const [format, setFormat] = useState<"mrpack" | "zip">("mrpack");
  const [name, setName] = useState(inst.name);
  const [ver, setVer] = useState("1.0.0");
  const [sum, setSum] = useState("");
  const [top, setTop] = useState<Top[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    invoke<Top[]>("instance_top", { id: inst.id })
      .then((l) => {
        setTop(l);
        let saved: string[] | null = null;
        try {
          saved = JSON.parse(localStorage.getItem("its.export") || "null");
        } catch {}
        const names = new Set(l.map((e) => e.name));
        const pick = saved ? saved.filter((n) => names.has(n)) : [];
        setSel(new Set(pick.length ? pick : l.filter((e) => EXPORT_DEFAULT.has(e.name)).map((e) => e.name)));
      })
      .catch(() => setTop([]));
  }, [inst.id]);
  const flip = (n: string) => setSel((s) => { const x = new Set(s); x.has(n) ? x.delete(n) : x.add(n); return x; });
  async function submit() {
    setBusy(true);
    try {
      const p = await invoke<string>("instance_export", { id: inst.id, format, name, version: ver, summary: sum, include: [...sel] });
      localStorage.setItem("its.export", JSON.stringify([...sel]));
      toast(t("Сохранено: {p}", { p }), "ok");
      invoke("open_exports_dir");
      onClose();
    } catch (e) {
      toast(String(e), "err");
      setBusy(false);
    }
  }
  return (
    <Modal title={t("Экспорт: {n}", { n: inst.name })} onClose={onClose} size="wide">
      <div className="field">
        {t("Формат")}
        <Seg<"mrpack" | "zip"> value={format} onChange={setFormat} options={[{ value: "mrpack", label: "Modrinth (.mrpack)" }, { value: "zip", label: "ZIP" }]} />
      </div>
      <div className="mem-grid">
        <label className="field">{t("Название")}<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        {format === "mrpack" && <label className="field">{t("Номер версии")}<input value={ver} onChange={(e) => setVer(e.target.value)} /></label>}
      </div>
      {format === "mrpack" && <label className="field">{t("Описание")}<input value={sum} onChange={(e) => setSum(e.target.value)} /></label>}
      <div className="field" style={{ marginBottom: 6 }}>{t("Что включить")}</div>
      <div className="fm-list export-list">
        {top === null && [0, 1, 2].map((i) => <div key={i} className="skel" style={{ height: 40 }} />)}
        {top?.map((e, i) => (
          <label key={e.name} className="fm-row" style={st(Math.min(i, 12))}>
            <span className="fm-ico"><Icon name={e.isDir ? "folder" : "file"} size={18} /></span>
            <span className="grow ellipsis fm-name">{e.name}</span>
            <span className="muted small">{fmtSize(e.size)}</span>
            <input type="checkbox" className="switch" checked={sel.has(e.name)} onChange={() => flip(e.name)} />
          </label>
        ))}
      </div>
      <div className="row end">
        <button className="btn ghost" onClick={onClose}>{t("Отмена")}</button>
        <button className="btn primary" disabled={busy || sel.size === 0} onClick={submit}>
          {busy ? <><span className="spinner sm dark" /> {t("Экспорт…")}</> : <><Icon name="archive" size={16} /> {t("Экспортировать")}</>}
        </button>
      </div>
    </Modal>
  );
}

export function InstanceSelect({ instances, value, onChange }: { instances: Instance[]; value: string | null; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [mounted, closing] = useMounted(open, 160);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [open]);
  const sorted = [...instances].sort((a, b) => b.lastPlayed - a.lastPlayed || a.name.localeCompare(b.name));
  const sel = sorted.find((i) => i.id === value) ?? sorted[0];
  if (!sel) return null;
  return (
    <div className="isel" ref={ref}>
      {mounted && (
        <div className={"isel-pop" + (closing ? " closing" : "")}>
          {sorted.map((i, n) => (
            <button key={i.id} className={"isel-row" + (i.id === sel.id ? " on" : "")} style={st(Math.min(n, 8))} onClick={() => { onChange(i.id); setOpen(false); }}>
              <InstanceIcon inst={i} size={34} />
              <div className="grow">
                <div className="inst-name">{i.name}</div>
                <div className="muted small">{i.mcVersion} · {loaderName(i.loader)}</div>
              </div>
              {i.id === sel.id && <Icon name="check" size={15} />}
            </button>
          ))}
        </div>
      )}
      <button className={"btn isel-btn" + (open ? " open" : "")} onClick={() => setOpen(!open)}>
        <InstanceIcon inst={sel} size={30} />
        <span className="ellipsis">{sel.name}</span>
        <Icon name="chevron" size={15} />
      </button>
    </div>
  );
}

export function AccountMenu({ info, closing, onSelect, onRemove, onClose, onOffline, onEly, onMs }: {
  info: AccountsInfo;
  closing: boolean;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
  onOffline: () => void;
  onEly: () => void;
  onMs: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (!ref.current?.contains(el) && !el.closest(".rail-profile")) onClose();
    };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [onClose]);
  const active = info.accounts.find((a) => a.id === info.active);
  const kindLabel = (a: Account) => ({ ms: "Microsoft", ely: "Ely.by", offline: t("Оффлайн") })[a.kind];
  return (
    <div className={"popover" + (closing ? " closing" : "")} ref={ref}>
      <div className="pop-head">
        <Avatar account={active} name={active?.name ?? "?"} size={46} />
        <div>
          <div className="pop-name">{active?.name ?? t("Нет аккаунта")}</div>
          <div className="muted small">{active ? kindLabel(active) : ""}</div>
        </div>
      </div>
      <div className="pop-label">{t("Аккаунты")}</div>
      <div className="pop-list">
        {info.accounts.map((a, i) => (
          <div key={a.id} className={"pop-item" + (info.active === a.id ? " on" : "")} style={st(i)} onClick={() => onSelect(a.id)}>
            <Avatar account={a} name={a.name} size={28} />
            <span className="grow ellipsis">{a.name}</span>
            <span className="chip">{kindLabel(a)}</span>
            <button className="mini-btn" title={t("Удалить аккаунт")} onClick={(e) => { e.stopPropagation(); onRemove(a.id); }}>
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      </div>
      <div className="pop-label">{t("Добавить")}</div>
      <button className="btn wide" onClick={onOffline}><Icon name="user" size={16} /> {t("Оффлайн-аккаунт")}</button>
      <button className="btn wide" onClick={onEly}><ElyLogo /> {t("Аккаунт Ely.by")}</button>
      <button className="btn wide" onClick={onMs}><MsLogo /> Microsoft</button>
    </div>
  );
}

export function CodeBox({ login }: { login: DeviceCode }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <p className="muted">{t("Страница входа Microsoft открылась в браузере. Войди в аккаунт и подтверди вход. Если код не подставился сам, он уже скопирован: вставь его (Ctrl+V).")}</p>
      <div className="code">{login.userCode}</div>
      <div className="row center">
        <button className="btn" onClick={() => { navigator.clipboard.writeText(login.userCode); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
          <Icon name={copied ? "check" : "copy"} size={16} /> {copied ? t("Скопировано") : t("Копировать код")}
        </button>
        <button className="btn" onClick={() => invoke("open_url", { url: login.verificationUri })}>
          <Icon name="external" size={16} /> {t("Открыть страницу")}
        </button>
      </div>
      <div className="waiting"><span className="spinner" /> {t("Ожидаю подтверждения…")}</div>
    </>
  );
}

export function OfflineModal({ onClose, onDone }: { onClose: () => void; onDone: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const go = () => { setBusy(true); onDone(name).catch(() => setBusy(false)); };
  return (
    <Modal title={t("Оффлайн-аккаунт")} onClose={onClose}>
      <label className="field">
        {t("Ник")}
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Player" onKeyDown={(e) => e.key === "Enter" && name.trim().length >= 3 && go()} />
      </label>
      <div className="row end">
        <button className="btn ghost" onClick={onClose}>{t("Отмена")}</button>
        <button className="btn primary" disabled={busy || name.trim().length < 3} onClick={go}>{t("Добавить")}</button>
      </div>
    </Modal>
  );
}

export function ElyModal({ onClose, onDone }: { onClose: () => void; onDone: (u: string, p: string) => Promise<void> }) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [busy, setBusy] = useState(false);
  const go = () => { setBusy(true); onDone(u, p).catch(() => setBusy(false)); };
  return (
    <Modal title={t("Вход через Ely.by")} onClose={onClose}>
      <label className="field">
        {t("Ник или e-mail")}
        <input autoFocus value={u} onChange={(e) => setU(e.target.value)} />
      </label>
      <label className="field">
        {t("Пароль")}
        <input type="password" value={p} onChange={(e) => setP(e.target.value)} onKeyDown={(e) => e.key === "Enter" && u && p && go()} />
      </label>
      <div className="row end">
        <button className="btn ghost" onClick={() => invoke("open_url", { url: "https://account.ely.by/register" })}>{t("Нет аккаунта?")}</button>
        <button className="btn primary" disabled={busy || !u || !p} onClick={go}>
          {busy ? <><span className="spinner sm dark" /> {t("Вхожу…")}</> : t("Войти")}
        </button>
      </div>
    </Modal>
  );
}
