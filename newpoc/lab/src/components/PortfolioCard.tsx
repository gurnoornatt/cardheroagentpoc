import type { PortfolioItem } from "../lib/api";

function fmt$(n: number) {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function PortfolioCard({ data }: { data: PortfolioItem[] }) {
  const totalValue = data.reduce((s, p) => s + p.current_value, 0);
  const totalPnl = data.reduce((s, p) => s + p.unrealized_pnl, 0);
  const pnlColor = totalPnl >= 0 ? "text-green-400" : "text-red-400";

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-white">Portfolio</span>
        <span className="text-xs text-gray-400">{data.length} cards</span>
      </div>

      <div className="flex gap-4">
        <div>
          <p className="text-[10px] text-gray-500 uppercase tracking-wide">Total Value</p>
          <p className="font-mono text-sm text-white">{fmt$(totalValue)}</p>
        </div>
        <div>
          <p className="text-[10px] text-gray-500 uppercase tracking-wide">Unrealized P&L</p>
          <p className={`font-mono text-sm ${pnlColor}`}>
            {totalPnl >= 0 ? "+" : ""}{fmt$(totalPnl)}
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        {data.slice(0, 5).map((p) => (
          <div key={p.id} className="flex items-center justify-between border-t border-white/10 pt-1.5">
            <div className="min-w-0">
              <p className="truncate text-xs text-gray-200">{p.name}</p>
              <p className="text-[10px] text-gray-500">{p.grade} · {p.cert_number}</p>
            </div>
            <div className="shrink-0 text-right">
              <p className="font-mono text-xs text-white">{fmt$(p.current_value)}</p>
              <p className={`text-[10px] font-mono ${p.unrealized_pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                {p.unrealized_pnl >= 0 ? "+" : ""}{fmt$(p.unrealized_pnl)}
              </p>
            </div>
          </div>
        ))}
        {data.length > 5 && (
          <p className="text-[10px] text-gray-600">+{data.length - 5} more…</p>
        )}
      </div>
    </div>
  );
}
