import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Accent, GameSettings, Lang, Settings, Theme } from "./types";
import { GameForm } from "./GameForm";
import { Icon, Logo, Modal, Seg, Switch } from "./ui";
import { claude, teddypes } from "./avatars";
import { t } from "./i18n";

type Tab = "look" | "language" | "game" | "java" | "devs";
type JavaItem = { major: number; installed: boolean };

export function SettingsPage({ settings, patch, patchGame, work, onReset, onFullReset }: {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
  patchGame: (p: Partial<GameSettings>) => void;
  work: <T>(label: string, fn: () => Promise<T>) => Promise<T | undefined>;
  onReset: () => void;
  onFullReset: () => void;
}) {
  const [tab, setTabRaw] = useState<Tab>("look");
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmFull, setConfirmFull] = useState(false);
  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "look", label: "Внешний вид", icon: "palette" },
    { id: "language", label: "Язык", icon: "globe" },
    { id: "game", label: "Minecraft", icon: "sliders" },
    { id: "java", label: "Java", icon: "coffee" },
    { id: "devs", label: "Разработчики", icon: "user" },
  ];
  const setTab = (id: Tab) => {
    if (id === tab) return;
    setTabRaw(id);
  };
  return (
    <>
      <div className="page-head"><h1>{t("Настройки")}</h1></div>
      <div className="settings">
        <nav className="tabs">
          {tabs.map((x) => (
            <button key={x.id} className={tab === x.id ? "on" : ""} onClick={() => setTab(x.id)}>
              <Icon name={x.icon} size={16} /> {t(x.label)}
            </button>
          ))}
          <button className="reset-btn reset-start" onClick={() => setConfirmReset(true)}><Icon name="refresh" size={15} /> {t("Сбросить настройки")}</button>
          <button className="reset-btn full-reset-btn" onClick={() => setConfirmFull(true)}><Icon name="trash" size={15} /> {t("Полный сброс лаунчера")}</button>
        </nav>
        <div className="tab-body" key={tab}>
          {tab === "look" && <Look settings={settings} patch={patch} />}
          {tab === "language" && (
            <section className="card section">
              <h3>{t("Язык")}</h3>
              <Seg<Lang> value={settings.lang} onChange={(v) => patch({ lang: v })} options={[{ value: "system", label: t("Авто") }, { value: "ru", label: "Русский" }, { value: "en", label: "English" }]} />
            </section>
          )}
          {tab === "game" && <GameForm value={settings.game} onChange={patchGame} />}
          {tab === "devs" && <Devs />}
          {tab === "java" && <JavaTab work={work} javaPath={settings.game.javaPath} onPath={(javaPath) => patchGame({ javaPath })} />}
        </div>
      </div>
      {confirmFull && (
        <Modal title={t("Полный сброс лаунчера")} onClose={() => setConfirmFull(false)}>
          <p className="muted">{t("Будут удалены все экземпляры, миры, аккаунты, скачанная Java и настройки. Лаунчер закроется.")}</p>
          <div className="row end">
            <button className="btn ghost" onClick={() => setConfirmFull(false)}>{t("Отмена")}</button>
            <button className="btn danger-solid" onClick={() => { setConfirmFull(false); onFullReset(); }}>{t("Сбросить всё")}</button>
          </div>
        </Modal>
      )}
      {confirmReset && (
        <Modal title={t("Сбросить настройки")} onClose={() => setConfirmReset(false)}>
          <p className="muted">{t("Все настройки лаунчера вернутся к значениям по умолчанию. Экземпляры и аккаунты не затрагиваются.")}</p>
          <div className="row end">
            <button className="btn ghost" onClick={() => setConfirmReset(false)}>{t("Отмена")}</button>
            <button className="btn danger-solid" onClick={() => { onReset(); setConfirmReset(false); }}>{t("Сбросить")}</button>
          </div>
        </Modal>
      )}
    </>
  );
}

const TEAM: { name: string; role: string; img?: string }[] = [
  { name: "ItsToof", role: "Главный разработчик" },
  { name: "TeddyPes", role: "Тостер", img: teddypes },
  { name: "Claude", role: "Исходники", img: claude },
];

function Devs() {
  return (
    <section className="card section">
      <h3>{t("Разработчики")}</h3>
      <div className="devs">
        {TEAM.map((m) => (
          <div key={m.name} className="dev">
            {m.img ? <img className="dev-ava" src={m.img} alt="" draggable={false} /> : <Logo size={44} />}
            <div>
              <div className="dev-name">{m.name}</div>
              <div className="muted small">{t(m.role)}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Look({ settings, patch }: { settings: Settings; patch: (p: Partial<Settings>) => void }) {
  const themes: { id: Theme; label: string }[] = [
    { id: "light", label: "Светлая" },
    { id: "dark", label: "Тёмная" },
    { id: "oled", label: "OLEG" },
    { id: "system", label: "Как в системе" },
  ];
  const accents: { id: Accent; color: string }[] = [
    { id: "red", color: "#ff3b3b" },
    { id: "orange", color: "#ff9f43" },
    { id: "yellow", color: "#facc15" },
    { id: "lime", color: "#a3e635" },
    { id: "green", color: "#1bd96a" },
    { id: "cyan", color: "#22d3ee" },
    { id: "blue", color: "#3b9cff" },
    { id: "indigo", color: "#6366f1" },
    { id: "purple", color: "#a66bff" },
    { id: "pink", color: "#ff5fa2" },
  ];
  return (
    <>
      <section className="card section">
        <h3>{t("Тема")}</h3>
        <div className="themes">
          {themes.map((x) => (
            <button key={x.id} className={"theme-card" + (settings.theme === x.id ? " on" : "")} onClick={() => patch({ theme: x.id })}>
              <div className={"preview sw-" + x.id}><i /><i /><i /></div>
              {t(x.label)}
            </button>
          ))}
        </div>
      </section>
      <section className="card section">
        <h3>{t("Акцентный цвет")}</h3>
        <div className="accents">
          {accents.map((a) => (
            <button key={a.id} className={"swatch" + (settings.accent === a.id ? " on" : "")} style={{ background: a.color }} onClick={() => patch({ accent: a.id })}>
              {settings.accent === a.id && <Icon name="check" size={18} />}
            </button>
          ))}
        </div>
      </section>
      <section className="card section">
        <h3>{t("Эффекты")}</h3>
        <Switch checked={settings.glow} onChange={(v) => patch({ glow: v })} label={t("Свечение")} />
        <div className="muted small" style={{ margin: "-2px 0 8px" }}>{t("Свечение было встроено с помощью ИИ")}</div>
        <Switch checked={settings.motion} onChange={(v) => patch({ motion: v })} label={t("Анимации интерфейса")} />
      </section>
    </>
  );
}

function JavaTab({ work, javaPath, onPath }: { work: <T>(label: string, fn: () => Promise<T>) => Promise<T | undefined>; javaPath: string; onPath: (p: string) => void }) {
  const [list, setList] = useState<JavaItem[] | null>(null);
  const [installing, setInstalling] = useState<number | null>(null);
  const load = () => invoke<JavaItem[]>("java_list").then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, []);
  const hint: Record<number, string> = { 8: "Minecraft 1.16 и старше", 17: "Minecraft 1.17 – 1.20.4", 21: "Minecraft 1.20.5 – 1.21.x", 25: "Новые версии Minecraft" };
  return (
    <>
      <section className="card section">
        <h3>{t("Свой путь к Java")}</h3>
        <input value={javaPath} onChange={(e) => onPath(e.target.value)} placeholder={t("Пусто: лаунчер сам скачает нужную Java")} />
      </section>
      <section className="card section">
        <h3>{t("Установленные Java")}</h3>
        <div className="java-list">
          {list === null && [0, 1, 2, 3].map((i) => <div key={i} className="skel" style={{ height: 52 }} />)}
          {list?.map((j) => (
            <div key={j.major} className="java-row">
              <span className="java-ico"><Icon name="coffee" size={20} /></span>
              <div className="grow">
                <div className="fm-name">Java {j.major}</div>
                {hint[j.major] && <div className="muted small">{t(hint[j.major])}</div>}
              </div>
              {j.installed ? (
                <>
                  <span className="chip accent">{t("Установлена")}</span>
                  <button className="btn sm" onClick={async () => { await invoke("java_remove", { major: j.major }).catch(() => {}); load(); }}>{t("Удалить")}</button>
                </>
              ) : (
                installing === j.major ? (
                  <button className="btn sm" onClick={() => invoke("cancel_task").catch(() => {})}>
                    <span className="spinner sm" /> {t("Отменить")}
                  </button>
                ) : (
                  <button className="btn sm primary" disabled={installing !== null} onClick={async () => {
                    setInstalling(j.major);
                    await work(t("Скачивание Java {v}", { v: j.major }), () => invoke("java_install", { major: j.major }));
                    setInstalling(null);
                    load();
                  }}>
                    <Icon name="download" size={14} /> {t("Скачать")}
                  </button>
                )
              )}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
