/**
 * Direction D — single scrolling page.
 *
 * Layout (top → bottom):
 *   Hero band   — one-sentence system state
 *   Findings    — PENDING deals that passed all filters
 *   Watching    — want list (3 rows + expand + add)
 *   Live Agents — ANALYZING deals (only shown when active)
 *   History     — collapsed accordion
 */

import { useState, useMemo, useRef, useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader,
  Plus,
  Terminal as TerminalIcon,
  Zap,
} from "lucide-react";
import {
  api,
  type Deal,
  type WantListItem,
  type Health,
  type WatchmanStatus,
} from "../lib/api";
import { cn, fmt$$, relativeTime } from "../lib/utils";

// ─── Hero band ────────────────────────────────────────────────────────────────

function HeroBand({
  watchman,
  health,
  huntingCount,
  findingsCount,
}: {
  watchman: WatchmanStatus | undefined;
  health: Health | undefined;
  huntingCount: number;
  findingsCount: number;
}) {
  const budgetLeft = health?.budget_remaining ?? 0;

  const scanPart =
    watchman?.status === "running"
      ? `Scanning ${huntingCount} card${huntingCount !== 1 ? "s" : ""}`
      : watchman?.status === "blocked"
      ? "Scanner blocked"
      : "Scanner idle";

  const findingsPart =
    findingsCount === 0
      ? "no new findings"
      : `${findingsCount} new finding${findingsCount !== 1 ? "s" : ""}`;

  return (
    <div className="border-b px-6 py-3" style={{ borderColor: "var(--border)" }}>
      <p className="text-sm" style={{ color: "var(--muted)" }}>
        {scanPart}
        <span className="mx-2 opacity-30">·</span>
        <span style={findingsCount > 0 ? { color: "var(--gold)" } : undefined}>
          {findingsPart}
        </span>
        <span className="mx-2 opacity-30">·</span>
        {fmt$$(budgetLeft)} left today
      </p>
    </div>
  );
}

// ─── Finding row ──────────────────────────────────────────────────────────────

function FindingRow({
  deal,
  wantItem,
}: {
  deal: Deal;
  wantItem: WantListItem | undefined;
}) {
  const cardName = wantItem
    ? `${wantItem.name} ${wantItem.grade}`
    : `Deal #${deal.id}`;
  const pctBelow =
    wantItem && wantItem.max_price > 0
      ? Math.round((1 - deal.landed_cost / wantItem.max_price) * 100)
      : null;
  const score = deal.watchman_score != null ? Math.round(deal.watchman_score * 100) : null;

  return (
    <div className="flex items-start justify-between gap-4 py-5 border-b" style={{ borderColor: "var(--border)" }}>
      <div className="space-y-1 min-w-0">
        <p className="font-display text-base font-semibold truncate" style={{ color: "var(--text)" }}>
          {cardName}
        </p>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          {[
            deal.seller_username,
            deal.seller_rating != null ? `${deal.seller_rating.toFixed(1)}%` : null,
            deal.seller_feedback_count != null
              ? `${deal.seller_feedback_count.toLocaleString()} reviews`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      <div className="flex items-center gap-5 shrink-0">
        <div className="text-right">
          <p className="font-display text-xl font-bold" style={{ color: "var(--text)" }}>
            {fmt$$(deal.landed_cost)}
          </p>
          <div className="flex items-center justify-end gap-2 mt-0.5">
            {pctBelow != null && pctBelow > 0 && (
              <span className="text-xs font-medium text-green-500">{pctBelow}% below max</span>
            )}
            {score != null && (
              <span className="text-xs font-mono" style={{ color: "var(--muted)" }}>
                score {score}
              </span>
            )}
          </div>
        </div>

        <a
          href={deal.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs flex items-center gap-1 transition-colors hover:opacity-70"
          style={{ color: "var(--gold)" }}
        >
          View <ExternalLink size={10} />
        </a>
      </div>
    </div>
  );
}

// ─── Watch row ────────────────────────────────────────────────────────────────

function WatchRow({ item }: { item: WantListItem }) {
  return (
    <div className="flex items-center gap-4 py-3 border-b" style={{ borderColor: "var(--border)" }}>
      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium" style={{ color: "var(--text)" }}>
          {item.name}
        </span>
        {item.set_name && (
          <span className="ml-2 text-xs" style={{ color: "var(--muted)" }}>
            {item.set_name}
          </span>
        )}
      </div>
      <span className="text-xs shrink-0" style={{ color: "var(--muted)" }}>
        {item.grade || "—"}
      </span>
      <span className="font-mono text-sm shrink-0" style={{ color: "var(--text)" }}>
        max {fmt$$(item.max_price)}
      </span>
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full shrink-0",
          item.is_active ? "bg-green-400" : "bg-gray-600"
        )}
      />
    </div>
  );
}

// ─── Add card inline form ─────────────────────────────────────────────────────

function AddCardForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [grade, setGrade] = useState("PSA 10");
  const [maxPrice, setMaxPrice] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const price = parseFloat(maxPrice);
    if (!name.trim() || isNaN(price) || price <= 0) return;
    setLoading(true);
    setError(null);
    try {
      await api.addWantListItem({ name: name.trim(), grade: grade.trim(), max_price: price });
      setName(""); setGrade("PSA 10"); setMaxPrice(""); setOpen(false);
      onAdded();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } }; message?: string })
        ?.response?.data?.detail ?? String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 py-3 text-sm transition-colors"
        style={{ color: "var(--muted)" }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--muted)")}
      >
        <Plus size={13} />
        Add a card
      </button>
    );
  }

  return (
    <div className="py-4 space-y-3">
      <div className="flex gap-3 flex-wrap">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Card name"
          autoFocus
          className="input-base flex-1 min-w-0 py-2"
        />
        <input
          type="text"
          value={grade}
          onChange={(e) => setGrade(e.target.value)}
          placeholder="Grade"
          className="input-base py-2"
          style={{ width: 100 }}
        />
        <input
          type="number"
          value={maxPrice}
          onChange={(e) => setMaxPrice(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Max $"
          min="1"
          className="input-base py-2"
          style={{ width: 100 }}
        />
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={submit}
          disabled={loading || !name.trim() || !maxPrice}
          className="btn-primary py-2 px-4 text-xs"
        >
          {loading ? <Loader size={12} className="animate-spin" /> : "Add"}
        </button>
        <button
          onClick={() => { setOpen(false); setError(null); }}
          className="px-3 py-2 text-xs transition-colors"
          style={{ color: "var(--muted)" }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Live agent card ──────────────────────────────────────────────────────────

const LIVE_STEPS = ["Created", "Extracting", "Checkout", "Done"];

function deriveStep(logs: string[], status: string): number {
  if (status === "BOUGHT" || status === "REJECTED") return 3;
  const c = logs.join(" ").toLowerCase();
  if (c.includes("checkout") || c.includes("confirm")) return 2;
  if (c.includes("navigat") || c.includes("extract")) return 1;
  return 0;
}

function LiveAgentCard({ deal, wantItem }: { deal: Deal; wantItem: WantListItem | undefined }) {
  const [expanded, setExpanded] = useState(true);
  const [bbUrl, setBbUrl] = useState<string | null>(null);
  const termRef = useRef<HTMLDivElement>(null);
  const isAnalyzing = deal.status === "ANALYZING";

  const { data: logsData } = useQuery({
    queryKey: ["deal-logs", deal.id],
    queryFn: async () => {
      const logs = await api.dealLogs(deal.id);
      const bbLog = logs.find((l) => l.startsWith("[BB_SESSION_URL]"));
      if (bbLog) setBbUrl(bbLog.replace("[BB_SESSION_URL] ", ""));
      return logs;
    },
    enabled: isAnalyzing,
    refetchInterval: 2000,
  });

  const logs = logsData ?? [];
  const visibleLogs = logs.filter((l) => !l.startsWith("[BB_SESSION_URL]"));
  const activeStep = deriveStep(logs, deal.status);

  useEffect(() => {
    if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
  }, [visibleLogs.length]);

  const cardName = wantItem
    ? `${wantItem.name} ${wantItem.grade}`
    : deal.ebay_item_id
    ? `eBay #${deal.ebay_item_id}`
    : `Deal #${deal.id}`;

  return (
    <div className="card p-0 overflow-hidden">
      <div className="px-4 pt-4 pb-3 flex items-start justify-between gap-2">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <span className="badge bg-blue-500/10 text-blue-400 border border-blue-500/30 text-xs">
              ANALYZING
            </span>
            {isAnalyzing && <Loader size={11} className="text-blue-400 animate-spin" />}
          </div>
          <p className="font-display text-base font-semibold mt-1" style={{ color: "var(--text)" }}>
            {cardName}
          </p>
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            {fmt$$(deal.landed_cost)} landed
            {wantItem ? ` · max ${fmt$$(wantItem.max_price)}` : ""}
          </p>
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="p-1 rounded transition-opacity hover:opacity-60 shrink-0"
          style={{ color: "var(--muted)" }}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {/* Step dots */}
      <div className="px-4 py-2 flex items-center border-t border-b" style={{ borderColor: "var(--border)" }}>
        {LIVE_STEPS.map((label, i) => {
          const done = i < activeStep;
          const active = i === activeStep;
          return (
            <div key={label} className="flex items-center flex-1 last:flex-none">
              <div className="flex flex-col items-center gap-0.5">
                <div
                  className={cn(
                    "w-2 h-2 rounded-full border transition-colors",
                    done ? "bg-green-500 border-green-500" :
                    active ? "bg-blue-400 border-blue-400" :
                    "border-zinc-600"
                  )}
                />
                <span className={cn("text-xs whitespace-nowrap",
                  done ? "text-green-500" : active ? "text-blue-400" : ""
                )} style={!done && !active ? { color: "var(--muted)" } : undefined}>
                  {label}
                </span>
              </div>
              {i < LIVE_STEPS.length - 1 && (
                <div className="flex-1 h-px mx-1 mb-3" style={{ background: done ? "#22c55e" : "var(--border)" }} />
              )}
            </div>
          );
        })}
      </div>

      {expanded && (
        <div>
          {bbUrl && isAnalyzing && (
            <div>
              <div className="flex items-center gap-2 px-4 py-2 border-b" style={{ borderColor: "var(--border)" }}>
                <span className="live-dot w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
                <span className="text-xs" style={{ color: "var(--muted)" }}>Live Browser</span>
                <a href={bbUrl} target="_blank" rel="noopener noreferrer"
                  className="ml-auto flex items-center gap-1 text-xs hover:underline" style={{ color: "var(--muted)" }}>
                  Full screen <ExternalLink size={10} />
                </a>
              </div>
              <iframe src={bbUrl} className="w-full" style={{ height: 320, border: "none" }}
                sandbox="allow-same-origin allow-scripts" allow="clipboard-read; clipboard-write"
                title={`Live session deal ${deal.id}`} />
            </div>
          )}
          <div className="px-4 pb-4 pt-3">
            <div className="flex items-center gap-1.5 mb-2">
              <TerminalIcon size={11} style={{ color: "var(--muted)" }} />
              <span className="text-xs" style={{ color: "var(--muted)" }}>Agent logs</span>
              {deal.url && (
                <a href={deal.url} target="_blank" rel="noopener noreferrer"
                  className="ml-auto flex items-center gap-1 text-xs hover:underline" style={{ color: "var(--muted)" }}>
                  eBay <ExternalLink size={9} />
                </a>
              )}
            </div>
            <div className="terminal" ref={termRef} style={{ maxHeight: 140, minHeight: 60 }}>
              {visibleLogs.length === 0
                ? <span style={{ opacity: 0.4 }}>Waiting for agent…</span>
                : visibleLogs.map((line, i) => <div key={i} className="fade-up">&gt; {line}</div>)}
              {isAnalyzing && <span className="cursor-blink" />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Test a listing (collapsed) ───────────────────────────────────────────────

function TestListing({ onSuccess }: { onSuccess: () => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [maxPrice, setMaxPrice] = useState("500");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successId, setSuccessId] = useState<number | null>(null);

  async function run() {
    if (!url.trim().includes("ebay.com/itm/")) {
      setError("Paste a valid eBay listing URL"); return;
    }
    const price = parseFloat(maxPrice);
    if (!price || price <= 0) { setError("Enter a valid max price"); return; }
    setError(null); setSuccessId(null); setLoading(true);
    try {
      const r = await api.runPipeline(url.trim(), price);
      setSuccessId(r.deal_id); setUrl(""); onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-xs transition-colors"
        style={{ color: "var(--muted)" }}
      >
        <Zap size={12} />
        Test a listing
        {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
      </button>
      {open && (
        <div className="mt-3 space-y-2">
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            Paste any eBay listing URL — dry run, stops before paying.
          </p>
          <div className="flex gap-2 flex-wrap">
            <input
              className="input-base flex-1 min-w-0 py-2 text-xs"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !loading && run()}
              placeholder="https://www.ebay.com/itm/123456789"
              disabled={loading}
            />
            <input
              className="input-base py-2 text-xs"
              style={{ width: 100 }}
              type="number"
              min="1"
              value={maxPrice}
              onChange={(e) => setMaxPrice(e.target.value)}
              placeholder="Max $"
              disabled={loading}
            />
            <button className="btn-primary shrink-0 py-2 px-4 text-xs" onClick={run} disabled={loading || !url.trim()}>
              {loading ? <Loader size={12} className="animate-spin" /> : "Run"}
            </button>
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          {successId != null && (
            <p className="text-xs text-green-500">Deal #{successId} running — watch it above ↑</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── History table (collapsed) ────────────────────────────────────────────────

const HISTORY_TABS = ["ALL", "BOUGHT", "ANALYZING", "REJECTED", "PENDING"] as const;
type HistoryTab = typeof HISTORY_TABS[number];

function HistoryTable({ deals, wantMap }: { deals: Deal[]; wantMap: Map<number, WantListItem> }) {
  const [tab, setTab] = useState<HistoryTab>("ALL");

  const filtered = useMemo(() => {
    const sorted = deals.slice().reverse();
    return tab === "ALL" ? sorted : sorted.filter((d) => d.status === tab);
  }, [deals, tab]);

  function outcomeCell(deal: Deal): ReactNode {
    if (deal.status === "BOUGHT" && deal.audit_log?.verified_cert)
      return <span className="font-mono text-xs text-green-500">{deal.audit_log.verified_cert}</span>;
    if (deal.status === "REJECTED" && deal.audit_log?.agent_extraction_json) {
      try {
        const reason = JSON.parse(deal.audit_log.agent_extraction_json)._rejection_reason;
        if (reason) return <span className="text-xs text-red-400">{reason}</span>;
      } catch { /* fall through */ }
    }
    return <span style={{ color: "var(--muted)" }}>—</span>;
  }

  function dealName(d: Deal) {
    const wi = wantMap.get(d.want_list_id);
    if (wi) return `${wi.name} ${wi.grade}`;
    if (d.ebay_item_id) return `eBay #${d.ebay_item_id}`;
    return `Deal #${d.id}`;
  }

  const STATUS_COLOR: Record<string, string> = {
    BOUGHT:    "text-green-500",
    ANALYZING: "text-blue-400",
    PENDING:   "text-yellow-500",
    REJECTED:  "text-red-400",
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-1 flex-wrap">
        {HISTORY_TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "px-3 py-1 rounded-lg text-xs font-medium transition-colors border",
              tab === t ? "text-white" : "hover:opacity-70"
            )}
            style={tab === t
              ? { background: "var(--gold)", borderColor: "transparent" }
              : { background: "transparent", color: "var(--muted)", borderColor: "var(--border)" }}
          >
            {t}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm py-4" style={{ color: "var(--muted)" }}>No deals match this filter.</p>
      ) : (
        <div className="card p-0 overflow-hidden overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b" style={{ borderColor: "var(--border)" }}>
                <th className="table-th">Card</th>
                <th className="table-th">Price</th>
                <th className="table-th">Status</th>
                <th className="table-th">Outcome</th>
                <th className="table-th">When</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => (
                <tr key={d.id} className="table-row">
                  <td className="table-td">
                    <a href={d.url} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1 text-xs hover:underline max-w-[220px] truncate"
                      style={{ color: "var(--text)" }}>
                      {dealName(d)}
                      <ExternalLink size={10} className="shrink-0" style={{ color: "var(--muted)" }} />
                    </a>
                  </td>
                  <td className="table-td font-mono text-xs">{fmt$$(d.price)}</td>
                  <td className="table-td">
                    <span className={cn("text-xs font-medium", STATUS_COLOR[d.status] ?? "")}>
                      {d.status}
                    </span>
                  </td>
                  <td className="table-td">{outcomeCell(d)}</td>
                  <td className="table-td text-xs" style={{ color: "var(--muted)" }}>
                    {relativeTime(d.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Section header ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: "var(--muted)" }}>
      {children}
    </p>
  );
}

// ─── Home page ────────────────────────────────────────────────────────────────

export function Home() {
  const [showAllCards, setShowAllCards] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    refetchInterval: 5000,
    retry: false,
  });

  const { data: allDeals = [], refetch: refetchDeals } = useQuery<Deal[]>({
    queryKey: ["deals"],
    queryFn: () => api.deals(),
    refetchInterval: 5000,
  });

  const { data: wantList = [] } = useQuery<WantListItem[]>({
    queryKey: ["want-list"],
    queryFn: api.wantList,
    refetchInterval: 30_000,
    staleTime: 60_000,
  });

  const { data: watchman } = useQuery({
    queryKey: ["watchman-status"],
    queryFn: api.watchmanStatus,
    refetchInterval: 30_000,
  });

  const wantMap = useMemo(() => new Map(wantList.map((w) => [w.id, w])), [wantList]);

  const pendingDeals = allDeals.filter((d) => d.status === "PENDING");
  const analyzingDeals = allDeals.filter((d) => d.status === "ANALYZING");
  const activeCards = wantList.filter((w) => w.is_active);

  const WATCH_PREVIEW = 4;
  const visibleCards = showAllCards ? wantList : wantList.slice(0, WATCH_PREVIEW);

  return (
    <div className="min-h-screen" style={{ background: "var(--canvas)" }}>
      <HeroBand
        watchman={watchman}
        health={health}
        huntingCount={activeCards.length}
        findingsCount={pendingDeals.length}
      />

      <main className="max-w-2xl mx-auto px-6 py-10 space-y-12">

        {/* ── Findings ─────────────────────────────────────────────────────── */}
        <section>
          <SectionLabel>Findings</SectionLabel>

          {pendingDeals.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                {wantList.length === 0
                  ? "Add cards below to start hunting."
                  : `Watching ${activeCards.length} card${activeCards.length !== 1 ? "s" : ""} — findings appear here when a deal passes all filters.`}
              </p>
            </div>
          ) : (
            pendingDeals.map((deal) => (
              <FindingRow key={deal.id} deal={deal} wantItem={wantMap.get(deal.want_list_id)} />
            ))
          )}
        </section>

        {/* ── Watching for ─────────────────────────────────────────────────── */}
        <section>
          <SectionLabel>Watching For</SectionLabel>

          {wantList.length === 0 ? (
            <p className="text-sm py-3" style={{ color: "var(--muted)" }}>
              No cards yet.
            </p>
          ) : (
            <>
              {visibleCards.map((item) => (
                <WatchRow key={item.id} item={item} />
              ))}
              {wantList.length > WATCH_PREVIEW && (
                <button
                  onClick={() => setShowAllCards((v) => !v)}
                  className="flex items-center gap-1 py-3 text-xs transition-colors"
                  style={{ color: "var(--muted)" }}
                >
                  {showAllCards ? (
                    <><ChevronUp size={11} /> Show less</>
                  ) : (
                    <><ChevronDown size={11} /> {wantList.length - WATCH_PREVIEW} more cards</>
                  )}
                </button>
              )}
            </>
          )}

          <AddCardForm onAdded={() => { /* react-query refetches via queryKey */ }} />
        </section>

        {/* ── Live agents (only shown when active) ─────────────────────────── */}
        {analyzingDeals.length > 0 && (
          <section>
            <SectionLabel>Live Agents</SectionLabel>
            <div className="space-y-4">
              {analyzingDeals.map((deal) => (
                <LiveAgentCard
                  key={deal.id}
                  deal={deal}
                  wantItem={wantMap.get(deal.want_list_id)}
                />
              ))}
            </div>
          </section>
        )}

        {/* ── Tools bar ────────────────────────────────────────────────────── */}
        <section className="pt-2 border-t" style={{ borderColor: "var(--border)" }}>
          <TestListing onSuccess={() => refetchDeals()} />
        </section>

        {/* ── History (collapsed) ───────────────────────────────────────────── */}
        <section>
          <button
            onClick={() => setShowHistory((v) => !v)}
            className="flex items-center gap-1.5 text-xs transition-colors"
            style={{ color: "var(--muted)" }}
          >
            {showHistory ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            Deal history ({allDeals.length})
          </button>

          {showHistory && (
            <div className="mt-4">
              <HistoryTable deals={allDeals} wantMap={wantMap} />
            </div>
          )}
        </section>

      </main>
    </div>
  );
}
