import { useState, useEffect } from "react";
import { Home } from "./pages/Home";
import { DealHunt } from "./pages/DealHunt";
import { Voice } from "./pages/Voice";

type Page = "home" | "hunt" | "voice";

function getPage(): Page {
  if (window.location.hash === "#hunt") return "hunt";
  if (window.location.hash === "#voice") return "voice";
  return "home";
}

const TABS: { id: Page; href: string; label: string; desc: string }[] = [
  { id: "home",  href: "#",      label: "Dashboard", desc: "Live deal feed + system status" },
  { id: "hunt",  href: "#hunt",  label: "Hunt",       desc: "Search deals + import Collectr" },
  { id: "voice", href: "#voice", label: "Voice",      desc: "Ask in plain English" },
];

export default function App() {
  const [page, setPage] = useState<Page>(getPage);

  useEffect(() => {
    const onHash = () => setPage(getPage());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <>
      {/* Top nav bar */}
      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-white/10 bg-gray-950/90 backdrop-blur px-4 flex items-center gap-1 h-12">
        <span className="font-serif text-white mr-4 text-sm">CardHero</span>
        {TABS.map((t) => (
          <a
            key={t.id}
            href={t.href}
            onClick={() => setPage(t.id)}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors flex flex-col items-start leading-tight ${
              page === t.id
                ? "bg-indigo-600 text-white"
                : "text-gray-400 hover:text-white hover:bg-white/5"
            }`}
          >
            <span>{t.label}</span>
            <span className={`text-[9px] font-normal ${page === t.id ? "text-indigo-200" : "text-gray-600"}`}>{t.desc}</span>
          </a>
        ))}
      </nav>

      <div className="pt-12">
        {page === "home" ? <Home /> : page === "hunt" ? <DealHunt /> : <Voice />}
      </div>
    </>
  );
}
