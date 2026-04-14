/**
 * Voice + Generative UI
 *
 * Connects to OpenAI Realtime API via an ephemeral key from /api/voice/session.
 * User holds push-to-talk → speaks a query → tool call fires → CardHero endpoint
 * is called → matching UI component renders with live data.
 *
 * Tool → Component map:
 *   search_deals   → DealCard
 *   get_portfolio  → PortfolioCard
 *   get_want_list  → WantListCard
 *   get_budget     → BudgetCard
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type DealHuntResponse, type Health, type PortfolioItem, type WantListItem } from "../lib/api";
import { BudgetCard } from "../components/BudgetCard";
import { DealCard } from "../components/DealCard";
import { PortfolioCard } from "../components/PortfolioCard";
import { WantListCard } from "../components/WantListCard";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
}

type CardData =
  | { tool: "search_deals"; data: DealHuntResponse }
  | { tool: "get_portfolio"; data: PortfolioItem[] }
  | { tool: "get_want_list"; data: WantListItem[] }
  | { tool: "get_budget"; data: Health }
  | { tool: "get_deals"; data: unknown };

// ---------------------------------------------------------------------------
// Tool definitions sent to Realtime API
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    type: "function",
    name: "search_deals",
    description:
      "Search multiple marketplaces for a specific Pokémon card and return ranked deal results.",
    parameters: {
      type: "object",
      properties: {
        card_name: { type: "string", description: "Card name e.g. 'Charizard ex'" },
        grade: { type: "string", description: "PSA grade e.g. 'PSA 10'" },
        max_price: { type: "number", description: "Maximum landed cost in USD" },
      },
      required: ["card_name", "grade", "max_price"],
    },
  },
  {
    type: "function",
    name: "get_portfolio",
    description: "Get the current card portfolio with P&L data.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "get_want_list",
    description: "Get the active want list — cards CardHero is hunting.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "get_deals",
    description: "Get recent deals filtered by status.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["ALL", "ANALYZING", "BOUGHT", "REJECTED", "PENDING"],
          description: "Deal status filter",
        },
      },
    },
  },
  {
    type: "function",
    name: "get_budget",
    description: "Get today's spend and remaining budget.",
    parameters: { type: "object", properties: {} },
  },
];

const SYSTEM_INSTRUCTIONS = `You are CardHero, an AI assistant for a Pokémon card deal-hunting system.
You help users search for underpriced PSA-graded cards across multiple marketplaces,
monitor their portfolio, and track their want list.

When the user asks about deals, call search_deals with the card name, grade, and max price.
When they ask about their collection or portfolio, call get_portfolio.
When they ask what cards are being hunted, call get_want_list.
When they ask about the budget, call get_budget.
Only call each tool once per user query. Keep responses concise.`;

// ---------------------------------------------------------------------------
// Max session duration — caps cost at ~$0.30 per session
// ---------------------------------------------------------------------------
const MAX_SESSION_MS = 120_000;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Voice() {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [cards, setCards] = useState<CardData[]>([]);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sessionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingToolCallsRef = useRef<Map<string, { name: string; args: string }>>(new Map());

  // Cleanup
  const disconnect = useCallback(() => {
    if (sessionTimerRef.current) clearTimeout(sessionTimerRef.current);
    if (processorRef.current) { processorRef.current.disconnect(); processorRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    if (audioCtxRef.current) { audioCtxRef.current.close(); audioCtxRef.current = null; }
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
    setConnected(false);
    setListening(false);
  }, []);

  useEffect(() => () => disconnect(), [disconnect]);

  // Tool handler — calls CardHero backend then sends result back to Realtime API
  const executeTool = useCallback(
    async (callId: string, toolName: string, argsJson: string) => {
      let result: unknown;
      try {
        const args = JSON.parse(argsJson);
        if (toolName === "search_deals") {
          const data = await api.dealHunt(
            args.card_name,
            args.grade,
            args.max_price,
            ["ebay"]
          );
          setCards((prev) => [...prev, { tool: "search_deals", data }]);
          result = data;
        } else if (toolName === "get_portfolio") {
          const data = await api.portfolio();
          setCards((prev) => [...prev, { tool: "get_portfolio", data }]);
          result = data;
        } else if (toolName === "get_want_list") {
          const data = await api.wantList();
          setCards((prev) => [...prev, { tool: "get_want_list", data }]);
          result = data;
        } else if (toolName === "get_budget") {
          const data = await api.health();
          setCards((prev) => [...prev, { tool: "get_budget", data }]);
          result = data;
        } else if (toolName === "get_deals") {
          const data = await api.deals(args.status === "ALL" ? undefined : args.status);
          setCards((prev) => [...prev, { tool: "get_deals", data }]);
          result = data;
        } else {
          result = { error: "unknown tool" };
        }
      } catch (err) {
        result = { error: String(err) };
      }

      // Send tool result back to Realtime API
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output: JSON.stringify(result),
            },
          })
        );
        wsRef.current.send(JSON.stringify({ type: "response.create" }));
      }
    },
    []
  );

  // Handle incoming WebSocket messages
  const handleWsMessage = useCallback(
    (event: MessageEvent) => {
      const msg = JSON.parse(event.data as string);

      switch (msg.type) {
        case "response.audio_transcript.delta":
          setTranscript((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "assistant") {
              return [...prev.slice(0, -1), { role: "assistant", text: last.text + msg.delta }];
            }
            return [...prev, { role: "assistant", text: msg.delta }];
          });
          break;

        case "conversation.item.input_audio_transcription.completed":
          setTranscript((prev) => [...prev, { role: "user", text: msg.transcript }]);
          break;

        case "response.function_call_arguments.delta": {
          const existing = pendingToolCallsRef.current.get(msg.call_id) ?? {
            name: msg.name ?? "",
            args: "",
          };
          pendingToolCallsRef.current.set(msg.call_id, {
            name: existing.name || msg.name,
            args: existing.args + (msg.delta ?? ""),
          });
          break;
        }

        case "response.function_call_arguments.done": {
          const call = pendingToolCallsRef.current.get(msg.call_id);
          if (call) {
            pendingToolCallsRef.current.delete(msg.call_id);
            executeTool(msg.call_id, call.name, call.args);
          }
          break;
        }

        case "error":
          setError(`Realtime API error: ${msg.error?.message ?? JSON.stringify(msg.error)}`);
          break;
      }
    },
    [executeTool]
  );

  // Connect to Realtime API
  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const session = await api.voiceSession();
      const key = session?.client_secret?.value;
      if (!key) throw new Error("No ephemeral key returned from /voice/session");

      const ws = new WebSocket(
        `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17`,
        ["realtime", `openai-insecure-api-key.${key}`, "openai-beta.realtime-v1"]
      );

      ws.onopen = () => {
        // Configure session
        ws.send(
          JSON.stringify({
            type: "session.update",
            session: {
              instructions: SYSTEM_INSTRUCTIONS,
              tools: TOOLS,
              tool_choice: "auto",
              input_audio_transcription: { model: "whisper-1" },
              turn_detection: null, // push-to-talk — no VAD
            },
          })
        );
        setConnected(true);
        setConnecting(false);

        // Auto-disconnect after MAX_SESSION_MS
        sessionTimerRef.current = setTimeout(() => {
          setTranscript((prev) => [
            ...prev,
            { role: "assistant", text: "[Session ended — 2 min limit reached. Reconnect to continue.]" },
          ]);
          disconnect();
        }, MAX_SESSION_MS);
      };

      ws.onmessage = handleWsMessage;

      ws.onerror = () => {
        setError("WebSocket error — check console");
        setConnecting(false);
      };

      ws.onclose = () => {
        setConnected(false);
        setListening(false);
        setConnecting(false);
      };

      wsRef.current = ws;
    } catch (err) {
      setError(String(err));
      setConnecting(false);
    }
  }, [handleWsMessage, disconnect]);

  // Push-to-talk: start capturing mic audio and stream PCM16 to WebSocket
  const startListening = useCallback(async () => {
    if (!connected || !wsRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioCtx = new AudioContext({ sampleRate: 24000 });
      audioCtxRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      // ScriptProcessorNode is deprecated but still universally supported
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        const float32 = e.inputBuffer.getChannelData(0);
        // Convert Float32 → PCM16 → base64
        const pcm16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          pcm16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768));
        }
        const bytes = new Uint8Array(pcm16.buffer);
        let binary = "";
        bytes.forEach((b) => (binary += String.fromCharCode(b)));
        const base64 = btoa(binary);

        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({ type: "input_audio_buffer.append", audio: base64 })
          );
        }
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);

      wsRef.current.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
      setListening(true);
    } catch (err) {
      setError(`Microphone error: ${err}`);
    }
  }, [connected]);

  const stopListening = useCallback(() => {
    if (processorRef.current) { processorRef.current.disconnect(); processorRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    if (audioCtxRef.current) { audioCtxRef.current.close(); audioCtxRef.current = null; }

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      wsRef.current.send(JSON.stringify({ type: "response.create" }));
    }
    setListening(false);
  }, []);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="min-h-screen bg-gray-950 text-white p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">CardHero Voice</h1>
            <p className="text-xs text-gray-500 mt-0.5">
              Ask about deals, portfolio, want list, or budget
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                connected ? "bg-green-400" : "bg-gray-600"
              }`}
            />
            <span className="text-xs text-gray-400">{connected ? "Connected" : "Disconnected"}</span>
          </div>
        </div>

        {error && (
          <div className="rounded border border-red-800 bg-red-950/50 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}

        {/* Connect / Disconnect */}
        {!connected ? (
          <button
            onClick={connect}
            disabled={connecting}
            className="w-full rounded-lg bg-indigo-600 py-3 text-sm font-semibold hover:bg-indigo-500 disabled:opacity-50 transition-colors"
          >
            {connecting ? "Connecting…" : "Connect"}
          </button>
        ) : (
          <div className="flex gap-3">
            <button
              onMouseDown={startListening}
              onMouseUp={stopListening}
              onTouchStart={startListening}
              onTouchEnd={stopListening}
              className={`flex-1 rounded-lg py-4 text-sm font-semibold transition-colors select-none ${
                listening
                  ? "bg-red-600 hover:bg-red-500 animate-pulse"
                  : "bg-indigo-600 hover:bg-indigo-500"
              }`}
            >
              {listening ? "🎤 Listening…" : "Hold to Talk"}
            </button>
            <button
              onClick={disconnect}
              className="rounded-lg border border-white/10 px-4 text-xs text-gray-400 hover:text-white hover:border-white/30 transition-colors"
            >
              Disconnect
            </button>
          </div>
        )}

        {/* Rendered UI cards from tool calls */}
        {cards.length > 0 && (
          <div className="space-y-3">
            {cards.map((c, i) => {
              if (c.tool === "search_deals")
                return <DealCard key={i} data={c.data} />;
              if (c.tool === "get_portfolio")
                return <PortfolioCard key={i} data={c.data} />;
              if (c.tool === "get_want_list")
                return <WantListCard key={i} data={c.data} />;
              if (c.tool === "get_budget")
                return <BudgetCard key={i} data={c.data} />;
              return null;
            })}
          </div>
        )}

        {/* Transcript */}
        {transcript.length > 0 && (
          <div className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">
              Transcript
            </p>
            {transcript.map((t, i) => (
              <div key={i} className={`flex ${t.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[80%] rounded-lg px-3 py-2 text-xs ${
                    t.role === "user"
                      ? "bg-indigo-600 text-white"
                      : "bg-white/10 text-gray-200"
                  }`}
                >
                  {t.text}
                </div>
              </div>
            ))}
          </div>
        )}

        {connected && transcript.length === 0 && cards.length === 0 && (
          <div className="text-center py-12 text-gray-600 text-sm space-y-1">
            <p>Hold the button and ask something like:</p>
            <p className="text-gray-500 italic">"Find me a Charizard PSA 10 under $400"</p>
            <p className="text-gray-500 italic">"Show my portfolio"</p>
            <p className="text-gray-500 italic">"What's my budget today?"</p>
          </div>
        )}
      </div>
    </div>
  );
}
