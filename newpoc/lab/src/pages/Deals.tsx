import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, ChevronDown, ChevronRight } from "lucide-react";
import { api, type Deal, type Health } from "../lib/api";
import { fmt$$, relativeTime, STATUS_COLORS, cn } from "../lib/utils";
import { StatusBadge } from "../components/StatusBadge";

const STATUSES = ["ALL", "ANALYZING", "PENDING", "BOUGHT", "REJECTED"] as const;

function StatsBar({ deals, health }: { deals: Deal[]; health?: Health }) {
  const spent = health?.daily_spend_today ?? 0;
  const limit = health?.daily_spend_limit ?? 500;
  const pct = Math.min((spent / limit) * 100, 100);
  const barColor = pct > 80 ? "bg-red-400" : pct > 60 ? "bg-yellow-400" : "bg-gold";

  const bought = deals.filter((d) => d.status === "BOUGHT").length;
  const analyzing = deals.filter((d) => d.status === "ANALYZING").length;
  const rejected = deals.filter((d) => d.status === "REJECTED").length;

  return (
    <div className="card flex flex-wrap items-center gap-6 py-3">
      <div className="flex-1 min-w-[160px]">
        <div className="flex justify-between text-xs text-muted mb-1">
          <span>Budget</span>
          <span>{fmt$$(spent)} / {fmt$$(limit)}</span>
        </div>
        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
          <div className={`h-full ${barColor} rounded-full transition-all duration-700`} style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className="flex gap-5 text-sm">
        <span><span className="font-semibold text-green-600">{bought}</span> <span className="text-muted">bought</span></span>
        <span><span className="font-semibold text-blue-600">{analyzing}</span> <span className="text-muted">analyzing</span></span>
        <span><span className="font-semibold text-red-500">{rejected}</span> <span className="text-muted">rejected</span></span>
      </div>
    </div>
  );
}

function AuditPanel({ deal }: { deal: Deal }) {
  const al = deal.audit_log;
  if (!al) return null;
  return (
    <div className="bg-gray-50 border-t border-border px-4 py-3 text-xs flex flex-wrap gap-6 text-gray-700">
      <span><span className="text-muted">Cert </span><span className="font-mono font-medium">{al.verified_cert ?? "—"}</span></span>
      <span><span className="text-muted">Locked </span><span className="font-medium">{fmt$$(al.price_locked)}</span></span>
      <span><span className="text-muted">Model </span><span className="font-medium">{al.model_used ?? "—"}</span></span>
      {al.psa_pop_grade10 != null && (
        <span><span className="text-muted">PSA Pop </span><span className="font-medium">{al.psa_pop_grade10} / {al.psa_pop_total ?? "?"}</span></span>
      )}
    </div>
  );
}

function DealRow({ deal }: { deal: Deal }) {
  const [expanded, setExpanded] = useState(false);
  const qc = useQueryClient();
  const reject = useMutation({
    mutationFn: () => api.patchDealStatus(deal.id, "REJECTED"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["deals"] }),
  });

  const hasAudit = deal.audit_log != null;

  return (
    <>
      <tr className="table-row">
        <td className="table-td w-8">
          <button
            onClick={() => setExpanded((e) => !e)}
            disabled={!hasAudit}
            className={cn("p-0.5 rounded hover:bg-gray-100", !hasAudit && "opacity-0 cursor-default")}
          >
            {expanded ? <ChevronDown size={14} className="text-muted" /> : <ChevronRight size={14} className="text-muted" />}
          </button>
        </td>
        <td className="table-td"><StatusBadge status={deal.status} /></td>
        <td className="table-td">
          <span className={cn("badge text-xs", STATUS_COLORS[deal.listing_type] ?? "bg-gray-100 text-gray-600")}>
            {deal.listing_type === "BUY_IT_NOW" ? "BIN" : "AUC"}
          </span>
        </td>
        <td className="table-td font-medium">{fmt$$(deal.landed_cost)}</td>
        <td className="table-td">
          {deal.undervalue_delta != null ? (
            <span className={cn("font-medium", deal.undervalue_delta >= 100 ? "text-green-600" : "text-yellow-600")}>
              −{fmt$$(Math.abs(deal.undervalue_delta))}
            </span>
          ) : <span className="text-muted">—</span>}
        </td>
        <td className="table-td text-muted text-xs">{relativeTime(deal.created_at)}</td>
        <td className="table-td">
          <div className="flex items-center gap-1.5">
            <a href={deal.url} target="_blank" rel="noopener noreferrer"
              className="p-1 rounded hover:bg-gray-100 text-muted hover:text-gray-700 transition-colors">
              <ExternalLink size={13} />
            </a>
            {deal.status !== "REJECTED" && deal.status !== "BOUGHT" && (
              <button onClick={() => reject.mutate()} disabled={reject.isPending}
                className="text-xs px-2 py-0.5 rounded border border-red-200 text-red-500 hover:bg-red-50 transition-colors disabled:opacity-50">
                Reject
              </button>
            )}
          </div>
        </td>
      </tr>
      {expanded && hasAudit && (
        <tr><td colSpan={7} className="p-0"><AuditPanel deal={deal} /></td></tr>
      )}
    </>
  );
}

export function Deals({ health }: { health?: Health }) {
  const [filter, setFilter] = useState<string>("ALL");

  const { data: deals = [], isLoading } = useQuery({
    queryKey: ["deals"],
    queryFn: () => api.deals(),
    refetchInterval: 5000,
  });

  const filtered = filter === "ALL" ? deals : deals.filter((d) => d.status === filter);

  const counts = STATUSES.reduce(
    (acc, s) => ({ ...acc, [s]: s === "ALL" ? deals.length : deals.filter((d) => d.status === s).length }),
    {} as Record<string, number>
  );

  return (
    <div className="space-y-4">
      <StatsBar deals={deals} health={health} />

      <div className="flex items-center gap-2 flex-wrap">
        {STATUSES.map((s) => (
          <button key={s} onClick={() => setFilter(s)}
            className={cn("tab-btn flex items-center gap-1.5", filter === s ? "tab-btn-active" : "tab-btn-inactive")}>
            {s}
            <span className={cn("text-xs px-1.5 py-0.5 rounded-full font-medium",
              filter === s ? "bg-white/20" : "bg-gray-100 text-gray-500")}>
              {counts[s]}
            </span>
          </button>
        ))}
      </div>

      <div className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[500px]">
            <thead className="bg-gray-50">
              <tr>
                <th className="table-th w-8" />
                <th className="table-th">Status</th>
                <th className="table-th">Type</th>
                <th className="table-th">Landed</th>
                <th className="table-th">vs Avg</th>
                <th className="table-th">Age</th>
                <th className="table-th">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={7} className="text-center py-12 text-muted text-sm">Loading…</td></tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr><td colSpan={7} className="text-center py-12 text-muted text-sm">No deals</td></tr>
              )}
              {filtered.map((deal) => <DealRow key={deal.id} deal={deal} />)}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
