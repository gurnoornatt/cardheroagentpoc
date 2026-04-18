import { useQuery } from "@tanstack/react-query";
import { TrendingUp, TrendingDown } from "lucide-react";
import { api } from "../lib/api";
import { fmt$$, fmtPct, cn } from "../lib/utils";

export function Portfolio() {
  const { data: items = [], isLoading } = useQuery({
    queryKey: ["portfolio"],
    queryFn: api.portfolio,
    refetchInterval: 60_000,
  });

  const totalCost = items.reduce((s, i) => s + i.purchase_price, 0);
  const totalValue = items.reduce((s, i) => s + i.current_value, 0);
  const totalPnl = totalValue - totalCost;
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Total Cost", value: fmt$$(totalCost) },
          { label: "Current Value", value: fmt$$(totalValue) },
          {
            label: "Unrealized P&L",
            value: `${totalPnl >= 0 ? "+" : ""}${fmt$$(totalPnl)}`,
            sub: fmtPct(totalPnlPct),
            positive: totalPnl >= 0,
          },
        ].map(({ label, value, sub, positive }) => (
          <div key={label} className="stat-card">
            <span className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
              {label}
            </span>
            <span
              className={cn(
                "text-xl font-semibold",
                positive === undefined
                  ? "text-gray-900"
                  : positive
                  ? "text-green-600"
                  : "text-red-500"
              )}
            >
              {value}
            </span>
            {sub && <span className="text-xs text-muted">{sub}</span>}
          </div>
        ))}
      </div>

      <div className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="table-th">Card</th>
                <th className="table-th">Grade</th>
                <th className="table-th">Purchase Price</th>
                <th className="table-th">Current Value</th>
                <th className="table-th">P&L</th>
                <th className="table-th">P&L %</th>
                <th className="table-th">Cert #</th>
                <th className="table-th">Purchased</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={8} className="text-center py-12 text-muted text-sm">
                    Loading…
                  </td>
                </tr>
              )}
              {items.map((item) => {
                const positive = item.unrealized_pnl >= 0;
                return (
                  <tr key={item.id} className="table-row">
                    <td className="table-td">
                      <p className="font-semibold text-gray-900">{item.name}</p>
                      <p className="text-xs text-muted">{item.set_name}</p>
                    </td>
                    <td className="table-td">
                      <span className="badge bg-gray-100 text-gray-700">{item.grade}</span>
                    </td>
                    <td className="table-td font-medium">{fmt$$(item.purchase_price)}</td>
                    <td className="table-td font-medium">{fmt$$(item.current_value)}</td>
                    <td className="table-td">
                      <span
                        className={cn(
                          "flex items-center gap-1 font-semibold text-sm",
                          positive ? "text-green-600" : "text-red-500"
                        )}
                      >
                        {positive ? (
                          <TrendingUp size={13} />
                        ) : (
                          <TrendingDown size={13} />
                        )}
                        {positive ? "+" : ""}
                        {fmt$$(item.unrealized_pnl)}
                      </span>
                    </td>
                    <td className="table-td">
                      <span
                        className={cn(
                          "font-medium",
                          positive ? "text-green-600" : "text-red-500"
                        )}
                      >
                        {positive ? "+" : ""}
                        {fmtPct(item.pnl_pct)}
                      </span>
                    </td>
                    <td className="table-td">
                      <code className="text-xs font-mono bg-gray-100 px-1.5 py-0.5 rounded">
                        {item.cert_number}
                      </code>
                    </td>
                    <td className="table-td text-muted text-xs">{item.purchase_date}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
