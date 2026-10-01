r"""
One-off migration: copies your local SQLite data into a hosted Postgres database.

Vercel functions have no persistent disk, so the local office_tasks.db cannot
follow you to production. Run this once against the new DATABASE_URL to carry
your members, tasks, and email log over.

    cd backend
    .\.venv\Scripts\Activate.ps1
    $env:DATABASE_URL = "postgresql://USER:PASSWORD@ep-xxx.aws.neon.tech/neondb?sslmode=require"
    python -m migrate_to_postgres

Pass --skip-existing if you have already seeded the target by hand; members and
tasks are matched on email and title respectively instead of being duplicated.
"""

import os
import sqlite3
import sys
from pathlib import Path

from datetime import date, datetime

from dotenv import load_dotenv

load_dotenv()

BACKEND_DIR = Path(__file__).resolve().parent
SOURCE_DB = BACKEND_DIR / "instance" / "office_tasks.db"


def parse_date(value):
    """sqlite3 hands back DATE/DATETIME columns as strings; SQLAlchemy wants real
    date/datetime objects, and Postgres will reject a string outright."""
    if not value:
        return None
    if isinstance(value, (date, datetime)):
        return value
    text_value = str(value).strip()
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            parsed = datetime.strptime(text_value, fmt)
            return parsed.date() if fmt == "%Y-%m-%d" else parsed
        except ValueError:
            continue
    return None


def die(message):
    print(f"\nERROR: {message}\n")
    sys.exit(1)


def load_source():
    if not SOURCE_DB.exists():
        die(f"No local database at {SOURCE_DB}. Nothing to migrate.")

    conn = sqlite3.connect(SOURCE_DB)
    conn.row_factory = sqlite3.Row

    def table_exists(name):
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (name,)
        ).fetchone()
        return row is not None

    def rows(name):
        if not table_exists(name):
            return []
        return [dict(r) for r in conn.execute(f"SELECT * FROM {name}").fetchall()]

    data = {
        "team_member": rows("team_member"),
        "task": rows("task"),
        "email_log": rows("email_log"),
    }
    conn.close()
    return data


def main():
    skip_existing = "--skip-existing" in sys.argv

    target_url = os.getenv("DATABASE_URL", "").strip()
    if not target_url or "sqlite" in target_url:
        die(
            "Set DATABASE_URL to your Postgres connection string first, e.g.\n"
            '  $env:DATABASE_URL = "postgresql://USER:PASSWORD@ep-xxx.aws.neon.tech/neondb?sslmode=require"\n'
            "(The current value points at SQLite, which would just copy a file onto itself.)"
        )

    data = load_source()
    totals = {k: len(v) for k, v in data.items()}
    print(f"Source: {SOURCE_DB}")
    print(f"  {totals['team_member']} members, {totals['task']} tasks, {totals['email_log']} email logs\n")
    if not any(totals.values()):
        die("The source database is empty. Nothing to migrate.")

    from app import app, db, TeamMember, Task, EmailLog

    with app.app_context():
        db.create_all()

        # Postgres sequences must advance past the ids we just inserted, or the
        # next INSERT collides with an existing primary key.
        def bump_sequence(table):
            db.session.execute(db.text(
                f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), "
                f"COALESCE((SELECT MAX(id) FROM {table}), 1))"
            ))

        # old SQLite member id -> new Postgres member id
        email_to_new_id = {}

        for row in data["team_member"]:
            existing = TeamMember.query.filter_by(email=(row["email"] or "").lower()).first()
            if existing:
                if skip_existing:
                    email_to_new_id[row["id"]] = existing.id
                    print(f"  = {row['name']} (already present)")
                    continue
                die(
                    f"A member with email {row['email']} already exists in the target. "
                    "Re-run with --skip-existing to skip duplicates, or use an empty database."
                )

            member = TeamMember(
                name=row["name"],
                email=(row["email"] or "").lower(),
                role=row.get("role") or "Team Member",
                avatar=row.get("avatar") or "\U0001F468\u200D\U0001F4BB",
                active=bool(row.get("active", 1)),
            )
            db.session.add(member)
            # Flush each row so member.id is a real integer; storing the ORM
            # object instead makes psycopg fail to adapt it as a parameter.
            db.session.flush()
            email_to_new_id[row["id"]] = member.id
            print(f"  + {member.name} <{member.email}> (new id {member.id})")

        for row in data["task"]:
            new_member_id = email_to_new_id.get(row["member_id"])
            if new_member_id is None:
                print(f"  ! skipping task '{row['title']}' (member not found)")
                continue

            if skip_existing:
                dupe = Task.query.filter_by(title=row["title"], member_id=new_member_id).first()
                if dupe:
                    print(f"  = task '{row['title']}' (already present)")
                    continue

            db.session.add(Task(
                title=row["title"],
                description=row.get("description") or "",
                status=row.get("status") or "todo",
                priority=row.get("priority") or "medium",
                due_date=parse_date(row.get("due_date")),
                position=row.get("position") or 0,
                notes=row.get("notes") or "",
                member_id=new_member_id,
            ))

        db.session.commit()

        for row in data["email_log"]:
            db.session.add(EmailLog(
                to_email=row.get("to_email") or row.get("to") or "unknown",
                subject=row.get("subject") or "",
                body_text=row.get("body_text") or "",
                body_html=row.get("body_html") or "",
                status=row.get("status") or "sent",
                error=row.get("error"),
                created_at=parse_date(row.get("created_at")),
            ))
        db.session.commit()

        for table in ("team_member", "task", "email_log"):
            bump_sequence(table)
        db.session.commit()

        print("\nTarget now contains:")
        print(f"  {TeamMember.query.count()} members")
        print(f"  {Task.query.count()} tasks")
        print(f"  {EmailLog.query.count()} email logs")
        print("\nMigration complete.")


if __name__ == "__main__":
    main()