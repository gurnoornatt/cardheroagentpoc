import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function fmt$$(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

export function fmtPct(n: number | null | undefined, decimals = 1): string {
  if (n == null) return "—";
  return `${n.toFixed(decimals)}%`;
}

export function fmtScore(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toFixed(3);
}

export function fmtMs(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${n.toLocaleString()}ms`;
}

export function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export const STATUS_COLORS: Record<string, string> = {
  PENDING: "bg-yellow-50 text-yellow-700 border border-yellow-200",
  ANALYZING: "bg-blue-50 text-blue-700 border border-blue-200",
  BOUGHT: "bg-green-50 text-green-700 border border-green-200",
  REJECTED: "bg-red-50 text-red-600 border border-red-200",
  BUY_IT_NOW: "bg-purple-50 text-purple-700 border border-purple-200",
  AUCTION: "bg-orange-50 text-orange-700 border border-orange-200",
};

export const MODEL_COLORS: Record<string, string> = {
  // OpenRouter models (current)
  "google/gemini-3-flash-preview": "#4285F4",
  "openai/gpt-5-nano": "#10B981",
  "anthropic/claude-sonnet-4-5": "#D97706",
  // Legacy (seed backward compat)
  "google/gemini-2.5-flash": "#4285F4",
  "claude-sonnet-4-6": "#D97706",
  "gpt-4o": "#10B981",
};
