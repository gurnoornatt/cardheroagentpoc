import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TrendingUp, TrendingDown } from "lucide-react";
import { api, type CollectrImportResponse } from "../lib/api";
import { fmt$$, cn } from "../lib/utils";

function CollectrModal({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CollectrImportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  async function submit() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.collectrImport(url.trim());
      setResult(data);
      qc.invalidateQueries({ queryKey: ["want-list"] });
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } }; message?: string })
        ?.response?.data?.detail ?? String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-2xl p-6 space-y-4">
        <h3 className="font-semibold text-gray-900">Import from Collectr</h3>
        <p className="text-sm text-gray-500">
          Paste a public Collectr showcase URL. PSA-graded cards will be added to your want list
          at 80% of their current Collectr value.
        </p>

        {!result ? (
          <>
            <input
              type="url"
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              placeholder="https://app.getcollectr.com/showcase/profile/..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={loading}
            />
            {error && <p className="text-xs text-red-600">{error}</p>}
            {loading && (
              <p className="text-xs text-gray-500 italic">
                Opening Browserbase session to read your showcase… this takes 20–30s
              </p>
            )}
            <div className="flex gap-2 justify-end">
              <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={loading || !url.includes("getcollectr.com")}
                className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {loading ? "Importing…" : "Import"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 space-y-1">
              <p className="text-sm font-medium text-green-800">Import complete</p>
              <p className="text-xs text-green-700">
                {result.cards_found} cards found · {result.imported_count} added to want list · {result.skipped_count} skipped
              </p>
            </div>
            {result.want_list_additions.length > 0 && (
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {result.want_list_additions.map((w, i) => (
                  <div key={i} className="flex justify-between text-xs text-gray-700 border-t pt-1">
                    <span>{w.name} <span className="text-gray-400">{w.grade}</span></span>
                    <span className={w.is_active ? "text-gray-900" : "text-yellow-600"}>
                      {w.max_price > 0 ? fmt$$(w.max_price) : "⚠ needs price"}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <button onClick={onClose} className="w-full rounded bg-gray-100 py-2 text-sm text-gray-700 hover:bg-gray-200">
              Done
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function WantList() {
  const [showImport, setShowImport] = useState(false);
  const { data: items = [], isLoading } = useQuery({
    queryKey: ["want-list"],
    queryFn: api.wantList,
    refetchInterval: 30_000,
  });

  return (
    <div className="space-y-4">
      {showImport && <CollectrModal onClose={() => setShowImport(false)} />}
      <div className="flex items-center justify-between">
        <h2 className="font-serif text-lg text-gray-900">Want List</h2>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowImport(true)}
            className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 transition-colors"
          >
            Import from Collectr
          </button>
          <span className="text-sm text-muted">{items.length} active</span>
        </div>
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
