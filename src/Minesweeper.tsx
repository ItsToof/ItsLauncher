import { useCallback, useEffect, useState } from "react";
import { Seg } from "./ui";
import { t } from "./i18n";

type Level = "easy" | "mid" | "hard";
type Cell = { mine: boolean; open: boolean; flag: boolean; n: number };
type Status = "ready" | "play" | "won" | "lost";

const LEVELS: Record<Level, { cols: number; rows: number; mines: number; name: string }> = {
  easy: { cols: 9, rows: 9, mines: 10, name: "Новичок" },
  mid: { cols: 16, rows: 16, mines: 50, name: "Любитель" },
  hard: { cols: 24, rows: 16, mines: 100, name: "Профи" },
};

const blank = (l: Level): Cell[] => Array.from({ length: LEVELS[l].cols * LEVELS[l].rows }, () => ({ mine: false, open: false, flag: false, n: 0 }));

function around(i: number, l: Level) {
  const { cols, rows } = LEVELS[l];
  const x = i % cols;
  const y = Math.floor(i / cols);
  const out: number[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if ((dx || dy) && nx >= 0 && nx < cols && ny >= 0 && ny < rows) out.push(ny * cols + nx);
    }
  }
  return out;
}

function scatter(cells: Cell[], l: Level, safe: number) {
  const banned = new Set([safe, ...around(safe, l)]);
  const free = cells.map((_, i) => i).filter((i) => !banned.has(i));
  cells.forEach((c) => { c.mine = false; });
  for (let k = 0; k < LEVELS[l].mines; k++) {
    const j = k + Math.floor(Math.random() * (free.length - k));
    [free[k], free[j]] = [free[j], free[k]];
    cells[free[k]].mine = true;
  }
  cells.forEach((c, i) => { c.n = around(i, l).filter((j) => cells[j].mine).length; });
}

function solved(cells: Cell[], l: Level, safe: number) {
  const seen = cells.map(() => false);
  const mark = cells.map(() => false);
  const reveal = (from: number) => {
    const st = [from];
    while (st.length) {
      const i = st.pop()!;
      if (seen[i] || mark[i]) continue;
      seen[i] = true;
      if (!cells[i].n) st.push(...around(i, l));
    }
  };
  reveal(safe);
  for (let moved = true; moved; ) {
    moved = false;
    const rules: { u: number[]; m: number }[] = [];
    cells.forEach((c, i) => {
      if (!seen[i] || !c.n) return;
      const ring = around(i, l);
      const u = ring.filter((j) => !seen[j] && !mark[j]);
      if (u.length) rules.push({ u, m: c.n - ring.filter((j) => mark[j]).length });
    });
    const apply = (u: number[], mines: number) => {
      if (mines === 0) u.forEach((j) => { if (!seen[j]) { reveal(j); moved = true; } });
      else if (mines === u.length) u.forEach((j) => { if (!mark[j]) { mark[j] = true; moved = true; } });
    };
    rules.forEach((r) => apply(r.u, r.m));
    if (moved) continue;
    for (const p of rules) {
      for (const q of rules) {
        if (p === q || p.u.length >= q.u.length || !p.u.every((j) => q.u.includes(j))) continue;
        apply(q.u.filter((j) => !p.u.includes(j)), q.m - p.m);
      }
    }
  }
  return cells.filter((c, i) => !c.mine && seen[i]).length;
}

function plant(cells: Cell[], l: Level, safe: number) {
  const target = cells.length - LEVELS[l].mines;
  const until = performance.now() + 150;
  let top = -1;
  let keep: boolean[] = [];
  do {
    scatter(cells, l, safe);
    const score = solved(cells, l, safe);
    if (score > top) { top = score; keep = cells.map((c) => c.mine); }
    if (score === target) return;
  } while (performance.now() < until);
  cells.forEach((c, i) => { c.mine = keep[i]; });
  cells.forEach((c, i) => { c.n = around(i, l).filter((j) => cells[j].mine).length; });
}

function flood(cells: Cell[], l: Level, from: number) {
  const stack = [from];
  while (stack.length) {
    const i = stack.pop()!;
    const c = cells[i];
    if (c.open || c.flag) continue;
    c.open = true;
    if (!c.n) stack.push(...around(i, l));
  }
}

const best = (l: Level) => {
  try { return Number(localStorage.getItem("its.mines." + l)) || 0; } catch { return 0; }
};

const sizeFor = (cols: number, rows: number) =>
  Math.max(20, Math.min(34, Math.floor((window.innerWidth - 150) / cols), Math.floor((window.innerHeight - 300) / rows)));

export function Minesweeper() {
  const [level, setLevel] = useState<Level>("easy");
  const [cells, setCells] = useState(() => blank("easy"));
  const [status, setStatus] = useState<Status>("ready");
  const [time, setTime] = useState(0);
  const [record, setRecord] = useState(() => best("easy"));
  const [size, setSize] = useState(() => sizeFor(9, 9));
  const { cols, rows, mines } = LEVELS[level];

  const reset = useCallback((l: Level) => {
    setLevel(l);
    setCells(blank(l));
    setStatus("ready");
    setTime(0);
    setRecord(best(l));
    setSize(sizeFor(LEVELS[l].cols, LEVELS[l].rows));
  }, []);

  useEffect(() => {
    const onResize = () => setSize(sizeFor(cols, rows));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [cols, rows]);

  useEffect(() => {
    if (status !== "play") return;
    const id = setInterval(() => setTime((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [status]);

  const finish = (next: Cell[], lost: boolean) => {
    if (lost) next.forEach((c) => { if (c.mine) c.open = true; });
    else {
      next.forEach((c) => { if (c.mine) c.flag = true; });
      if (!record || time < record) {
        setRecord(time);
        try { localStorage.setItem("its.mines." + level, String(time)); } catch {}
      }
    }
    setStatus(lost ? "lost" : "won");
  };

  const open = (i: number) => {
    if (status === "won" || status === "lost") return;
    const next = cells.map((c) => ({ ...c }));
    const c = next[i];
    if (c.flag) return;
    if (c.open) {
      const ring = around(i, level);
      if (!c.n || ring.filter((j) => next[j].flag).length !== c.n) return;
      const hit = ring.some((j) => !next[j].flag && next[j].mine);
      ring.forEach((j) => { if (!next[j].flag) flood(next, level, j); });
      if (hit) { finish(next, true); setCells(next); return; }
    } else {
      if (status === "ready") { plant(next, level, i); setStatus("play"); }
      if (c.mine) { c.open = true; finish(next, true); setCells(next); return; }
      flood(next, level, i);
    }
    if (next.every((x) => x.mine || x.open)) finish(next, false);
    setCells(next);
  };

  const flag = (e: React.MouseEvent, i: number) => {
    e.preventDefault();
    if (status === "won" || status === "lost" || cells[i].open) return;
    setCells(cells.map((c, j) => (j === i ? { ...c, flag: !c.flag } : c)));
  };

  const chordable = (i: number) => {
    const c = cells[i];
    if (!c.open || c.mine || !c.n) return false;
    const ring = around(i, level);
    return ring.filter((j) => cells[j].flag).length === c.n && ring.some((j) => !cells[j].open && !cells[j].flag);
  };

  const left = mines - cells.filter((c) => c.flag).length;
  const mm = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  return (
    <div className="mines">
      <div className="mines-bar">
        <Seg<Level> value={level} onChange={reset} options={(Object.keys(LEVELS) as Level[]).map((k) => ({ value: k, label: t(LEVELS[k].name) }))} />
        <span className="chip">{t("Мины")}: {left}</span>
        <span className="chip">{mm(time)}</span>
        {record > 0 && <span className="chip accent">{t("Рекорд")}: {mm(record)}</span>}
        <button className="btn sm" onClick={() => reset(level)}>{t("Заново")}</button>
      </div>
      <div className="mines-field">
        <div className={"mines-board" + (status === "won" || status === "lost" ? " over" : "")} style={{ gridTemplateColumns: `repeat(${cols}, ${size}px)`, "--c": size + "px" } as React.CSSProperties}>
          {cells.map((c, i) => (
            <button
              key={i}
              className={"mc" + (c.open ? " open" : "") + (c.flag ? " flag" : "") + (c.open && c.mine ? " mine" : "") + (status === "lost" && c.flag && !c.mine ? " wrong" : "") + (chordable(i) ? " chord" : "")}
              data-n={c.open && !c.mine ? c.n : 0}
              onClick={() => open(i)}
              onContextMenu={(e) => flag(e, i)}
            >
              {c.open && !c.mine && c.n > 0 ? c.n : ""}
            </button>
          ))}
        </div>
        {(status === "won" || status === "lost") && <div className={"mines-msg " + status}>{t(status === "won" ? "Поле разминировано" : "Вы подорвались")}</div>}
      </div>
    </div>
  );
}
