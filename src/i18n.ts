import type { Lang } from "./types";

const EN: Record<string, string> = {};
export function registerEn(dict: Record<string, string>) {
  Object.assign(EN, dict);
}

let current: "ru" | "en" = "ru";
export function setLang(l: Lang) {
  current = l === "system" ? (/^(ru|uk|be|kk)/.test(navigator.language.toLowerCase()) ? "ru" : "en") : l;
  document.documentElement.lang = current;
}
export const isEn = () => current === "en";
export function t(s: string, vars?: Record<string, string | number>) {
  let r = current === "en" ? (EN[s] ?? s) : s;
  if (vars) for (const k in vars) r = r.split(`{${k}}`).join(String(vars[k]));
  return r;
}
