import { cn, STATUS_COLORS } from "../lib/utils";

interface Props {
  status: string;
  className?: string;
}

const STATUS_DOTS: Record<string, string> = {
  ANALYZING: "bg-blue-500 live-dot",
  PENDING: "bg-yellow-500",
  BOUGHT: "bg-green-500",
  REJECTED: "bg-red-400",
};

export function StatusBadge({ status, className }: Props) {
  const dotClass = STATUS_DOTS[status];
  return (
    <span className={cn("badge", STATUS_COLORS[status] ?? "bg-gray-100 text-gray-600", className)}>
      {dotClass && <span className={cn("inline-block w-1.5 h-1.5 rounded-full", dotClass)} />}
      {status}
    </span>
  );
}
