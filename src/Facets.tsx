import { useEffect, useRef, useState } from "react";
import { Icon, Seg, useMounted } from "./ui";
import { isEn, t } from "./i18n";

export type FacetState = { inc: string[]; exc: string[]; env: "" | "client" | "server" };
export const EMPTY_FACETS: FacetState = { inc: [], exc: [], env: "" };
export type FacetKind = "modpack" | "mod" | "resourcepack" | "shader";

type Group = { ru: string; en: string; items: [string, string, string][]; exclude?: boolean };

const CATEGORY = "Категория";
const FEATURES = "Особенности";

const X = (ids: string[]): Group => {
  const all: Record<string, [string, string]> = {
    "ai-powered": ["Функциональность на ИИ", "AI-powered features"],
    "ai-generated": ["ИИ-контент", "AI-generated content"],
    ads: ["Реклама", "Advertisements"],
    "flashing-lights": ["Вспышки света", "Flashing lights"],
    "system-interaction": ["Взаимодействие с системой", "System interaction"],
    telemetry: ["Телеметрия", "Telemetry"],
    "paid-content": ["Платный контент", "Paid content"],
    archived: ["Архивированные", "Archived"],
    plugins: ["Плагины", "Plugins"],
    datapacks: ["Наборы данных", "Datapacks"],
  };
  return { ru: "Особые исключения", en: "Special exclusions", exclude: true, items: ids.map((i) => [i, all[i][0], all[i][1]] as [string, string, string]) };
};

const BASE: Record<FacetKind, Group[]> = {
  modpack: [
    {
      ru: CATEGORY, en: "Category",
      items: [["adventure", "Приключения", "Adventure"], ["challenging", "Сложные", "Challenging"], ["combat", "Бой", "Combat"], ["kitchen-sink", "Всё и сразу", "Kitchen sink"], ["lightweight", "Лёгкие", "Lightweight"], ["magic", "Магия", "Magic"], ["multiplayer", "Мультиплеер", "Multiplayer"], ["optimization", "Оптимизация", "Optimization"], ["quests", "Квесты", "Quests"], ["technology", "Технологии", "Technology"]],
    },
  ],
  mod: [
    {
      ru: CATEGORY, en: "Category",
      items: [["library", "Библиотеки", "Library"], ["worldgen", "Генерация мира", "World generation"], ["food", "Еда", "Food"], ["game-mechanics", "Игровые механики", "Game mechanics"], ["magic", "Магия", "Magic"], ["minigame", "Мини-игры", "Minigame"], ["mobs", "Мобы", "Mobs"], ["optimization", "Оптимизация", "Optimization"], ["decoration", "Оформление", "Decoration"], ["transportation", "Передвижение", "Transportation"], ["adventure", "Приключения", "Adventure"], ["equipment", "Снаряжение", "Equipment"], ["social", "Социальные", "Social"], ["cursed", "Странные", "Cursed"], ["technology", "Технологии", "Technology"], ["management", "Управление", "Management"], ["utility", "Утилиты", "Utility"], ["storage", "Хранение", "Storage"], ["economy", "Экономика", "Economy"]],
    },
  ],
  resourcepack: [
    {
      ru: CATEGORY, en: "Category",
      items: [["combat", "Бой", "Combat"], ["vanilla-like", "Ванильный вид", "Vanilla-like"], ["modded", "Модовые", "Modded"], ["decoration", "Оформление", "Decoration"], ["simplistic", "Простые", "Simplistic"], ["realistic", "Реализм", "Realistic"], ["cursed", "Странные", "Cursed"], ["themed", "Тематические", "Themed"], ["tweaks", "Улучшения", "Tweaks"], ["utility", "Утилиты", "Utility"]],
    },
    {
      ru: FEATURES, en: "Features",
      items: [["blocks", "Блоки", "Blocks"], ["audio", "Звуки", "Audio"], ["gui", "Интерфейс", "GUI"], ["models", "Модели", "Models"], ["environment", "Окружение", "Environment"], ["items", "Предметы", "Items"], ["equipment", "Снаряжение", "Equipment"], ["entities", "Сущности", "Entities"], ["core-shaders", "Шейдеры", "Core shaders"], ["fonts", "Шрифты", "Fonts"], ["locale", "Языки", "Locale"]],
    },
    {
      ru: "Разрешение", en: "Resolution",
      items: ["8x-", "16x", "32x", "48x", "64x", "128x", "256x", "512x+"].map((r) => [r, r, r] as [string, string, string]),
    },
  ],
  shader: [
    {
      ru: CATEGORY, en: "Category",
      items: [["vanilla-like", "Ванильный вид", "Vanilla-like"], ["cartoon", "Мультяшные", "Cartoon"], ["semi-realistic", "Полуреализм", "Semi-realistic"], ["realistic", "Реализм", "Realistic"], ["cursed", "Странные", "Cursed"], ["fantasy", "Фэнтези", "Fantasy"]],
    },
    {
      ru: FEATURES, en: "Features",
      items: [["atmosphere", "Атмосфера", "Atmosphere"], ["reflections", "Отражения", "Reflections"], ["pbr", "Поддержка PBR", "PBR support"], ["foliage", "Растительность", "Foliage"], ["bloom", "Свечение", "Bloom"], ["shadows", "Тени", "Shadows"], ["path-tracing", "Трассировка пути", "Path tracing"], ["colored-lighting", "Цветное освещение", "Colored lighting"]],
    },
    {
      ru: "Требования", en: "Requirements",
      items: [["potato", "Калькулятор", "Potato"], ["low", "Низкие", "Low"], ["medium", "Средние", "Medium"], ["high", "Высокие", "High"], ["screenshot", "Суперкомпьютер", "Screenshot"]],
    },
    {
      ru: "Загрузчик", en: "Loader",
      items: [["iris", "Iris", "Iris"], ["optifine", "OptiFine", "OptiFine"], ["vanilla", "Ванильный шейдер", "Vanilla shader"]],
    },
  ],
};

const GROUPS: Record<FacetKind, Group[]> = {
  modpack: [...BASE.modpack, X(["ai-powered", "ai-generated", "ads", "flashing-lights", "system-interaction", "telemetry", "paid-content", "archived"])],
  mod: [...BASE.mod, X(["ai-powered", "ai-generated", "ads", "flashing-lights", "system-interaction", "telemetry", "paid-content", "archived", "plugins", "datapacks"])],
  resourcepack: [...BASE.resourcepack, X(["ai-generated", "ai-powered", "ads", "flashing-lights", "paid-content", "archived"])],
  shader: [...BASE.shader, X(["ai-generated", "ai-powered", "ads", "flashing-lights", "paid-content", "archived"])],
};

export function Facets({ kind, value, onChange }: { kind: FacetKind; value: FacetState; onChange: (v: FacetState) => void }) {
  const [open, setOpen] = useState(false);
  const [mounted, closing] = useMounted(open, 160);
  const [folded, setFolded] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [open]);

  const cycle = (c: string) => {
    if (value.inc.includes(c)) onChange({ ...value, inc: value.inc.filter((x) => x !== c), exc: [...value.exc, c] });
    else if (value.exc.includes(c)) onChange({ ...value, exc: value.exc.filter((x) => x !== c) });
    else onChange({ ...value, inc: [...value.inc, c] });
  };
  const exclude = (c: string) =>
    onChange({ ...value, inc: value.inc.filter((x) => x !== c), exc: value.exc.includes(c) ? value.exc.filter((x) => x !== c) : [...value.exc, c] });
  const count = value.inc.length + value.exc.length + (value.env ? 1 : 0);
  const flip = (g: string) => setFolded((f) => (f.includes(g) ? f.filter((x) => x !== g) : [...f, g]));

  return (
    <div className="facets" ref={ref}>
      <button className={"btn sm" + (count ? " lock on" : "")} onClick={() => setOpen(!open)}>
        <Icon name="filter" size={14} /> {t("Фильтры")}{count > 0 && <span className="badge">{count}</span>}
      </button>
      {mounted && (
        <div className={"facet-pop" + (closing ? " closing" : "")}>
          {kind === "mod" && (
            <div className="facet-group">
              <div className="facet-head static">{t("Среда")}</div>
              <Seg<"" | "client" | "server"> value={value.env} onChange={(env) => onChange({ ...value, env })} options={[{ value: "", label: t("Любая") }, { value: "client", label: t("Клиент") }, { value: "server", label: t("Сервер") }]} />
            </div>
          )}
          {GROUPS[kind].map((g) => {
            const isFolded = folded.includes(g.ru);
            return (
              <div key={g.ru} className={"facet-group" + (isFolded ? " folded" : "")}>
                <button className="facet-head" aria-expanded={!isFolded} onClick={() => flip(g.ru)}>
                  {isEn() ? g.en : g.ru}
                  <Icon name="chevron" size={16} />
                </button>
                <div className="facet-collapse">
                  <div className="facet-items">
                    {g.items.map(([id, ru, en]) => {
                      const state = value.inc.includes(id) ? "inc" : value.exc.includes(id) ? "exc" : "";
                      return (
                        <button key={id} className={"facet-item " + state} onClick={() => (g.exclude ? exclude(id) : cycle(id))}>
                          <span className="facet-box">{state === "inc" && <Icon name="check" size={11} />}{state === "exc" && <Icon name="x" size={11} />}</span>
                          {isEn() ? en : ru}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="muted small">{t("Нажми ещё раз, чтобы исключить")}</span>
            <button className="btn sm ghost" disabled={!count} onClick={() => onChange(EMPTY_FACETS)}>{t("Сбросить")}</button>
          </div>
        </div>
      )}
    </div>
  );
}
