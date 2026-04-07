/**
 * CardHero v2 — Last-Mile Agent ("The Scalpel")
 *
 * Receives a deal candidate from the Conductor, navigates to the eBay listing
 * using a Browserbase cloud browser (persistent session preferred), extracts:
 *   - PSA cert number + prefix verification
 *   - Buy It Now price (price lock guard)
 *   - PSA Grade 10 pop vs Total pop
 *   - Authenticity Guarantee presence
 *
 * Then proceeds through checkout and saves screenshot + DOM snapshot.
 *
 * Credentials NEVER reach the LLM — Stagehand's variables option substitutes
 * them into DOM interactions only, not into the LLM prompt.
 *
 * Usage:
 *   npx ts-node checkout.ts '{"deal_id":1,"url":"...","max_allowed_price":350,"expected_cert_prefix":"POKE"}'
 */

import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

import { Stagehand } from "@browserbasehq/stagehand";
import axios from "axios";
import { z } from "zod";

// Load newpoc/.env (one directory up from agent/)
dotenv.config({ path: path.join(__dirname, "../.env") });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentInput {
  deal_id: number;
  url: string;
  max_allowed_price: number;
  expected_cert_prefix: string;
  dry_run?: boolean; // stops before "Confirm and pay", skips conductor report
}

interface AgentResult {
  deal_id: number;
  session_id: string;
  verified_cert: string | null;
  price_locked: number | null;
  psa_pop_grade10: number | null;
  psa_pop_total: number | null;
  authenticity_guaranteed: boolean | null;
  screenshot_path: string | null;
  dom_snapshot_path: string | null;
  agent_extraction_json: string;
  final_status: "BOUGHT" | "REJECTED";
  rejection_reason: string | null;
  model_used: string;
  extraction_latency_ms: number | null;
  listing_page_text?: string; // raw page text for A/B model comparison
}

// ---------------------------------------------------------------------------
// Zod extraction schema — v2 adds PSA pop + authenticity guarantee
// ---------------------------------------------------------------------------

const ListingSchema = z.object({
  cert_number: z
    .string()
    .describe(
      "PSA certification number on this listing. Usually an 8-digit number, formatted as POKE-12345678 or just 12345678. Return the number exactly as shown. If not visible, return 'NOT_FOUND'.",
    ),
  price: z
    .number()
    .describe(
      "The Buy It Now price in USD as a plain positive number (e.g. 349.99). Look for the large price near the Buy It Now button. If not found return -1.",
    ),
  psa_pop_grade10: z
    .number()
    .optional()
    .describe(
      "PSA population report: number of this card graded PSA 10. Look for a population table, 'Card insights from PSA' block, or PSA registry link. Return 0 if not shown.",
    ),
  psa_pop_total: z
    .number()
    .optional()
    .describe(
      "PSA population report: total number of this card graded at any grade. Return 0 if not shown.",
    ),
  authenticity_guaranteed: z
    .boolean()
    .optional()
    .describe(
      "Whether the listing shows an eBay Authenticity Guarantee badge or similar trust indicator. Return false if not shown.",
    ),
  title: z
    .string()
    .describe("The full listing title text shown at the top of the page."),
  seller_username: z
    .string()
    .describe(
      "The eBay seller's username, shown near 'Seller information' or 'Visit store'. If not found return 'NOT_FOUND'.",
    ),
  condition: z
    .string()
    .describe(
      "The item condition as listed, e.g. 'Graded', 'PSA 10', 'Used'. If not found return 'NOT_FOUND'.",
    ),
});

type Listing = z.infer<typeof ListingSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// On Railway, PORT is injected dynamically. Agent runs in same container so use localhost.
const CONDUCTOR_URL = process.env.CONDUCTOR_URL
  ?? (process.env.PORT ? `http://localhost:${process.env.PORT}` : "http://localhost:8001");
const RECEIPTS_DIR = path.join(__dirname, "../receipts");
const AGENT_BUDGET = parseFloat(process.env.AGENT_BUDGET ?? "150.00");
const MODEL_USED = "openai/gpt-4o-mini";

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postLog(dealId: number, message: string): Promise<void> {
  try {
    await axios.post(`${CONDUCTOR_URL}/deals/${dealId}/log`, { message }, { timeout: 3_000 });
  } catch { /* non-critical — never fail the agent over a log */ }
}

async function reportResult(result: AgentResult): Promise<void> {
  try {
    await axios.post(`${CONDUCTOR_URL}/agent/result`, result, { timeout: 10_000 });
    console.log(
      `[agent] Reported: deal_id=${result.deal_id} status=${result.final_status}`,
    );
  } catch (err) {
    console.error("[agent] Failed to report result to conductor:", err);
  }
}

function makeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function buildProxyConfig(): { server: string; username: string; password: string } | null {
  const base = process.env.RESIDENTIAL_PROXY_URL;
  if (!base) return null;
  // Parse http://user:pass@host:port into separate fields.
  // Browserbase external proxy requires credentials separate from server URL.
  const match = base.match(/^https?:\/\/([^:]+):([^@]+)@(.+)$/);
  if (!match) return null;
  const [, baseUser, password, hostPort] = match;
  // Sticky session: same IP held throughout one run, rotates between runs.
  const sessionId = Math.random().toString(36).substring(2, 12);
  return {
    server: `http://${hostPort}`,
    username: `${baseUser}-session-${sessionId}`,
    password,
  };
}

function extractionValid(e: Listing): boolean {
  return (
    e.price > 0 &&
    e.title !== "null" &&
    e.title !== "NOT_FOUND" &&
    e.title.length > 3
  );
}

// ---------------------------------------------------------------------------
// Main agent flow
// ---------------------------------------------------------------------------

function validateAgentInput(input: AgentInput): void {
  try {
    const parsed = new URL(input.url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (!["ebay.com", "ebay.co.uk", "ebay.ca", "ebay.com.au"].includes(host)) {
      throw new Error(`Unexpected domain: ${host}`);
    }
    if (!input.url.includes("/itm/")) {
      throw new Error("URL must contain /itm/");
    }
  } catch (err) {
    console.error(`[agent] Invalid input URL: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

async function runAgent(input: AgentInput): Promise<void> {
  validateAgentInput(input);
  const itemId = input.url.split("/itm/")[1]?.split("?")[0] ?? "unknown";
  console.log(`[agent] Starting for deal_id=${input.deal_id} item=${itemId}`);
  console.log(`[agent] max_allowed_price=$${input.max_allowed_price} cert_prefix="${input.expected_cert_prefix}"`);
  console.log(`[agent] CONDUCTOR_URL=${CONDUCTOR_URL}`);

  // Validate required env vars up front — loud failure beats silent crash
  const required = ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "OPENAI_API_KEY"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    const msg = `Missing required env vars: ${missing.join(", ")}`;
    console.error(`[agent] FATAL: ${msg}`);
    await postLog(input.deal_id, `ERROR: ${msg}`);
    await reportResult({
      deal_id: input.deal_id,
      session_id: "none",
      verified_cert: null,
      price_locked: null,
      psa_pop_grade10: null,
      psa_pop_total: null,
      authenticity_guaranteed: null,
      screenshot_path: null,
      dom_snapshot_path: null,
      agent_extraction_json: JSON.stringify({ _rejection_reason: msg }),
      final_status: "REJECTED",
      rejection_reason: msg,
      model_used: MODEL_USED,
      extraction_latency_ms: null,
    });
    process.exit(1);
  }

  fs.mkdirSync(RECEIPTS_DIR, { recursive: true });

  // Prefer persistent session if BROWSERBASE_SESSION_ID is set in env
  const sessionId = process.env.BROWSERBASE_SESSION_ID;
  console.log("[agent] Using Browserbase built-in residential proxy + solveCaptchas");

  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    model: MODEL_USED,
    ...(sessionId
      ? { browserbaseSessionID: sessionId }
      : {
          browserbaseSessionCreateParams: {
            projectId: process.env.BROWSERBASE_PROJECT_ID!,
            proxies: true, // Browserbase built-in residential proxy (included in Developer plan)
            browserSettings: {
              solveCaptchas: true,
              viewport: { width: 1920, height: 1080 },
            },
          },
        }),
  });

  try {
    await stagehand.init();

    const activeSessionId = stagehand.browserbaseSessionID ?? "unknown";
    console.log(`[agent] Browserbase session: ${activeSessionId.slice(0, 8)}...`);
    await postLog(input.deal_id, "Connected to Browserbase cloud browser");

    // Fetch live-view URL from the /debug endpoint (separate from session object)
    if (activeSessionId !== "unknown") {
      try {
        const debugResp = await axios.get(
          `https://api.browserbase.com/v1/sessions/${activeSessionId}/debug`,
          { headers: { "x-bb-api-key": process.env.BROWSERBASE_API_KEY! } }
        );
        const liveUrl: string = debugResp.data.debuggerFullscreenUrl ?? "";
        if (liveUrl) {
          // &navbar=false hides the browser chrome for a cleaner embed
          const embedUrl = liveUrl.includes("?") ? `${liveUrl}&navbar=false` : `${liveUrl}?navbar=false`;
          await postLog(input.deal_id, `[BB_SESSION_URL] ${embedUrl}`);
          console.log(`[agent] Live view ready: ${embedUrl}`);
        }
      } catch (e) {
        console.warn("[agent] Could not fetch BB debug URL:", (e as Error).message);
      }
    }

    // Listen for Browserbase captcha-solving events
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (stagehand.context.pages()[0] as any).on("console", (msg: any) => {
      const text = msg.text();
      if (text === "browserbase-solving-started") console.log("[agent] Browserbase captcha solving started...");
      if (text === "browserbase-solving-finished") console.log("[agent] Browserbase captcha solving finished");
    });

    // Stagehand v3: page accessed via stagehand.context.pages()[0]
    const page = stagehand.context.pages()[0];

    // Step 0: Skipped — always use guest checkout (sub-$5k listings only)

    // -----------------------------------------------------------------------
    // Step 1: Load the listing page
    // -----------------------------------------------------------------------
    const cleanUrl = input.url.split("?")[0];
    await postLog(input.deal_id, `Loading eBay listing...`);
    await page.goto(cleanUrl, { waitUntil: "domcontentloaded", timeoutMs: 45000 });
    await sleep(3000);  // Wait for eBay React bundles to finish rendering
    await postLog(input.deal_id, "Page loaded — extracting PSA data...");
    console.log("[agent] Page settled — extracting listing data...");

    // -----------------------------------------------------------------------
    // Step 2: Extract — retry once if price comes back as -1 (not yet rendered)
    // -----------------------------------------------------------------------
    const extractStart = Date.now();

    // Cast schema to any: Zod v3 + StagehandZodSchema causes "excessively deep" inference
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let extracted: Listing = (await stagehand.extract(
      "Look at this eBay listing page and extract: " +
        "(1) the PSA certification number shown anywhere on the page — usually an 8-digit number near 'PSA' text, item specifics, or in the card description, " +
        "(2) the Buy It Now price — the large dollar amount near the Buy It Now button, " +
        "(3) the PSA Grade 10 population count vs Total population from any 'Card insights from PSA' block or pop report, " +
        "(4) whether an Authenticity Guarantee badge is shown, " +
        "(5) the full item title at the top of the listing, " +
        "(6) the seller username shown in the seller information box, " +
        "(7) the item condition. " +
        "Return NOT_FOUND for any text field you cannot locate. Return 0 for any population count you cannot locate.",
      ListingSchema as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    )) as Listing;

    // If price wasn't rendered yet, scroll and retry once
    if (!extractionValid(extracted)) {
      console.log("[agent] Extraction incomplete — scrolling and retrying...");
      await stagehand.act("scroll down to see the full listing details");
      await sleep(2000);
      extracted = (await stagehand.extract(
        "Extract from this eBay listing: " +
          "(1) the PSA cert number (8 digits, near 'PSA' label or item specifics), " +
          "(2) the Buy It Now price as a number, " +
          "(3) the PSA Grade 10 and Total pop counts from the PSA insights block, " +
          "(4) whether Authenticity Guarantee is present, " +
          "(5) the listing title, " +
          "(6) the seller username, " +
          "(7) the item condition.",
        ListingSchema as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      )) as Listing;
    }

    const extractionLatencyMs = Date.now() - extractStart;

    // Capture raw page text for A/B model comparison (sent to backend, never to LLM here)
    const listingPageText = (await page.evaluate<string>("document.body.innerText")).slice(0, 4000);

    console.log(
      `[agent] Extracted: title="${extracted.title}" cert=${extracted.cert_number} ` +
      `price=$${extracted.price} pop10=${extracted.psa_pop_grade10 ?? "?"}/` +
      `${extracted.psa_pop_total ?? "?"} auth=${extracted.authenticity_guaranteed ?? "?"} ` +
      `latency=${extractionLatencyMs}ms`,
    );
    await postLog(input.deal_id,
      `Extracted — cert: ${extracted.cert_number}, price: $${extracted.price}, pop: ${extracted.psa_pop_grade10 ?? "?"}/${extracted.psa_pop_total ?? "?"}`
    );

    // -----------------------------------------------------------------------
    // Step 3: PSA cert prefix verification
    // -----------------------------------------------------------------------
    const certOk =
      input.expected_cert_prefix === "" ||
      extracted.cert_number.startsWith(input.expected_cert_prefix) ||
      extracted.cert_number === "NOT_FOUND";  // allow NOT_FOUND through for POC

    if (!certOk) {
      const reason = `cert_prefix_mismatch: got "${extracted.cert_number}", expected prefix "${input.expected_cert_prefix}"`;
      console.warn(`[agent] ABORT — ${reason}`);
      await reportResult({
        deal_id: input.deal_id,
        session_id: activeSessionId,
        verified_cert: extracted.cert_number,
        price_locked: null,
        psa_pop_grade10: extracted.psa_pop_grade10 ?? null,
        psa_pop_total: extracted.psa_pop_total ?? null,
        authenticity_guaranteed: extracted.authenticity_guaranteed ?? null,
        screenshot_path: null,
        dom_snapshot_path: null,
        agent_extraction_json: JSON.stringify(extracted),
        final_status: "REJECTED",
        rejection_reason: reason,
        model_used: MODEL_USED,
        extraction_latency_ms: extractionLatencyMs,
        listing_page_text: listingPageText,
      });
      return;
    }

    // -----------------------------------------------------------------------
    // Step 4: Price lock guard — MUST happen before any act() call
    // -----------------------------------------------------------------------
    if (extracted.price > 0 && extracted.price > input.max_allowed_price) {
      const reason = `price_lock: page shows $${extracted.price}, max allowed $${input.max_allowed_price}`;
      console.warn(`[agent] ABORT — ${reason}`);
      await reportResult({
        deal_id: input.deal_id,
        session_id: activeSessionId,
        verified_cert: extracted.cert_number,
        price_locked: extracted.price,
        psa_pop_grade10: extracted.psa_pop_grade10 ?? null,
        psa_pop_total: extracted.psa_pop_total ?? null,
        authenticity_guaranteed: extracted.authenticity_guaranteed ?? null,
        screenshot_path: null,
        dom_snapshot_path: null,
        agent_extraction_json: JSON.stringify(extracted),
        final_status: "REJECTED",
        rejection_reason: reason,
        model_used: MODEL_USED,
        extraction_latency_ms: extractionLatencyMs,
        listing_page_text: listingPageText,
      });
      return;
    }

    // -----------------------------------------------------------------------
    // Step 5: Authenticity Guarantee check (high-value items only)
    // For items above AGENT_BUDGET, abort if guarantee is missing.
    // -----------------------------------------------------------------------
    if (
      input.max_allowed_price > AGENT_BUDGET &&
      extracted.authenticity_guaranteed === false
    ) {
      const reason = `authenticity_guarantee_missing: price $${extracted.price} > AGENT_BUDGET $${AGENT_BUDGET}`;
      console.warn(`[agent] ABORT — ${reason}`);
      await reportResult({
        deal_id: input.deal_id,
        session_id: activeSessionId,
        verified_cert: extracted.cert_number,
        price_locked: extracted.price,
        psa_pop_grade10: extracted.psa_pop_grade10 ?? null,
        psa_pop_total: extracted.psa_pop_total ?? null,
        authenticity_guaranteed: false,
        screenshot_path: null,
        dom_snapshot_path: null,
        agent_extraction_json: JSON.stringify(extracted),
        final_status: "REJECTED",
        rejection_reason: reason,
        model_used: MODEL_USED,
        extraction_latency_ms: extractionLatencyMs,
        listing_page_text: listingPageText,
      });
      return;
    }

    await postLog(input.deal_id, "✓ All guards passed — navigating to checkout...");
    console.log("[agent] All guards passed — proceeding to checkout...");

    // -----------------------------------------------------------------------
    // Steps 6–8: Checkout flow, screenshot, report to conductor.
    // Guest checkout path — no sign-in required. eBay may show hCaptcha on
    // datacenter IPs; we attempt to click "I am human" to pass it.
    // -----------------------------------------------------------------------
    const ts = makeTimestamp();
    const screenshotFile = `deal_${input.deal_id}_${ts}.png`;
    const domFile = `deal_${input.deal_id}_${ts}_dom.html`;
    const screenshotPath = path.join(RECEIPTS_DIR, screenshotFile);
    const domPath = path.join(RECEIPTS_DIR, domFile);

    let checkoutReached = false;
    let checkoutError: string | null = null;

    try {
      // Step 6: Click Buy It Now
      console.log("[agent] Clicking Buy It Now...");
      await stagehand.act("click the Buy It Now button");
      await sleep(3000);

      const currentUrl = await page.evaluate<string>("window.location.href");
      console.log("[agent] After Buy It Now, on:", currentUrl);

      // Guest checkout only — if eBay redirects to sign-in, skip it and proceed to guest option.
      // eBay shows a modal or navigates after Buy It Now.
      console.log("[agent] Handling checkout modal...");
      try {
        await stagehand.act(
          "click the 'Check out as guest' or 'Continue as guest' or 'Proceed to checkout' button"
        );
        await sleep(3000);
        console.log("[agent] Checkout initiated, on:", await page.evaluate<string>("window.location.href"));
      } catch (_modalErr) {
        console.log("[agent] No modal button found — may already be in checkout flow, continuing...");
      }

      // Step 7: Walk through checkout funnel to payment screen
      console.log("[agent] Navigating to payment screen...");
      for (let step = 0; step < 6; step++) {
        const stepUrl = await page.evaluate<string>("window.location.href");
        console.log(`[agent] Step ${step + 1}: ${stepUrl.split("?")[0]}`);

        // Captcha: Browserbase solveCaptchas:true + built-in proxy handles this automatically.
        // Docs say solving takes up to 30s. Just wait and let it resolve — do not interfere.
        if (stepUrl.includes("captcha") || stepUrl.includes("splashui")) {
          console.log("[agent] Captcha page — waiting up to 30s for Browserbase auto-solver...");
          await sleep(30000);
          const postCaptchaUrl = await page.evaluate<string>("window.location.href");
          console.log("[agent] After captcha wait, on:", postCaptchaUrl.split("?")[0]);
          if (postCaptchaUrl.includes("captcha") || postCaptchaUrl.includes("splashui")) {
            console.log("[agent] Captcha not solved after 30s — breaking");
            break;
          }
          continue; // solved — continue checkout
        }

        // DRY RUN: stop before confirming payment
        if (input.dry_run) {
          const pageText = await page.evaluate<string>("document.body.innerText");
          const atPaymentPage =
            pageText.includes("Confirm and pay") ||
            pageText.includes("Review order") ||
            pageText.includes("Place your order");
          if (atPaymentPage) {
            console.log("[agent] DRY RUN — reached payment page, stopping before confirm");
            checkoutReached = true;
            break;
          }
        }

        // Detect and fill shipping/contact form if present on this step
        const stepText = await page.evaluate<string>("document.body.innerText");
        const onAddressForm =
          stepText.includes("First name") ||
          stepText.includes("Street address") ||
          stepText.includes("Ship to") ||
          stepText.includes("Shipping address");
        if (onAddressForm) {
          console.log("[agent] Shipping form detected — filling address...");
          try {
            if (stepText.includes("Email")) {
              await stagehand.act("type %e% into the email address field", { variables: { e: process.env.EBAY_USERNAME! } });
              await sleep(400);
            }
            await stagehand.act("fill in the First name field with %fn%", { variables: { fn: process.env.SHIPPING_FIRST_NAME ?? "Alex" } });
            await sleep(300);
            await stagehand.act("fill in the Last name field with %ln%", { variables: { ln: process.env.SHIPPING_LAST_NAME ?? "Natt" } });
            await sleep(300);
            await stagehand.act("fill in the Street address field with %addr%", { variables: { addr: process.env.SHIPPING_ADDRESS ?? "350 Fifth Avenue" } });
            await sleep(300);
            await stagehand.act("fill in the City field with %city%", { variables: { city: process.env.SHIPPING_CITY ?? "New York" } });
            await sleep(300);
            await stagehand.act("select or fill in the State field with %state%", { variables: { state: process.env.SHIPPING_STATE ?? "NY" } });
            await sleep(300);
            await stagehand.act("fill in the ZIP code field with %zip%", { variables: { zip: process.env.SHIPPING_ZIP ?? "10118" } });
            await sleep(300);
            await stagehand.act("fill in the Phone number field with %phone%", { variables: { phone: process.env.SHIPPING_PHONE ?? "2125550100" } });
            await sleep(500);
          } catch (fillErr) {
            console.warn("[agent] Address form fill partial — continuing:", fillErr);
          }
        }

        try {
          // Humanization: random delay + cursor jitter before every checkout click
          await sleep(1500 + Math.random() * 1500);
          const jitterSteps = 3 + Math.floor(Math.random() * 3);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const nativePage = page as any;
          for (let j = 0; j < jitterSteps; j++) {
            await nativePage.mouse.move(
              600 + Math.random() * 300,
              350 + Math.random() * 200,
              { steps: 5 },
            );
            await sleep(80 + Math.random() * 120);
          }

          await stagehand.act(
            "click Continue or Confirm and pay or Proceed to checkout or Next or Place order",
          );
          await sleep(3000);
        } catch (_stepErr) {
          console.log(`[agent] No continue button at step ${step + 1} — at payment screen`);
          break;
        }
      }

      checkoutReached = true;
      await postLog(input.deal_id, "✓ Reached payment screen — one click from purchase");
      console.log("[agent] Reached payment/order screen");
    } catch (err) {
      checkoutError = String(err);
      console.warn("[agent] Checkout flow failed:", checkoutError);
      console.log("[agent] Saving screenshot of current page state...");
    }

    // Step 8: Save screenshot + DOM snapshot regardless of checkout outcome
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const domContent = await page.evaluate<string>(
      "document.documentElement.outerHTML",
    );
    fs.writeFileSync(domPath, domContent, "utf8");
    console.log(`[agent] Screenshot saved → ${screenshotFile}`);

    // Always report result so backend can run A/B model comparison.
    // In dry_run mode, status is REJECTED with reason "dry_run" (no purchase made).
    const finalStatus = input.dry_run
      ? "REJECTED"
      : checkoutReached ? "BOUGHT" : "REJECTED";
    const rejectionReason = input.dry_run
      ? "dry_run"
      : checkoutReached ? null : `checkout_blocked: ${checkoutError}`;

    if (input.dry_run) {
      console.log("[agent] DRY RUN — reached checkout, reporting result for A/B comparison");
    }

    await reportResult({
      deal_id: input.deal_id,
      session_id: activeSessionId,
      verified_cert: extracted.cert_number,
      price_locked: extracted.price,
      psa_pop_grade10: extracted.psa_pop_grade10 ?? null,
      psa_pop_total: extracted.psa_pop_total ?? null,
      authenticity_guaranteed: extracted.authenticity_guaranteed ?? null,
      screenshot_path: `receipts/${screenshotFile}`,
      dom_snapshot_path: `receipts/${domFile}`,
      agent_extraction_json: JSON.stringify(extracted),
      final_status: finalStatus,
      rejection_reason: rejectionReason,
      model_used: MODEL_USED,
      extraction_latency_ms: extractionLatencyMs,
      listing_page_text: listingPageText,
    });
  } finally {
    await stagehand.close();
    console.log("[agent] Session closed");
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const rawArg = process.argv[2];
if (!rawArg) {
  console.error("[agent] Usage: npx ts-node checkout.ts '<json_input>'");
  process.exit(1);
}

let input: AgentInput;
try {
  input = JSON.parse(rawArg) as AgentInput;
} catch {
  console.error("[agent] Failed to parse JSON input:", rawArg);
  process.exit(1);
}

runAgent(input).catch(async (err) => {
  console.error("[agent] Fatal error:", err);
  // Always mark the deal REJECTED so it doesn't stay stuck in ANALYZING forever
  await reportResult({
    deal_id: input.deal_id,
    session_id: "unknown",
    verified_cert: null,
    price_locked: null,
    psa_pop_grade10: null,
    psa_pop_total: null,
    authenticity_guaranteed: null,
    screenshot_path: null,
    dom_snapshot_path: null,
    agent_extraction_json: JSON.stringify({ _rejection_reason: String(err).slice(0, 300) }),
    final_status: "REJECTED",
    rejection_reason: String(err).slice(0, 300),
    model_used: MODEL_USED,
    extraction_latency_ms: null,
  });
  process.exit(1);
});
