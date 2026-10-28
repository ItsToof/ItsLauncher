import type { GameSettings } from "./types";
import { Range, Switch } from "./ui";
import { screenLimit } from "./settings";
import { t } from "./i18n";

type Props = { value: GameSettings; onChange: (p: Partial<GameSettings>) => void };

export function MemoryForm({ value, onChange }: Props) {
  const mem = (k: "minMem" | "maxMem") => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ [k]: Math.max(512, Number(e.target.value) || 512) });
  return (
    <section className="card section">
      <h3>{t("Память и аргументы Java")}</h3>
      <div className="mem-grid">
        <label className="field">
          {t("Минимум памяти (МБ)")}
          <input type="number" min={512} step={256} value={value.minMem} onChange={mem("minMem")} />
        </label>
        <label className="field">
          {t("Максимум памяти (МБ)")}
          <input type="number" min={512} step={256} value={value.maxMem} onChange={mem("maxMem")} />
        </label>
      </div>
      <Range min={512} max={16384} step={256} value={Math.max(512, value.maxMem)} onChange={(v) => onChange({ maxMem: v })} />
      <label className="field" style={{ marginTop: 14 }}>
        {t("Аргументы JVM")}
        <textarea rows={3} value={value.jvmArgs} onChange={(e) => onChange({ jvmArgs: e.target.value })} placeholder="-Dkey=value" spellCheck={false} />
      </label>
    </section>
  );
}

export function GameForm({ value, onChange }: Props) {
  const lim = screenLimit();
  const size = (k: "width" | "height") => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ [k]: Math.min(k === "width" ? lim.w : lim.h, Math.max(0, Number(e.target.value) || 0)) });
  return (
    <>
      <section className="card section">
        <h3>{t("Окно игры")}</h3>
        <Switch checked={value.fullscreen} onChange={(v) => onChange({ fullscreen: v })} label={t("Запускать Minecraft в полноэкранном режиме")} />
        <div className="size-row">
          <span>{t("Размер окна")}</span>
          <input type="number" min={320} max={lim.w} value={value.width} disabled={value.fullscreen} onChange={size("width")} />
          <span>×</span>
          <input type="number" min={240} max={lim.h} value={value.height} disabled={value.fullscreen} onChange={size("height")} />
          <span className="muted">{t("пикселей")}</span>
        </div>
        <Switch checked={value.hideLauncher} onChange={(v) => onChange({ hideLauncher: v })} label={t("Прятать лаунчер, когда запускается игра")} />
        <Switch checked={value.quitOnExit} onChange={(v) => onChange({ quitOnExit: v })} label={t("Завершать работу лаунчера при закрытии игры")} />
      </section>

      <section className="card section">
        <h3>{t("Журнал игры")}</h3>
        <Switch checked={value.journalOnLaunch} onChange={(v) => onChange({ journalOnLaunch: v })} label={t("Открывать журнал при запуске игры")} />
        <Switch checked={value.journalOnCrash} onChange={(v) => onChange({ journalOnCrash: v })} label={t("Открывать журнал при сбое игры")} />
        <Switch checked={value.journalHideOnExit} onChange={(v) => onChange({ journalHideOnExit: v })} label={t("Закрывать журнал после нормального завершения игры")} />
      </section>

      <MemoryForm value={value} onChange={onChange} />
    </>
  );
}
