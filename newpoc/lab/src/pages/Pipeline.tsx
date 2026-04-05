import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, CheckCircle, XCircle, Clock, Loader } from "lucide-react";
import { api, type Deal, type LabRun } from "../lib/api";
import { fmt$$, fmtMs, MODEL_COLORS, cn } from "../lib/utils";

const STEPS = [
  { id: "create",   label: "Deal created",         desc: "URL submitted to pipeline" },
  { id: "extract",  label: "Extraction running",    desc: "Agent reading eBay listing via Browserbase" },
  { id: "checkout", label: "Walking checkout",      desc: "Agent navigating to payment screen" },
  { id: "ab",       label: "A/B model comparison",  desc: "Gemini + GPT-5 Nano extracting same listing" },
];

type Phase = "idle" | "running" | "done" | "error";

function label(m: string) {
  const map: Record<string, string> = {
    "google/gemini-3-flash-preview": "Gemini 3 Flash",
    "openai/gpt-5-nano": "GPT-5 Nano",
  };
  return map[m] ?? m;
}

function color(m: string) {
  return MODEL_COLORS[m] ?? "#6B7280";
}

function StepRow({
  step,
  currentStatus,
  index,
  activeStep,
}: {
  step: (typeof STEPS)[number];
  currentStatus: string | null;
  index: number;
  activeStep: number;
}) {
  const done = index < activeStep;
  const active = index === activeStep;

  return (
    <div className={cn("flex items-start gap-3 p-3 rounded-lg transition-colors", active && "bg-blue-50")}>
      <div className="mt-0.5 shrink-0">
        {done ? (
          <CheckCircle size={18} className="text-green-500" />
        ) : active ? (
          <Loader size={18} className="text-blue-500 animate-spin" />
        ) : (
          <Clock size={18} className="text-gray-300" />
        )}
      </div>
      <div>
        <p className={cn("text-sm font-medium", done ? "text-gray-700" : active ? "text-blue-700" : "text-gray-400")}>
          {step.label}
        </p>
        <p className={cn("text-xs", done || active ? "text-muted" : "text-gray-300")}>{step.desc}</p>
        {active && currentStatus && (
          <p className="text-xs text-blue-500 mt-0.5">{currentStatus}</p>
        )}
      </div>
    </div>
  );
}

function AbCard({ run }: { run: LabRun }) {
  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border border-border bg-white">
      <div
        className="w-2 h-10 rounded-full shrink-0"
        style={{ backgroundColor: color(run.model) }}
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900">{label(run.model)}</p>
        <p className="text-xs text-muted truncate">
          cert: {run.extracted_cert ?? "—"} · price: {run.extracted_price != null ? fmt$$(run.extracted_price) : "—"}
        </p>
      </div>
      <div className="text-right shrink-0">
        <div className="flex items-center gap-1.5 justify-end">
          {run.cert_correct != null ? (
            run.cert_correct ? (
              <CheckCircle size={14} className="text-green-500" />
            ) : (
              <XCircle size={14} className="text-red-400" />
            )
          ) : null}
          <span className="text-xs text-muted">{fmtMs(run.latency_ms)}</span>
        </div>
        {run.cert_correct != null && (
          <p className={cn("text-xs font-medium mt-0.5", run.cert_correct ? "text-green-600" : "text-red-500")}>
            {run.cert_correct ? "cert match" : "cert mismatch"}
          </p>
        )}
      </div>
    </div>
  );
}

export function Pipeline() {
  const [url, setUrl] = useState("");
  const [maxPrice, setMaxPrice] = useState("500");
  const [phase, setPhase] = useState<Phase>("idle");
  const [dealId, setDealId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeStep, setActiveStep] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll the deal status while running
  const { data: deal } = useQuery<Deal>({
    queryKey: ["pipeline-deal", dealId],
    queryFn: () => api.deal(dealId!),
    enabled: phase === "running" && dealId != null,
    refetchInterval: 3000,
  });

  // Poll for A/B lab runs on this deal
  const { data: allRuns = [] } = useQuery<LabRun[]>({
    queryKey: ["lab-runs"],
    queryFn: api.labRuns,
    enabled: dealId != null,
    refetchInterval: phase === "running" ? 5000 : false,
  });

  const abRuns = allRuns.filter((r) => r.deal_id === dealId);

  // Derive active step from deal status
  useEffect(() => {
    if (!deal) return;
    if (deal.status === "ANALYZING") {
      setActiveStep(2); // checkout step
    } else if (deal.status === "BOUGHT" || deal.status === "REJECTED") {
      if (abRuns.length >= 2) {
        setActiveStep(4); // all done
        setPhase("done");
      } else {
        setActiveStep(3); // waiting for A/B
      }
    }
  }, [deal, abRuns.length]);

  async function handleRun() {
    const trimmed = url.trim();
    if (!trimmed || !trimmed.includes("ebay.com/itm/")) {
      setError("Paste a valid eBay listing URL (must contain /itm/)");
      return;
    }
    const price = parseFloat(maxPrice);
    if (!price || price <= 0) {
      setError("Enter a valid max price");
      return;
    }

    setError(null);
    setPhase("running");
    setActiveStep(0);
    setDealId(null);

    try {
      const result = await api.runPipeline(trimmed, price);
      setDealId(result.deal_id);
      setActiveStep(1);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  function handleReset() {
    setPhase("idle");
    setDealId(null);
    setActiveStep(0);
    setError(null);
    setUrl("");
    if (pollRef.current) clearInterval(pollRef.current);
  }

  const rejectionReason = (() => {
    if (!deal?.audit_log?.agent_extraction_json) return null;
    try {
      const j = JSON.parse(deal.audit_log.agent_extraction_json);
      return j._rejection_reason ?? null;
    } catch { return null; }
  })();

  const guestUnavailable =
    rejectionReason?.includes("checkout_blocked") ||
    rejectionReason?.includes("signin");

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-serif text-lg text-gray-900">Run Pipeline</h2>
        <p className="text-sm text-muted mt-1">
          Paste any eBay listing URL — the agent extracts, verifies, and walks checkout. Both AI models analyze the same listing.
        </p>
      </div>

      {/* Input panel */}
      {phase === "idle" && (
        <div className="card space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">eBay Listing URL</label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.ebay.com/itm/123456789"
              className="w-full border border-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Max Price (USD)</label>
            <input
              type="number"
              min="1"
              value={maxPrice}
              onChange={(e) => setMaxPrice(e.target.value)}
              className="w-32 border border-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </div>
          {error && <p className="text-xs text-red-500">{error}</p>}
          <button
            onClick={handleRun}
            className="px-4 py-2 bg-gray-900 text-white text-sm font-medium rounded hover:bg-gray-700 transition-colors"
          >
            Run Full Pipeline
          </button>
          <p className="text-xs text-muted">
            Agent runs in a real Browserbase cloud browser with residential proxy. No purchase is made — stops before "Confirm and pay".
          </p>
        </div>
      )}

      {/* Progress view */}
      {(phase === "running" || phase === "done") && (
        <div className="space-y-4">
          {/* Steps */}
          <div className="card divide-y divide-border p-0 overflow-hidden">
            {STEPS.map((step, i) => (
              <StepRow
                key={step.id}
                step={step}
                index={i}
                activeStep={activeStep}
                currentStatus={null}
              />
            ))}
          </div>

          {/* Deal card — show once deal is created */}
          {deal && (
            <div className="card space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-xs text-muted">Deal #{deal.id}</p>
                  <a
                    href={deal.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-blue-600 hover:underline flex items-center gap-1"
                  >
                    View on eBay <ExternalLink size={12} />
                  </a>
                </div>
                <span
                  className={cn(
                    "text-xs px-2 py-0.5 rounded-full font-medium",
                    deal.status === "BOUGHT"
                      ? "bg-green-50 text-green-700 border border-green-200"
                      : deal.status === "ANALYZING"
                      ? "bg-blue-50 text-blue-700 border border-blue-200"
                      : "bg-red-50 text-red-600 border border-red-200"
                  )}
                >
                  {deal.status}
                </span>
              </div>

              {/* Extraction result */}
              {deal.audit_log && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-muted">PSA Cert</p>
                    <p className="font-medium text-gray-900">{deal.audit_log.verified_cert ?? "—"}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted">Price locked</p>
                    <p className="font-medium text-gray-900">{fmt$$(deal.audit_log.price_locked)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted">PSA Pop (10 / Total)</p>
                    <p className="font-medium text-gray-900">
                      {deal.audit_log.psa_pop_grade10 ?? "?"} / {deal.audit_log.psa_pop_total ?? "?"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted">Auth Guarantee</p>
                    <p className="font-medium text-gray-900">
                      {deal.audit_log.authenticity_guaranteed == null
                        ? "—"
                        : deal.audit_log.authenticity_guaranteed
                        ? "Yes"
                        : "No"}
                    </p>
                  </div>
                </div>
              )}

              {/* Checkout outcome */}
              {deal.status !== "ANALYZING" && (
                <div className={cn(
                  "rounded-lg p-3 text-sm",
                  deal.status === "BOUGHT"
                    ? "bg-green-50 border border-green-200 text-green-800"
                    : guestUnavailable
                    ? "bg-yellow-50 border border-yellow-200 text-yellow-800"
                    : "bg-red-50 border border-red-200 text-red-800"
                )}>
                  {deal.status === "BOUGHT" ? (
                    <p><span className="font-semibold">Checkout reached.</span> Agent stopped before "Confirm and pay" (dry run mode).</p>
                  ) : guestUnavailable ? (
                    <p><span className="font-semibold">Guest checkout unavailable.</span> eBay requires sign-in for this listing — likely a high-value item or restricted seller.</p>
                  ) : rejectionReason ? (
                    <p><span className="font-semibold">Rejected:</span> {rejectionReason}</p>
                  ) : (
                    <p>Pipeline finished.</p>
                  )}
                </div>
              )}

              {deal.audit_log?.screenshot_path && (
                <p className="text-xs text-muted">
                  Screenshot: <code className="bg-gray-100 px-1 rounded">{deal.audit_log.screenshot_path}</code>
                </p>
              )}
            </div>
          )}

          {/* A/B model results */}
          {abRuns.length > 0 && (
            <div className="card space-y-3">
              <h3 className="text-sm font-semibold text-gray-900">A/B Model Comparison</h3>
              <p className="text-xs text-muted">Both models received the same raw eBay page text and extracted independently.</p>
              <div className="space-y-2">
                {abRuns.map((run) => (
                  <AbCard key={run.id} run={run} />
                ))}
              </div>
              {abRuns.length < 2 && phase === "running" && (
                <p className="text-xs text-muted flex items-center gap-1">
                  <Loader size={12} className="animate-spin" /> Waiting for second model...
                </p>
              )}
            </div>
          )}

          {phase === "done" && (
            <button
              onClick={handleReset}
              className="text-sm text-blue-600 hover:underline"
            >
              Run another listing
            </button>
          )}
        </div>
      )}

      {phase === "error" && (
        <div className="card space-y-3">
          <p className="text-sm text-red-600">{error}</p>
          <button onClick={handleReset} className="text-sm text-blue-600 hover:underline">
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
