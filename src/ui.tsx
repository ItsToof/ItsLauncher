import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import type { CSSProperties, ReactNode } from "react";
import logo from "./assets/logo.png";
import type { Account, Instance } from "./types";
import { hue } from "./settings";
import { t } from "./i18n";

const ICONS: Record<string, string> = {
  home: "M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 22V12h6v10",
  library: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
  browse: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  settings: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  play: "M5 3l14 9-14 9V3z",
  folder: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z",
  trash: "M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6",
  plus: "M12 5v14M5 12h14",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35",
  x: "M18 6L6 18M6 6l12 12",
  check: "M20 6L9 17l-5-5",
  copy: "M9 9h11v11H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1",
  minus: "M5 12h14",
  square: "M5 5h14v14H5z",
  restore: "M8 8V5h11v11h-3M5 8h11v11H5z",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  external: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
  up: "M12 19V5M5 12l7-7 7 7",
  globe: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20",
  package: "M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7zM3.3 7L12 12l8.7-5M12 22V12",
  image: "M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21",
  chevron: "M6 9l6 6 6-6",
  refresh: "M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5",
  terminal: "M4 17l6-6-6-6M12 19h8",
  archive: "M21 8v13H3V8M1 3h22v5H1zM10 12h4",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
  unlock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 7.5-2",
  sliders: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  coffee: "M18 8h1a4 4 0 0 1 0 8h-1M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4zM6 1v3M10 1v3M14 1v3",
  swap: "M8 3L4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4",
  tag: "M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7.5 7.5h.01",
  filter: "M22 3H2l8 9.5V19l4 2v-8.5z",
  games: "M6 11h4M8 9v4M15 12h.01M18 10h.01M17.32 5H6.68a4 4 0 0 0-3.978 3.59C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258A4 4 0 0 0 17.32 5z",
  palette: "M12 22a10 10 0 1 1 10-10c0 3-2 4-4 4h-2a2 2 0 0 0-1 3.7c.6.5.5 2.3-3 2.3zM7.5 12a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM10 7.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM15 7.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
};

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={name === "settings" || name === "sliders" ? { transform: "rotate(90deg)" } : undefined}>
      <path d={ICONS[name] ?? ""} />
    </svg>
  );
}

export const MsLogo = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24">
    <rect x="2" y="2" width="9.5" height="9.5" fill="#f25022" />
    <rect x="12.5" y="2" width="9.5" height="9.5" fill="#7fba00" />
    <rect x="2" y="12.5" width="9.5" height="9.5" fill="#00a4ef" />
    <rect x="12.5" y="12.5" width="9.5" height="9.5" fill="#ffb900" />
  </svg>
);

export function ElyLogo({ size = 16 }: { size?: number }) {
  const [bad, setBad] = useState(false);
  if (bad) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24">
        <rect width="24" height="24" rx="7" fill="#1f9d6e" />
        <text x="12" y="17" textAnchor="middle" fontSize="15" fontWeight="800" fill="#fff" fontFamily="Inter, sans-serif">E</text>
      </svg>
    );
  }
  return <img src="https://ely.by/favicon.ico" width={size} height={size} alt="Ely.by" style={{ borderRadius: 4 }} onError={() => setBad(true)} />;
}

export const Logo = ({ size = 26 }: { size?: number }) => <img className="logo" src={logo} width={size} height={size} alt="" draggable={false} />;
export const st = (i: number) => ({ "--i": i }) as CSSProperties;

export function useMounted(open: boolean, ms = 200): [boolean, boolean] {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const id = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(id);
  }, [open, ms]);
  return [mounted || open, !open && mounted];
}

export function HScroll({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const go = useRef<(to: number) => void>(() => {});
  const [edge, setEdge] = useState({ l: false, r: false });
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const l = el.scrollLeft > 4;
    const r = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setEdge((p) => (p.l === l && p.r === r ? p : { l, r }));
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let target = el.scrollLeft;
    let raf = 0;
    const tick = () => {
      const d = target - el.scrollLeft;
      if (Math.abs(d) < 0.5) {
        el.scrollLeft = target;
        raf = 0;
        return;
      }
      el.scrollLeft += Math.sign(d) * Math.max(1, Math.abs(d) * 0.2);
      raf = requestAnimationFrame(tick);
    };
    go.current = (to) => {
      target = Math.max(0, Math.min(el.scrollWidth - el.clientWidth, to));
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const wheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      const base = raf ? target : el.scrollLeft;
      if ((e.deltaY < 0 && base <= 0) || (e.deltaY > 0 && base >= max - 1)) return;
      e.preventDefault();
      target = Math.max(0, Math.min(max, base + e.deltaY));
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const scroll = () => {
      if (!raf) target = el.scrollLeft;
      update();
    };
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("scroll", scroll, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("scroll", scroll);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [update]);
  useEffect(update, [children, update]);
  const step = (dir: number) => {
    const el = ref.current;
    if (el) go.current(el.scrollLeft + dir * Math.max(240, el.clientWidth * 0.8));
  };
  return (
    <div className={"hs" + (edge.l ? " fade-l" : "") + (edge.r ? " fade-r" : "")}>
      {edge.l && <button type="button" className="hs-btn l" onClick={() => step(-1)}><Icon name="chevron" size={18} /></button>}
      <div className="hscroll" ref={ref}>{children}</div>
      {edge.r && <button type="button" className="hs-btn r" onClick={() => step(1)}><Icon name="chevron" size={18} /></button>}
    </div>
  );
}

function Jump({ pages, onGo }: { pages: number; onGo: (p: number) => void }) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState("");
  const done = () => {
    const n = parseInt(v, 10);
    if (n >= 1 && n <= pages) onGo(n - 1);
    setEdit(false);
    setV("");
  };
  if (!edit) return <button type="button" className="pg dots" onClick={() => setEdit(true)}>…</button>;
  return (
    <input
      className="pg jump"
      autoFocus
      inputMode="numeric"
      value={v}
      placeholder={`1–${pages}`}
      onChange={(e) => setV(e.target.value.replace(/\D/g, ""))}
      onBlur={done}
      onKeyDown={(e) => { if (e.key === "Enter") done(); else if (e.key === "Escape") { setV(""); setEdit(false); } }}
    />
  );
}

export function Pager({ page, pages, onChange }: { page: number; pages: number; onChange: (p: number) => void }) {
  const near = new Set([0, pages - 1, page - 1, page, page + 1]);
  const items: (number | "…")[] = [];
  let last = -1;
  for (let i = 0; i < pages; i++) {
    if (!near.has(i)) continue;
    if (last !== -1 && i - last > 1) items.push("…");
    items.push(i);
    last = i;
  }
  return (
    <nav className="pager">
      <button type="button" className="pg prev" disabled={page <= 0} onClick={() => onChange(page - 1)}><Icon name="chevron" size={16} /></button>
      {items.map((n, i) =>
        n === "…"
          ? <Jump key={"e" + i} pages={pages} onGo={onChange} />
          : <button key={n} type="button" className={"pg" + (n === page ? " on" : "")} onClick={() => n !== page && onChange(n)}>{n + 1}</button>
      )}
      <button type="button" className="pg next" disabled={page >= pages - 1} onClick={() => onChange(page + 1)}><Icon name="chevron" size={16} /></button>
    </nav>
  );
}

const modalStack: symbol[] = [];

export function Modal({ title, onClose, children, size = "md" }: { title: ReactNode; onClose: () => void; children: ReactNode; size?: "md" | "wide" | "xl" }) {
  const [closing, setClosing] = useState(false);
  const id = useRef(Symbol("modal"));
  const onCloseRef = useRef(onClose);
  const closingRef = useRef(false);
  const timer = useRef<number>(0);
  onCloseRef.current = onClose;

  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    timer.current = window.setTimeout(() => onCloseRef.current(), 170);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    const me = id.current;
    modalStack.push(me);
    const h = (e: KeyboardEvent) => e.key === "Escape" && modalStack[modalStack.length - 1] === me && close();
    window.addEventListener("keydown", h);
    return () => {
      window.removeEventListener("keydown", h);
      modalStack.splice(modalStack.indexOf(me), 1);
    };
  }, [close]);
  return createPortal(
    <div className={"overlay" + (closing ? " closing" : "")} onMouseDown={close}>
      <div className={"modal " + size} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={close} aria-label={t("Закрыть")}>
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}

export function Select({ value, options, onChange, searchable }: { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; searchable?: boolean }) {
  const [open, setOpen] = useState(false);
  const [mounted, closing] = useMounted(open, 160);
  const [q, setQ] = useState("");
  const [pos, setPos] = useState<CSSProperties>({});
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const n = e.target as Node;
      if (!ref.current?.contains(n) && !popRef.current?.contains(n)) setOpen(false);
    };
    const away = (e: Event) => !popRef.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", down);
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", away);
    };
  }, [open]);
  const toggle = () => {
    if (!open && ref.current) {
      const r = ref.current.getBoundingClientRect();
      const below = window.innerHeight - r.bottom;
      const up = below < 300 && r.top > below;
      setPos(up ? { left: r.left, width: r.width, bottom: window.innerHeight - r.top + 8 } : { left: r.left, width: r.width, top: r.bottom + 8 });
    }
    setOpen(!open);
    setQ("");
  };
  const list = useMemo(() => options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase())), [options, q]);
  const current = options.find((o) => o.value === value);
  return (
    <div className={"select" + (open ? " open" : "")} ref={ref}>
      <button type="button" className="select-btn" onClick={toggle}>
        <span className="ellipsis">{current?.label ?? "—"}</span>
        <Icon name="chevron" size={16} />
      </button>
      {mounted &&
        createPortal(
          <div ref={popRef} className={"select-pop" + (closing ? " closing" : "") + (pos.bottom !== undefined ? " up" : "")} style={pos}>
            {searchable && <input autoFocus placeholder={t("Поиск…")} value={q} onChange={(e) => setQ(e.target.value)} />}
            <div className="select-list">
              {list.map((o) => (
                <button key={o.value} type="button" className={"select-opt" + (o.value === value ? " on" : "")} onClick={() => { onChange(o.value); setOpen(false); }}>
                  {o.label}
                  {o.value === value && <Icon name="check" size={15} />}
                </button>
              ))}
              {list.length === 0 && <div className="muted small" style={{ padding: 10 }}>{t("Ничего не найдено")}</div>}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} type="button" className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="switch-row">
      <span>
        {label}
        {hint && <small className="muted">{hint}</small>}
      </span>
      <input type="checkbox" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function InstanceIcon({ inst, size = 56 }: { inst: Pick<Instance, "name" | "icon">; size?: number }) {
  const [bad, setBad] = useState(false);
  if (inst.icon && !bad) return <img className="inst-icon" style={{ width: size, height: size }} src={inst.icon} onError={() => setBad(true)} alt="" />;
  const h = hue(inst.name);
  return (
    <div
      className="inst-icon letter"
      style={{ width: size, height: size, fontSize: size * 0.4, background: `linear-gradient(135deg, hsl(${h} 65% 52%), hsl(${(h + 50) % 360} 65% 38%))` }}
    >
      {inst.name.slice(0, 1).toUpperCase()}
    </div>
  );
}

export function ProjectIcon({ url, title, size = 48 }: { url?: string | null; title: string; size?: number }) {
  return <InstanceIcon inst={{ name: title || "?", icon: url }} size={size} />;
}

export function SkinCanvas({ url, slim = false, mode = "body", scale = 8, onFail }: { url: string; slim?: boolean; mode?: "head" | "body"; scale?: number; onFail?: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const img = new Image();
    img.onerror = () => onFail?.();
    img.onload = () => {
      const c = ref.current;
      const ctx = c?.getContext("2d");
      if (!c || !ctx) return;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.imageSmoothingEnabled = false;
      const s = scale;
      const part = (sx: number, sy: number, w: number, h: number, dx: number, dy: number, flip = false) => {
        ctx.save();
        if (flip) {
          ctx.translate((dx + w) * s, dy * s);
          ctx.scale(-1, 1);
          ctx.drawImage(img, sx, sy, w, h, 0, 0, w * s, h * s);
        } else ctx.drawImage(img, sx, sy, w, h, dx * s, dy * s, w * s, h * s);
        ctx.restore();
      };
      if (mode === "head") {
        part(8, 8, 8, 8, 0, 0);
        part(40, 8, 8, 8, 0, 0);
        return;
      }
      const legacy = img.height === 32;
      const aw = slim ? 3 : 4;
      part(8, 8, 8, 8, 4, 0);
      part(20, 20, 8, 12, 4, 8);
      part(44, 20, aw, 12, 4 - aw, 8);
      part(4, 20, 4, 12, 4, 20);
      if (legacy) {
        part(44, 20, aw, 12, 12, 8, true);
        part(4, 20, 4, 12, 8, 20, true);
      } else {
        part(36, 52, aw, 12, 12, 8);
        part(20, 52, 4, 12, 8, 20);
        part(20, 36, 8, 12, 4, 8);
        part(44, 36, aw, 12, 4 - aw, 8);
        part(52, 52, aw, 12, 12, 8);
        part(4, 36, 4, 12, 4, 20);
        part(4, 52, 4, 12, 8, 20);
      }
      part(40, 8, 8, 8, 4, 0);
    };
    img.src = url;
  }, [url, slim, mode, scale, onFail]);
  const w = mode === "head" ? 8 : 16;
  const h = mode === "head" ? 8 : 32;
  return <canvas ref={ref} className="skin-canvas" width={w * scale} height={h * scale} />;
}

const msSkins = new Map<string, string>();

export function Avatar({ account, name, size = 40 }: { account?: Account; name: string; size?: number }) {
  const [skin, setSkin] = useState<string | null>(null);
  useEffect(() => {
    if (account?.kind === "ely") {
      setSkin(`https://skinsystem.ely.by/skins/${account.name}.png`);
      return;
    }
    if (account?.kind === "ms") {
      let alive = true;
      const id = account.id;
      setSkin(msSkins.get(id) ?? null);
      if (!msSkins.has(id)) {
        invoke<string | null>("account_skin", { id })
          .then((u) => {
            if (!u) return;
            msSkins.set(id, u);
            if (alive) setSkin(u);
          })
          .catch((e) => console.error("account_skin:", e));
      }
      return () => { alive = false; };
    }
    setSkin(null);
  }, [account?.kind, account?.name, account?.id]);
  const fallback = useCallback(() => setSkin(null), []);
  return (
    <div className={"avatar " + (account?.kind ?? "offline")} style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {skin ? <SkinCanvas url={skin} mode="head" scale={Math.max(2, Math.round(size / 8))} onFail={fallback} /> : name.slice(0, 1).toUpperCase()}
    </div>
  );
}
