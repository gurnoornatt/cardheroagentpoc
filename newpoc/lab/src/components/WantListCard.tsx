import type { WantListItem } from "../lib/api";

function fmt$(n: number) {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function WantListCard({ data }: { data: WantListItem[] }) {
  const active = data.filter((w) => w.is_active);

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-white">Want List</span>
        <span className="text-xs text-gray-400">{active.length} active targets</span>
      </div>

      <div className="space-y-1.5">
        {active.slice(0, 6).map((w) => (
          <div key={w.id} className="flex items-center justify-between border-t border-white/10 pt-1.5">
            <div className="min-w-0">
              <p className="truncate text-xs text-gray-200">{w.name}</p>
              <p className="text-[10px] text-gray-500">{w.grade}{w.set_name ? ` · ${w.set_name}` : ""}</p>
            </div>
            <div className="shrink-0 text-right">
              <p className="font-mono text-xs text-white">max {fmt$(w.max_price)}</p>
              {w.sanitized_avg != null && (
                <p className="text-[10px] text-gray-500">avg {fmt$(w.sanitized_avg)}</p>
              )}
            </div>
          </div>
        ))}
        {active.length > 6 && (
          <p className="text-[10px] text-gray-600">+{active.length - 6} more…</p>
        )}
      </div>
    </div>
  );
}
