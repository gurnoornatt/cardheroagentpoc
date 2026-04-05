"""
CardHero v2 — Minimal seeder.

Seeds only the want_list table (required for /pipeline/run to work).
No fake deals, no mock lab runs, no portfolio data.
Real runs come from actual pipeline executions.

Run:  uv run python -m newpoc.backend.seed
"""

from newpoc.backend.database import (
    Deal,
    LabRun,
    AuditLog,
    WantList,
    SessionLocal,
    init_db,
)


def seed_all() -> None:
    init_db()
    db = SessionLocal()
    try:
        # Clear only want_list — preserve real run history (deals, lab_runs)
        existing = db.query(WantList).count()
        if existing > 0:
            print(f"[seed] Want list already seeded ({existing} items) — skipping")
            return

        cards = [
            dict(name="Charizard ex", grade="PSA 10", max_price=380.00, cert_prefix="POKE",
                 target_id="charizard-ex-obsidian-psa10", set_name="Obsidian Flames", year=2023),
            dict(name="Pikachu VMAX Rainbow Rare", grade="PSA 10", max_price=220.00, cert_prefix="POKE",
                 target_id="pikachu-vmax-rainbow-psa10", set_name="Vivid Voltage", year=2020),
            dict(name="Umbreon VMAX Alt Art", grade="PSA 10", max_price=1800.00, cert_prefix="POKE",
                 target_id="umbreon-vmax-altart-psa10", set_name="Evolving Skies", year=2021),
            dict(name="Charizard VSTAR", grade="PSA 10", max_price=150.00, cert_prefix="POKE",
                 target_id="charizard-vstar-psa10", set_name="Brilliant Stars", year=2022),
            dict(name="Lugia V Alt Art", grade="PSA 10", max_price=600.00, cert_prefix="POKE",
                 target_id="lugia-v-altart-psa10", set_name="Silver Tempest", year=2022),
            dict(name="Rayquaza VMAX Alt Art", grade="PSA 10", max_price=500.00, cert_prefix="POKE",
                 target_id="rayquaza-vmax-altart-psa10", set_name="Evolving Skies", year=2021),
            dict(name="Blastoise ex", grade="PSA 10", max_price=120.00, cert_prefix="POKE",
                 target_id="blastoise-ex-psa10", set_name="Scarlet & Violet 151", year=2023),
        ]

        for c in cards:
            db.add(WantList(**c, is_active=True))
        db.commit()

        print(f"[seed] Done. {len(cards)} want_list items seeded.")
    finally:
        db.close()


if __name__ == "__main__":
    seed_all()
