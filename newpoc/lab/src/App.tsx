import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Wifi, WifiOff } from "lucide-react";
import { api } from "./lib/api";
import { cn } from "./lib/utils";
import { Deals } from "./pages/Deals";
import { Lab } from "./pages/Lab";
import { Pipeline } from "./pages/Pipeline";

type Tab = "run" | "deals" | "lab";

const TABS: { id: Tab; label: string }[] = [
  { id: "run", label: "Run" },
  { id: "deals", label: "Deals" },
  { id: "lab", label: "Lab" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("run");

  const { data: health, isError } = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    refetchInterval: 5000,
    retry: false,
  });

  const isOnline = !isError && health?.status === "ok";

  return (
    <div className="min-h-screen bg-canvas">
      <header className="bg-white border-b border-border sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 h-12 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <span className="font-serif text-gray-900">CardHero</span>
            <nav className="flex gap-1">
              {TABS.map(({ id, label }) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={cn(
                    "px-3 py-1.5 text-sm rounded-lg transition-colors",
                    tab === id
                      ? "bg-gray-100 text-gray-900 font-medium"
                      : "text-muted hover:text-gray-700 hover:bg-gray-50"
                  )}
                >
                  {label}
                </button>
              ))}
            </nav>
          </div>
          <span className={cn("flex items-center gap-1.5 text-xs", isOnline ? "text-green-600" : "text-red-500")}>
            {isOnline ? <Wifi size={13} /> : <WifiOff size={13} />}
            {isOnline ? "Live" : "Offline"}
          </span>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6">
        {tab === "run" && <Pipeline />}
        {tab === "deals" && <Deals health={health} />}
        {tab === "lab" && <Lab />}
      </main>
    </div>
  );
}
