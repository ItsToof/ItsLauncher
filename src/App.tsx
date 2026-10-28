import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";
import type { Account, AccountsInfo, DeviceCode, GameSettings, Hit, Instance, MrVersion, Page, PackUpdate, Progress, Settings, ToastFn, VersionEntry } from "./types";
import { DEFAULTS, gameFor, screenLimit, useSettings } from "./settings";
import { setLang, t } from "./i18n";
import { Avatar, Icon, Logo, Modal, useMounted } from "./ui";
import { AccountMenu, CodeBox, ElyModal, ExportModal, InstanceSelect, NewInstance, OfflineModal, PackVersions } from "./Modals";
import { Home } from "./Home";
import { Library } from "./Library";
import { Manage, prefetchInstance } from "./Manage";
import type { ManageTab } from "./Manage";
import { SettingsPage } from "./SettingsPage";
import { Games } from "./Games";
import "./en";

const CANCELLED = "Отменено пользователем";
const appWindow = getCurrentWindow();
const ORDER: Page[] = ["home", "library", "games", "settings"];
const NAV: { id: Page; label: string; icon: string }[] = [
  { id: "home", label: "Главная", icon: "home" },
  { id: "library", label: "Библиотека", icon: "library" },
  { id: "games", label: "Игры", icon: "games" },
];

const POP_PAGE = 20;
const popPageCount = (total: number) => Math.min(25, Math.max(1, Math.ceil(total / POP_PAGE)));
const fetchPopular = (page: number) =>
  invoke<{ hits: Hit[]; total_hits: number }>("modrinth_search", { kind: "modpack", query: "", offset: page * POP_PAGE, mcVersion: null, loader: null, sort: "downloads" });

function cached<T>(key: string, set: (v: T) => void, load: () => Promise<T>) {
  try {
    const s = localStorage.getItem(key);
    if (s) set(JSON.parse(s));
  } catch {}
  load()
    .then((v) => {
      set(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {}
    })
    .catch(() => {});
}

function ErrorToast({ text, onClose }: { text: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return (
    <div className="toast err">
      <div className="toast-head">
        <b>{t("Ошибка")}</b>
        <button className="mini-btn" title={t("Закрыть")} onClick={onClose}><Icon name="x" size={14} /></button>
      </div>
      <pre className="toast-detail">{text}</pre>
      <div className="toast-actions">
        <button className="btn sm" onClick={copy}>
          {copied ? <><Icon name="check" size={13} /> {t("Скопировано")}</> : <><Icon name="copy" size={13} /> {t("Скопировать")}</>}
        </button>
      </div>
    </div>
  );
}

function WindowControls() {
  const [max, setMax] = useState(false);
  const w = appWindow;
  useEffect(() => {
    const sync = () => w.isMaximized().then(setMax).catch(() => {});
    sync();
    const un = w.onResized(sync);
    return () => { un.then((f) => f()); };
  }, [w]);
  return (
    <div className="win-ctl">
      <button onClick={() => w.minimize()} title={t("Свернуть")}><Icon name="minus" size={16} /></button>
      <button onClick={() => w.toggleMaximize()} title={max ? t("Восстановить") : t("Развернуть")}><Icon name={max ? "restore" : "square"} size={14} /></button>
      <button className="close" onClick={() => w.close()} title={t("Закрыть")}><Icon name="x" size={17} /></button>
    </div>
  );
}

export default function App() {
  const [settings, setSettings] = useSettings();
  setLang(settings.lang);
  const patch = (p: Partial<Settings>) => setSettings((s) => ({ ...s, ...p }));
  const patchGame = (p: Partial<GameSettings>) => setSettings((s) => ({ ...s, game: { ...s.game, ...p } }));

  const [page, setPage] = useState<Page>("home");
  const [dir, setDir] = useState<"fwd" | "back">("fwd");
  const [instances, setInstances] = useState<Instance[] | null>(null);
  const [accounts, setAccounts] = useState<AccountsInfo>({ accounts: [], active: null });
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [featured, setFeatured] = useState<Hit | null | undefined>(undefined);
  const [popular, setPopular] = useState<Hit[] | null>(null);
  const [popPage, setPopPage] = useState(0);
  const [popPages, setPopPages] = useState(1);
  const popSeq = useRef(0);
  const themeTimer = useRef(0);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [running, setRunning] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() => localStorage.getItem("its.sel"));
  const [packUpdates, setPackUpdates] = useState<Record<string, PackUpdate>>({});
  const [toasts, setToasts] = useState<{ id: number; text: string; kind: string }[]>([]);
  const [, bump] = useState(0);
  const [splashOpen, setSplashOpen] = useState(true);
  const [splashMounted, splashClosing] = useMounted(splashOpen, 350);
  const bootAt = useRef(performance.now());

  const [profileOpen, setProfileOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [store, setStore] = useState<"create" | "store" | null>(null);
  const [profMounted, profClosing] = useMounted(profileOpen);
  const [actMounted, actClosing] = useMounted(activityOpen);
  const [offlineOpen, setOfflineOpen] = useState(false);
  const [elyOpen, setElyOpen] = useState(false);
  const [login, setLogin] = useState<DeviceCode | null>(null);
  const [pack, setPack] = useState<Hit | null>(null);
  const [packVers, setPackVers] = useState<MrVersion[] | null>(null);
  const [manage, setManage] = useState<{ id: string; tab: ManageTab } | null>(null);
  const [exporting, setExporting] = useState<Instance | null>(null);

  const logs = useRef<Record<string, string[]>>({});
  const bumpTimer = useRef<number>(0);
  const instRef = useRef<Instance[]>([]);
  const gameRef = useRef<Record<string, GameSettings>>({});
  const settingsRef = useRef(settings);
  const accSeq = useRef(0);
  const accQueue = useRef<Promise<unknown>>(Promise.resolve());
  const checkedPacks = useRef<Set<string>>(new Set());
  const iconTried = useRef<Set<string>>(new Set());
  const panelRef = useRef<HTMLDivElement>(null);
  const prefetched = useRef<Set<string>>(new Set());
  instRef.current = instances ?? [];
  settingsRef.current = settings;

  const toast: ToastFn = useCallback((text, kind = "info") => {
    if (kind === "err" && text.includes(CANCELLED)) return;
    const shown = kind === "ok" ? t("Успешно") : t(text);
    const id = Date.now() + Math.random();
    setToasts((x) => (x.some((y) => y.kind === kind && y.text === shown) ? x : [...x.slice(kind === "err" ? -3 : -1), { id, text: shown, kind }]));
    if (kind !== "err") setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), kind === "ok" ? 2000 : 3500);
  }, []);

  const go = (p: Page) => {
    if (p === page) return;
    setDir(ORDER.indexOf(p) > ORDER.indexOf(page) ? "fwd" : "back");
    setPage(p);
    setProfileOpen(false);
  };

  useLayoutEffect(() => {
    const root = document.documentElement;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const theme = settings.theme === "system" ? (mq.matches ? "dark" : "light") : settings.theme;

      if ((root.dataset.theme && root.dataset.theme !== theme) || (root.dataset.accent && root.dataset.accent !== settings.accent)) {
        root.classList.add("theme-fade");
        window.clearTimeout(themeTimer.current);
        themeTimer.current = window.setTimeout(() => root.classList.remove("theme-fade"), 500);
      }
      root.dataset.theme = theme;
      root.dataset.accent = settings.accent;
      root.dataset.motion = settings.motion ? "on" : "off";
      root.style.setProperty("--radius", `${settings.radius}px`);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [settings.theme, settings.accent, settings.motion, settings.radius]);

  useEffect(() => {
    if (!activityOpen) return;
    const h = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (!panelRef.current?.contains(el) && !el.closest(".pill")) setActivityOpen(false);
    };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [activityOpen]);

  const refreshInstances = useCallback(async () => {
    try {
      setInstances(await invoke<Instance[]>("list_instances"));
    } catch (e) {
      toast(String(e), "err");
      setInstances([]);
    }
  }, [toast]);

  const refreshAccounts = useCallback(async () => {
    const seq = ++accSeq.current;
    try {
      const info = await invoke<AccountsInfo>("list_accounts");
      if (seq === accSeq.current) setAccounts(info);
    } catch (e) {
      toast(String(e), "err");
    }
  }, [toast]);

  useEffect(() => {
    refreshInstances();
    refreshAccounts();
    const id = setTimeout(() => {
      cached("its.c.versions", setVersions, () => invoke<VersionEntry[]>("get_versions"));
      cached<Hit | null>("its.c.featured", setFeatured, () =>
        invoke<{ hits: Hit[] }>("modrinth_search", { kind: "modpack", query: "visualvanilla", offset: 0, mcVersion: null, loader: null, sort: "relevance" }).then(
          (r) => r.hits.find((h) => h.slug === "visualvanilla") ?? r.hits.find((h) => h.title.toLowerCase().includes("visual vanilla")) ?? null
        )
      );
      cached<Hit[]>("its.c.popular", setPopular, () =>
        fetchPopular(0).then((r) => {
          setPopPages(popPageCount(r.total_hits));
          return r.hits;
        })
      );
    }, 0);
    return () => clearTimeout(id);
  }, [refreshInstances, refreshAccounts]);

  const booted = instances !== null && accounts.accounts.length > 0;
  useEffect(() => {
    if (!booted) return;
    const id = setTimeout(() => setSplashOpen(false), Math.max(0, 250 - (performance.now() - bootAt.current)));
    return () => clearTimeout(id);
  }, [booted]);
  useEffect(() => {
    const id = setTimeout(() => setSplashOpen(false), 6000);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    if (!instances) return;
    const todo = instances.filter((i) => !prefetched.current.has(i.id));
    if (!todo.length) return;
    todo.forEach((i) => prefetched.current.add(i.id));
    const id = setTimeout(async () => {
      for (const i of todo) await prefetchInstance(i);
    }, 3000);
    return () => clearTimeout(id);
  }, [instances]);

  useEffect(() => {
    instances?.forEach((i) => {
      if (!i.sourceProject) return;
      if (i.packDetached) {
        checkedPacks.current.delete(i.id);
        setPackUpdates((p) => { if (!(i.id in p)) return p; const x = { ...p }; delete x[i.id]; return x; });
        return;
      }
      if (checkedPacks.current.has(i.id)) return;
      checkedPacks.current.add(i.id);
      invoke<PackUpdate | null>("instance_pack_update", { id: i.id })
        .then((u) => u && setPackUpdates((p) => ({ ...p, [i.id]: u })))
        .catch(() => {});
    });
  }, [instances]);

  useEffect(() => {
    if (!instances) return;
    const todo = instances.filter((i) => !i.icon && !iconTried.current.has(i.id));
    if (!todo.length) return;
    todo.forEach((i) => iconTried.current.add(i.id));
    (async () => {
      let changed = false;
      for (const i of todo) {
        try {
          if (await invoke<string | null>("fetch_instance_icon", { id: i.id })) changed = true;
        } catch {}
      }
      if (changed) refreshInstances();
    })();
  }, [instances, refreshInstances]);

  useEffect(() => {
    const scheduleBump = () => {
      if (bumpTimer.current) return;
      bumpTimer.current = window.setTimeout(() => { bumpTimer.current = 0; bump((n) => n + 1); }, 250);
    };
    const subs = [
      listen<Progress>("progress", (e) => setProgress(e.payload)),
      listen<string>("stage", (e) => setWorking((w) => (w ? e.payload : w))),
      listen<string>("game-start", (e) => { logs.current[e.payload] = []; setRunning((r) => (r.includes(e.payload) ? r : [...r, e.payload])); }),
      listen<{ id: string; line: string }>("game-log", (e) => {
        const arr = (logs.current[e.payload.id] ??= []);
        arr.push(e.payload.line);
        if (arr.length > 4000) arr.splice(0, 1000);
        scheduleBump();
      }),
      listen<{ id: string; code: number; killed: boolean }>("game-exit", (e) => {
        const { id, killed } = e.payload;
        const code = killed ? 0 : e.payload.code;
        const g = gameRef.current[id] ?? settingsRef.current.game;
        setRunning((r) => r.filter((x) => x !== id));
        refreshInstances();
        if (g.quitOnExit && (code === 0 || !g.journalOnCrash)) {
          invoke("quit_app");
          return;
        }
        if (g.hideLauncher) appWindow.show().then(() => appWindow.setFocus());
        if (code !== 0) {
          toast(t("Игра завершилась с кодом {c}", { c: code }), "err");
          if (g.journalOnCrash && instRef.current.some((i) => i.id === id)) setManage({ id, tab: "journal" });
        } else if (g.journalHideOnExit) {
          setManage((m) => (m && m.id === id && m.tab === "journal" ? null : m));
        }
      }),
    ];
    return () => { subs.forEach((p) => p.then((un) => un())); };
  }, [toast, refreshInstances]);

  async function work<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setWorking(label);
    setProgress(null);
    try {
      return await fn();
    } catch (e) {
      toast(`${label}\n${String(e)}`, "err");
    } finally {
      setWorking(null);
      setProgress(null);
    }
  }

  async function play(inst: Instance) {
    if (working || running.includes(inst.id)) return;
    if (!accounts.active) return toast(t("Выбери аккаунт в профиле"), "err");
    const g = gameFor(settings, inst);
    gameRef.current[inst.id] = g;
    setBusyId(inst.id);
    if (g.journalOnLaunch) setManage({ id: inst.id, tab: "journal" });
    await work(t("Подготовка «{n}»", { n: inst.name }), async () => {
      await invoke("launch", {
        options: {
          instanceId: inst.id, accountId: accounts.active, javaPath: g.javaPath,
          memoryMb: g.maxMem || 4096, minMemoryMb: g.minMem, jvmArgs: g.jvmArgs, width: Math.min(g.width, screenLimit().w), height: Math.min(g.height, screenLimit().h),
          fullscreen: g.fullscreen, recordTime: g.recordPlaytime,
        },
      });
      if (g.hideLauncher) appWindow.hide();
    });
    setBusyId(null);
  }

  async function createInstance(name: string, mc: string, loader: string) {
    try {
      await invoke("create_instance", { name, mcVersion: mc, loader });
      await refreshInstances();
      setStore(null);
      go("library");
    } catch (e) {
      toast(String(e), "err");
      throw e;
    }
  }

  async function deleteInstance(inst: Instance) {
    try {
      await invoke("delete_instance", { id: inst.id });
      await refreshInstances();
    } catch (e) {
      toast(String(e), "err");
    }
  }

  async function openPack(h: Hit) {
    setPack(h);
    setPackVers(null);
    try {
      setPackVers(await invoke<MrVersion[]>("modrinth_versions", { projectId: h.project_id }));
    } catch (e) {
      toast(String(e), "err");
      setPack(null);
    }
  }

  async function installPack(v: MrVersion) {
    const hit = pack!;
    setPack(null);
    setStore(null);
    const ok = await work(t("Установка «{n}»", { n: hit.title }), () => invoke("modrinth_install", { versionId: v.id, title: hit.title, icon: hit.icon_url ?? null }));
    if (ok) {
      await refreshInstances();
      go("library");
    }
  }

  async function installLatest(h: Hit) {
    const ok = await work(t("Установка «{n}»", { n: h.title }), async () => {
      const vs = await invoke<MrVersion[]>("modrinth_versions", { projectId: h.project_id });
      const v = vs.find((x) => x.version_type === "release") ?? vs[0];
      if (!v) throw new Error(t("Нет доступных версий"));
      return invoke("modrinth_install", { versionId: v.id, title: h.title, icon: h.icon_url ?? null });
    });
    if (ok) {
      await refreshInstances();
      go("library");
    }
  }

  async function updatePack(inst: Instance) {
    const upd = packUpdates[inst.id];
    if (!upd) return;
    const ok = await work(t("Обновление «{n}»", { n: inst.name }), () => invoke("modrinth_update_pack", { id: inst.id, versionId: upd.versionId }));
    if (ok !== undefined) {
      setPackUpdates((u) => { const x = { ...u }; delete x[inst.id]; return x; });
      await refreshInstances();
    }
  }

  async function importPack(path: string, name: string, mc: string, loader: string) {
    setStore(null);
    const inst = await work(t("Импорт «{n}»", { n: name || path.split(/[\\/]/).pop() || "" }), () => invoke<Instance>("import_pack", { path, name, mcVersion: mc, loader }));
    if (inst) {
      await refreshInstances();
      go("library");
    }
  }

  async function startMs() {
    setProfileOpen(false);
    try {
      const dc = await invoke<DeviceCode>("ms_begin_login", { clientId: "" });
      setLogin(dc);
      navigator.clipboard.writeText(dc.userCode).catch(() => {});
      const sep = dc.verificationUri.includes("?") ? "&" : "?";
      invoke("open_url", { url: `${dc.verificationUri}${sep}otc=${encodeURIComponent(dc.userCode)}` }).catch(() => {});
      const acc = await invoke<Account>("ms_poll_login", { clientId: "", deviceCode: dc.deviceCode, interval: dc.interval, expiresIn: dc.expiresIn });
      setLogin(null);
      await refreshAccounts();
      toast(t("Вход выполнен: {n}", { n: acc.name }), "ok");
    } catch (e) {
      setLogin(null);
      toast(String(e), "err");
    }
  }

  async function fullReset() {
    try {
      await invoke("reset_launcher");
      localStorage.clear();
      await invoke("quit_app");
    } catch (e) {
      toast(String(e), "err");
    }
  }

  function openPopPage(p: number) {
    const seq = ++popSeq.current;
    setPopPage(p);
    setPopular(null);
    fetchPopular(p)
      .then((r) => {
        if (seq !== popSeq.current) return;
        setPopular(r.hits);
        setPopPages(popPageCount(r.total_hits));
      })
      .catch((e) => {
        if (seq !== popSeq.current) return;
        toast(String(e), "err");
        setPopular([]);
      });
  }

  function accountOp(fn: () => Promise<unknown>, okMsg?: string): Promise<void> {
    const run = async () => {
      try {
        await fn();
        await refreshAccounts();
        if (okMsg) toast(okMsg, "ok");
      } catch (e) {
        toast(String(e), "err");
        throw e;
      }
    };
    const result = accQueue.current.then(run);
    accQueue.current = result.catch(() => {});
    return result;
  }

  const select = (id: string) => { setSelectedId(id); localStorage.setItem("its.sel", id); };
  const selected = instances?.find((i) => i.id === selectedId) ?? [...(instances ?? [])].sort((a, b) => b.lastPlayed - a.lastPlayed)[0];
  const active = accounts.accounts.find((a) => a.id === accounts.active);
  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const manageInst = manage ? instances?.find((i) => i.id === manage.id) : undefined;
  const addOffline = () => { setProfileOpen(false); setOfflineOpen(true); };
  const addEly = () => { setProfileOpen(false); setElyOpen(true); };
  const selectAcc = (id: string) => { accountOp(() => invoke("set_active_account", { id })).catch(() => {}); };
  const removeAcc = (id: string) => { accountOp(() => invoke("remove_account", { id })).catch(() => {}); };

  return (
    <div className="app">
      <header className="titlebar" data-tauri-drag-region>
        <div className="tb-brand" data-tauri-drag-region>
          <Logo size={26} />
          <span data-tauri-drag-region>ItsLauncher</span>
        </div>
        <button className={"pill" + (working ? " busy" : running.length ? " live" : "") + (activityOpen ? " open" : "")} onClick={() => setActivityOpen((o) => !o)}>
          <div className="pill-row">
            {working ? (
              <><span className="spinner sm" /><span className="pill-text">{working}</span>{progress && progress.total > 0 && <b>{pct}%</b>}</>
            ) : running.length ? (
              <><span className="dot live" /><span className="pill-text">{running.length > 1 ? t("Запущено экземпляров: {n}", { n: running.length }) : t("Игра запущена")}</span></>
            ) : (
              <><span className="dot" /><span className="pill-text">{t("Нет активных сборок")}</span></>
            )}
          </div>
          {working && <div className="pill-bar"><div className={"pill-fill" + (progress && progress.total > 0 ? "" : " indet")} style={progress && progress.total > 0 ? { width: pct + "%" } : undefined} /></div>}
        </button>
        <WindowControls />
      </header>

      {actMounted && (
        <div className={"activity" + (actClosing ? " closing" : "")} ref={panelRef}>
          <div className="activity-head">{t("Выполняемые задачи")}</div>
          {working && (
            <div className="activity-now">
              <div className="row"><span className="spinner sm" /><span className="grow ellipsis">{working}</span>{progress && progress.total > 0 && <b>{progress.done}/{progress.total}</b>}<button className="btn sm" onClick={() => invoke("cancel_task").catch(() => {})}>{t("Отменить")}</button></div>
              <div className="bar"><div className={"fill" + (progress ? "" : " indet")} style={progress ? { width: pct + "%" } : undefined} /></div>
            </div>
          )}
          {running.map((id) => <div key={id} className="activity-now"><div className="row"><span className="dot live" /><span className="grow ellipsis">{t("Запущено: {n}", { n: instances?.find((i) => i.id === id)?.name ?? "" })}</span></div></div>)}
          {!working && !running.length && <div className="muted small" style={{ padding: "8px 4px" }}>{t("Сейчас ничего не выполняется")}</div>}
        </div>
      )}

      <div className="body">
        <aside className="rail">
          {NAV.map((n) => (
            <button key={n.id} className={"rail-btn" + (page === n.id ? " active" : "")} data-tip={t(n.label)} onClick={() => go(n.id)}>
              <Icon name={n.icon} size={22} />
            </button>
          ))}
          <div className="spacer" />
          <button className={"rail-btn" + (page === "settings" ? " active" : "")} data-tip={t("Настройки")} onClick={() => go("settings")}>
            <Icon name="settings" size={22} />
          </button>
          <button className="rail-btn rail-profile" data-tip={t("Профиль")} onClick={() => setProfileOpen((o) => !o)}>
            <Avatar account={active} name={active?.name ?? "?"} size={38} />
          </button>
        </aside>

        {profMounted && <AccountMenu closing={profClosing} info={accounts} onSelect={selectAcc} onRemove={removeAcc} onClose={() => setProfileOpen(false)} onOffline={addOffline} onEly={addEly} onMs={startMs} />}

        <main className="content">
          <div className={"page " + dir} key={page}>
            {page === "home" && <Home featured={featured} popular={popular} page={popPage} pages={popPages} onPage={openPopPage} instances={instances} busy={working !== null} onInstall={installLatest} onPick={openPack} />}
            {page === "library" && (
              <Library instances={instances} settings={settings} running={running} busyId={busyId} busy={working !== null} updates={packUpdates}
                onPlay={play} onStop={(i) => invoke("stop_instance", { id: i.id }).catch((e) => toast(String(e), "err"))}
                onManage={(i) => setManage({ id: i.id, tab: "mods" })} onExport={setExporting} onDelete={deleteInstance}
                onCreate={() => setStore("create")} onUpdate={updatePack} />
            )}
            {page === "games" && <Games />}
            {page === "settings" && (
              <SettingsPage settings={settings} patch={patch} patchGame={patchGame} work={work} onFullReset={fullReset} onReset={() => { setSettings(DEFAULTS); toast(t("Настройки сброшены"), "ok"); }} />
            )}
          </div>
        </main>
      </div>

      {page === "home" && (
        <div className="dock-row">
          {instances && instances.length > 0 && <InstanceSelect instances={instances} value={selectedId} onChange={select} />}
          <button className="btn primary play-dock" disabled={working !== null || instances === null || (!!selected && running.includes(selected.id))}
            onClick={() => (selected ? play(selected) : setStore("create"))}>
            <Icon name="play" size={22} /> {selected && running.includes(selected.id) ? t("Запущено") : t("Играть")}
          </button>
        </div>
      )}
      {store && <NewInstance versions={versions} initialTab={store} busy={working !== null} toast={toast} onClose={() => setStore(null)} onCreate={createInstance} onPick={openPack} onImport={importPack} />}
      {login && <Modal title={t("Вход через Microsoft")} onClose={() => setLogin(null)}><CodeBox login={login} /></Modal>}
      {offlineOpen && (
        <OfflineModal onClose={() => setOfflineOpen(false)} onDone={async (n) => { await accountOp(() => invoke("add_offline_account", { name: n }), t("Аккаунт добавлен")); setOfflineOpen(false); }} />
      )}
      {elyOpen && (
        <ElyModal onClose={() => setElyOpen(false)} onDone={async (u, p) => { await accountOp(() => invoke("ely_login", { username: u, password: p }), t("Вход в Ely.by выполнен")); setElyOpen(false); }} />
      )}
      {manage && manageInst && (
        <Manage inst={manageInst} settings={settings} versions={versions} logs={logs.current[manage.id] ?? []} initialTab={manage.tab} onClose={() => setManage(null)}
          onChanged={refreshInstances} onClearLogs={() => { logs.current[manage.id] = []; bump((n) => n + 1); }} toast={toast} />
      )}
      {exporting && <ExportModal inst={exporting} onClose={() => setExporting(null)} toast={toast} />}
      {pack && <PackVersions pack={pack} versions={packVers} onClose={() => setPack(null)} onInstall={installPack} />}

      {splashMounted && (
        <div className={"splash" + (splashClosing ? " closing" : "")}>
          <Logo size={76} />
          <div className="splash-name">ItsLauncher</div>
          <div className="bar splash-bar"><div className="fill indet" /></div>
        </div>
      )}

      <div className="toasts">
        {toasts.map((x) => x.kind === "err"
          ? <ErrorToast key={x.id} text={x.text} onClose={() => setToasts((l) => l.filter((y) => y.id !== x.id))} />
          : <div key={x.id} className={"toast " + x.kind}>{x.text}</div>)}
      </div>
    </div>
  );
}
