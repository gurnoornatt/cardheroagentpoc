import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { fmtMs, fmtPct, MODEL_COLORS, cn } from "../lib/utils";

const MODEL_LABELS: Record<string, string> = {
  "google/gemini-2.5-flash": "Gemini 2.5",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "gpt-4o": "GPT-4o",
};

function label(m: string) { return MODEL_LABELS[m] ?? m; }
function color(m: string) { return MODEL_COLORS[m] ?? "#6B7280"; }

export function Lab() {
  const { data: metrics = {} } = useQuery({
    queryKey: ["lab-metrics"],
    queryFn: api.labMetrics,
    refetchInterval: 10_000,
  });

  const { data: runs = [], isLoading } = useQuery({
    queryKey: ["lab-runs"],
    queryFn: api.labRuns,
    refetchInterval: 10_000,
  });

  const models = Object.entries(metrics).map(([model, m]) => ({ model, ...m }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="font-serif text-lg text-gray-900">Model Lab</h2>
        <span className="text-sm text-muted">{runs.length} runs</span>
      </div>

      {/* Model summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {models.map(({ model, run_count, cert_accuracy, avg_latency_ms }) => {
          const acc = cert_accuracy != null ? cert_accuracy * 100 : null;
          return (
            <div key={model} className="card border-l-4" style={{ borderLeftColor: color(model) }}>
              <div className="flex items-start justify-between mb-2">
                <div>
                  <p className="font-semibold text-gray-900 text-sm">{label(model)}</p>
                  <p className="text-xs text-muted">{run_count} runs · {fmtMs(avg_latency_ms)} avg</p>
                </div>
                <span className={cn("text-xl font-bold",
                  acc == null ? "text-muted" : acc >= 90 ? "text-green-600" : acc >= 70 ? "text-yellow-600" : "text-red-500")}>
                  {acc != null ? fmtPct(acc) : "—"}
                </span>
              </div>
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all duration-700"
                  style={{ width: `${acc ?? 0}%`, backgroundColor: color(model) }} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Run log */}
      <div className="card p-0 overflow-hidden">
        <div className="px-5 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-gray-900">Extraction Runs</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="table-th">Deal</th>
                <th className="table-th">Model</th>
                <th className="table-th">Cert ✓</th>
                <th className="table-th">Price ✓</th>
                <th className="table-th">Latency</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={5} className="text-center py-10 text-muted text-sm">Loading…</td></tr>
              )}
              {!isLoading && runs.length === 0 && (
                <tr><td colSpan={5} className="text-center py-10 text-muted text-sm">No runs yet</td></tr>
              )}
              {runs.map((run) => (
                <tr key={run.id} className="table-row">
                  <td className="table-td font-medium text-gray-900">#{run.deal_id}</td>
                  <td className="table-td">
                    <span className="badge font-medium text-xs"
                      style={{ backgroundColor: color(run.model) + "18", color: color(run.model), border: `1px solid ${color(run.model)}30` }}>
                      {label(run.model)}
                    </span>
                  </td>
                  <td className="table-td">
                    {run.cert_correct == null ? <span className="text-muted">—</span>
                      : run.cert_correct ? <span className="text-green-600 font-bold">✓</span>
                      : <span className="text-red-500 font-bold">✗</span>}
                  </td>
                  <td className="table-td">
                    {run.price_correct == null ? <span className="text-muted">—</span>
                      : run.price_correct ? <span className="text-green-600 font-bold">✓</span>
                      : <span className="text-red-500 font-bold">✗</span>}
                  </td>
                  <td className="table-td">{fmtMs(run.latency_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
