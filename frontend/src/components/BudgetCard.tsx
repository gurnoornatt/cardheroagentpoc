import type { Health } from "../lib/api";

function fmt$(n: number) {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function BudgetCard({ data }: { data: Health }) {
  const pct = data.daily_spend_limit > 0
    ? Math.min((data.daily_spend_today / data.daily_spend_limit) * 100, 100)
    : 0;
  const barColor = pct > 80 ? "bg-red-500" : pct > 50 ? "bg-yellow-500" : "bg-green-500";

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
      <span className="text-sm font-semibold text-white">Daily Budget</span>

      <div className="space-y-1">
        <div className="flex justify-between text-xs text-gray-400">
          <span>Spent {fmt$(data.daily_spend_today)}</span>
          <span>Limit {fmt$(data.daily_spend_limit)}</span>
        </div>
        <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
          <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
        </div>
      </div>

      <p className="text-sm text-gray-300">
        <span className="font-mono text-white">{fmt$(data.budget_remaining)}</span> remaining today
      </p>
    </div>
  );
}
