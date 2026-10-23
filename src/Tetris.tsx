import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "./i18n";

const COLS = 10;
const ROWS = 20;
const POINTS = [0, 100, 300, 500, 800];
export const ORES = ["#4fd8d0", "#e8b73c", "#9a5fd6", "#3fc46a", "#d6453d", "#3f63d6", "#d9803d"];
const SHAPES: number[][][] = [
  [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
  [[1, 1], [1, 1]],
  [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
  [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
  [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
  [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
  [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
];

type Status = "idle" | "play" | "pause" | "over";
type Piece = { k: number; m: number[][]; x: number; y: number };
type Game = { board: number[][]; piece: Piece; next: number; bag: number[]; score: number; lines: number; level: number; acc: number; status: Status; drop: { y: number; to: number; v: number } | null; clear: { rows: number[]; t: number } | null };

const emptyBoard = () => Array.from({ length: ROWS }, () => Array<number>(COLS).fill(0));
const turned = (m: number[][], dir: 1 | -1) => (dir === 1 ? m[0].map((_, x) => m.map((r) => r[x]).reverse()) : m[0].map((_, x) => m.map((r) => r[r.length - 1 - x])));
const fits = (board: number[][], m: number[][], x: number, y: number) =>
  m.every((row, r) => row.every((v, c) => !v || (x + c >= 0 && x + c < COLS && y + r < ROWS && (y + r < 0 || !board[y + r][x + c]))));

function take(s: Game) {
  if (!s.bag.length) {
    s.bag = [0, 1, 2, 3, 4, 5, 6];
    for (let i = 6; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [s.bag[i], s.bag[j]] = [s.bag[j], s.bag[i]];
    }
  }
  return s.bag.pop()!;
}

const spawn = (k: number): Piece => ({ k, m: SHAPES[k], x: Math.floor((COLS - SHAPES[k][0].length) / 2), y: k === 0 ? -1 : 0 });

function fresh(): Game {
  const s = { board: emptyBoard(), bag: [], score: 0, lines: 0, level: 1, acc: 0, status: "idle", drop: null, clear: null } as unknown as Game;
  s.piece = spawn(take(s));
  s.next = take(s);
  return s;
}

const CLEAR_MS = 320;

function advance(s: Game) {
  s.piece = spawn(s.next);
  s.next = take(s);
  if (!fits(s.board, s.piece.m, s.piece.x, s.piece.y)) s.status = "over";
}

function collapse(s: Game) {
  const keep = s.board.filter((row) => row.some((v) => !v));
  const n = ROWS - keep.length;
  s.board = [...Array.from({ length: n }, () => Array<number>(COLS).fill(0)), ...keep];
  s.lines += n;
  s.score += POINTS[n] * s.level;
  s.level = Math.floor(s.lines / 10) + 1;
  s.clear = null;
  advance(s);
}

function settle(s: Game) {
  const { m, x, y, k } = s.piece;
  m.forEach((row, r) => row.forEach((v, c) => { if (v && y + r >= 0) s.board[y + r][x + c] = k + 1; }));
  const rows = s.board.flatMap((row, i) => (row.every(Boolean) ? [i] : []));
  if (rows.length) s.clear = { rows, t: 0 };
  else advance(s);
}

function fall(s: Game, manual = false) {
  if (fits(s.board, s.piece.m, s.piece.x, s.piece.y + 1)) {
    s.piece.y++;
    if (manual) s.score++;
  } else settle(s);
}

function slam(s: Game) {
  let to = s.piece.y;
  while (fits(s.board, s.piece.m, s.piece.x, to + 1)) to++;
  if (to === s.piece.y) settle(s);
  else s.drop = { y: s.piece.y, to, v: 6 };
}

function land(s: Game, dt: number) {
  const d = s.drop!;
  d.v += dt * 0.12;
  d.y = Math.min(d.to, d.y + (d.v * dt) / 1000 * 4);
  if (d.y < d.to) return;
  s.score += (d.to - s.piece.y) * 2;
  s.piece.y = d.to;
  s.drop = null;
  settle(s);
}

function turn(s: Game, dir: 1 | -1) {
  const m = turned(s.piece.m, dir);
  for (const dx of [0, -1, 1, -2, 2]) {
    if (fits(s.board, m, s.piece.x + dx, s.piece.y)) { s.piece = { ...s.piece, m, x: s.piece.x + dx }; return; }
  }
}

function shift(s: Game, dx: number) {
  if (fits(s.board, s.piece.m, s.piece.x + dx, s.piece.y)) s.piece.x += dx;
}

function block(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(x + .5, y + .5, s - 1, s - 1);
}

function prepare(canvas: HTMLCanvasElement, w: number, h: number) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

const readBest = () => {
  try { return Number(localStorage.getItem("its.tetris.best")) || 0; } catch { return 0; }
};

const sizeFor = () => Math.max(18, Math.min(32, Math.floor((window.innerHeight - 250) / ROWS)));

export function Tetris() {
  const boardRef = useRef<HTMLCanvasElement>(null);
  const nextRef = useRef<HTMLCanvasElement>(null);
  const g = useRef<Game>(fresh());
  const [cell, setCell] = useState(sizeFor);
  const [ui, setUi] = useState({ status: "idle" as Status, score: 0, lines: 0, level: 1, best: readBest() });

  const sync = useCallback(() => {
    const s = g.current;
    setUi((u) => {
      const best = Math.max(u.best, s.score);
      if (best !== u.best) { try { localStorage.setItem("its.tetris.best", String(best)); } catch {} }
      return { status: s.status, score: s.score, lines: s.lines, level: s.level, best };
    });
  }, []);

  const start = useCallback(() => {
    g.current = fresh();
    g.current.status = "play";
    sync();
  }, [sync]);

  const toggle = useCallback(() => {
    const s = g.current;
    if (s.status === "play") s.status = "pause";
    else if (s.status === "pause") s.status = "play";
    else return;
    sync();
  }, [sync]);

  useEffect(() => {
    const onResize = () => setCell(sizeFor());
    const onBlur = () => { if (g.current.status === "play") toggle(); };
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", onBlur);
    return () => { window.removeEventListener("resize", onResize); window.removeEventListener("blur", onBlur); };
  }, [toggle]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      const s = g.current;
      const key = e.code;
      if (key === "KeyP" || key === "Escape") { toggle(); return; }
      if (s.drop || s.clear) { if (key === "Space") e.preventDefault(); return; }
      if (s.status !== "play") {
        if (key === "Space" || key === "Enter") { e.preventDefault(); if (s.status === "pause") toggle(); else start(); }
        return;
      }
      if (key === "KeyA" || key === "ArrowLeft") shift(s, -1);
      else if (key === "KeyD" || key === "ArrowRight") shift(s, 1);
      else if (key === "KeyS" || key === "ArrowDown") fall(s, true);
      else if (key === "KeyW" || key === "ArrowUp" || key === "KeyE") turn(s, 1);
      else if (key === "KeyQ" || key === "KeyZ") turn(s, -1);
      else if (key === "Space") slam(s);
      else return;
      e.preventDefault();
      sync();
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, [start, sync, toggle]);

  useEffect(() => {
    const board = boardRef.current!;
    const next = nextRef.current!;
    const ctx = prepare(board, COLS * cell, ROWS * cell);
    const nctx = prepare(next, 4 * 22, 3 * 22);
    let last = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const s = g.current;
      const dt = now - last;
      last = now;
      if (s.status === "play" && s.clear) {
        s.clear.t += dt;
        if (s.clear.t >= CLEAR_MS) {
          collapse(s);
          sync();
        }
      } else if (s.status === "play" && s.drop) {
        land(s, dt);
        if (!s.drop) sync();
      } else if (s.status === "play") {
        s.acc += dt;
        const step = Math.max(90, 820 - (s.level - 1) * 72);
        let moved = false;
        while (s.acc >= step && s.status === "play") { s.acc -= step; fall(s); moved = true; }
        if (moved) sync();
      }
      ctx.clearRect(0, 0, COLS * cell, ROWS * cell);
      const prog = s.clear ? Math.min(1, s.clear.t / CLEAR_MS) : 0;
      s.board.forEach((row, r) => {
        const dying = !!s.clear && s.clear.rows.includes(r);
        row.forEach((v, c) => {
          if (!v) return;
          if (!dying) return block(ctx, c * cell, r * cell, cell, ORES[v - 1]);
          if (prog < .35) return block(ctx, c * cell, r * cell, cell, prog * 20 % 2 < 1 ? "#ffffff" : ORES[v - 1]);
          const z = cell * (1 - (prog - .35) / .65);
          block(ctx, c * cell + (cell - z) / 2, r * cell + (cell - z) / 2, z, ORES[v - 1]);
        });
      });
      if (s.status !== "over" && !s.clear) {
        const p = s.piece;
        let gy = p.y;
        while (fits(s.board, p.m, p.x, gy + 1)) gy++;
        ctx.globalAlpha = .2;
        p.m.forEach((row, r) => row.forEach((v, c) => { if (v && gy + r >= 0) block(ctx, (p.x + c) * cell, (gy + r) * cell, cell, ORES[p.k]); }));
        ctx.globalAlpha = 1;
        const py = s.drop ? s.drop.y : p.y;
        p.m.forEach((row, r) => row.forEach((v, c) => { if (v && py + r > -1) block(ctx, (p.x + c) * cell, (py + r) * cell, cell, ORES[p.k]); }));
      }
      nctx.clearRect(0, 0, 4 * 22, 3 * 22);
      const nm = SHAPES[s.next].filter((row) => row.some(Boolean));
      const ox = (4 * 22 - nm[0].length * 22) / 2;
      const oy = (3 * 22 - nm.length * 22) / 2;
      nm.forEach((row, r) => row.forEach((v, c) => { if (v) block(nctx, ox + c * 22, oy + r * 22, 22, ORES[s.next]); }));
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [cell, sync]);

  const label = ui.status === "pause" ? "Продолжить" : ui.status === "over" ? "Заново" : "Играть";
  const title = ui.status === "pause" ? "Пауза" : ui.status === "over" ? "Игра окончена" : "Тетрис";

  return (
    <div className="tetris">
      <div className="tetris-board" style={{ width: COLS * cell, height: ROWS * cell }}>
        <canvas ref={boardRef} />
        {ui.status !== "play" && (
          <div className="tetris-veil">
            <h2>{t(title)}</h2>
            {ui.status === "over" && <div className="muted">{t("Счёт")}: {ui.score}</div>}
            <button className="btn primary" onClick={ui.status === "pause" ? toggle : start}>{t(label)}</button>
          </div>
        )}
      </div>
      <div className="tetris-side">
        <div className="card stats">
          <div><span>{t("Счёт")}</span><b>{ui.score}</b></div>
          <div><span>{t("Линии")}</span><b>{ui.lines}</b></div>
          <div><span>{t("Уровень")}</span><b>{ui.level}</b></div>
          <div><span>{t("Рекорд")}</span><b>{ui.best}</b></div>
        </div>
        <div className="card"><div className="muted small">{t("Дальше")}</div><canvas ref={nextRef} /></div>
        <div className="card keys">
          <div><kbd>A</kbd><kbd>D</kbd><span>{t("двигать")}</span></div>
          <div><kbd>W</kbd><kbd>Q</kbd><span>{t("повернуть")}</span></div>
          <div><kbd>S</kbd><span>{t("ускорить")}</span></div>
          <div><kbd>Пробел</kbd><span>{t("сбросить")}</span></div>
          <div><kbd>P</kbd><span>{t("пауза")}</span></div>
        </div>
        {(ui.status === "play" || ui.status === "pause") && (
          <div className="row">
            <button className="btn grow" onClick={toggle}>{t(ui.status === "play" ? "Пауза" : "Продолжить")}</button>
            <button className="btn ghost" onClick={start}>{t("Заново")}</button>
          </div>
        )}
      </div>
    </div>
  );
}
