"""
Collectr portfolio importer.

Uses Browserbase + Stagehand (collectr_import.ts) to extract cards from a
public Collectr showcase SPA page, then writes PSA-graded cards into want_list.
"""

import json
import logging
import os
import subprocess
import tempfile
from pathlib import Path

from newpoc.backend.database import SessionLocal, WantList

logger = logging.getLogger(__name__)

AGENT_DIR = Path(__file__).resolve().parent.parent.parent / "agent"


def run_collectr_import(showcase_url: str) -> dict:
    """
    Spawn collectr_import.ts, write JSON to a temp file, return parsed card list.

    Uses a temp file instead of stdout because Stagehand's logger writes INFO
    messages to stdout, which pollutes the JSON output.
    Raises RuntimeError with user-readable message on failure.
    """
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tmp:
        tmp_path = tmp.name

    try:
        result = subprocess.run(
            ["npx", "ts-node", "collectr_import.ts", showcase_url, tmp_path],
            cwd=str(AGENT_DIR),
            capture_output=True,
            text=True,
            timeout=120,  # 2 min max — Browserbase session + networkidle wait
        )
        if result.returncode != 0:
            stderr_snippet = (result.stderr or "")[-500:]
            raise RuntimeError(f"Collectr extraction failed: {stderr_snippet or 'unknown error'}")

        if not os.path.exists(tmp_path) or os.path.getsize(tmp_path) == 0:
            raise RuntimeError("Collectr script produced no output file")

        with open(tmp_path, "r") as f:
            raw = f.read().strip()

        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Collectr script returned invalid JSON: {exc}")
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def import_cards_to_want_list(
    cards: list[dict],
    default_max_price_discount: float = 0.80,
) -> dict:
    """
    For each PSA-graded card from the Collectr extract:
    - Skip non-PSA grades (raw cards, BGS, CGC, etc.)
    - Skip cards already in want_list (name + grade match, case-insensitive)
    - Create new WantList row: max_price = current_value * discount
    - Cards with no Collectr value get max_price=0 and is_active=False
      (user must set price before Watchman acts on them)

    Returns {"imported": [...], "skipped": [...]}
    """
    db = SessionLocal()
    try:
        imported = []
        skipped = []

        for card in cards:
            grade_raw = (card.get("grade") or "").strip()
            grade_upper = grade_raw.upper()

            # Accept PSA grades ("PSA 10", "PSA 9", "PSA GRADED") and generic "GRADED"
            # Skip raw conditions ("NEAR MINT", "LIGHTLY PLAYED", "HOLO RARE", etc.)
            is_psa = grade_upper.startswith("PSA") or grade_upper == "GRADED"
            # Also accept cards with no grade if they have significant value (likely graded)
            current_value = card.get("current_value") or 0
            is_high_value_likely_graded = (not grade_raw) and (current_value >= 100)

            if not is_psa and not is_high_value_likely_graded:
                skipped.append({"card": card, "reason": "non_psa_grade"})
                continue

            # Normalize grade
            grade = grade_raw if grade_raw else "Unknown Grade"

            name = (card.get("name") or "").strip()
            if not name:
                skipped.append({"card": card, "reason": "missing_name"})
                continue

            # Sanity check: reject obvious hallucinations
            if len(name) > 100:
                skipped.append({"card": card, "reason": "name_too_long"})
                continue

            if current_value and current_value > 50_000:
                skipped.append({"card": card, "reason": "suspiciously_high_value"})
                continue

            # Case-insensitive duplicate check
            existing = (
                db.query(WantList)
                .filter(
                    WantList.name.ilike(name),
                    WantList.grade.ilike(grade),
                    WantList.is_active == True,
                )
                .first()
            )
            if existing:
                skipped.append({
                    "card": card,
                    "reason": "already_in_want_list",
                    "want_list_id": existing.id,
                })
                continue

            # Compute max_price from Collectr's current value * discount
            if current_value and current_value > 0:
                max_price = round(current_value * default_max_price_discount, 2)
                is_active = True
            else:
                max_price = 0.0
                is_active = False  # user must set price before Watchman hunts it

            wl = WantList(
                name=name,
                grade=grade,
                max_price=max_price,
                set_name=card.get("set_name") or None,
                year=card.get("year") or None,
                is_active=is_active,
            )
            db.add(wl)
            db.flush()
            imported.append({
                "want_list_id": wl.id,
                "name": name,
                "grade": grade,
                "max_price": max_price,
                "set_name": card.get("set_name"),
                "is_active": is_active,
            })

        db.commit()
        logger.info(f"[collectr] imported={len(imported)} skipped={len(skipped)}")
        return {"imported": imported, "skipped": skipped}

    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
