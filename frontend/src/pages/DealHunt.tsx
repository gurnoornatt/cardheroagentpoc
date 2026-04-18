/**
 * Deal Hunt — interactive multi-platform search + Collectr importer
 *
 * Two sections:
 * 1. Deal Search — fill in card name, grade, max price, pick platforms → see ranked results
 * 2. Collectr Sync — paste showcase URL → import graded cards into want_list
 */

import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Search,
  RefreshCw,
  ExternalLink,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Download,
} from "lucide-react";
import { api, type DealHuntResponse, type DealHuntResult, type CollectrImportResponse } from "../lib/api";
import { cn } from "../lib/utils";

// ─── helpers ─────────────────────────────────────────────────────────────────

function fmt$(n: number) {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const PLATFORM_META: Record<string, { label: string; color: string; dot: string }> = {
  ebay:           { label: "eBay",          color: "bg-yellow-500/15 text-yellow-300 border-yellow-500/30", dot: "bg-yellow-400" },
  mercari:        { label: "Mercari",        color: "bg-red-500/15 text-red-300 border-red-500/30",         dot: "bg-red-400" },
  offerup:        { label: "OfferUp",        color: "bg-green-500/15 text-green-300 border-green-500/30",   dot: "bg-green-400" },
  fb_marketplace: { label: "FB Marketplace", color: "bg-blue-500/15 text-blue-300 border-blue-500/30",      dot: "bg-blue-400" },
};

function ScoreMeter({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color = pct >= 60 ? "bg-green-500" : pct >= 35 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-16 rounded-full bg-white/10 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] font-mono text-gray-400">{pct}%</span>
    </div>
  );
}

// ─── Deal result row ──────────────────────────────────────────────────────────

function ResultRow({ r, rank }: { r: DealHuntResult; rank: number }) {
  const [expanded, setExpanded] = useState(false);
  const pm = PLATFORM_META[r.platform] ?? { label: r.platform, color: "bg-gray-700 text-gray-300 border-gray-600", dot: "bg-gray-400" };

  return (
    <div className={cn("rounded-lg border transition-all", r.filter_passed ? "border-white/10 bg-white/5" : "border-white/5 bg-white/[0.02] opacity-60")}>
      <div className="flex items-center gap-3 p-3 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        {/* Rank */}
        <span className={cn("shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold", r.filter_passed ? "bg-indigo-600 text-white" : "bg-white/10 text-gray-500")}>
          {r.filter_passed ? rank : "✗"}
        </span>

        {/* Platform badge */}
        <span className={cn("shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold", pm.color)}>
          {pm.label}
        </span>

        {/* Title */}
        <p className="min-w-0 flex-1 truncate text-xs text-gray-200">{r.title}</p>

        {/* Price */}
        <div className="shrink-0 text-right">
          <p className="font-mono text-sm text-white">{fmt$(r.landed_cost)}</p>
          <p className="text-[10px] text-gray-500">{fmt$(r.price)} + ship</p>
        </div>

        {/* Score */}
        <div className="shrink-0 hidden sm:block">
          <ScoreMeter score={r.watchman_score} />
        </div>

        {/* Expand */}
        <button className="shrink-0 text-gray-600 hover:text-gray-400">
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {expanded && (
        <div className="border-t border-white/10 px-3 py-2 space-y-1.5 text-xs text-gray-400">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <span>Seller: <span className="text-gray-200">{r.seller_username}</span></span>
            <span>Rating: <span className="text-gray-200">{r.seller_rating}% ({r.seller_feedback_count} reviews)</span></span>
            <span>Price: <span className="font-mono text-gray-200">{fmt$(r.price)}</span></span>
            <span>Shipping: <span className="font-mono text-gray-200">{r.shipping > 0 ? fmt$(r.shipping) : "Free"}</span></span>
            <span>Landed cost: <span className="font-mono text-gray-200">{fmt$(r.landed_cost)}</span></span>
            <span>
              {r.filter_passed
                ? <span className="text-green-400 flex items-center gap-1"><CheckCircle2 size={11} /> Passed filter</span>
                : <span className="text-red-400 flex items-center gap-1"><XCircle size={11} /> {r.filter_reason}</span>}
            </span>
          </div>
          <a
            href={r.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-indigo-400 hover:text-indigo-300 hover:underline mt-1"
          >
            View listing <ExternalLink size={11} />
          </a>
        </div>
      )}
    </div>
  );
}

// ─── Deal Search section ──────────────────────────────────────────────────────

const PLATFORMS = [
  { id: "ebay",           label: "eBay",           active: true  },
  { id: "mercari",        label: "Mercari",         active: false },
  { id: "offerup",        label: "OfferUp",         active: false },
  { id: "fb_marketplace", label: "FB Marketplace",  active: false },
];

function DealSearchSection() {
  const [cardName, setCardName]   = useState("Charizard ex");
  const [grade, setGrade]         = useState("PSA 10");
  const [maxPrice, setMaxPrice]   = useState("500");
  const [platforms, setPlatforms] = useState<string[]>(["ebay"]);
  const [loading, setLoading]     = useState(false);
  const [result, setResult]       = useState<DealHuntResponse | null>(null);
  const [error, setError]         = useState<string | null>(null);

  function togglePlatform(id: string) {
    setPlatforms((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  }

  async function search() {
    const price = parseFloat(maxPrice);
    if (!cardName.trim() || !grade.trim() || isNaN(price) || price <= 0) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await api.dealHunt(cardName.trim(), grade.trim(), price, platforms);
      setResult(data);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } }; message?: string })
        ?.response?.data?.detail ?? String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  const passedResults = result?.results.filter((r) => r.filter_passed) ?? [];
  const failedResults = result?.results.filter((r) => !r.filter_passed) ?? [];

  return (
    <div className="space-y-5">
      {/* Search form */}
      <div className="rounded-xl border border-white/10 bg-white/5 p-5 space-y-4">
        <h2 className="text-base font-semibold text-white flex items-center gap-2">
          <Search size={15} className="text-indigo-400" />
          Deal Search
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-1">Card Name</label>
            <input
              type="text"
              value={cardName}
              onChange={(e) => setCardName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search()}
              placeholder="Charizard ex"
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-1">Grade</label>
            <input
              type="text"
              value={grade}
              onChange={(e) => setGrade(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search()}
              placeholder="PSA 10"
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-1">Max Price ($)</label>
            <input
              type="number"
              value={maxPrice}
              onChange={(e) => setMaxPrice(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search()}
              placeholder="500"
              min="1"
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
          </div>
        </div>

        {/* Platform toggles */}
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-2">Platforms</label>
          <div className="flex flex-wrap gap-2">
            {PLATFORMS.map((p) => {
              const pm = PLATFORM_META[p.id];
              const selected = platforms.includes(p.id);
              const disabled = !p.active;
              return (
                <button
                  key={p.id}
                  onClick={() => !disabled && togglePlatform(p.id)}
                  disabled={disabled}
                  title={disabled ? "Requires Apify paid plan ($15/mo)" : undefined}
                  className={cn(
                    "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all",
                    disabled
                      ? "cursor-not-allowed border-white/5 bg-white/[0.02] text-gray-700"
                      : selected
                        ? cn("border", pm.color)
                        : "border-white/10 bg-white/5 text-gray-500 hover:border-white/20 hover:text-gray-300"
                  )}
                >
                  <span className={cn("h-1.5 w-1.5 rounded-full", disabled ? "bg-gray-700" : pm.dot)} />
                  {p.label}
                  {disabled && <span className="text-[9px] text-gray-700 ml-0.5">soon</span>}
                </button>
              );
            })}
          </div>
        </div>

        <button
          onClick={search}
          disabled={loading || platforms.length === 0}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
        >
          {loading ? <RefreshCw size={14} className="animate-spin" /> : <Search size={14} />}
          {loading ? "Searching…" : "Search"}
        </button>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-red-800 bg-red-950/40 px-3 py-2 text-xs text-red-300">
            <AlertCircle size={13} className="mt-0.5 shrink-0" />
            {error}
          </div>
        )}
      </div>

      {/* Results */}
      {result && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-white">
              Results
              <span className="ml-2 text-xs font-normal text-gray-500">
                {result.filtered_count} passed filter · {result.total} total
              </span>
            </p>
            {result.total === 0 && (
              <p className="text-xs text-gray-600 italic">No listings found. eBay may be rate-limiting — try again in a minute.</p>
            )}
          </div>

          {passedResults.length > 0 && (
            <div className="space-y-2">
              {passedResults.map((r, i) => (
                <ResultRow key={r.url} r={r} rank={i + 1} />
              ))}
            </div>
          )}

          {failedResults.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs text-gray-600 hover:text-gray-400 py-1">
                {failedResults.length} filtered out (click to expand)
              </summary>
              <div className="mt-2 space-y-2">
                {failedResults.map((r) => (
                  <ResultRow key={r.url} r={r} rank={0} />
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Collectr Sync section ────────────────────────────────────────────────────

function CollectrSyncSection() {
  const [url, setUrl]               = useState("");
  const [jobId, setJobId]           = useState<string | null>(null);
  const [jobStatus, setJobStatus]   = useState<"running" | "done" | "error" | null>(null);
  const [sessionUrl, setSessionUrl] = useState<string | null>(null);
  const [result, setResult]         = useState<CollectrImportResponse | null>(null);
  const [error, setError]           = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const qc = useQueryClient();

  // Kick off polling when a jobId is set
  useEffect(() => {
    if (!jobId) return;

    pollRef.current = setInterval(async () => {
      try {
        const data = await api.collectrJobStatus(jobId);
        if (data.session_url && !sessionUrl) setSessionUrl(data.session_url);
        if (data.status === "done") {
          setJobStatus("done");
          setResult(data.result);
          qc.invalidateQueries({ queryKey: ["want-list"] });
          clearInterval(pollRef.current!);
        } else if (data.status === "error") {
          setJobStatus("error");
          setError(data.error ?? "Unknown error");
          clearInterval(pollRef.current!);
        } else {
          setJobStatus("running");
        }
      } catch {
        // Network hiccup — keep polling
      }
    }, 2000);

    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  async function importShowcase() {
    setError(null);
    setResult(null);
    setSessionUrl(null);
    setJobStatus(null);
    setJobId(null);
    try {
      const data = await api.collectrImport(url.trim());
      setJobId(data.job_id);
      setJobStatus("running");
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } }; message?: string })
        ?.response?.data?.detail ?? String(err);
      setError(msg);
    }
  }

  const loading = jobStatus === "running";
  const isWrongUrlFormat = url.includes("getcollectr.com") && !url.includes("/showcase/profile/");

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-5 space-y-4">
      <div>
        <h2 className="text-base font-semibold text-white flex items-center gap-2">
          <Download size={15} className="text-indigo-400" />
          Collectr Sync
        </h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Imports your graded cards from Collectr into the want list at 80% of their current value — so the Watchman starts hunting them automatically.
        </p>
      </div>

      {/* How to find the URL */}
      <div className="rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2.5 space-y-1.5 text-xs text-gray-400">
        <p className="font-semibold text-gray-300">How to get your showcase URL:</p>
        <ol className="space-y-0.5 list-decimal list-inside">
          <li>Open <a href="https://app.getcollectr.com" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">app.getcollectr.com <ExternalLink size={9} className="inline" /></a></li>
          <li>Go to your <strong className="text-gray-300">Profile</strong></li>
          <li>Tap <strong className="text-gray-300">Share</strong> or <strong className="text-gray-300">Showcase</strong></li>
          <li>Copy the link — it should look like:<br />
            <span className="font-mono text-gray-500">getcollectr.com/showcase/profile/xxxxxxxx-...</span>
          </li>
        </ol>
        <p className="text-yellow-600 text-[10px]">Note: product/explore URLs won't work — you need your personal showcase link.</p>
      </div>

      <div className="flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !loading && url.includes("/showcase/profile/") && importShowcase()}
          placeholder="https://app.getcollectr.com/showcase/profile/your-uuid-here"
          disabled={loading}
          className={`flex-1 rounded-lg border bg-white/5 px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:ring-1 disabled:opacity-50 ${
            isWrongUrlFormat
              ? "border-yellow-600 focus:border-yellow-500 focus:ring-yellow-500"
              : "border-white/10 focus:border-indigo-500 focus:ring-indigo-500"
          }`}
        />
        <button
          onClick={importShowcase}
          disabled={loading || !url.includes("/showcase/profile/")}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors whitespace-nowrap"
        >
          {loading ? <RefreshCw size={14} className="animate-spin" /> : <Download size={14} />}
          {loading ? "Importing…" : "Import"}
        </button>
      </div>

      {isWrongUrlFormat && (
        <div className="flex items-start gap-2 rounded-lg border border-yellow-800 bg-yellow-950/30 px-3 py-2 text-xs text-yellow-300">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span>That looks like a product/explore URL, not your personal showcase. Follow the steps above to find your showcase link.</span>
        </div>
      )}

      {/* Loading state — before session URL arrives */}
      {loading && !sessionUrl && (
        <p className="text-xs text-gray-500 italic">
          Opening Browserbase session to read your showcase — takes ~30s…
        </p>
      )}

      {/* Live Browserbase session iframe */}
      {sessionUrl && (loading || jobStatus === "done") && (
        <div className="rounded-lg border border-white/10 overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10 bg-white/5">
            <span className={cn(
              "h-1.5 w-1.5 rounded-full",
              loading ? "bg-green-400 animate-pulse" : "bg-gray-500"
            )} />
            <span className="text-xs text-gray-400">
              {loading ? "Live Browserbase session — reading your Collectr showcase" : "Session complete"}
            </span>
            <a
              href={sessionUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 hover:underline"
            >
              Full screen <ExternalLink size={10} />
            </a>
          </div>
          <iframe
            src={sessionUrl}
            className="w-full"
            style={{ height: 360, border: "none" }}
            sandbox="allow-same-origin allow-scripts"
            allow="clipboard-read; clipboard-write"
            title="Collectr import live session"
          />
        </div>
      )}

      {error && !isWrongUrlFormat && (
        <div className="flex items-start gap-2 rounded-lg border border-red-800 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-3">
          {/* Summary banner */}
          <div className={cn(
            "rounded-lg border px-4 py-3 text-sm",
            result.imported_count > 0
              ? "border-green-700/50 bg-green-950/40 text-green-300"
              : "border-white/10 bg-white/5 text-gray-300"
          )}>
            <p className="font-semibold">
              {result.imported_count > 0 ? "Import complete" : `${result.cards_found} cards found on your showcase`}
            </p>
            <p className="text-xs mt-0.5 opacity-80">
              {result.imported_count} new cards added to want list · {result.skipped_count} skipped
            </p>
          </div>

          {/* Skipped breakdown */}
          {result.skipped_count > 0 && (() => {
            type SkipEntry = { card: { name?: string }; reason: string };
            const details = result.skipped_details as SkipEntry[];
            const alreadyIn = details.filter((s) => s.reason === "already_in_want_list");
            const rawCards  = details.filter((s) => s.reason === "non_psa_grade");
            const other     = details.filter((s) => s.reason !== "already_in_want_list" && s.reason !== "non_psa_grade");
            return (
              <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 space-y-2.5 text-xs">
                <p className="font-semibold text-gray-300 text-[11px] uppercase tracking-wide">Why cards were skipped</p>
                {alreadyIn.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-green-400 font-medium flex items-center gap-1">
                      <CheckCircle2 size={11} /> {alreadyIn.length} already in your want list
                    </p>
                    <p className="text-gray-500 pl-4">These were imported before — no duplicate added.</p>
                    <div className="pl-4 space-y-0.5">
                      {alreadyIn.map((s, i) => <p key={i} className="text-gray-600">{s.card?.name ?? "Unknown"}</p>)}
                    </div>
                  </div>
                )}
                {rawCards.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-gray-400 font-medium flex items-center gap-1">
                      <XCircle size={11} className="text-gray-600" /> {rawCards.length} raw / ungraded cards
                    </p>
                    <p className="text-gray-500 pl-4">CardHero only hunts PSA-graded cards. Raw cards are skipped.</p>
                    <div className="pl-4 space-y-0.5">
                      {rawCards.map((s, i) => <p key={i} className="text-gray-600">{s.card?.name ?? "Unknown"}</p>)}
                    </div>
                  </div>
                )}
                {other.length > 0 && (
                  <div className="space-y-0.5">
                    <p className="text-gray-400 font-medium">{other.length} other</p>
                    {other.map((s, i) => (
                      <p key={i} className="text-gray-600 pl-4">{s.card?.name ?? "Unknown"} — {s.reason}</p>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Imported cards table */}
          {result.want_list_additions.length > 0 && (
            <div className="rounded-lg border border-white/10 overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-white/10 bg-white/5">
                    <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-gray-500">Card</th>
                    <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-gray-500">Grade</th>
                    <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wide text-gray-500">Max Price</th>
                    <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-gray-500">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {result.want_list_additions.map((w, i) => (
                    <tr key={i} className="border-b border-white/5 last:border-0">
                      <td className="px-3 py-2 text-gray-200">
                        <p className="font-medium">{w.name}</p>
                        {w.set_name && <p className="text-[10px] text-gray-500">{w.set_name}</p>}
                      </td>
                      <td className="px-3 py-2 text-gray-400">
                        {w.grade.startsWith("PSA") ? (
                          <span className="rounded bg-indigo-900/50 border border-indigo-700/50 px-1.5 py-0.5 text-indigo-300 text-[10px] font-semibold">{w.grade}</span>
                        ) : (
                          <span className="rounded bg-yellow-900/30 border border-yellow-700/40 px-1.5 py-0.5 text-yellow-400 text-[10px]">{w.grade}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-gray-200">{fmt$(w.max_price)}</td>
                      <td className="px-3 py-2">
                        {w.is_active ? (
                          <span className="flex items-center gap-1 text-green-400 text-[10px]"><CheckCircle2 size={11} /> Active</span>
                        ) : (
                          <span className="flex items-center gap-1 text-yellow-500 text-[10px]"><AlertCircle size={11} /> Needs grade</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function DealHunt() {
  return (
    <div className="min-h-screen bg-gray-950 text-white p-6">
      <div className="max-w-3xl mx-auto space-y-8">

        {/* Page intro */}
        <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-3">
          <h1 className="text-base font-bold text-white">Hunt Tools</h1>
          <div className="grid sm:grid-cols-2 gap-3 text-xs text-gray-400">
            <div className="space-y-1">
              <p className="font-semibold text-white">Deal Search</p>
              <p>Type a card + grade + your max price. Searches eBay (and soon Mercari/OfferUp/FB) and ranks results by deal quality — price headroom, seller rating, free shipping.</p>
            </div>
            <div className="space-y-1">
              <p className="font-semibold text-white">Collectr Sync</p>
              <p>Paste your public Collectr portfolio URL. CardHero reads your collection and adds all PSA-graded cards to your want list at 80% of current value — so the Watchman starts hunting them automatically.</p>
            </div>
          </div>
        </div>

        <DealSearchSection />

        <div className="border-t border-white/10" />

        <CollectrSyncSection />
      </div>
    </div>
  );
}
