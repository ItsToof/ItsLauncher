import type { CSSProperties, ReactNode } from "react";
import type { Hit, Instance } from "./types";
import { HScroll, Icon, Pager, ProjectIcon, st } from "./ui";
import { compact, hue } from "./settings";
import { t } from "./i18n";

const hueOf = (title: string) => ({ "--h": hue(title) }) as CSSProperties;

function PackSkeleton() {
  return (
    <div className="pack-card card">
      <div className="pack-info">
        <div className="skel" style={{ height: 14, width: "70%" }} />
        <div className="skel" style={{ height: 10, width: "90%" }} />
        <div className="skel" style={{ height: 10, width: "60%" }} />
      </div>
    </div>
  );
}

function PackCard({ hit, rank, index, onPick, action }: { hit: Hit; rank?: number; index: number; onPick?: (h: Hit) => void; action?: ReactNode }) {
  const click = onPick ? { role: "button", tabIndex: 0, onClick: () => onPick(hit), onKeyDown: (e: React.KeyboardEvent) => e.key === "Enter" && onPick(hit) } : {};
  return (
    <div className={"pack-card card" + (onPick ? "" : " static")} style={{ ...st(index), ...hueOf(hit.title) }} {...click}>
      {rank !== undefined && <span className="pack-rank">#{rank}</span>}
      <div className="pack-ico"><ProjectIcon url={hit.icon_url} title={hit.title} size={64} /></div>
      <div className="pack-info">
        <div className="pack-title" title={hit.title}>{hit.title}</div>
        <div className="pack-desc">{hit.description}</div>
        <div className="pack-foot">
          <span className="chip accent"><Icon name="download" size={12} /> {compact(hit.downloads)}</span>
          {action}
        </div>
      </div>
    </div>
  );
}

export function Home({ featured, popular, page, pages, onPage, instances, busy, onInstall, onPick }: {
  featured: Hit | null | undefined;
  popular: Hit[] | null;
  page: number;
  pages: number;
  onPage: (p: number) => void;
  instances: Instance[] | null;
  busy: boolean;
  onInstall: (h: Hit) => void;
  onPick: (h: Hit) => void;
}) {
  const installed = !!featured && !!instances?.some((i) => i.sourceProject === featured.project_id || i.name.trim().toLowerCase() === featured.title.trim().toLowerCase());
  return (
    <>
      <div className="sec-head" style={{ marginTop: 0 }}><h2>{t("Наши сборки")}</h2></div>
      {featured === undefined && <div className="hs-single"><PackSkeleton /></div>}
      {featured && (
        <div className="hs-single">
          <PackCard hit={featured} index={0} action={
            <button className={"btn sm" + (installed ? "" : " primary")} style={{ marginLeft: "auto" }} disabled={busy || installed} onClick={(e) => { e.stopPropagation(); onInstall(featured); }}>
              {installed ? <><Icon name="check" size={14} /> {t("Установлено")}</> : <><Icon name="download" size={14} /> {t("Установить")}</>}
            </button>
          } />
        </div>
      )}

      <div className="sec-head">
        <h2>{t("Популярные сборки")}</h2>
      </div>
      <HScroll key={page}>
        {popular === null && [0, 1, 2, 3, 4].map((i) => <PackSkeleton key={i} />)}
        {popular?.map((h, i) => <PackCard key={h.project_id} hit={h} rank={page * 20 + i + 1} index={i} onPick={onPick} />)}
      </HScroll>
      {pages > 1 && <Pager page={page} pages={pages} onChange={onPage} />}
    </>
  );
}
