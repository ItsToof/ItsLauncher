import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon, Seg } from "./ui";
import { t } from "./i18n";

type Svc = "yandex" | "spotify" | "soundcloud";
type Item = { svc: Svc; url: string };

const NAMES: Record<Svc, string> = { yandex: "Яндекс Музыка", spotify: "Spotify", soundcloud: "SoundCloud" };
const HOME: Record<Svc, string> = { yandex: "https://music.yandex.ru", spotify: "https://open.spotify.com", soundcloud: "https://soundcloud.com" };
const KEY = "its.music";

const detect = (url: string): Svc | null =>
  /music\.yandex\./.test(url) ? "yandex" : /open\.spotify\.com/.test(url) ? "spotify" : /soundcloud\.com/.test(url) ? "soundcloud" : null;

function embed(item: Item): { src: string; h: number } | null {
  const { svc, url } = item;
  let path = "";
  try { path = new URL(url).pathname; } catch { return null; }
  if (svc === "spotify") {
    const m = path.match(/(?:intl-\w+\/)?(track|album|playlist|artist|episode|show)\/(\w+)/);
    return m ? { src: `https://open.spotify.com/embed/${m[1]}/${m[2]}?theme=0`, h: m[1] === "track" || m[1] === "episode" ? 152 : 352 } : null;
  }
  if (svc === "soundcloud") {
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().replace("#", "");
    const clean = url.split("?")[0];
    return { src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(clean)}&color=%23${accent || "3b9cff"}&auto_play=false&hide_related=true&show_comments=false`, h: 300 };
  }
  const base = "https://music.yandex.ru/iframe/";
  let m = path.match(/album\/(\d+)\/track\/(\d+)/);
  if (m) return { src: `${base}track/${m[2]}/${m[1]}`, h: 100 };
  m = path.match(/users\/([^/]+)\/playlists\/(\d+)/);
  if (m) return { src: `${base}playlist/${m[1]}/${m[2]}`, h: 450 };
  m = path.match(/playlists\/([\w.-]+)/);
  if (m) return { src: `${base}playlist/${m[1]}`, h: 450 };
  m = path.match(/album\/(\d+)/);
  if (m) return { src: `${base}album/${m[1]}`, h: 450 };
  m = path.match(/track\/(\d+)/);
  return m ? { src: `${base}track/${m[1]}`, h: 100 } : null;
}

const load = (): Item[] => {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; }
};
const save = (items: Item[]) => {
  try { localStorage.setItem(KEY, JSON.stringify(items)); } catch {}
};
const open = (url: string) => invoke("open_url", { url }).catch(() => {});

export function Music() {
  const [svc, setSvc] = useState<Svc>("spotify");
  const [text, setText] = useState("");
  const [err, setErr] = useState(false);
  const [items, setItems] = useState<Item[]>(load);
  const [cur, setCur] = useState<Item | null>(items[0] ?? null);

  const play = (item: Item) => {
    setCur(item);
    setSvc(item.svc);
  };
  const submit = () => {
    const url = text.trim();
    const kind = detect(url);
    const item = kind && { svc: kind, url };
    if (!item || !embed(item)) { setErr(true); return; }
    setErr(false);
    setText("");
    const next = [item, ...items.filter((x) => x.url !== url)].slice(0, 10);
    setItems(next);
    save(next);
    play(item);
  };
  const drop = (url: string) => {
    const next = items.filter((x) => x.url !== url);
    setItems(next);
    save(next);
  };
  const frame = cur && embed(cur);

  return (
    <>
      <div className="page-head">
        <h1>{t("Музыка")}</h1>
        <button className="btn sm" onClick={() => open(HOME[svc])}><Icon name="external" size={14} /> {NAMES[svc]}</button>
      </div>
      <div className="content-bar">
        <Seg<Svc> value={svc} onChange={setSvc} options={(Object.keys(NAMES) as Svc[]).map((k) => ({ value: k, label: NAMES[k] }))} />
        <div className="search grow">
          <Icon name="search" size={16} />
          <input placeholder={t("Ссылка на трек, альбом или плейлист")} value={text} onChange={(e) => { setText(e.target.value); setErr(false); }} onKeyDown={(e) => e.key === "Enter" && submit()} />
        </div>
        <button className="btn primary" disabled={!text.trim()} onClick={submit}>{t("Слушать")}</button>
      </div>
      {err && <div className="music-err">{t("Не удалось распознать ссылку")}</div>}
      {frame && cur ? (
        <div className="card music-frame">
          <iframe key={frame.src} src={frame.src} height={frame.h} allow="autoplay; encrypted-media; clipboard-write; fullscreen" title={NAMES[cur.svc]} />
          <div className="row end">
            <span className="muted small grow">{t(cur.svc === "yandex" ? "Если плеер не загрузился, откройте ссылку в браузере" : "Без входа в аккаунт сервис проигрывает только отрывки")}</span>
            <button className="btn sm ghost" onClick={() => open(cur.url)}><Icon name="external" size={14} /> {t("Открыть в браузере")}</button>
          </div>
        </div>
      ) : (
        <div className="empty small">{t("Вставьте ссылку из Яндекс Музыки, Spotify или SoundCloud")}</div>
      )}
      {items.length > 0 && (
        <>
          <div className="sec-head"><h2>{t("Недавнее")}</h2></div>
          <div className="fm-list">
            {items.map((x, i) => (
              <div key={x.url} className={"fm-row music-row" + (cur?.url === x.url ? " on" : "")} style={{ "--i": i } as React.CSSProperties} onClick={() => play(x)}>
                <span className="chip accent">{NAMES[x.svc]}</span>
                <div className="grow ellipsis muted small">{x.url.replace(/^https?:\/\/(www\.)?/, "")}</div>
                <button className="mini-btn" title={t("Удалить")} onClick={(e) => { e.stopPropagation(); drop(x.url); }}><Icon name="trash" size={15} /></button>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
