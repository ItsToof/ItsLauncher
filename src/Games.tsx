import { useState } from "react";
import { t } from "./i18n";
import { Minesweeper } from "./Minesweeper";
import { ORES, Tetris } from "./Tetris";

const GAMES = [
  { id: "tetris", title: "Тетрис", text: "Классика: собирайте линии из падающих блоков." },
  { id: "mines", title: "Сапёр", text: "Откройте все клетки и не наступите на мину." },
];

const ART: [number, number, number][] = [[0, 3, 0], [1, 3, 0], [2, 3, 0], [3, 3, 0], [0, 2, 1], [1, 2, 1], [1, 1, 1], [2, 1, 1], [2, 2, 3], [3, 2, 3], [3, 1, 3], [3, 0, 3]];

function TetrisArt() {
  return (
    <svg viewBox="0 0 100 56" className="game-art" aria-hidden>
      {ART.map(([x, y, k], i) => <rect key={i} x={x * 14 + 22} y={y * 14 + 2} width="13" height="13" fill={ORES[k]} stroke="rgba(0,0,0,.45)" />)}
    </svg>
  );
}

const MINES_ART = ["1", "", "2", "", "", "F", "1", "", "3", "", "2", "1"];

function MinesArt() {
  return (
    <svg viewBox="0 0 100 56" className="game-art" aria-hidden>
      {MINES_ART.map((v, i) => {
        const x = (i % 4) * 16 + 18;
        const y = Math.floor(i / 4) * 16 + 4;
        return (
          <g key={i}>
            <rect x={x} y={y} width="15" height="15" rx="2" fill={v ? ORES[(i * 3) % 7] : "var(--surface2)"} opacity={v === "F" ? 1 : .9} />
            {v && v !== "F" && <text x={x + 7.5} y={y + 11.5} textAnchor="middle" fontSize="10" fontWeight="800" fill="rgba(0,0,0,.7)">{v}</text>}
            {v === "F" && <path d={`M${x + 4} ${y + 3}L${x + 12} ${y + 6.5}L${x + 6} ${y + 9}V${y + 13}H${x + 4}Z`} fill="#fff" />}
          </g>
        );
      })}
    </svg>
  );
}

export function Games() {
  const [open, setOpen] = useState<string | null>(null);
  if (open) {
    return (
      <>
        <div className="page-head">
          <h1>{t(GAMES.find((g) => g.id === open)!.title)}</h1>
          <button className="btn sm" onClick={() => setOpen(null)}>{t("Все игры")}</button>
        </div>
        {open === "tetris" ? <Tetris /> : <Minesweeper />}
      </>
    );
  }
  return (
    <>
      <div className="page-head"><h1>{t("Мини-игры")}</h1></div>
      <div className="games-grid">
        {GAMES.map((g, i) => (
          <button key={g.id} className="card game-card" style={{ "--i": i } as React.CSSProperties} onClick={() => setOpen(g.id)}>
            {g.id === "tetris" ? <TetrisArt /> : <MinesArt />}
            <div className="game-info">
              <div className="game-title">{t(g.title)}</div>
              <div className="muted small">{t(g.text)}</div>
            </div>
          </button>
        ))}
      </div>
    </>
  );
}
