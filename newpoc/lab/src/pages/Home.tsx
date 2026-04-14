import { useState, useMemo, useRef, useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  WifiOff,
  Sun,
  Moon,
  CheckCircle,
  Loader,
  ExternalLink,
  Terminal as TerminalIcon,
  FlaskConical,
  ChevronDown,
  ChevronUp,
  Activity,
  Zap,
} from "lucide-react";
import {
  api,
  type Deal,
  type ScraperStats,
  type ScraperSample,
  type WantListItem,
  type Health,
} from "../lib/api";
import { cn, fmt$$, relativeTime } from "../lib/utils";

// ─── Dark mode hook ───────────────────────────────────────────────────────────

function useDarkMode() {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark")
  );
  function toggle() {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("ch-theme", next ? "dark" : "light");
    setDark(next);
  }
  return { dark, toggle };
}

// ─── Stat sub-component ───────────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs mb-0.5" style={{ color: "var(--muted)" }}>{label}</p>
      <p className="text-sm font-semibold font-mono" style={{ color: "var(--text)" }}>{value}</p>
    </div>
  );
}

// ─── StatusBadge sub-component ────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    BOUGHT:    "bg-green-500/10 text-green-500 border-green-500/30",
    ANALYZING: "bg-blue-500/10  text-blue-400  border-blue-500/30",
    PENDING:   "bg-yellow-500/10 text-yellow-500 border-yellow-500/30",
    REJECTED:  "bg-red-500/10   text-red-400   border-red-500/30",
  };
  return (
    <span className={cn("badge border", map[status] ?? "bg-zinc-500/10 text-zinc-500 border-zinc-500/30")}>
      {status}
    </span>
  );
}

// ─── BudgetBar component ──────────────────────────────────────────────────────

function BudgetBar({ health }: { health: Health | undefined }) {
  if (!health) return null;

  const pct =
    health.daily_spend_limit > 0
      ? (health.daily_spend_today / health.daily_spend_limit) * 100
      : 0;

  const fillColor =
    pct < 60
      ? "bg-green-500"
      : pct < 85
      ? "bg-amber-500"
      : "bg-red-500";

  return (
    <div className="hidden sm:flex items-center gap-2">
      <div
        className="relative rounded-full overflow-hidden"
        style={{ width: 96, height: 6, background: "var(--border)" }}
      >
        <div
          className={cn("absolute inset-y-0 left-0 rounded-full transition-all", fillColor)}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <span className="text-xs" style={{ color: "var(--muted)" }}>
        Budget · {fmt$$(health.budget_remaining)} left
      </span>
    </div>
  );
}

// ─── DealLiveCard component ───────────────────────────────────────────────────

const LIVE_STEPS = ["Created", "Extracting", "Checkout", "Done"];

function deriveActiveStep(logs: string[], status: string): number {
  if (status === "BOUGHT" || status === "REJECTED") return 3;
  const combined = logs.join(" ").toLowerCase();
  if (combined.includes("checkout") || combined.includes("confirm")) return 2;
  if (combined.includes("navigat") || combined.includes("extract")) return 1;
  return 0;
}

function DealLiveCard({
  deal,
  wantItem,
}: {
  deal: Deal;
  wantItem: WantListItem | undefined;
}) {
  const [expanded, setExpanded] = useState(true);
  const [bbSessionUrl, setBbSessionUrl] = useState<string | null>(null);
  const terminalRef = useRef<HTMLDivElement>(null);

  const isAnalyzing = deal.status === "ANALYZING";

  const { data: logsData } = useQuery({
    queryKey: ["deal-logs", deal.id],
    queryFn: async () => {
      const fetched = await api.dealLogs(deal.id);
      const bbLog = fetched.find((l) => l.startsWith("[BB_SESSION_URL]"));
      if (bbLog) setBbSessionUrl(bbLog.replace("[BB_SESSION_URL] ", ""));
      return fetched;
    },
    enabled: isAnalyzing,
    refetchInterval: 2000,
  });

  const logs = logsData ?? [];
  const visibleLogs = logs.filter((l) => !l.startsWith("[BB_SESSION_URL]"));
  const activeStep = deriveActiveStep(logs, deal.status);

  // Auto-scroll terminal
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [visibleLogs.length]);

  const cardName = wantItem
    ? `${wantItem.name} ${wantItem.grade}`
    : deal.ebay_item_id
    ? `eBay #${deal.ebay_item_id}`
    : `Deal #${deal.id}`;

  const maxPrice = wantItem?.max_price ?? null;

  return (
    <div
      className="card p-0 overflow-hidden fade-up"
      style={{ borderColor: "var(--border)" }}
    >
      {/* ── Card header ── */}
      <div className="px-4 pt-4 pb-3 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <StatusBadge status={deal.status} />
            {isAnalyzing && (
              <Loader size={12} className="text-blue-400 animate-spin" />
            )}
          </div>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="p-1 rounded-lg transition-opacity hover:opacity-60"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? (
              <ChevronUp size={14} style={{ color: "var(--muted)" }} />
            ) : (
              <ChevronDown size={14} style={{ color: "var(--muted)" }} />
            )}
          </button>
        </div>

        <p
          className="text-base font-semibold truncate"
          style={{ color: "var(--text)" }}
          title={cardName}
        >
          {cardName}
        </p>

        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs"
          style={{ color: "var(--muted)" }}
        >
          <span className="font-mono font-semibold" style={{ color: "var(--text)" }}>
            {fmt$$(deal.landed_cost)} landed
          </span>
          {maxPrice != null && <span>max {fmt$$(maxPrice)}</span>}
          {deal.seller_username && <span>{deal.seller_username}</span>}
          {deal.seller_rating != null && (
            <span className="flex items-center gap-0.5">
              ⭐ {deal.seller_rating.toFixed(1)}%
            </span>
          )}
        </div>
      </div>

      {/* ── Mini step dots ── */}
      <div
        className="px-4 py-2 flex items-center gap-0 border-t border-b"
        style={{ borderColor: "var(--border)" }}
      >
        {LIVE_STEPS.map((label, i) => {
          const isDone = i < activeStep;
          const isActive = i === activeStep;
          return (
            <div key={label} className="flex items-center flex-1 last:flex-none">
              <div className="flex flex-col items-center gap-0.5">
                <div
                  className={cn(
                    "w-2 h-2 rounded-full border transition-colors",
                    isDone
                      ? "bg-green-500 border-green-500"
                      : isActive
                      ? "bg-blue-400 border-blue-400"
                      : "border-zinc-400"
                  )}
                />
                <span
                  className={cn(
                    "text-xs whitespace-nowrap",
                    isDone
                      ? "text-green-500"
                      : isActive
                      ? "text-blue-400"
                      : ""
                  )}
                  style={!isDone && !isActive ? { color: "var(--muted)" } : undefined}
                >
                  {isActive && isAnalyzing && <Loader size={8} className="inline animate-spin mr-0.5" />}
                  {label}
                </span>
              </div>
              {i < LIVE_STEPS.length - 1 && (
                <div
                  className="flex-1 h-px mx-1 mb-3"
                  style={{
                    background: isDone ? "#22c55e" : "var(--border)",
                  }}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* ── Expanded section ── */}
      {expanded && (
        <div className="space-y-0">
          {/* Live browser iframe */}
          {bbSessionUrl && isAnalyzing && (
            <div>
              <div
                className="flex items-center gap-2 px-4 py-2 border-b"
                style={{ borderColor: "var(--border)" }}
              >
                <span className="live-dot w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
                <span className="text-xs font-medium" style={{ color: "var(--muted)" }}>
                  Live Browser Session
                </span>
                <a
                  href={bbSessionUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto flex items-center gap-1 text-xs hover:underline"
                  style={{ color: "var(--muted)" }}
                >
                  Full screen <ExternalLink size={10} />
                </a>
              </div>
              <iframe
                src={bbSessionUrl}
                className="w-full"
                style={{ height: 360, border: "none" }}
                sandbox="allow-same-origin allow-scripts"
                allow="clipboard-read; clipboard-write"
                title={`Live session deal ${deal.id}`}
              />
            </div>
          )}

          {/* Agent logs terminal */}
          <div className="px-4 pb-4 pt-3">
            <div className="flex items-center gap-1.5 mb-2">
              <TerminalIcon size={11} style={{ color: "var(--muted)" }} />
              <span className="text-xs font-medium" style={{ color: "var(--muted)" }}>
                Agent Logs
              </span>
              {deal.url && (
                <a
                  href={deal.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto flex items-center gap-1 text-xs hover:underline"
                  style={{ color: "var(--muted)" }}
                >
                  eBay <ExternalLink size={9} />
                </a>
              )}
            </div>
            <div
              className="terminal"
              ref={terminalRef}
              style={{ maxHeight: 160, minHeight: 60 }}
            >
              {visibleLogs.length === 0 ? (
                <span style={{ opacity: 0.4 }}>Waiting for agent output…</span>
              ) : (
                visibleLogs.map((line, i) => (
                  <div key={i} className="fade-up">
                    {">"} {line}
                  </div>
                ))
              )}
              {isAnalyzing && <span className="cursor-blink" />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── RunInput component ───────────────────────────────────────────────────────

function RunInput({ onSuccess }: { onSuccess: () => void }) {
  const [url, setUrl] = useState("");
  const [maxPrice, setMaxPrice] = useState("500");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successDealId, setSuccessDealId] = useState<number | null>(null);

  async function handleRun() {
    const trimmed = url.trim();
    if (!trimmed || !trimmed.includes("ebay.com/itm/")) {
      setError("Paste a valid eBay listing URL (must contain /itm/)");
      return;
    }
    const price = parseFloat(maxPrice);
    if (!price || price <= 0) {
      setError("Enter a valid max price");
      return;
    }

    setError(null);
    setSuccessDealId(null);
    setLoading(true);

    try {
      const result = await api.runPipeline(trimmed, price);
      setSuccessDealId(result.deal_id);
      setUrl("");
      onSuccess();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card space-y-3">
      <div>
        <div className="flex items-center gap-2">
          <Zap size={14} style={{ color: "var(--gold)" }} />
          <h2 className="text-sm font-semibold" style={{ color: "var(--text)" }}>
            Test a Listing
          </h2>
          <span
            className="text-xs px-1.5 py-0.5 rounded font-mono"
            style={{ background: "var(--canvas)", color: "var(--muted)" }}
          >
            dry run — stops before paying
          </span>
        </div>
        <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>
          Paste any eBay listing URL to run it through the full pipeline — price check, seller check, PSA cert extraction — without actually buying.
        </p>
      </div>

      <div className="flex gap-2 items-center flex-wrap sm:flex-nowrap">
        <input
          className="input-base flex-1 min-w-0"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !loading && handleRun()}
          placeholder="https://www.ebay.com/itm/123456789"
          disabled={loading}
        />
        <input
          className="input-base"
          style={{ width: 128 }}
          type="number"
          min="1"
          value={maxPrice}
          onChange={(e) => setMaxPrice(e.target.value)}
          placeholder="Max $"
          disabled={loading}
        />
        <button
          className="btn-primary shrink-0"
          onClick={handleRun}
          disabled={loading || !url.trim()}
        >
          {loading ? <Loader size={14} className="animate-spin" /> : "Run"}
        </button>
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}
      {successDealId != null && (
        <p className="text-xs text-green-500">
          Deal #{successDealId} in flight — watch it above ↑
        </p>
      )}
    </div>
  );
}

// ─── ScraperCard component ────────────────────────────────────────────────────

function ScraperCard({
  label,
  tag,
  color,
  stats,
  loading,
}: {
  label: string;
  tag: string;
  color: string;
  stats: ScraperStats | null;
  loading: boolean;
}) {
  return (
    <div className="card space-y-3 flex-1 min-w-0">
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
        <span className="text-sm font-semibold" style={{ color: "var(--text)" }}>{label}</span>
        <span
          className="text-xs px-1.5 py-0.5 rounded font-mono ml-auto"
          style={{ background: "var(--canvas)", color: "var(--muted)" }}
        >
          {tag}
        </span>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
          <Loader size={12} className="animate-spin" />
          Running…
        </div>
      )}

      {!loading && stats && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Listings found" value={String(stats.count)} />
            <Stat label="Time" value={`${(stats.time_ms / 1000).toFixed(1)}s`} />
            <Stat label="Price range" value={stats.price_min != null ? `$${stats.price_min} – $${stats.price_max}` : "—"} />
            <Stat label="Avg price" value={stats.price_avg != null ? `$${stats.price_avg}` : "—"} />
          </div>
          <div
            className="text-xs font-semibold uppercase tracking-wider pt-1"
            style={{ color: "var(--muted)" }}
          >
            Top listings
          </div>
          <div className="space-y-1.5">
            {stats.samples.map((s: ScraperSample, i: number) => (
              <a
                key={i}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start justify-between gap-2 text-xs group"
              >
                <span
                  className="truncate group-hover:underline leading-snug"
                  style={{ color: "var(--text)" }}
                >
                  {s.title}
                </span>
                <span className="shrink-0 font-mono" style={{ color: "var(--muted)" }}>
                  ${s.price}{s.shipping > 0 ? ` +$${s.shipping}` : " free ship"}
                </span>
              </a>
            ))}
          </div>
        </>
      )}

      {!loading && stats && stats.count === 0 && (
        <p className="text-xs text-amber-400">eBay blocked the direct request — this is why we use Apify.</p>
      )}

      {!loading && !stats && (
        <p className="text-xs" style={{ color: "var(--muted)" }}>No results yet</p>
      )}
    </div>
  );
}

// ─── ScraperLab component ─────────────────────────────────────────────────────

function ScraperLab() {
  const [query, setQuery] = useState("Charizard ex PSA 10 Obsidian Flames");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ html: ScraperStats; apify: ScraperStats; search_url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runCompare() {
    if (!query.trim()) return;
    setRunning(true);
    setResult(null);
    setError(null);
    try {
      const data = await api.scraperCompare(query.trim());
      setResult(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <FlaskConical size={15} style={{ color: "var(--muted)" }} />
          <h2 className="text-sm font-semibold" style={{ color: "var(--text)" }}>
            Scraper Comparison
          </h2>
          <span
            className="text-xs px-1.5 py-0.5 rounded font-mono"
            style={{ background: "var(--canvas)", color: "var(--muted)" }}
          >
            dev tool
          </span>
        </div>
        <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>
          Test how the Watchman finds listings. Type a card + grade — it hits eBay two ways (direct HTML vs Apify) and shows which returns better results. This is how the Watchman works under the hood.
        </p>
      </div>

      <div className="flex gap-2">
        <input
          className="input-base flex-1"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !running && runCompare()}
          placeholder="e.g. Umbreon VMAX PSA 10 Brilliant Stars"
        />
        <button
          className="btn-primary shrink-0"
          onClick={runCompare}
          disabled={running || !query.trim()}
        >
          {running ? <Loader size={14} className="animate-spin" /> : "Compare"}
        </button>
      </div>

      {error && (
        <p className="text-xs text-red-400">{error}</p>
      )}

      {(running || result) && (
        <div className="flex gap-4 flex-col sm:flex-row">
          <ScraperCard
            label="HTML Scraper"
            tag="old"
            color="#6B7280"
            stats={result?.html ?? null}
            loading={running}
          />
          <ScraperCard
            label="Apify Actor"
            tag="new · $0.002/result"
            color="#22c55e"
            stats={result?.apify ?? null}
            loading={running}
          />
        </div>
      )}

      {result && (
        <div className="flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
          <CheckCircle size={12} className="text-green-500" />
          Both scrapers searched:&nbsp;
          <a
            href={result.search_url}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline truncate"
          >
            {result.search_url}
          </a>
        </div>
      )}

      {result && (
        <div
          className="rounded-xl p-3 space-y-1.5 border"
          style={{ borderColor: "var(--border)", background: "var(--canvas)" }}
        >
          <p className="text-xs font-semibold" style={{ color: "var(--text)" }}>
            What each scraper gets vs what the agent adds
          </p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs" style={{ color: "var(--muted)" }}>
            <span>✓ Listing title</span>
            <span>✓ Agent: PSA cert #</span>
            <span>✓ Buy-It-Now price</span>
            <span>✓ Agent: price lock verify</span>
            <span>✓ Shipping cost</span>
            <span>✓ Agent: checkout walk</span>
            <span>✗ Seller rating (Apify only HTML has it)</span>
            <span>✗ PSA pop data (agent reads pop report)</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Home (main page) ─────────────────────────────────────────────────────────

const HISTORY_TABS = ["ALL", "BOUGHT", "ANALYZING", "REJECTED", "PENDING"] as const;
type HistoryTab = typeof HISTORY_TABS[number];

export function Home() {
  const { dark, toggle: toggleDark } = useDarkMode();
  const [historyTab, setHistoryTab] = useState<HistoryTab>("ALL");

  // ── Data queries ──────────────────────────────────────────────────────────

  const { data: health, isError: healthError } = useQuery({
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
    staleTime: 60_000,
  });

  // ── Derived data ──────────────────────────────────────────────────────────

  const wantMap = useMemo(
    () => new Map(wantList.map((w) => [w.id, w])),
    [wantList]
  );

  const analyzingDeals = allDeals.filter((d) => d.status === "ANALYZING");

  const spentToday = health?.daily_spend_today ?? 0;
  const budgetLeft = health?.budget_remaining ?? 0;
  const boughtToday = allDeals.filter((d) => d.status === "BOUGHT").length;

  const isOnline = !healthError && health?.status === "ok";

  const filteredDeals = useMemo(() => {
    const sorted = allDeals.slice().reverse();
    if (historyTab === "ALL") return sorted;
    return sorted.filter((d) => d.status === historyTab);
  }, [allDeals, historyTab]);

  // ── Helpers ───────────────────────────────────────────────────────────────

  function dealCardName(deal: Deal): string {
    const wi = wantMap.get(deal.want_list_id);
    if (wi) return `${wi.name} ${wi.grade}`;
    if (deal.ebay_item_id) return `eBay #${deal.ebay_item_id}`;
    return `Deal #${deal.id}`;
  }

  function outcomeCell(deal: Deal): ReactNode {
    if (deal.status === "BOUGHT" && deal.audit_log?.verified_cert) {
      return (
        <span className="font-mono text-green-500 text-xs">
          {deal.audit_log.verified_cert}
        </span>
      );
    }
    if (deal.status === "REJECTED" && deal.audit_log?.agent_extraction_json) {
      try {
        const reason =
          JSON.parse(deal.audit_log.agent_extraction_json)._rejection_reason;
        if (reason)
          return (
            <span className="text-xs text-red-400">{reason}</span>
          );
      } catch {
        // fall through
      }
    }
    return <span style={{ color: "var(--muted)" }}>—</span>;
  }

  return (
    <div className="min-h-screen" style={{ background: "var(--canvas)" }}>

      <main className="max-w-6xl mx-auto px-5 py-8 space-y-8">

        {/* ── How it works banner ───────────────────────────────────────────── */}
        <div
          className="rounded-xl border p-4 space-y-2"
          style={{ borderColor: "var(--border)", background: "var(--surface)" }}
        >
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
              How CardHero works
            </p>
            <div className="flex items-center gap-3 flex-wrap text-xs" style={{ color: "var(--muted)" }}>
              <BudgetBar health={health} />
              <span
                className={cn(
                  "flex items-center gap-1.5 font-medium",
                  isOnline ? "text-green-500" : "text-red-500"
                )}
              >
                {isOnline ? (
                  <><span className="live-dot w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />Live</>
                ) : (
                  <><WifiOff size={12} />Offline</>
                )}
              </span>
              <button onClick={toggleDark} className="p-1 rounded hover:opacity-70" aria-label="Toggle dark mode">
                {dark ? <Sun size={14} style={{ color: "var(--muted)" }} /> : <Moon size={14} style={{ color: "var(--muted)" }} />}
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs flex-wrap" style={{ color: "var(--muted)" }}>
            <span className="rounded px-2 py-0.5 font-medium" style={{ background: "var(--canvas)", color: "var(--text)" }}>1. Watchman</span>
            <span>scans eBay every few minutes for PSA-graded cards on your want list</span>
            <span className="opacity-40">→</span>
            <span className="rounded px-2 py-0.5 font-medium" style={{ background: "var(--canvas)", color: "var(--text)" }}>2. Filter</span>
            <span>checks price, seller quality, and title for fakes</span>
            <span className="opacity-40">→</span>
            <span className="rounded px-2 py-0.5 font-medium" style={{ background: "var(--canvas)", color: "var(--text)" }}>3. Agent</span>
            <span>opens a real browser, verifies the PSA cert, and checks out</span>
          </div>
        </div>

        {/* ── Stats row ─────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Spent today", value: fmt$$(spentToday), tip: "Total of all BOUGHT deals today" },
            { label: "Budget left", value: fmt$$(budgetLeft), tip: "Daily limit minus spent" },
            {
              label: "Agents running",
              value: String(analyzingDeals.length),
              highlight: analyzingDeals.length > 0,
              tip: "Browser agents currently buying",
            },
            { label: "Bought today", value: String(boughtToday), tip: "Deals completed today" },
          ].map(({ label, value, highlight, tip }) => (
            <div
              key={label}
              className="card py-3 px-4"
              title={tip}
            >
              <p className="text-xs mb-1" style={{ color: "var(--muted)" }}>
                {label}
              </p>
              <p
                className={cn(
                  "text-2xl font-mono font-semibold",
                  highlight ? "text-blue-400" : ""
                )}
                style={!highlight ? { color: "var(--text)" } : undefined}
              >
                {value}
              </p>
            </div>
          ))}
        </div>

        {/* ── Live Agents ───────────────────────────────────────────────────── */}
        <div className="space-y-4">
          <div>
            <div className="flex items-center gap-2">
              <Activity size={15} style={{ color: "var(--muted)" }} />
              <h2 className="text-sm font-semibold" style={{ color: "var(--text)" }}>
                Live Agents
              </h2>
              {analyzingDeals.length > 0 && (
                <span className="badge bg-blue-500/10 text-blue-400 border border-blue-500/30">
                  {analyzingDeals.length} running
                </span>
              )}
            </div>
            <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
              When the Watchman finds a deal that passes all filters, it launches a browser agent here. You can watch it live.
            </p>
          </div>

          {analyzingDeals.length === 0 ? (
            <div
              className="card flex items-center gap-3 py-6 justify-center"
              style={{ borderStyle: "dashed" }}
            >
              <Loader size={14} style={{ color: "var(--muted)" }} />
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                No agents running — Watchman is scanning eBay in the background…
              </p>
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {analyzingDeals.map((deal) => (
                <DealLiveCard
                  key={deal.id}
                  deal={deal}
                  wantItem={wantMap.get(deal.want_list_id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* ── Run a Test ────────────────────────────────────────────────────── */}
        <RunInput onSuccess={() => refetchDeals()} />

        {/* ── Deal History ──────────────────────────────────────────────────── */}
        <div className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold" style={{ color: "var(--text)" }}>Deal History</h2>
            <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
              Every listing the Watchman has evaluated. PENDING = queued, ANALYZING = agent running, BOUGHT = purchased, REJECTED = failed cert/price check.
            </p>
          </div>

          {/* Filter tabs */}
          <div className="flex gap-1 flex-wrap">
            {HISTORY_TABS.map((tab) => (
              <button
                key={tab}
                onClick={() => setHistoryTab(tab)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
                  historyTab === tab
                    ? "text-white"
                    : "hover:opacity-70"
                )}
                style={
                  historyTab === tab
                    ? { background: "var(--gold)" }
                    : {
                        background: "var(--canvas)",
                        color: "var(--muted)",
                        border: "1px solid var(--border)",
                      }
                }
              >
                {tab}
              </button>
            ))}
          </div>

          {filteredDeals.length === 0 ? (
            <p className="text-xs py-4" style={{ color: "var(--muted)" }}>
              No deals match this filter.
            </p>
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
                  {filteredDeals.map((d) => (
                    <tr key={d.id} className="table-row">
                      <td className="table-td">
                        <a
                          href={d.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-xs hover:underline max-w-[220px] truncate"
                          style={{ color: "var(--text)" }}
                        >
                          {dealCardName(d)}
                          <ExternalLink size={10} className="shrink-0" style={{ color: "var(--muted)" }} />
                        </a>
                      </td>
                      <td className="table-td font-mono text-xs">{fmt$$(d.price)}</td>
                      <td className="table-td">
                        <StatusBadge status={d.status} />
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

        {/* ── Scraper Lab ───────────────────────────────────────────────────── */}
        <ScraperLab />

      </main>
    </div>
  );
}
