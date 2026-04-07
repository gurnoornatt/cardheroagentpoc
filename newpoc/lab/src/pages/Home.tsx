import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  WifiOff,
  Sun,
  Moon,
  CheckCircle,
  XCircle,
  Clock,
  Loader,
  ExternalLink,
  Terminal as TerminalIcon,
  ImageIcon,
  FlaskConical,
} from "lucide-react";
import { api, type Deal, type LabRun, type ScraperStats, type ScraperSample } from "../lib/api";
import { cn, fmt$$, fmtMs, MODEL_COLORS, relativeTime } from "../lib/utils";

// ─── Dark mode ───────────────────────────────────────────────────────────────

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

// ─── Constants ────────────────────────────────────────────────────────────────

const STEPS = [
  { id: "submit",   label: "Submitting",       desc: "URL queued for processing" },
  { id: "create",   label: "Deal created",      desc: "Pipeline accepted the listing" },
  { id: "extract",  label: "Extracting",        desc: "Agent reading the eBay page via Browserbase" },
  { id: "checkout", label: "Walking checkout",  desc: "Agent navigating to payment screen" },
  { id: "ab",       label: "A/B comparison",    desc: "Both AI models extracted the same listing" },
];

function modelLabel(m: string): string {
  const map: Record<string, string> = {
    "google/gemini-3-flash-preview": "Gemini 3 Flash",
    "google/gemini-2.5-flash": "Gemini 2.5 Flash",
    "openai/gpt-5-nano": "GPT-5 Nano",
    "anthropic/claude-sonnet-4-5": "Claude Sonnet",
  };
  return map[m] ?? m;
}

type Phase = "idle" | "running" | "done" | "error";

// ─── Sub-components ───────────────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs mb-0.5" style={{ color: "var(--muted)" }}>{label}</p>
      <p className="text-sm font-semibold font-mono" style={{ color: "var(--text)" }}>{value}</p>
    </div>
  );
}

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

function AbCard({
  run,
  certDiff,
  priceDiff,
}: {
  run: LabRun;
  certDiff: boolean;
  priceDiff: boolean;
}) {
  const color = MODEL_COLORS[run.model] ?? "#6B7280";
  return (
    <div
      className="flex items-center gap-3 rounded-xl px-3 py-2.5 border transition-colors"
      style={{ borderColor: "var(--border)", background: "var(--canvas)" }}
    >
      <div className="w-1.5 h-10 rounded-full shrink-0" style={{ backgroundColor: color }} />
      <div className="flex-1 min-w-0 space-y-0.5">
        <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
          {modelLabel(run.model)}
        </p>
        <div className="flex gap-3 text-xs flex-wrap">
          <span
            className={cn(certDiff && "text-amber-400 font-semibold")}
            style={!certDiff ? { color: "var(--muted)" } : undefined}
          >
            cert: {run.extracted_cert ?? "—"}
          </span>
          <span
            className={cn(priceDiff && "text-amber-400 font-semibold")}
            style={!priceDiff ? { color: "var(--muted)" } : undefined}
          >
            price: {run.extracted_price != null ? fmt$$(run.extracted_price) : "—"}
          </span>
        </div>
      </div>
      <div className="text-right shrink-0 space-y-0.5">
        <div className="flex items-center gap-1.5 justify-end">
          {run.cert_correct != null &&
            (run.cert_correct ? (
              <CheckCircle size={13} className="text-green-500" />
            ) : (
              <XCircle size={13} className="text-red-400" />
            ))}
          <span className="text-xs font-mono" style={{ color: "var(--muted)" }}>
            {fmtMs(run.latency_ms)}
          </span>
        </div>
        {run.cert_correct != null && (
          <p className={cn("text-xs", run.cert_correct ? "text-green-500" : "text-red-400")}>
            {run.cert_correct ? "match" : "mismatch"}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Scraper Lab ──────────────────────────────────────────────────────────────

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

      {!loading && !stats && (
        <p className="text-xs" style={{ color: "var(--muted)" }}>No results yet</p>
      )}
    </div>
  );
}

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
      <div className="flex items-center gap-2">
        <FlaskConical size={15} style={{ color: "var(--muted)" }} />
        <h2 className="text-sm font-semibold" style={{ color: "var(--text)" }}>
          Scraper Lab
        </h2>
        <span
          className="text-xs px-1.5 py-0.5 rounded font-mono"
          style={{ background: "var(--canvas)", color: "var(--muted)" }}
        >
          HTML vs Apify
        </span>
      </div>

      <p className="text-xs" style={{ color: "var(--muted)" }}>
        Compare the old raw HTML scraper against the new Apify actor. Type a card name and grade —
        both scrapers hit the same eBay BIN search URL in parallel. Note: neither returns PSA cert
        numbers (those are on individual listing pages, extracted by the agent).
      </p>

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

// ─── Main page ────────────────────────────────────────────────────────────────

export function Home() {
  const { dark, toggle: toggleDark } = useDarkMode();

  const [url, setUrl] = useState("");
  const [maxPrice, setMaxPrice] = useState("500");
  const [phase, setPhase] = useState<Phase>("idle");
  const [dealId, setDealId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeStep, setActiveStep] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const runStartedAt = useRef<number>(0);
  const terminalRef = useRef<HTMLDivElement>(null);

  // Health check
  const { data: health, isError: healthError } = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    refetchInterval: 5000,
    retry: false,
  });
  const isOnline = !healthError && health?.status === "ok";

  // Poll deal status while running
  const { data: deal } = useQuery<Deal>({
    queryKey: ["pipeline-deal", dealId],
    queryFn: () => api.deal(dealId!),
    enabled: phase === "running" && dealId != null,
    refetchInterval: 2000,
  });

  // Poll A/B lab runs
  const { data: allRuns = [] } = useQuery<LabRun[]>({
    queryKey: ["lab-runs"],
    queryFn: api.labRuns,
    enabled: dealId != null,
    refetchInterval: phase === "running" ? 4000 : false,
  });
  const abRuns = allRuns.filter((r) => r.deal_id === dealId);

  // Poll agent logs while running
  useQuery({
    queryKey: ["deal-logs", dealId],
    queryFn: async () => {
      const newLogs = await api.dealLogs(dealId!);
      setLogs(newLogs);
      return newLogs;
    },
    enabled: phase === "running" && dealId != null,
    refetchInterval: 2000,
  });

  // All deals for history table
  const { data: allDeals = [] } = useQuery<Deal[]>({
    queryKey: ["deals"],
    queryFn: () => api.deals(),
    refetchInterval: phase === "running" ? 5000 : 30000,
  });

  // Auto-scroll terminal to bottom
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [logs]);

  // Advance step based on deal status; timeout after 5 min stuck in ANALYZING
  useEffect(() => {
    if (!deal) return;
    if (deal.status === "ANALYZING") {
      setActiveStep((prev) => Math.max(prev, 3));
      if (runStartedAt.current && Date.now() - runStartedAt.current > 5 * 60 * 1000) {
        setError("Agent timed out — deal is stuck in ANALYZING. Check Railway logs for errors.");
        setPhase("error");
      }
    } else if (deal.status === "BOUGHT" || deal.status === "REJECTED") {
      if (abRuns.length >= 2) {
        setActiveStep(5);
        setPhase("done");
      } else {
        setActiveStep((prev) => Math.max(prev, 4));
      }
    }
  }, [deal?.status, abRuns.length]);

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
    setPhase("running");
    setActiveStep(0); // "submitting" active
    setDealId(null);
    setLogs([]);
    runStartedAt.current = Date.now();

    try {
      const result = await api.runPipeline(trimmed, price);
      setDealId(result.deal_id);
      setActiveStep(2); // submit + create both done; extract is active
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  function handleReset() {
    setPhase("idle");
    setDealId(null);
    setActiveStep(0);
    setError(null);
    setUrl("");
    setLogs([]);
  }

  const rejectionReason = (() => {
    if (!deal?.audit_log?.agent_extraction_json) return null;
    try {
      return JSON.parse(deal.audit_log.agent_extraction_json)._rejection_reason ?? null;
    } catch {
      return null;
    }
  })();

  const screenshotUrl = (() => {
    const p = deal?.audit_log?.screenshot_path;
    if (!p) return null;
    const filename = p.split("/").pop();
    return filename ? `/receipts/${filename}` : null;
  })();

  const certsDiffer =
    abRuns.length >= 2 && abRuns[0].extracted_cert !== abRuns[1].extracted_cert;
  const pricesDiffer =
    abRuns.length >= 2 &&
    Math.abs((abRuns[0].extracted_price ?? 0) - (abRuns[1].extracted_price ?? 0)) > 0.01;

  function safeItemId(rawUrl: string): string {
    try {
      return new URL(rawUrl).pathname.split("/")[2] ?? rawUrl;
    } catch {
      return rawUrl;
    }
  }

  return (
    <div className="min-h-screen" style={{ background: "var(--canvas)" }}>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header
        className="sticky top-0 z-20 border-b"
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
      >
        <div className="max-w-6xl mx-auto px-5 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <span className="font-serif text-xl" style={{ color: "var(--text)" }}>
              CardHero
            </span>
            <span
              className="text-xs px-2 py-0.5 rounded font-mono"
              style={{ background: "var(--canvas)", color: "var(--muted)" }}
            >
              POC
            </span>
          </div>

          <div className="flex items-center gap-4">
            {/* Live / offline indicator */}
            <span
              className={cn(
                "flex items-center gap-1.5 text-xs font-medium",
                isOnline ? "text-green-500" : "text-red-500"
              )}
            >
              {isOnline ? (
                <>
                  <span className="live-dot w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
                  Live
                </>
              ) : (
                <>
                  <WifiOff size={12} />
                  Offline
                </>
              )}
            </span>

            {/* Dark mode toggle */}
            <button
              onClick={toggleDark}
              className="p-1.5 rounded-lg transition-colors hover:opacity-70"
              aria-label="Toggle dark mode"
            >
              {dark ? (
                <Sun size={16} style={{ color: "var(--muted)" }} />
              ) : (
                <Moon size={16} style={{ color: "var(--muted)" }} />
              )}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-5 py-8 space-y-8">
        {/* ── Hero ─────────────────────────────────────────────────────────── */}
        <div>
          <h1 className="text-2xl font-serif" style={{ color: "var(--text)" }}>
            PSA Card Deal Hunter
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
            Paste any eBay listing — the agent reads, verifies, and walks checkout in a real
            cloud browser. Two AI models extract independently so you can compare accuracy.
          </p>
        </div>

        {/* ── Idle: input form ─────────────────────────────────────────────── */}
        {phase === "idle" && (
          <div className="card max-w-2xl space-y-4 fade-up">
            <div className="space-y-3">
              <div>
                <label
                  className="block text-xs font-medium mb-1.5"
                  style={{ color: "var(--muted)" }}
                >
                  eBay Listing URL
                </label>
                <input
                  className="input-base"
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://www.ebay.com/itm/123456789"
                  onKeyDown={(e) => e.key === "Enter" && handleRun()}
                />
              </div>
              <div>
                <label
                  className="block text-xs font-medium mb-1.5"
                  style={{ color: "var(--muted)" }}
                >
                  Max Price (USD)
                </label>
                <input
                  className="input-base"
                  style={{ maxWidth: "9rem" }}
                  type="number"
                  min="1"
                  value={maxPrice}
                  onChange={(e) => setMaxPrice(e.target.value)}
                />
              </div>
            </div>

            {error && <p className="text-xs text-red-500">{error}</p>}

            <div className="flex items-center gap-4 flex-wrap">
              <button className="btn-primary" onClick={handleRun}>
                Run Pipeline
              </button>
              <p className="text-xs" style={{ color: "var(--muted)" }}>
                Dry run — stops before "Confirm and pay"
              </p>
            </div>
          </div>
        )}

        {/* ── Error state ─────────────────────────────────────────────────── */}
        {phase === "error" && (
          <div className="card max-w-2xl space-y-3 fade-up">
            <p className="text-sm text-red-500">{error}</p>
            <button className="btn-primary" onClick={handleReset}>
              Try again
            </button>
          </div>
        )}

        {/* ── Running / Done: two-column layout ───────────────────────────── */}
        {(phase === "running" || phase === "done") && (
          <div className="grid lg:grid-cols-2 gap-6 items-start">
            {/* Left: steps + terminal + outcome */}
            <div className="space-y-4">
              {/* Step progress */}
              <div className="card p-0 overflow-hidden">
                {STEPS.map((step, i) => {
                  const done = i < activeStep;
                  const active = i === activeStep;
                  return (
                    <div
                      key={step.id}
                      className={cn(
                        "flex items-start gap-3 px-4 py-3 border-b last:border-b-0 transition-colors",
                        active && "bg-blue-500/5"
                      )}
                      style={{ borderColor: "var(--border)" }}
                    >
                      <div className="mt-0.5 shrink-0">
                        {done ? (
                          <CheckCircle size={16} className="text-green-500" />
                        ) : active ? (
                          <Loader size={16} className="text-blue-400 animate-spin" />
                        ) : (
                          <Clock size={16} style={{ color: "var(--border)" }} />
                        )}
                      </div>
                      <div>
                        <p
                          className={cn("text-sm font-medium", active && "text-blue-400")}
                          style={!active ? { color: done ? "var(--text)" : "var(--muted)" } : undefined}
                        >
                          {step.label}
                        </p>
                        <p className="text-xs" style={{ color: "var(--muted)" }}>
                          {step.desc}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Terminal logs */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <TerminalIcon size={13} style={{ color: "var(--muted)" }} />
                  <span className="text-xs font-medium" style={{ color: "var(--muted)" }}>
                    Agent Logs
                  </span>
                </div>
                <div className="terminal" ref={terminalRef}>
                  {logs.length === 0 ? (
                    <span style={{ opacity: 0.4 }}>Waiting for agent output...</span>
                  ) : (
                    logs.map((line, i) => (
                      <div key={i} className="fade-up">
                        {">"} {line}
                      </div>
                    ))
                  )}
                  {phase === "running" && <span className="cursor-blink" />}
                </div>
              </div>

              {/* Outcome banner */}
              {deal && deal.status !== "ANALYZING" && (
                <div
                  className={cn(
                    "rounded-xl px-4 py-3 text-sm border fade-up",
                    deal.status === "BOUGHT"
                      ? "bg-green-500/10 border-green-500/30 text-green-500"
                      : "bg-red-500/10 border-red-500/30 text-red-400"
                  )}
                >
                  {deal.status === "BOUGHT"
                    ? "Checkout reached — stopped before Confirm and pay (dry run)."
                    : rejectionReason
                    ? `Rejected: ${rejectionReason}`
                    : "Pipeline finished."}
                </div>
              )}

              {phase === "done" && (
                <button
                  onClick={handleReset}
                  className="text-sm hover:underline transition-opacity hover:opacity-70"
                  style={{ color: "var(--gold)" }}
                >
                  Run another listing
                </button>
              )}
            </div>

            {/* Right: extraction data + screenshot + A/B */}
            <div className="space-y-4">
              {/* Extraction stats */}
              {deal?.audit_log && (
                <div className="card fade-up">
                  <p
                    className="text-xs font-semibold uppercase tracking-wider mb-3"
                    style={{ color: "var(--muted)" }}
                  >
                    Extraction
                  </p>
                  <div className="grid grid-cols-2 gap-4">
                    <Stat label="PSA Cert" value={deal.audit_log.verified_cert ?? "—"} />
                    <Stat label="Price locked" value={fmt$$(deal.audit_log.price_locked)} />
                    <Stat
                      label="Pop (10 / Total)"
                      value={`${deal.audit_log.psa_pop_grade10 ?? "?"} / ${deal.audit_log.psa_pop_total ?? "?"}`}
                    />
                    <Stat
                      label="Auth Guarantee"
                      value={
                        deal.audit_log.authenticity_guaranteed == null
                          ? "—"
                          : deal.audit_log.authenticity_guaranteed
                          ? "Yes"
                          : "No"
                      }
                    />
                  </div>
                  {deal.url && (
                    <a
                      href={deal.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-3 flex items-center gap-1 text-xs hover:underline"
                      style={{ color: "var(--muted)" }}
                    >
                      <ExternalLink size={11} /> View on eBay
                    </a>
                  )}
                </div>
              )}

              {/* Screenshot */}
              {screenshotUrl && (
                <div className="card p-0 overflow-hidden fade-up">
                  <div
                    className="flex items-center gap-2 px-4 py-2.5 border-b"
                    style={{ borderColor: "var(--border)" }}
                  >
                    <ImageIcon size={13} style={{ color: "var(--muted)" }} />
                    <span className="text-xs font-medium" style={{ color: "var(--muted)" }}>
                      Checkout screenshot
                    </span>
                    <a
                      href={screenshotUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-auto"
                    >
                      <ExternalLink size={12} style={{ color: "var(--muted)" }} />
                    </a>
                  </div>
                  <img
                    src={screenshotUrl}
                    alt="Checkout screenshot"
                    className="w-full object-cover max-h-80"
                  />
                </div>
              )}

              {/* A/B model comparison */}
              {abRuns.length > 0 && (
                <div className="card fade-up space-y-3">
                  <div className="flex items-center justify-between">
                    <p
                      className="text-xs font-semibold uppercase tracking-wider"
                      style={{ color: "var(--muted)" }}
                    >
                      Model Comparison
                    </p>
                    {abRuns.length < 2 && phase === "running" && (
                      <span
                        className="flex items-center gap-1 text-xs"
                        style={{ color: "var(--muted)" }}
                      >
                        <Loader size={11} className="animate-spin" /> Waiting for 2nd model...
                      </span>
                    )}
                  </div>

                  <div className="space-y-2">
                    {abRuns.map((run) => (
                      <AbCard
                        key={run.id}
                        run={run}
                        certDiff={certsDiffer}
                        priceDiff={pricesDiffer}
                      />
                    ))}
                  </div>

                  {abRuns.length >= 2 && !certsDiffer && !pricesDiffer && (
                    <p className="text-xs text-green-500 flex items-center gap-1">
                      <CheckCircle size={12} /> Both models agree on cert and price.
                    </p>
                  )}
                  {abRuns.length >= 2 && (certsDiffer || pricesDiffer) && (
                    <p className="text-xs text-amber-400 flex items-center gap-1">
                      <XCircle size={12} /> Models disagree — highlighted fields differ.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── History table ─────────────────────────────────────────────────── */}
        {allDeals.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold mb-3" style={{ color: "var(--text)" }}>
              Run History
            </h2>
            <div className="card p-0 overflow-hidden overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b" style={{ borderColor: "var(--border)" }}>
                    <th className="table-th">ID</th>
                    <th className="table-th">Item</th>
                    <th className="table-th">Price</th>
                    <th className="table-th">Status</th>
                    <th className="table-th">PSA Cert</th>
                    <th className="table-th">When</th>
                  </tr>
                </thead>
                <tbody>
                  {allDeals
                    .slice()
                    .reverse()
                    .map((d) => (
                      <tr key={d.id} className="table-row">
                        <td className="table-td font-mono text-xs">#{d.id}</td>
                        <td className="table-td">
                          <a
                            href={d.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-xs hover:underline max-w-[180px] truncate"
                            style={{ color: "var(--muted)" }}
                          >
                            {safeItemId(d.url)}
                            <ExternalLink size={10} className="shrink-0" />
                          </a>
                        </td>
                        <td className="table-td font-mono text-xs">{fmt$$(d.price)}</td>
                        <td className="table-td">
                          <StatusBadge status={d.status} />
                        </td>
                        <td className="table-td font-mono text-xs">
                          {d.audit_log?.verified_cert ?? "—"}
                        </td>
                        <td className="table-td text-xs" style={{ color: "var(--muted)" }}>
                          {relativeTime(d.created_at)}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {/* ── Scraper Lab ───────────────────────────────────────────────────── */}
        <ScraperLab />
      </main>
    </div>
  );
}
