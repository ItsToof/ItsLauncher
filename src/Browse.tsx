import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Hit, ToastFn, VersionEntry } from "./types";
import { EMPTY_FACETS, Facets } from "./Facets";
import { Icon, Pager, ProjectIcon, Seg, Select, st } from "./ui";
import { compact, loaderName } from "./settings";
import { t } from "./i18n";

const PAGE = 20;

export function Browse({ toast, busy, versions, onPick }: { toast: ToastFn; busy: boolean; versions: VersionEntry[]; onPick: (h: Hit) => void }) {
  const [q, setQ] = useState("");
  const [loader, setLoader] = useState("");
  const [mc, setMc] = useState("");
  const [facets, setFacets] = useState(EMPTY_FACETS);
  const [hits, setHits] = useState<Hit[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const top = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (offset: number) => {
      setLoading(true);
      setHits([]);
      try {
        const r = await invoke<{ hits: Hit[]; total_hits: number }>("modrinth_search", {
          kind: "modpack", query: q, offset, mcVersion: mc || null, loader: loader || null, sort: q ? "relevance" : "downloads",
          categories: facets.inc, exclude: facets.exc, environment: null,
        });
        setHits(r.hits);
        setPage(Math.floor(offset / PAGE));
        setTotal(r.total_hits);
      } catch (e) {
        toast(String(e), "err");
      }
      setLoading(false);
    },
    [q, mc, loader, facets, toast]
  );
  useEffect(() => {
    const id = setTimeout(() => load(0), q ? 350 : 0);
    return () => clearTimeout(id);
  }, [load, q]);

  const mcOptions = [{ value: "", label: t("Любая версия") }, ...versions.filter((v) => v.type === "release").map((v) => ({ value: v.id, label: v.id }))];
  const pager = total > PAGE && (
    <Pager
      page={page}
      pages={Math.min(Math.ceil(total / PAGE), 500)}
      onChange={(p) => {
        top.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        load(p * PAGE);
      }}
    />
  );
  return (
    <>
      <div ref={top} className="search big-search">
        <Icon name="search" />
        <input placeholder={t("Найти сборку на Modrinth…")} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="filters">
        <div className="filter-mc"><Select value={mc} onChange={setMc} searchable options={mcOptions} /></div>
        <Seg value={loader} onChange={setLoader} options={[{ value: "", label: t("Все") }, ...["fabric", "forge", "neoforge", "quilt"].map((l) => ({ value: l, label: loaderName(l) }))]} />
        <Facets kind="modpack" value={facets} onChange={setFacets} />
      </div>
      <div style={{ marginTop: 12 }}>{pager}</div>
      <div className="list">
        {hits.map((h, i) => (
          <div key={h.project_id} className="card hit" style={st(i % 20)}>
            <ProjectIcon url={h.icon_url} title={h.title} size={60} />
            <div className="hit-body">
              <div className="hit-title">{h.title} <span className="muted small">{t("от {a}", { a: h.author })}</span></div>
              <div className="hit-desc">{h.description}</div>
              <div className="chips">
                <span className="chip"><Icon name="download" size={12} /> {compact(h.downloads)}</span>
                {h.categories.filter((c) => ["fabric", "forge", "neoforge", "quilt"].includes(c)).map((c) => <span key={c} className="chip accent">{loaderName(c)}</span>)}
              </div>
            </div>
            <button className="mini-btn link" title={t("Открыть на Modrinth")} onClick={() => invoke("open_url", { url: `https://modrinth.com/modpack/${h.slug || h.project_id}` }).catch(() => {})}><Icon name="external" size={15} /></button>
            <button className="btn primary" disabled={busy} onClick={() => onPick(h)}><Icon name="download" size={16} /> {t("Установить")}</button>
          </div>
        ))}
        {loading && [0, 1, 2, 3].map((i) => (
          <div key={"s" + i} className="card hit">
            <div className="skel" style={{ width: 60, height: 60, borderRadius: 16 }} />
            <div className="hit-body"><div className="skel" style={{ height: 16, width: "40%" }} /><div className="skel" style={{ height: 12, width: "80%" }} /></div>
          </div>
        ))}
      </div>
      {pager}
      {!loading && hits.length === 0 && <div className="empty small">{t("Ничего не найдено")}</div>}
    </>
  );
}
