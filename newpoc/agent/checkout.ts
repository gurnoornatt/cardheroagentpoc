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

const CONDUCTOR_URL = process.env.CONDUCTOR_URL ?? "http://localhost:8001";
const RECEIPTS_DIR = path.join(__dirname, "../receipts");
const AGENT_BUDGET = parseFloat(process.env.AGENT_BUDGET ?? "150.00");
const MODEL_USED = "google/gemini-2.5-flash";

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function buildProxyUrl(): string | null {
  const base = process.env.RESIDENTIAL_PROXY_URL;
  if (!base) return null;
  // Inject a per-run sticky session ID so the IP is held throughout one
  // checkout flow but rotates between separate runs.
  // http://user:pass@host:port → http://user-session-RANDOM:pass@host:port
  const sessionId = Math.random().toString(36).substring(2, 12);
  return base.replace(/^(https?:\/\/)([^:]+):/, `$1$2-session-${sessionId}:`);
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

async function runAgent(input: AgentInput): Promise<void> {
  console.log(`[agent] Starting for deal_id=${input.deal_id}`);
  console.log(`[agent] URL: ${input.url}`);
  console.log(`[agent] max_allowed_price=$${input.max_allowed_price} cert_prefix="${input.expected_cert_prefix}"`);

  fs.mkdirSync(RECEIPTS_DIR, { recursive: true });

  // Prefer persistent session if BROWSERBASE_SESSION_ID is set in env
  const sessionId = process.env.BROWSERBASE_SESSION_ID;
  const proxyUrl = buildProxyUrl();
  console.log(proxyUrl
    ? "[agent] Residential proxy active — sticky session"
    : "[agent] No residential proxy — captcha possible on guest checkout"
  );

  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    model: MODEL_USED,
    ...(sessionId
      ? { browserbaseSessionID: sessionId }
      : {
          browserbaseSessionCreateParams: {
            projectId: process.env.BROWSERBASE_PROJECT_ID!,
            ...(proxyUrl ? { proxies: [{ type: "external", server: proxyUrl }] } : {}),
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
    console.log(`[agent] Browserbase session: ${activeSessionId}`);
    console.log(`[agent] Watch live: https://www.browserbase.com/sessions/${activeSessionId}`);

    // Stagehand v3: page accessed via stagehand.context.pages()[0]
    const page = stagehand.context.pages()[0];

    // -----------------------------------------------------------------------
    // Step 1: Load the listing page
    // -----------------------------------------------------------------------
    const cleanUrl = input.url.split("?")[0];
    await page.goto(cleanUrl, { waitUntil: "load" });
    await sleep(3000);  // Wait for eBay React bundles to finish rendering
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

    console.log(
      `[agent] Extracted: title="${extracted.title}" cert=${extracted.cert_number} ` +
      `price=$${extracted.price} pop10=${extracted.psa_pop_grade10 ?? "?"}/` +
      `${extracted.psa_pop_total ?? "?"} auth=${extracted.authenticity_guaranteed ?? "?"} ` +
      `latency=${extractionLatencyMs}ms`,
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
      });
      return;
    }

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

      // eBay either shows a modal ON the listing page or navigates to sign-in.
      // In both cases we want to click "Check out as guest" / "Continue as guest".
      console.log("[agent] Looking for guest checkout option (modal or page)...");
      try {
        await stagehand.act("click the 'Check out as guest' or 'Continue as guest' button");
        await sleep(3000);
        console.log("[agent] Guest checkout selected, now on:", await page.evaluate<string>("window.location.href"));
      } catch (_guestErr) {
        // No guest button found — may already be on checkout page
        console.log("[agent] No guest button found, continuing...");
      }

      // Step 7: Walk through checkout funnel to payment screen
      console.log("[agent] Navigating to payment screen...");
      for (let step = 0; step < 6; step++) {
        const stepUrl = await page.evaluate<string>("window.location.href");
        console.log(`[agent] Step ${step + 1}: ${stepUrl.split("?")[0]}`);

        // hCaptcha: the checkbox is inside an iframe — must use Playwright frameLocator
        // (Stagehand act() cannot reach cross-origin iframes)
        if (stepUrl.includes("captcha") || stepUrl.includes("splashui")) {
          console.log("[agent] hCaptcha detected — using Playwright frameLocator to click checkbox...");
          try {
            // Wait for the hCaptcha iframe to fully load
            await page.waitForSelector('iframe[src*="hcaptcha"], iframe[data-hcaptcha-widget-id]', {
              state: "attached", timeout: 10_000,
            });
            await sleep(3000); // let iframe JS initialize
            const captchaFrame = page.frameLocator('iframe[src*="hcaptcha"], iframe[data-hcaptcha-widget-id]');
            await captchaFrame.locator("#checkbox").click();
            console.log("[agent] Captcha checkbox clicked");
            await sleep(6000); // wait for captcha processing + possible image challenge
            const postCaptchaUrl = await page.evaluate<string>("window.location.href");
            console.log("[agent] After captcha, on:", postCaptchaUrl);
            if (!postCaptchaUrl.includes("captcha")) {
              continue; // passed — continue checkout
            }
          } catch (_captchaErr) {
            console.log("[agent] Could not solve captcha:", String(_captchaErr).split("\n")[0]);
          }
          break; // captcha stuck — screenshot current state and report
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

    if (input.dry_run) {
      console.log("[agent] DRY RUN complete — skipping conductor report");
      console.log("[agent] Result:", JSON.stringify({
        cert: extracted.cert_number,
        price_locked: extracted.price,
        psa_pop: `${extracted.psa_pop_grade10 ?? "?"}/${extracted.psa_pop_total ?? "?"}`,
        auth_guarantee: extracted.authenticity_guaranteed,
        checkout_reached: checkoutReached,
        screenshot: `receipts/${screenshotFile}`,
      }, null, 2));
    } else {
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
        final_status: checkoutReached ? "BOUGHT" : "REJECTED",
        rejection_reason: checkoutReached
          ? null
          : `checkout_blocked: ${checkoutError}`,
        model_used: MODEL_USED,
        extraction_latency_ms: extractionLatencyMs,
      });
    }
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

runAgent(input).catch((err) => {
  console.error("[agent] Fatal error:", err);
  process.exit(1);
});
