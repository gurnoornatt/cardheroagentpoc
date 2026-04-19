"""
Collectr portfolio importer.

Uses Browserbase + Stagehand (collectr_import.ts) to extract cards from a
public Collectr showcase SPA page, then writes PSA-graded cards into want_list.

Async job pattern:
  1. start_collectr_job(url)  → job_id (returns immediately)
  2. get_job(job_id)          → {status, session_url, result, error}

The background thread reads stderr from the subprocess line-by-line.
When it sees [BB_SESSION_URL] it stores the live view URL in the job state
so the frontend can embed it as an iframe while extraction is still running.
"""

import json
import logging
import os
import subprocess
import tempfile
import threading
import uuid
from pathlib import Path

from backend.database import SessionLocal, WantList

logger = logging.getLogger(__name__)

AGENT_DIR = Path(__file__).resolve().parent.parent.parent / "agent"

# ─── In-memory job store ──────────────────────────────────────────────────────
# Maps job_id → {status, session_url, result, error}
# Status: "running" | "done" | "error"
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def get_job(job_id: str) -> dict | None:
    with _jobs_lock:
        return _jobs.get(job_id)


def start_collectr_job(showcase_url: str) -> str:
    """
    Spawn collectr_import.ts in a background thread. Returns job_id immediately.
    Poll get_job(job_id) to watch progress and get the live session URL.
    """
    job_id = str(uuid.uuid4())
    with _jobs_lock:
        _jobs[job_id] = {
            "status": "running",
            "session_url": None,
            "result": None,
            "error": None,
        }

    thread = threading.Thread(
        target=_run_job,
        args=(job_id, showcase_url),
        daemon=True,
    )
    thread.start()
    return job_id


# ─── Background worker ────────────────────────────────────────────────────────

def _run_job(job_id: str, showcase_url: str) -> None:
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tmp:
        tmp_path = tmp.name

    try:
        proc = subprocess.Popen(
            ["npx", "ts-node", "collectr_import.ts", showcase_url, tmp_path],
            cwd=str(AGENT_DIR),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        # Read stderr line-by-line — watch for [BB_SESSION_URL]
        assert proc.stderr is not None
        for line in proc.stderr:
            line = line.rstrip()
            logger.debug("[collectr-job %s] %s", job_id[:8], line)
            if line.startswith("[BB_SESSION_URL]"):
                url = line.removeprefix("[BB_SESSION_URL]").strip()
                with _jobs_lock:
                    _jobs[job_id]["session_url"] = url
                logger.info("[collectr-job %s] live view ready: %s", job_id[:8], url)

        proc.wait(timeout=120)

        if proc.returncode != 0:
            # Collect any remaining stdout for context
            stdout_tail = (proc.stdout.read() if proc.stdout else "")[-300:]
            raise RuntimeError(
                f"collectr_import.ts exited {proc.returncode}. "
                f"stdout tail: {stdout_tail or '(empty)'}"
            )

        if not os.path.exists(tmp_path) or os.path.getsize(tmp_path) == 0:
            raise RuntimeError("collectr_import.ts produced no output file")

        with open(tmp_path, "r") as f:
            raw = json.loads(f.read().strip())

        cards = raw.get("cards", [])
        import_result = import_cards_to_want_list(cards)

        logger.info(
            "[collectr-job %s] done — found=%d imported=%d skipped=%d",
            job_id[:8], len(cards), len(import_result["imported"]), len(import_result["skipped"]),
        )

        with _jobs_lock:
            _jobs[job_id]["status"] = "done"
            _jobs[job_id]["result"] = {
                "cards_found": len(cards),
                "imported_count": len(import_result["imported"]),
                "skipped_count": len(import_result["skipped"]),
                "want_list_additions": import_result["imported"],
                "skipped_details": import_result["skipped"],
            }

    except Exception as exc:
        logger.error("[collectr-job %s] error: %s", job_id[:8], exc)
        with _jobs_lock:
            _jobs[job_id]["status"] = "error"
            _jobs[job_id]["error"] = str(exc)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ─── Card import logic ────────────────────────────────────────────────────────

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
    """
    db = SessionLocal()
    try:
        imported = []
        skipped = []

        for card in cards:
            grade_raw = (card.get("grade") or "").strip()
            grade_upper = grade_raw.upper()

            is_psa = grade_upper.startswith("PSA") or grade_upper == "GRADED"
            current_value = card.get("current_value") or 0
            is_high_value_likely_graded = (not grade_raw) and (current_value >= 100)

            if not is_psa and not is_high_value_likely_graded:
                skipped.append({"card": card, "reason": "non_psa_grade"})
                continue

            grade = grade_raw if grade_raw else "Unknown Grade"

            name = (card.get("name") or "").strip()
            if not name:
                skipped.append({"card": card, "reason": "missing_name"})
                continue

            if len(name) > 100:
                skipped.append({"card": card, "reason": "name_too_long"})
                continue

            if current_value and current_value > 50_000:
                skipped.append({"card": card, "reason": "suspiciously_high_value"})
                continue

            existing = (
                db.query(WantList)
                .filter(
                    WantList.name.ilike(name),
                    WantList.grade.ilike(grade),
                    WantList.is_active,
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

            if current_value and current_value > 0:
                max_price = round(current_value * default_max_price_discount, 2)
                is_active = True
            else:
                max_price = 0.0
                is_active = False

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
        return {"imported": imported, "skipped": skipped}

    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
