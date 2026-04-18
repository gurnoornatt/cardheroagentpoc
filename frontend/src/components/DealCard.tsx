import type { DealHuntResponse, DealHuntResult } from "../lib/api";

const PLATFORM_COLORS: Record<string, string> = {
  ebay: "bg-yellow-900/60 text-yellow-300",
  mercari: "bg-red-900/60 text-red-300",
  offerup: "bg-green-900/60 text-green-300",
  fb_marketplace: "bg-blue-900/60 text-blue-300",
};

function fmt$(n: number) {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function ScoreBadge({ score }: { score: number }) {
  const color =
    score >= 0.6 ? "text-green-400" : score >= 0.35 ? "text-yellow-400" : "text-red-400";
  return <span className={`font-mono text-xs ${color}`}>{(score * 100).toFixed(0)}%</span>;
}

function ResultRow({ r }: { r: DealHuntResult }) {
  const platformCls = PLATFORM_COLORS[r.platform] ?? "bg-gray-700 text-gray-300";
  return (
    <div className="flex items-start gap-3 border-t border-white/10 pt-2">
      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${platformCls}`}>
        {r.platform}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-gray-200">{r.title}</p>
        <p className="text-[10px] text-gray-500">{r.seller_username} · {r.seller_rating}%</p>
      </div>
      <div className="shrink-0 text-right">
        <p className="font-mono text-xs text-white">{fmt$(r.landed_cost)}</p>
        <ScoreBadge score={r.watchman_score} />
      </div>
      <a
        href={r.url}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0 text-[10px] text-indigo-400 hover:underline"
      >
        View
      </a>
    </div>
  );
}

export function DealCard({ data }: { data: DealHuntResponse }) {
  const passed = data.results.filter((r) => r.filter_passed);
  const failed = data.results.filter((r) => !r.filter_passed);

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-white">Deal Search</span>
        <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-semibold text-white">
          {data.filtered_count} / {data.total} passed
        </span>
      </div>

      {passed.length === 0 ? (
        <p className="text-xs text-gray-500">No listings passed the waterfall filter.</p>
      ) : (
        <div className="space-y-2">
          {passed.map((r, i) => (
            <ResultRow key={i} r={r} />
          ))}
        </div>
      )}

      {failed.length > 0 && (
        <details className="text-[10px] text-gray-600">
          <summary className="cursor-pointer hover:text-gray-400">
            {failed.length} filtered out
          </summary>
          <div className="mt-1 space-y-1">
            {failed.map((r, i) => (
              <p key={i} className="truncate">
                {r.title.slice(0, 60)} — {r.filter_reason}
              </p>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
