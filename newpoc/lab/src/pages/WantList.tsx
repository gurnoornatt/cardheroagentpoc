/**
 * Targets — the want list page.
 *
 * Shows:
 * 1. Watchman status banner — running / offline / blocked + last scan time
 * 2. Quick-add form — add a new card target in seconds
 * 3. Targets table — all active cards the Watchman is hunting
 */

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Activity,
  AlertCircle,
  WifiOff,
  Clock,
} from "lucide-react";
import { api, type WantListItem, type WatchmanStatus } from "../lib/api";
import { fmt$$, cn } from "../lib/utils";

// ─── Watchman status banner ───────────────────────────────────────────────────

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const diff = Math.floor((Date.now() - new Date(iso + "Z").getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function WatchmanBanner({ status }: { status: WatchmanStatus | undefined }) {
  if (!status) return null;

  const configs = {
    running: {
      bg: "bg-green-950/40 border-green-700/50",
      dot: "bg-green-400 animate-pulse",
      label: "Running",
      labelColor: "text-green-400",
      icon: <Activity size={13} className="text-green-400" />,
    },
    offline: {
      bg: "bg-gray-900 border-white/10",
      dot: "bg-gray-600",
      label: "Offline",
      labelColor: "text-gray-400",
      icon: <WifiOff size={13} className="text-gray-500" />,
    },
    blocked: {
      bg: "bg-yellow-950/40 border-yellow-700/40",
      dot: "bg-yellow-500",
      label: "Blocked",
      labelColor: "text-yellow-400",
      icon: <AlertCircle size={13} className="text-yellow-400" />,
    },
  };

  const cfg = configs[status.status];

  return (
    <div className={cn("rounded-xl border px-4 py-3 flex items-start justify-between gap-4 flex-wrap", cfg.bg)}>
      <div className="flex items-center gap-3">
        <span className={cn("h-2 w-2 rounded-full shrink-0 mt-0.5", cfg.dot)} />
        <div>
          <div className="flex items-center gap-2">
            {cfg.icon}
            <span className={cn("text-sm font-semibold", cfg.labelColor)}>
              Watchman {cfg.label}
            </span>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            {status.status === "running" && `Scanning ${status.items_scanned} cards · last scan ${relativeTime(status.last_scan_at)}`}
            {status.status === "offline" && (
              <span>
                Not running.{" "}
                <span className="font-mono bg-black/30 px-1 py-0.5 rounded text-[10px]">
                  uv run python -m newpoc.backend.monitor
                </span>
              </span>
            )}
            {status.status === "blocked" && (
              status.error?.includes("apify") || status.error?.includes("403")
                ? "Apify monthly limit exceeded — upgrade to $15/mo to resume scanning"
                : status.error ?? "Unknown error"
            )}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 text-xs text-gray-600">
        <Clock size={11} />
        {relativeTime(status.last_scan_at)}
      </div>
    </div>
  );
}

// ─── Quick-add form ───────────────────────────────────────────────────────────

function QuickAddForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [grade, setGrade] = useState("PSA 10");
  const [maxPrice, setMaxPrice] = useState("");
  const [setNameVal, setSetNameVal] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!name.trim() || !grade.trim() || !maxPrice) return;
    const price = parseFloat(maxPrice);
    if (isNaN(price) || price <= 0) { setError("Max price must be > 0"); return; }
    setLoading(true);
    setError(null);
    try {
      await api.addWantListItem({
        name: name.trim(),
        grade: grade.trim(),
        max_price: price,
        set_name: setNameVal.trim() || undefined,
      });
      setName(""); setGrade("PSA 10"); setMaxPrice(""); setSetNameVal(""); setOpen(false);
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
        className="flex items-center gap-2 rounded-lg border border-dashed border-white/20 bg-white/[0.02] px-4 py-2.5 text-sm text-gray-500 hover:border-indigo-500/50 hover:text-indigo-400 transition-colors w-full justify-center"
      >
        <Plus size={14} />
        Add a card target
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-indigo-500/30 bg-indigo-950/20 p-4 space-y-3">
      <p className="text-xs font-semibold text-indigo-300 uppercase tracking-wide">New Target</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-1">Card Name *</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Charizard ex"
            autoFocus
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
          />
        </div>
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-1">Grade *</label>
          <input
            type="text"
            value={grade}
            onChange={(e) => setGrade(e.target.value)}
            placeholder="PSA 10"
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
          />
        </div>
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-1">Max Price ($) *</label>
          <input
            type="number"
            value={maxPrice}
            onChange={(e) => setMaxPrice(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="500"
            min="1"
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
          />
        </div>
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-1">Set Name (optional)</label>
          <input
            type="text"
            value={setNameVal}
            onChange={(e) => setSetNameVal(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Obsidian Flames"
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
          />
        </div>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={submit}
          disabled={loading || !name.trim() || !maxPrice}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
        >
          {loading ? <RefreshCw size={13} className="animate-spin" /> : <Plus size={13} />}
          {loading ? "Adding…" : "Add Target"}
        </button>
        <button
          onClick={() => { setOpen(false); setError(null); }}
          className="px-4 py-2 text-sm text-gray-500 hover:text-gray-300 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Targets table ────────────────────────────────────────────────────────────

function TargetsTable({ items, loading }: { items: WantListItem[]; loading: boolean }) {
  return (
    <div className="rounded-xl border border-white/10 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-white/10 bg-white/[0.03]">
              <th className="px-4 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wide text-gray-500">Card</th>
              <th className="px-4 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wide text-gray-500">Grade</th>
              <th className="px-4 py-2.5 text-right text-[10px] font-semibold uppercase tracking-wide text-gray-500">Max Buy Price</th>
              <th className="px-4 py-2.5 text-right text-[10px] font-semibold uppercase tracking-wide text-gray-500">Market Avg</th>
              <th className="px-4 py-2.5 text-right text-[10px] font-semibold uppercase tracking-wide text-gray-500">Headroom</th>
              <th className="px-4 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wide text-gray-500">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-gray-600">Loading…</td>
              </tr>
            )}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-gray-600">
                  No targets yet — add one above or import from Collectr on the Hunt page.
                </td>
              </tr>
            )}
            {items.map((item) => {
              const headroom = item.sanitized_avg != null ? item.max_price - item.sanitized_avg : null;
              const goodDeal = headroom != null && headroom >= 50;
              const unknownGrade = !item.grade || item.grade === "Unknown Grade";

              return (
                <tr key={item.id} className="border-t border-white/5 hover:bg-white/[0.02] transition-colors">
                  <td className="px-4 py-3">
                    <p className="text-sm font-medium text-white">{item.name}</p>
                    {item.set_name && <p className="text-[10px] text-gray-500 mt-0.5">{item.set_name}</p>}
                  </td>
                  <td className="px-4 py-3">
                    {unknownGrade ? (
                      <span className="inline-flex items-center gap-1 rounded border border-yellow-700/40 bg-yellow-900/20 px-1.5 py-0.5 text-[10px] text-yellow-400">
                        <AlertCircle size={9} /> {item.grade || "No grade"}
                      </span>
                    ) : (
                      <span className="rounded border border-indigo-700/40 bg-indigo-900/20 px-1.5 py-0.5 text-[10px] text-indigo-300 font-semibold">
                        {item.grade}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-sm text-white">
                    {fmt$$(item.max_price)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-sm">
                    {item.sanitized_avg != null
                      ? <span className="text-gray-300">{fmt$$(item.sanitized_avg)}</span>
                      : <span className="text-gray-600 text-xs italic">no data yet</span>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {headroom != null ? (
                      <span className={cn("flex items-center justify-end gap-1 font-mono text-sm font-medium", goodDeal ? "text-green-400" : "text-yellow-500")}>
                        {goodDeal ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                        {fmt$$(headroom)}
                      </span>
                    ) : (
                      <span className="text-gray-600 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {item.is_active ? (
                      <span className="flex items-center gap-1.5 text-[11px] text-green-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
                        Hunting
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 text-[11px] text-gray-600">
                        <span className="h-1.5 w-1.5 rounded-full bg-gray-700" />
                        Paused
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function WantList() {
  const qc = useQueryClient();

  const { data: watchman } = useQuery({
    queryKey: ["watchman-status"],
    queryFn: api.watchmanStatus,
    refetchInterval: 30_000,
  });

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["want-list"],
    queryFn: api.wantList,
    refetchInterval: 30_000,
  });

  const activeCount = items.filter((i) => i.is_active).length;
  const unknownGradeCount = items.filter((i) => !i.grade || i.grade === "Unknown Grade").length;

  return (
    <div className="min-h-screen bg-gray-950 text-white p-6 space-y-5">
      <div>
        <h1 className="text-base font-bold text-white">Targets</h1>
        <p className="text-xs text-gray-500 mt-0.5">
          {activeCount} card{activeCount !== 1 ? "s" : ""} the Watchman is actively hunting on eBay
        </p>
      </div>

      <WatchmanBanner status={watchman} />

      {unknownGradeCount > 0 && (
        <div className="rounded-lg border border-yellow-700/40 bg-yellow-950/20 px-4 py-2.5 flex items-start gap-2 text-xs text-yellow-300">
          <AlertCircle size={13} className="shrink-0 mt-0.5" />
          <span>
            {unknownGradeCount} card{unknownGradeCount !== 1 ? "s have" : " has"} no PSA grade set — imported from Collectr.
            Update the grade so the Watchman knows exactly what to search for.
          </span>
        </div>
      )}

      <QuickAddForm onAdded={() => qc.invalidateQueries({ queryKey: ["want-list"] })} />

      <TargetsTable items={items} loading={isLoading} />
    </div>
  );
}
