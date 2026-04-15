import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sun, Moon } from "lucide-react";
import { Home } from "./pages/Home";
import { WantList } from "./pages/WantList";
import { DealHunt } from "./pages/DealHunt";
import { Voice } from "./pages/Voice";
import { api } from "./lib/api";

type Page = "home" | "targets" | "hunt" | "voice";

function getPage(): Page {
  if (window.location.hash === "#targets") return "targets";
  if (window.location.hash === "#hunt") return "hunt";
  if (window.location.hash === "#voice") return "voice";
  return "home";
}

function useDarkMode() {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark")
  );
  function toggle() {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("ch-theme", next ? "dark" : "light");
    setDark(next);
  }
  return { dark, toggle };
}

export default function App() {
  const [page, setPage] = useState<Page>(getPage);
  const { dark, toggle: toggleDark } = useDarkMode();

  useEffect(() => {
    const onHash = () => setPage(getPage());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const { data: watchman } = useQuery({
    queryKey: ["watchman-status"],
    queryFn: api.watchmanStatus,
    refetchInterval: 30_000,
  });

  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    refetchInterval: 10_000,
    retry: false,
  });

  const isApiOnline = !!health && health.status === "ok";

  const scanStatus = watchman?.status ?? "offline";
  const dotColor =
    !isApiOnline ? "bg-red-500" :
    scanStatus === "running" ? "bg-green-400 animate-pulse" :
    scanStatus === "blocked" ? "bg-yellow-400" :
    "bg-gray-600";
  const dotLabel =
    !isApiOnline ? "API offline" :
    scanStatus === "running" ? "Scanning" :
    scanStatus === "blocked" ? "Blocked" :
    "Idle";

  const NAV_LINKS: { id: Page; href: string; label: string }[] = [
    { id: "targets", href: "#targets", label: "Targets" },
    { id: "hunt",    href: "#hunt",    label: "Hunt" },
    { id: "voice",   href: "#voice",   label: "Voice" },
  ];

  return (
    <>
      <nav className="fixed top-0 left-0 right-0 z-50 h-11 flex items-center justify-between px-5 border-b border-white/5 bg-gray-950/95 backdrop-blur">
        {/* Left: logo — clicking goes home */}
        <a
          href="#"
          onClick={() => setPage("home")}
          className="font-display font-semibold text-white text-sm tracking-tight hover:opacity-80 transition-opacity"
        >
          CardHero
        </a>

        {/* Right: secondary links + status dot + theme toggle */}
        <div className="flex items-center gap-5">
          <div className="flex items-center gap-4">
            {NAV_LINKS.map((t) => (
              <a
                key={t.id}
                href={t.href}
                onClick={() => setPage(t.id)}
                className={`text-xs transition-colors ${
                  page === t.id ? "text-white" : "text-gray-600 hover:text-gray-400"
                }`}
              >
                {t.label}
              </a>
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
            <span className="text-xs text-gray-600">{dotLabel}</span>
          </div>

          <button
            onClick={toggleDark}
            className="text-gray-600 hover:text-gray-400 transition-colors"
            aria-label="Toggle dark mode"
          >
            {dark ? <Sun size={13} /> : <Moon size={13} />}
          </button>
        </div>
      </nav>

      <div className="pt-11">
        {page === "home" ? <Home /> :
         page === "targets" ? <WantList /> :
         page === "hunt" ? <DealHunt /> :
         <Voice />}
      </div>
    </>
  );
}
