import os
import json
import smtplib
from datetime import datetime, date
from email.message import EmailMessage
from pathlib import Path
from flask import has_app_context
from dotenv import load_dotenv

ENV_PATH = Path(__file__).resolve().parent / ".env"
load_dotenv(ENV_PATH)

# The JSON outbox is only a local convenience mirror now. On serverless the
# filesystem is ephemeral, so the database is the source of truth.
IS_SERVERLESS = bool(os.getenv("VERCEL") or os.getenv("AWS_LAMBDA_FUNCTION_NAME"))


def _resolve_module():
    """
    Find the module that actually owns the running app, db and models.

    "python app.py" executes the file as __main__, while a plain "import app"
    (WSGI servers, Vercel, tests) loads it as "app". Importing the wrong one
    builds a second Flask app with its own SQLAlchemy instance, and every query
    then fails with "the current Flask app is not registered with this
    SQLAlchemy instance". So prefer whichever module is already loaded.
    """
    import sys

    main = sys.modules.get("__main__")
    if main is not None and all(hasattr(main, name) for name in ("app", "db", "EmailLog")):
        return main

    module = sys.modules.get("app")
    if module is not None and all(hasattr(module, name) for name in ("app", "db", "EmailLog")):
        return module

    # Neither is loaded yet (e.g. running scheduler.py directly).
    import app as module
    return module


def _get_app_and_db():
    # Resolved lazily: app.py imports this module while defining its models.
    module = _resolve_module()
    return module.app, module.db, module.EmailLog


class _maybe_app_context:
    """Reuses the caller's app context when there already is one.

    Flask-SQLAlchemy scopes its session to the app context, so opening a nested
    one mid-request would hand back a second session. Reusing keeps callers that
    already have a context (API routes) on the same session.
    """

    def __init__(self, flask_app):
        self.flask_app = flask_app
        self._ctx = None

    def __enter__(self):
        if has_app_context():
            return self.flask_app
        self._ctx = self.flask_app.app_context()
        return self._ctx.__enter__()

    def __exit__(self, *args):
        if self._ctx is not None:
            return self._ctx.__exit__(*args)
        return False


def log_email(to_email, subject, body_text, body_html, status, error=None):
    """Records a sent/failed/simulated email. Never raises, so a logging
    failure can never take down a task assignment."""
    timestamp = datetime.utcnow().isoformat()

    try:
        flask_app, db, EmailLog = _get_app_and_db()
        with _maybe_app_context(flask_app):
            row = EmailLog(
                to_email=to_email,
                subject=subject,
                body_text=body_text or "",
                body_html=body_html or "",
                status=status,
                error=error,
            )
            db.session.add(row)
            db.session.commit()
            entry_id = row.id
    except Exception as e:
        print(f"[EMAIL LOG ERROR] Could not persist email log: {e}")
        entry_id = None

    # Best-effort local mirror for SQLite runs.
    if not IS_SERVERLESS:
        try:
            outbox_path = Path(__file__).resolve().parent / "instance" / "outbox.json"
            outbox_path.parent.mkdir(parents=True, exist_ok=True)
            entries = []
            if outbox_path.exists():
                try:
                    entries = json.loads(outbox_path.read_text(encoding="utf-8"))
                except Exception:
                    entries = []
            entries.insert(0, {
                "id": entry_id or len(entries) + 1,
                "timestamp": timestamp,
                "to": to_email,
                "subject": subject,
                "body_text": body_text or "",
                "body_html": body_html or "",
                "status": status,
                "error": error,
            })
            outbox_path.write_text(json.dumps(entries[:100], indent=2), encoding="utf-8")
        except Exception as e:
            print(f"[EMAIL LOG FILE NOTICE] {e}")

    return {
        "id": entry_id,
        "timestamp": timestamp,
        "to": to_email,
        "subject": subject,
        "status": status,
        "error": error,
    }


def get_outbox(limit=50):
    try:
        flask_app, db, EmailLog = _get_app_and_db()
        with _maybe_app_context(flask_app):
            rows = (
                EmailLog.query
                .order_by(EmailLog.id.desc())
                .limit(limit)
                .all()
            )
            return [r.to_dict() for r in rows]
    except Exception as e:
        print(f"[OUTBOX READ ERROR] {e}")
        return []

def get_smtp_config():
    host = os.getenv("SMTP_HOST", "").strip()
    port = int(os.getenv("SMTP_PORT", "587"))
    user = os.getenv("SMTP_USERNAME", "").strip()
    password = os.getenv("SMTP_PASSWORD", "").strip()
    from_email = os.getenv("SMTP_FROM", "").strip() or user
    is_configured = bool(host and user and password and from_email)
    return {
        "host": host,
        "port": port,
        "username": user,
        "password": password,
        "from_email": from_email,
        "is_configured": is_configured,
    }

def update_smtp_config(host, port, username, password, from_email):
    """Saves SMTP credentials to backend/.env and updates os.environ dynamically."""
    host = (host or "smtp.gmail.com").strip()
    port = str(port or "587").strip()
    username = (username or "").strip()
    password = (password or "").strip()
    from_email = (from_email or username).strip()

    os.environ["SMTP_HOST"] = host
    os.environ["SMTP_PORT"] = port
    os.environ["SMTP_USERNAME"] = username
    os.environ["SMTP_PASSWORD"] = password
    os.environ["SMTP_FROM"] = from_email

    if IS_SERVERLESS:
        # The deployed filesystem is read-only and each container is cold-started
        # from the env vars Vercel provides, so writing credentials to disk would
        # silently do nothing. Say so instead of pretending it saved.
        print("[SMTP] Saved for this container instance. Add these values as Vercel environment variables to persist them.")
        return get_smtp_config()

    new_keys = {
        "SMTP_HOST": host,
        "SMTP_PORT": port,
        "SMTP_USERNAME": username,
        "SMTP_PASSWORD": password,
        "SMTP_FROM": from_email,
    }

    lines = []
    if ENV_PATH.exists():
        lines = ENV_PATH.read_text(encoding="utf-8").splitlines()

    updated_keys = set()
    new_lines = []
    for line in lines:
        if "=" in line and not line.strip().startswith("#"):
            k = line.split("=", 1)[0].strip()
            if k in new_keys:
                new_lines.append(f"{k}={new_keys[k]}")
                updated_keys.add(k)
                continue
        new_lines.append(line)

    for k, v in new_keys.items():
        if k not in updated_keys:
            new_lines.append(f"{k}={v}")

    ENV_PATH.write_text("\n".join(new_lines), encoding="utf-8")
    return get_smtp_config()

def send_task_assignment_email(task, member, frontend_url=None):
    """
    Sends an immediate email notification to the team member informing them of their new/updated task,
    complete with task metadata and their personal status portal link.
    """
    if not frontend_url:
        frontend_url = os.getenv("FRONTEND_URL", "http://localhost:5000").rstrip("/")

    portal_url = f"{frontend_url}/?portal={member.id}"
    due_str = task.due_date.isoformat() if task.due_date else "No due date"
    priority_upper = (task.priority or "MEDIUM").upper()

    subject = f"📋 New Task Assigned: {task.title} | Office Task Hub"

    body_text = f"""Hi {member.name},

You have been assigned a new task on Office Task Hub.

Task Details:
- Title: {task.title}
- Priority: {priority_upper}
- Due Date: {due_str}
- Current Status: {task.status.replace('_', ' ').title()}
- Description: {task.description or 'No additional description provided.'}

Your Personal Status Portal:
Open your dedicated dashboard to update your progress (Yet to Start, In Progress, Review, or Completed) and add notes:
{portal_url}

Best regards,
Office Task Hub Operations
"""

    priority_color = {
        "urgent": "#ff4d6d",
        "high": "#ff758f",
        "medium": "#f5b83d",
        "low": "#50d890"
    }.get((task.priority or "").lower(), "#f5b83d")

    body_html = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #08111d; color: #edf4fb; margin: 0; padding: 24px; }}
    .card {{ max-width: 580px; margin: 0 auto; background: #0e1a2b; border: 1px solid #23374e; border-radius: 14px; overflow: hidden; box-shadow: 0 16px 40px rgba(0,0,0,0.4); }}
    .header {{ background: linear-gradient(135deg, #16263b, #0d1725); padding: 24px 28px; border-bottom: 1px solid #23374e; }}
    .badge {{ display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: 1px; padding: 4px 10px; border-radius: 20px; background: rgba(245,184,61,0.15); color: #f5b83d; }}
    .title {{ font-size: 22px; font-weight: 700; margin: 12px 0 4px; color: #ffffff; }}
    .content {{ padding: 28px; }}
    .greeting {{ font-size: 16px; margin-bottom: 18px; color: #cbd7e4; }}
    .task-box {{ background: #132236; border-left: 4px solid {priority_color}; border-radius: 8px; padding: 18px; margin: 20px 0; }}
    .task-title {{ font-size: 18px; font-weight: 600; color: #ffffff; margin-bottom: 8px; }}
    .meta-row {{ display: flex; gap: 16px; font-size: 13px; color: #8fa5bc; margin-top: 10px; }}
    .meta-item b {{ color: #e1ecf7; }}
    .desc {{ font-size: 14px; line-height: 1.6; color: #9bb0c6; margin-top: 12px; white-space: pre-wrap; }}
    .btn-container {{ text-align: center; margin: 32px 0 20px; }}
    .portal-btn {{ display: inline-block; background: #f5b83d; color: #08111d; font-weight: 700; font-size: 15px; padding: 14px 28px; border-radius: 8px; text-decoration: none; box-shadow: 0 6px 20px rgba(245,184,61,0.3); }}
    .portal-link {{ font-size: 12px; color: #6a829c; word-break: break-all; margin-top: 10px; }}
    .footer {{ padding: 18px 28px; background: #0a1320; border-top: 1px solid #1c2c3e; font-size: 12px; color: #617891; text-align: center; }}
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <span class="badge">OFFICE TASK HUB</span>
      <div class="title">New Task Assigned</div>
    </div>
    <div class="content">
      <div class="greeting">Hi <b>{member.name}</b>,</div>
      <p style="color: #9bb0c6; font-size: 14px; margin: 0 0 16px;">
        You have been assigned a new task. Please review the details below and update your status in your personal portal:
      </p>

      <div class="task-box">
        <div class="task-title">{task.title}</div>
        <div class="meta-row">
          <div class="meta-item">Priority: <b style="color: {priority_color};">{priority_upper}</b></div>
          <div class="meta-item">Due: <b>{due_str}</b></div>
          <div class="meta-item">Status: <b>{task.status.replace('_', ' ').title()}</b></div>
        </div>
        {f'<div class="desc">{task.description}</div>' if task.description else ''}
      </div>

      <div class="btn-container">
        <a href="{portal_url}" class="portal-btn">👉 Open Your Status Portal</a>
        <div class="portal-link">Or open: <a href="{portal_url}" style="color: #54d8d1;">{portal_url}</a></div>
      </div>
    </div>
    <div class="footer">
      Office Task Hub Operations System &bull; Live workspace &bull; Automated notification
    </div>
  </div>
</body>
</html>
"""

    cfg = get_smtp_config()
    if not cfg["is_configured"]:
        # Log to outbox as simulated
        log_email(
            to_email=member.email,
            subject=subject,
            body_text=body_text,
            body_html=body_html,
            status="simulated",
            error="SMTP not configured in .env (Saved to Outbox Preview)"
        )
        print(f"[EMAIL SIMULATION] Task notification logged to outbox for {member.email}: {task.title}")
        return {
            "success": True,
            "mode": "simulation",
            "message": f"Task notification logged to Outbox for {member.email}. Configure SMTP in Email Center or backend/.env for live delivery."
        }

    # Attempt real SMTP delivery
    try:
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = cfg["from_email"]
        msg["To"] = member.email
        msg.set_content(body_text)
        msg.add_alternative(body_html, subtype="html")

        with smtplib.SMTP(cfg["host"], cfg["port"], timeout=12) as server:
            server.starttls()
            server.login(cfg["username"], cfg["password"])
            server.send_message(msg)

        log_email(
            to_email=member.email,
            subject=subject,
            body_text=body_text,
            body_html=body_html,
            status="sent"
        )
        print(f"[EMAIL SENT] Live email delivered to {member.email}: {task.title}")
        return {"success": True, "mode": "smtp", "message": f"Email delivered to {member.email}."}
    except Exception as e:
        error_msg = str(e)
        log_email(
            to_email=member.email,
            subject=subject,
            body_text=body_text,
            body_html=body_html,
            status="failed",
            error=error_msg
        )
        print(f"[EMAIL ERROR] Failed sending to {member.email}: {error_msg}")
        return {"success": False, "mode": "smtp", "error": error_msg}

def send_test_email(to_email):
    """Verifies SMTP connectivity and sends a test message."""
    cfg = get_smtp_config()
    if not cfg["is_configured"]:
        return {
            "success": False,
            "error": "SMTP credentials are not configured yet. Please enter your email and 16-character App Password below in the 'Configure SMTP' section."
        }

    subject = "✅ Office Task Hub: SMTP Test Connection"
    body_text = f"Hello! This is a test email sent from your Office Task Hub backend at {datetime.utcnow().isoformat()} UTC."
    body_html = f"""<div style="font-family:sans-serif;background:#0d1825;color:#fff;padding:24px;border-radius:10px;">
        <h2 style="color:#f5b83d;">Office Task Hub Test Email</h2>
        <p>Your SMTP configuration is working correctly!</p>
        <p><small>Timestamp: {datetime.utcnow().isoformat()} UTC</small></p>
    </div>"""

    try:
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = cfg["from_email"]
        msg["To"] = to_email
        msg.set_content(body_text)
        msg.add_alternative(body_html, subtype="html")

        with smtplib.SMTP(cfg["host"], cfg["port"], timeout=10) as server:
            server.starttls()
            server.login(cfg["username"], cfg["password"])
            server.send_message(msg)

        log_email(to_email, subject, body_text, body_html, status="sent")
        return {"success": True, "message": f"Test email sent successfully to {to_email}."}
    except Exception as e:
        log_email(to_email, subject, body_text, body_html, status="failed", error=str(e))
        return {"success": False, "error": str(e)}

def send_daily_emails():
    """Daily digest for all team members with their open tasks.

    Returns a summary dict so the cron endpoint can report what happened.
    """
    module = _resolve_module()
    app, TeamMember, Task = module.app, module.TeamMember, module.Task

    cfg = get_smtp_config()
    frontend_url = os.getenv("FRONTEND_URL", "http://localhost:5000").rstrip("/")
    today = date.today()
    summary = {"members": 0, "sent": 0, "simulated": 0, "failed": 0}

    with app.app_context():
        members = TeamMember.query.filter_by(active=True).all()
        summary["members"] = len(members)
        for member in members:
            tasks = Task.query.filter(
                Task.member_id == member.id,
                Task.status != "done"
            ).order_by(Task.position.asc(), Task.due_date.asc().nullslast()).all()

            portal_url = f"{frontend_url}/?portal={member.id}"
            subject = f"📅 Your Daily Task Plan — {today.isoformat()}"

            lines = [f"Hi {member.name},", "", f"Here is your task plan for {today.isoformat()}:", ""]
            if not tasks:
                lines.append("No open tasks are currently assigned to you.")
            else:
                for t in tasks:
                    due = t.due_date.isoformat() if t.due_date else "No due date"
                    lines.append(f"- {t.title} [{t.status}] | Priority: {t.priority} | Due: {due}")

            lines += ["", "Update your tasks in your personal portal:", portal_url, "", "— Office Task Hub"]
            body_text = "\n".join(lines)

            if cfg["is_configured"]:
                try:
                    msg = EmailMessage()
                    msg["Subject"] = subject
                    msg["From"] = cfg["from_email"]
                    msg["To"] = member.email
                    msg.set_content(body_text)
                    with smtplib.SMTP(cfg["host"], cfg["port"], timeout=12) as s:
                        s.starttls()
                        s.login(cfg["username"], cfg["password"])
                        s.send_message(msg)
                    log_email(member.email, subject, body_text, "", "sent")
                    summary["sent"] += 1
                except Exception as e:
                    log_email(member.email, subject, body_text, "", "failed", error=str(e))
                    summary["failed"] += 1
            else:
                log_email(member.email, subject, body_text, "", "simulated", error="SMTP not configured in .env")
                summary["simulated"] += 1

    return summary

if __name__ == "__main__":
    send_daily_emails()
