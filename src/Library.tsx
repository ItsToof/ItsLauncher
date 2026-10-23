import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties } from "react";
import type { Instance, PackUpdate, Settings } from "./types";
import { Icon, InstanceIcon, Modal, st, useMounted } from "./ui";
import { fmtPlay, hue, loaderName } from "./settings";
import { t } from "./i18n";

export function Library({ instances, settings, running, busyId, busy, updates, onPlay, onStop, onManage, onExport, onDelete, onCreate, onUpdate }: {
  instances: Instance[] | null;
  settings: Settings;
  running: string[];
  busyId: string | null;
  busy: boolean;
  updates: Record<string, PackUpdate>;
  onPlay: (i: Instance) => void;
  onStop: (i: Instance) => void;
  onManage: (i: Instance) => void;
  onExport: (i: Instance) => void;
  onDelete: (i: Instance) => void;
  onCreate: () => void;
  onUpdate: (i: Instance) => void;
}) {
  const [del, setDel] = useState<Instance | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; inst: Instance } | null>(null);
  const [ctxOpen, setCtxOpen] = useState(false);
  const [ctxMounted, ctxClosing] = useMounted(ctxOpen, 150);
  const openCtx = (x: number, y: number, inst: Instance) => { setCtx({ x, y, inst }); setCtxOpen(true); };
  useEffect(() => {
    if (!ctxOpen) return;
    const close = () => setCtxOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
      window.removeEventListener("blur", close);
    };
  }, [ctxOpen]);
  return (
    <>
      <div className="page-head">
        <h1>{t("Библиотека")}</h1>
        <button className="btn primary" onClick={onCreate}><Icon name="plus" /> {t("Новый экземпляр")}</button>
      </div>

      {instances === null && (
        <div className="compact-grid">
          {[0, 1, 2, 3].map((i) => <div key={i} className="card inst"><div className="skel" style={{ width: 46, height: 46, borderRadius: 14 }} /><div className="skel grow" style={{ height: 14 }} /></div>)}
        </div>
      )}

      {instances?.length === 0 && (
        <div className="empty">
          <h2>{t("Здесь пока пусто")}</h2>
          <div className="row center" style={{ marginTop: 18 }}>
            <button className="btn primary" onClick={onCreate}><Icon name="plus" /> {t("Новый экземпляр")}</button>
          </div>
        </div>
      )}

      <div className="compact-grid">
        {instances?.map((inst, i) => {
          const isRunning = running.includes(inst.id);
          const upd = updates[inst.id];
          return (
            <div key={inst.id} className="card inst clickable" style={{ ...st(i), "--h": hue(inst.name) } as CSSProperties} onClick={() => onManage(inst)} onContextMenu={(e) => { e.preventDefault(); openCtx(e.clientX, e.clientY, inst); }}>
              <InstanceIcon inst={inst} size={40} />
              <div className="inst-info grow">
                <div className="inst-name" title={inst.name}>{inst.name}</div>
                <div className="chips">
                  <span className="chip">{inst.mcVersion}</span>
                  <span className={"chip " + (inst.loader !== "vanilla" ? "accent" : "")}>{loaderName(inst.loader)}</span>
                  {settings.game.showPlaytime && inst.played > 0 && <span className="chip"><Icon name="clock" size={11} /> {fmtPlay(inst.played, settings.game.alwaysHours)}</span>}
                </div>
              </div>
              {upd && !isRunning && (
                <button className="icon-btn sm upd" title={t("Обновить сборку") + ": " + upd.versionName} disabled={busy} onClick={(e) => { e.stopPropagation(); onUpdate(inst); }}>
                  <Icon name="download" size={15} />
                </button>
              )}
              {isRunning ? (
                <button className="btn sm stop" title={t("Остановить экземпляр")} onClick={(e) => { e.stopPropagation(); onStop(inst); }}>
                  <Icon name="square" size={13} /> {t("Остановить")}
                </button>
              ) : (
                <button className="btn primary sm play" disabled={busy} onClick={(e) => { e.stopPropagation(); onPlay(inst); }}>
                  {busyId === inst.id ? <span className="spinner sm dark" /> : <Icon name="play" size={15} />} {t("Играть")}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {ctx && ctxMounted && createPortal(
        <div className={"ctx" + (ctxClosing ? " closing" : "")} style={{ left: Math.max(4, Math.min(ctx.x, window.innerWidth - 210)), top: Math.max(4, Math.min(ctx.y, window.innerHeight - 110)) }} onMouseDown={(e) => e.stopPropagation()}>
          <button onClick={() => { onExport(ctx.inst); setCtxOpen(false); }}><Icon name="archive" size={15} /> {t("Экспорт")}</button>
          <button className="danger" onClick={() => { setDel(ctx.inst); setCtxOpen(false); }}><Icon name="trash" size={15} /> {t("Удалить")}</button>
        </div>,
        document.body
      )}

      {del && (
        <Modal title={t("Удалить экземпляр?")} onClose={() => setDel(null)}>
          <p className="muted">{t("«{n}» будет удалён вместе с мирами и модами. Это действие нельзя отменить.", { n: del.name })}</p>
          <div className="row end">
            <button className="btn ghost" onClick={() => setDel(null)}>{t("Отмена")}</button>
            <button className="btn danger-solid" onClick={() => { onDelete(del); setDel(null); }}>{t("Удалить")}</button>
          </div>
        </Modal>
      )}
    </>
  );
}
