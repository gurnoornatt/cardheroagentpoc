/**
 * Collectr Portfolio Importer
 *
 * Loads a public Collectr showcase SPA page in a fresh Browserbase session,
 * waits for card data to render, then extracts the full card list via
 * stagehand.extract(). Outputs JSON to stdout for Python to parse.
 *
 * Exit 0 = success (even if 0 cards found), exit 1 = hard failure.
 *
 * Usage:
 *   npx ts-node collectr_import.ts "https://app.getcollectr.com/showcase/profile/{uuid}"
 */

import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";

// Load newpoc/.env (one directory up from agent/)
dotenv.config({ path: path.join(__dirname, "../.env") });

// ---------------------------------------------------------------------------
// Schema — minimal fields CardHero needs
// ---------------------------------------------------------------------------

const CardListSchema = z.object({
  cards: z.array(
    z.object({
      name: z.string().describe("Card name, e.g. 'Charizard ex'"),
      set_name: z.string().nullish().describe("Set name, e.g. 'Obsidian Flames' or 'Base Set'"),
      grade: z.string().nullish().describe(
        "PSA grade if shown (e.g. 'PSA 10', 'PSA 9'). Look for 'Graded Cards' section label or PSA badge. Empty string for raw/ungraded."
      ),
      current_value: z.number().nullish().describe(
        "Current estimated market value in USD as shown on Collectr. 0 if not shown."
      ),
      year: z.number().nullish().describe("Card year if visible, else null"),
    })
  ),
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const showcaseUrl = process.argv[2];
  const outFile = process.argv[3]; // optional: write JSON to file instead of stdout

  if (!showcaseUrl || !showcaseUrl.includes("getcollectr.com")) {
    process.stderr.write("Usage: npx ts-node collectr_import.ts <showcase_url> [output_file]\n");
    process.exit(1);
  }

  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!projectId) {
    process.stderr.write("BROWSERBASE_PROJECT_ID not set\n");
    process.exit(1);
  }

  // Always create a NEW session — never reuse BROWSERBASE_SESSION_ID
  // (that persistent session is pre-logged into eBay)
  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    model: "openai/gpt-4o-mini",
    browserbaseSessionCreateParams: {
      projectId,
      browserSettings: {
        solveCaptchas: true,
        viewport: { width: 1440, height: 900 },
      },
    },
  });

  try {
    await stagehand.init();
    process.stderr.write(`[collectr] Session started\n`);

    // Stagehand v3: page accessed via stagehand.context.pages()[0]
    const page = stagehand.context.pages()[0];

    // Navigate and wait for SPA to finish rendering card data
    process.stderr.write(`[collectr] Navigating to ${showcaseUrl}\n`);
    await page.goto(showcaseUrl, { waitUntil: "networkidle" });
    process.stderr.write(`[collectr] Page loaded\n`);

    // Try to click "Graded Cards" filter to narrow to graded-only view
    try {
      await stagehand.act('click the "Graded Cards" filter or toggle to show only graded cards');
      await new Promise((r) => setTimeout(r, 2000));
      process.stderr.write("[collectr] Clicked Graded Cards filter\n");
    } catch {
      process.stderr.write("[collectr] Graded Cards filter not found — extracting all cards\n");
    }

    // Scroll to trigger lazy-loaded cards
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise((r) => setTimeout(r, 2000));
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise((r) => setTimeout(r, 500));

    // Extract card list via LLM — Stagehand v3 API: (instruction: string, schema: any)
    process.stderr.write("[collectr] Running stagehand.extract()\n");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const extracted = (await stagehand.extract(
      "Extract the complete list of cards shown in this Collectr portfolio showcase. " +
      "For each card include: name (e.g. 'Charizard ex'), set name (e.g. 'Obsidian Flames'), " +
      "grade — look specifically for PSA grading like 'PSA 10', 'PSA 9' near the card or in a grade/slab label; " +
      "if it says 'Graded' without a number return 'PSA Graded'; if raw/ungraded return empty string. " +
      "current market value in USD (the dollar amount shown), and year if visible. " +
      "Include ALL cards visible on the page.",
      CardListSchema as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    )) as any;

    await stagehand.close().catch(() => {});

    const cards = extracted?.cards ?? [];
    process.stderr.write(`[collectr] Extracted ${cards.length} cards\n`);

    const json = JSON.stringify({ cards });
    if (outFile) {
      // Write to file — avoids Stagehand's stdout logging polluting our output
      fs.writeFileSync(outFile, json, "utf8");
      process.stderr.write(`[collectr] Wrote output to ${outFile}\n`);
    } else {
      process.stdout.write(json);
    }
    process.exit(0);

  } catch (err) {
    process.stderr.write(`[collectr] Error: ${err}\n`);
    await stagehand.close().catch(() => {});
    process.exit(1);
  }
}

main();
