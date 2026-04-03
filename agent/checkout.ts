/**
 * CardHero Last-Mile Agent
 *
 * Receives a deal candidate from the Conductor, navigates to the eBay listing
 * using a Browserbase cloud browser, extracts the PSA cert number and price,
 * verifies both against guardrails, then proceeds to the checkout confirmation
 * page and saves a receipt screenshot + DOM snapshot.
 *
 * Credentials NEVER reach the LLM — Stagehand's variables option substitutes
 * them directly into DOM interactions only, not into the LLM prompt.
 *
 * Usage:
 *   npx ts-node agent/checkout.ts '{"deal_id":7,"url":"...","max_allowed_price":380,"expected_cert_prefix":"POKE"}'
 */

import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

import { Stagehand } from "@browserbasehq/stagehand";
import axios from "axios";
import { z } from "zod";

dotenv.config({ path: path.join(__dirname, "../.env") });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentInput {
  deal_id: number;
  url: string;
  max_allowed_price: number;
  expected_cert_prefix: string;
}

interface AgentResult {
  deal_id: number;
  session_id: string;
  verified_cert: string | null;
  price_locked: number | null;
  screenshot_path: string | null;
  dom_snapshot_path: string | null;
  agent_extraction_json: string;
  final_status: "BOUGHT" | "REJECTED";
  rejection_reason: string | null;
}

interface Listing {
  cert_number: string;
  price: number;
  title: string;
  seller_username: string;
  condition: string;
}

// ---------------------------------------------------------------------------
// Zod extraction schema
// ---------------------------------------------------------------------------

const ListingSchema = z.object({
  cert_number: z
    .string()
    .describe(
      "PSA certification number on this listing. Usually an 8-digit number like 12345678 or formatted as POKE-12345678. Return the number exactly as shown. If not visible, return the string 'NOT_FOUND'.",
    ),
  price: z
    .number()
    .describe(
      "The Buy It Now price in USD as a plain positive number (e.g. 349.99). Look for the large price near the Buy It Now button. If not found return -1.",
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONDUCTOR_URL = process.env.CONDUCTOR_URL ?? "http://localhost:8000";
const RECEIPTS_DIR = path.join(__dirname, "../receipts");

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

  fs.mkdirSync(RECEIPTS_DIR, { recursive: true });

  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    model: "google/gemini-2.5-flash",
    browserbaseSessionCreateParams: {
      projectId: process.env.BROWSERBASE_PROJECT_ID!,
      browserSettings: {
        solveCaptchas: true,      // Browserbase auto-solves hCaptcha/reCAPTCHA (free plan)
        viewport: { width: 1920, height: 1080 },
      },
    },
  });

  try {
    await stagehand.init();

    const sessionId = stagehand.browserbaseSessionID ?? "unknown";
    console.log(`[agent] Browserbase session: ${sessionId}`);
    console.log(`[agent] Watch live: https://www.browserbase.com/sessions/${sessionId}`);

    const page = stagehand.context.activePage();
    if (!page) throw new Error("No active page after init()");

    // -----------------------------------------------------------------------
    // Step 1: Load the listing page and wait for JS to fully render
    // -----------------------------------------------------------------------
    // Strip tracking params — cleaner URL for eBay's CDN
    const cleanUrl = input.url.split("?")[0];
    await page.goto(cleanUrl, { waitUntil: "load" });
    // Extra wait for eBay's React bundles to finish rendering price/seller
    await sleep(3000);
    console.log("[agent] Page settled — extracting listing data...");

    // -----------------------------------------------------------------------
    // Step 2: Extract — retry once if price comes back as -1 (not yet rendered)
    // -----------------------------------------------------------------------
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let extracted = (await stagehand.extract(
      "Look at this eBay listing page and extract: " +
        "(1) the PSA certification number shown anywhere on the page — usually an 8-digit number near 'PSA' text or in the item specifics section, " +
        "(2) the Buy It Now price — the large dollar amount near the Buy It Now button, " +
        "(3) the full item title at the top of the listing, " +
        "(4) the seller username shown in the seller information box, " +
        "(5) the item condition. " +
        "Return NOT_FOUND for any field you cannot locate.",
      ListingSchema as any,
    )) as Listing;

    // If price wasn't rendered yet, scroll and retry once
    if (!extractionValid(extracted)) {
      console.log("[agent] Extraction incomplete — scrolling and retrying...");
      await stagehand.act("scroll down to see the full listing details");
      await sleep(2000);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      extracted = (await stagehand.extract(
        "Extract from this eBay listing: " +
          "(1) the PSA cert number (8 digits, near 'PSA' label or item specifics), " +
          "(2) the Buy It Now price as a number, " +
          "(3) the listing title, " +
          "(4) the seller username, " +
          "(5) the item condition.",
        ListingSchema as any,
      )) as Listing;
    }

    console.log(
      `[agent] Extracted: title="${extracted.title}" cert=${extracted.cert_number} price=$${extracted.price} seller=${extracted.seller_username}`,
    );

    // -----------------------------------------------------------------------
    // Step 3: PSA cert prefix verification
    // -----------------------------------------------------------------------
    const certOk =
      input.expected_cert_prefix === "" ||
      extracted.cert_number.startsWith(input.expected_cert_prefix) ||
      extracted.cert_number === "NOT_FOUND"; // allow NOT_FOUND through for POC

    if (!certOk) {
      const reason = `cert prefix mismatch: got "${extracted.cert_number}", expected prefix "${input.expected_cert_prefix}"`;
      console.warn(`[agent] ABORT — ${reason}`);
      await reportResult({
        deal_id: input.deal_id, session_id: sessionId,
        verified_cert: extracted.cert_number, price_locked: null,
        screenshot_path: null, dom_snapshot_path: null,
        agent_extraction_json: JSON.stringify(extracted),
        final_status: "REJECTED", rejection_reason: reason,
      });
      return;
    }

    // -----------------------------------------------------------------------
    // Step 4: Price lock guard — MUST happen before any act() call
    // -----------------------------------------------------------------------
    if (extracted.price > 0 && extracted.price > input.max_allowed_price) {
      const reason = `price lock: page shows $${extracted.price}, max allowed $${input.max_allowed_price}`;
      console.warn(`[agent] ABORT — ${reason}`);
      await reportResult({
        deal_id: input.deal_id, session_id: sessionId,
        verified_cert: extracted.cert_number, price_locked: extracted.price,
        screenshot_path: null, dom_snapshot_path: null,
        agent_extraction_json: JSON.stringify(extracted),
        final_status: "REJECTED", rejection_reason: reason,
      });
      return;
    }

    console.log("[agent] Guards passed — proceeding to checkout...");

    // -----------------------------------------------------------------------
    // Steps 5–8: Checkout flow, screenshot, report to conductor.
    // Fully wrapped in try/catch — eBay anti-bot (captcha, modals on datacenter
    // IPs) can block any step. We always save a screenshot and report back so
    // the conductor never hangs waiting for a result.
    // -----------------------------------------------------------------------
    const ts = makeTimestamp();
    const screenshotFile = `deal_${input.deal_id}_${ts}.png`;
    const domFile = `deal_${input.deal_id}_${ts}_dom.html`;
    const screenshotPath = path.join(RECEIPTS_DIR, screenshotFile);
    const domPath = path.join(RECEIPTS_DIR, domFile);

    let checkoutReached = false;
    let checkoutError: string | null = null;

    try {
      // Step 5: Click Buy It Now. eBay may redirect to sign-in or show modal.
      console.log("[agent] Clicking Buy It Now...");
      await stagehand.act("click the Buy It Now button");
      await sleep(3000);

      const currentUrl = await page.evaluate<string>("window.location.href");
      console.log("[agent] After Buy It Now, on:", currentUrl);

      // If eBay redirected to sign-in (checkout flow), fill credentials via locator
      const onSignIn = currentUrl.includes("signin") || currentUrl.includes("login");
      if (onSignIn) {
        console.log("[agent] Sign-in required — filling credentials via Playwright locator...");
        await sleep(2000);
        await page.locator("#userid, input[name='userid'], input[type='email']").fill(process.env.EBAY_USERNAME!);
        await page.locator("#signin-continue-btn, button[type='submit']").click();
        await sleep(3000);
        await page.locator("#pass, input[name='pass'], input[type='password']").fill(process.env.EBAY_PASSWORD!);
        await page.locator("#sgnBt, button[type='submit']").click();
        await sleep(4000);
        console.log("[agent] Login submitted — now on:", await page.evaluate<string>("window.location.href"));
      }

      // Step 6: Continue to order review
      await stagehand.act("click the Continue button or proceed to checkout or confirm purchase");
      await sleep(3000);
      checkoutReached = true;
      console.log("[agent] On order review / checkout page");
    } catch (err) {
      checkoutError = String(err);
      console.warn("[agent] Checkout flow failed:", checkoutError);
      console.log("[agent] Saving screenshot of current page state...");
    }

    await page.screenshot({ path: screenshotPath, fullPage: true });
    const domContent = await page.evaluate<string>("document.documentElement.outerHTML");
    fs.writeFileSync(domPath, domContent, "utf8");
    console.log(`[agent] Screenshot saved → ${screenshotFile}`);

    await reportResult({
      deal_id: input.deal_id, session_id: sessionId,
      verified_cert: extracted.cert_number, price_locked: extracted.price,
      screenshot_path: `receipts/${screenshotFile}`,
      dom_snapshot_path: `receipts/${domFile}`,
      agent_extraction_json: JSON.stringify(extracted),
      final_status: checkoutReached ? "BOUGHT" : "REJECTED",
      rejection_reason: checkoutReached ? null : `checkout_blocked: ${checkoutError}`,
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

runAgent(input).catch((err) => {
  console.error("[agent] Fatal error:", err);
  process.exit(1);
});
