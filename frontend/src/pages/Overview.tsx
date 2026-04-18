import { useQuery } from "@tanstack/react-query";
import {
  TrendingDown,
  ShoppingCart,
  Clock,
  DollarSign,
  Activity,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { api, type Deal } from "../lib/api";
import { fmt$$, fmtPct } from "../lib/utils";
import { StatusBadge } from "../components/StatusBadge";

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  accent?: string;
}) {
  return (
    <div className="stat-card">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold text-muted uppercase tracking-wider">
          {label}
        </span>
        <span
          className={`p-1.5 rounded-lg ${accent ?? "bg-gray-50 text-gray-400"}`}
        >
          <Icon size={14} />
        </span>
      </div>
      <div className="text-2xl font-semibold text-gray-900">{value}</div>
      {sub && <div className="text-xs text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

function BudgetMeter({
  spent,
  limit,
}: {
  spent: number;
  limit: number;
}) {
  const pct = Math.min((spent / limit) * 100, 100);
  const color =
    pct > 80 ? "bg-red-400" : pct > 60 ? "bg-yellow-400" : "bg-gold";
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-serif text-lg text-gray-900">Daily Budget</h3>
        <span className="text-sm font-medium text-muted">
          {fmt$$(spent)} / {fmt$$(limit)}
        </span>
      </div>
      <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
        <div
          className={`h-full ${color} rounded-full transition-all duration-700`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex justify-between mt-2 text-xs text-muted">
        <span>{fmtPct(pct)} used</span>
        <span>{fmt$$(limit - spent)} remaining</span>
      </div>
    </div>
  );
}

function RecentDeals({ deals }: { deals: Deal[] }) {
  const recent = deals.slice(0, 8);
  return (
    <div className="card">
      <h3 className="font-serif text-lg text-gray-900 mb-4">Recent Deals</h3>
      {recent.length === 0 ? (
        <p className="text-sm text-muted text-center py-8">No deals yet</p>
      ) : (
        <div className="space-y-2">
          {recent.map((deal) => (
            <div
              key={deal.id}
              className="flex items-center justify-between py-2.5 border-b border-border last:border-0"
            >
              <div className="flex items-center gap-3 min-w-0">
                <StatusBadge status={deal.status} />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate max-w-[180px]">
                    {deal.ebay_item_id || `Deal #${deal.id}`}
                  </p>
                  <p className="text-xs text-muted">
                    {deal.listing_type === "AUCTION" ? "Auction" : "Buy It Now"}
                  </p>
                </div>
              </div>
              <div className="text-right flex-shrink-0 ml-3">
                <p className="text-sm font-semibold text-gray-900">
                  {fmt$$(deal.landed_cost)}
                </p>
                {deal.undervalue_delta != null && (
                  <p className="text-xs text-green-600">
                    −{fmt$$(deal.undervalue_delta)} vs avg
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Overview() {
  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    refetchInterval: 5000,
  });

  const { data: deals = [] } = useQuery({
    queryKey: ["deals"],
    queryFn: () => api.deals(),
    refetchInterval: 5000,
  });

  const bought = deals.filter((d) => d.status === "BOUGHT");
  const analyzing = deals.filter((d) => d.status === "ANALYZING");
  const pending = deals.filter((d) => d.status === "PENDING");
  const rejected = deals.filter((d) => d.status === "REJECTED");

  const totalSpend = bought.reduce((s, d) => s + d.landed_cost, 0);

  return (
    <div className="space-y-6">
      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Daily Spend"
          value={fmt$$(health?.daily_spend_today ?? 0)}
          sub={`of ${fmt$$(health?.daily_spend_limit ?? 500)} limit`}
          icon={DollarSign}
          accent="bg-gold-50 text-gold"
        />
        <StatCard
          label="Deals Bought"
          value={String(bought.length)}
          sub={`Total: ${fmt$$(totalSpend)}`}
          icon={CheckCircle2}
          accent="bg-green-50 text-green-600"
        />
        <StatCard
          label="Analyzing"
          value={String(analyzing.length)}
          sub={`${pending.length} pending`}
          icon={Activity}
          accent="bg-blue-50 text-blue-600"
        />
        <StatCard
          label="Rejected"
          value={String(rejected.length)}
          sub={`${deals.length} total`}
          icon={XCircle}
          accent="bg-red-50 text-red-500"
        />
      </div>

      {/* Budget meter */}
      <BudgetMeter
        spent={health?.daily_spend_today ?? 0}
        limit={health?.daily_spend_limit ?? 500}
      />

      {/* Pipeline funnel + recent deals */}
      <div className="grid lg:grid-cols-2 gap-4">
        {/* Funnel */}
        <div className="card">
          <h3 className="font-serif text-lg text-gray-900 mb-4">
            Pipeline Funnel
          </h3>
          <div className="space-y-3">
            {[
              { label: "Pending", count: pending.length, color: "bg-yellow-300", icon: Clock },
              { label: "Analyzing", count: analyzing.length, color: "bg-blue-400 live-dot", icon: Activity },
              { label: "Bought", count: bought.length, color: "bg-green-500", icon: ShoppingCart },
              { label: "Rejected", count: rejected.length, color: "bg-red-300", icon: TrendingDown },
            ].map(({ label, count, color, icon: Icon }) => (
              <div key={label} className="flex items-center gap-3">
                <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${color}`} />
                <div className="flex-1">
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-gray-700 flex items-center gap-1.5">
                      <Icon size={12} className="text-muted" />
                      {label}
                    </span>
                    <span className="font-medium text-gray-900">{count}</span>
                  </div>
                  <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${color} rounded-full transition-all duration-500`}
                      style={{
                        width: deals.length
                          ? `${(count / deals.length) * 100}%`
                          : "0%",
                      }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <RecentDeals deals={[...deals].sort((a, b) =>
          new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime()
        )} />
      </div>
    </div>
  );
}
