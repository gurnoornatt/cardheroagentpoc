import { useQuery } from "@tanstack/react-query";
import { TrendingUp, TrendingDown } from "lucide-react";
import { api } from "../lib/api";
import { fmt$$, cn } from "../lib/utils";

export function WantList() {
  const { data: items = [], isLoading } = useQuery({
    queryKey: ["want-list"],
    queryFn: api.wantList,
    refetchInterval: 30_000,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-serif text-lg text-gray-900">Want List</h2>
        <span className="text-sm text-muted">{items.length} active</span>
      </div>

      <div className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="table-th">Card</th>
                <th className="table-th">Grade</th>
                <th className="table-th">Max Price</th>
                <th className="table-th">Market Avg</th>
                <th className="table-th">Headroom</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={5} className="text-center py-12 text-muted text-sm">Loading…</td></tr>
              )}
              {items.map((item) => {
                const headroom = item.sanitized_avg != null ? item.max_price - item.sanitized_avg : null;
                const good = headroom != null && headroom >= 100;

                return (
                  <tr key={item.id} className="table-row">
                    <td className="table-td">
                      <p className="font-semibold text-gray-900">{item.name}</p>
                      {item.set_name && <p className="text-xs text-muted">{item.set_name}</p>}
                    </td>
                    <td className="table-td">
                      <span className="badge bg-gray-100 text-gray-700">{item.grade}</span>
                    </td>
                    <td className="table-td font-medium">{fmt$$(item.max_price)}</td>
                    <td className="table-td">
                      {item.sanitized_avg != null
                        ? <span className="font-medium">{fmt$$(item.sanitized_avg)}</span>
                        : <span className="text-xs text-muted italic">no data</span>}
                    </td>
                    <td className="table-td">
                      {headroom != null ? (
                        <span className={cn("flex items-center gap-1 font-medium text-sm", good ? "text-green-600" : "text-yellow-600")}>
                          {good ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                          {fmt$$(headroom)}
                        </span>
                      ) : <span className="text-muted">—</span>}
                    </td>
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
