import { useEffect, useState } from "react";
import type { GameSettings, Instance, Settings } from "./types";
import { isEn, t } from "./i18n";

export const GAME_DEFAULTS: GameSettings = {
  fullscreen: false,
  width: 854,
  height: 480,
  hideLauncher: false,
  quitOnExit: false,
  journalOnLaunch: false,
  journalOnCrash: true,
  journalHideOnExit: false,
  showPlaytime: true,
  recordPlaytime: true,
  alwaysHours: false,
  minMem: 512,
  maxMem: 4096,
  jvmArgs: "",
  javaPath: "",
};

export const DEFAULTS: Settings = {
  theme: "dark",
  accent: "mono",
  motion: true,
  radius: 4,
  lang: "system",
  clientId: "",
  game: GAME_DEFAULTS,
};

export function useSettings() {
  const [s, setS] = useState<Settings>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("its.settings.v4") || "{}");
      return { ...DEFAULTS, ...saved, game: { ...GAME_DEFAULTS, ...saved.game } };
    } catch {
      return DEFAULTS;
    }
  });
  useEffect(() => localStorage.setItem("its.settings.v4", JSON.stringify(s)), [s]);
  return [s, setS] as const;
}

export function screenLimit() {
  const k = window.devicePixelRatio || 1;
  return { w: Math.round(window.screen.width * k), h: Math.round(window.screen.height * k) };
}

export function gameFor(s: Settings, inst: Instance): GameSettings {
  const o = inst.settings;
  if (!o?.override) return s.game;
  return { ...s.game, minMem: o.minMem ?? s.game.minMem, maxMem: o.maxMem ?? s.game.maxMem, jvmArgs: o.jvmArgs ?? s.game.jvmArgs };
}

export function fmtPlay(secs: number, hoursOnly: boolean) {
  if (secs < 60) return t("меньше минуты");
  if (hoursOnly) return t("{h} ч", { h: (secs / 3600).toFixed(1) });
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h ? t("{h} ч {m} мин", { h, m }) : t("{m} мин", { m });
}

export const compact = (n: number) => new Intl.NumberFormat(isEn() ? "en" : "ru", { notation: "compact" }).format(n);
export const loaderName = (l: string) => ({ vanilla: "Vanilla", fabric: "Fabric", quilt: "Quilt", forge: "Forge", neoforge: "NeoForge" })[l] ?? l;
export const hue = (str: string) => [...str].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0);
export const joinPath = (...p: string[]) => p.filter(Boolean).join("/");
export const fmtSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
export const prettyName = (f: string) =>
  f.replace(/\.disabled$/, "").replace(/\.(jar|zip)$/i, "").replace(/[_]+/g, " ").replace(/-+/g, " ").trim();
