import os
import json
import html
import smtplib
from datetime import datetime, date, timedelta, timezone as dt_timezone
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

def _setting_key(name):
    return f"smtp_{name}"


def _load_stored_setting(name, default=""):
    """Read one SMTP value saved through the Email Center."""
    try:
        module = _resolve_module()
        with _maybe_app_context(module.app):
            row = module.AppSetting.query.filter_by(key=_setting_key(name)).first()
            return (row.value if row and row.value else default)
    except Exception as e:
        print(f"[SMTP SETTINGS READ ERROR] {name}: {e}")
        return default


def _save_setting(key, value):
    """Persist one setting row, creating it if needed."""
    module = _resolve_module()
    with _maybe_app_context(module.app):
        row = module.AppSetting.query.filter_by(key=key).first()
        if row:
            row.value = value or ""
        else:
            module.db.session.add(module.AppSetting(key=key, value=value or ""))
        module.db.session.commit()


def _derive_encryption_key():
    """Derive a 32-byte Fernet key from SECRET_KEY.

    Storing the SMTP password in the database means it must not sit in plain
    text, so it is encrypted with a key derived from the app secret. Changing
    SECRET_KEY makes existing stored credentials unreadable.
    """
    import base64
    import hashlib

    secret = (os.getenv("SECRET_KEY") or "").strip()
    if not secret:
        # Local fallback so saving still works without SECRET_KEY configured.
        secret = "office-task-hub-local-development-key"
    digest = hashlib.sha256(secret.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest)


def encrypt_secret(plaintext):
    from cryptography.fernet import Fernet

    if not plaintext:
        return ""
    return Fernet(_derive_encryption_key()).encrypt(plaintext.encode("utf-8")).decode("utf-8")


def decrypt_secret(ciphertext):
    from cryptography.fernet import Fernet, InvalidToken

    if not ciphertext:
        return ""
    try:
        return Fernet(_derive_encryption_key()).decrypt(ciphertext.encode("utf-8")).decode("utf-8")
    except (InvalidToken, ValueError):
        # Most likely SECRET_KEY changed, so the stored value is unreadable.
        return ""


def get_smtp_config():
    """Environment variables win; anything missing falls back to what was saved
    through the Email Center, so the form stays configured across restarts."""
    host = os.getenv("SMTP_HOST", "").strip() or _load_stored_setting("host")
    try:
        port = int(os.getenv("SMTP_PORT", "").strip() or _load_stored_setting("port", "587"))
    except ValueError:
        port = 587
    user = os.getenv("SMTP_USERNAME", "").strip() or _load_stored_setting("username")

    env_password = os.getenv("SMTP_PASSWORD", "").strip()
    password = env_password or decrypt_secret(_load_stored_setting("password"))

    from_email = os.getenv("SMTP_FROM", "").strip() or _load_stored_setting("from_email") or user
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
    """Persists SMTP credentials to the database and syncs the live process."""
    host = (host or "smtp.gmail.com").strip()
    port = str(port or "587").strip()
    username = (username or "").strip()
    password = (password or "").strip()
    from_email = (from_email or username).strip()

    # Persist to the database so the settings survive a refresh, a restart and
    # a redeploy. The password is encrypted, never stored as plain text.
    _save_setting(_setting_key("host"), host)
    _save_setting(_setting_key("port"), str(port))
    _save_setting(_setting_key("username"), username)
    _save_setting(_setting_key("password"), encrypt_secret(password))
    _save_setting(_setting_key("from_email"), from_email)

    # Keep the live process in sync so a test email sent right after saving works.
    os.environ["SMTP_HOST"] = host
    os.environ["SMTP_PORT"] = str(port)
    os.environ["SMTP_USERNAME"] = username
    os.environ["SMTP_PASSWORD"] = password
    os.environ["SMTP_FROM"] = from_email

    if not IS_SERVERLESS:
        # Also mirror to .env for local convenience. The database is the
        # source of truth, so a failed write here is harmless.
        _mirror_to_env_file({
            "SMTP_HOST": host,
            "SMTP_PORT": str(port),
            "SMTP_USERNAME": username,
            "SMTP_PASSWORD": password,
            "SMTP_FROM": from_email,
        })

    return get_smtp_config()


def _mirror_to_env_file(new_keys):
    try:
        lines = ENV_PATH.read_text(encoding="utf-8").splitlines() if ENV_PATH.exists() else []

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
    except Exception as e:
        print(f"[SMTP ENV MIRROR NOTICE] {e}")


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


# ---------------- Due-date reminders ----------------

# Marker embedded in the subject so a second run on the same day is a no-op.
# Vercel cron can retry, and a manual "Send now" can be pressed twice.
REMINDER_MARKER = "[due-reminder]"


def _reminder_html(member, tasks, portal_url, today):
    """A small, readable mail. Kept inline because there is no template engine."""
    rows = []
    for t in tasks:
        if t.due_date < today:
            when, tone = f"Overdue since {t.due_date.strftime('%d %b')}", "#b3261e"
        elif t.due_date == today:
            when, tone = "Due today", "#8a5a00"
        else:
            days = (t.due_date - today).days
            when, tone = f"Due in {days} day{'s' if days != 1 else ''}", "#0f6b41"

        label = {
            "todo": "Not started",
            "in_progress": "In progress",
            "review": "Waiting for sign-off",
        }.get(t.status, t.status)

        rows.append(f"""
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e6edf5;">
            <div style="font-weight:600;color:#16212e;font-size:14px;">{html.escape(t.title)}</div>
            <div style="color:{tone};font-size:12px;font-weight:600;margin-top:3px;">{when}</div>
          </td>
          <td style="padding:10px 0;border-bottom:1px solid #e6edf5;text-align:right;
                     color:#5c7085;font-size:12px;white-space:nowrap;">{html.escape(label)}</td>
        </tr>""")

    first = tasks[0].title
    extra = len(tasks) - 1
    heading = (
        f"You have {len(tasks)} task{'s' if len(tasks) != 1 else ''} with a due date "
        f"that {'have' if len(tasks) != 1 else 'has'} not been marked complete."
    )

    return f"""<!doctype html>
<html><body style="margin:0;padding:24px;background:#eef2f7;
  font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#16212e;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;
       border:1px solid #dbe4ee;overflow:hidden;">
    <div style="background:linear-gradient(135deg,#d98c04,#f5b83d);padding:18px 24px;">
      <div style="font-size:11px;letter-spacing:1.6px;font-weight:700;color:#5c3d00;">
        DAILY REMINDER
      </div>
      <div style="font-size:19px;font-weight:700;color:#231604;margin-top:4px;">
        Please update your task status
      </div>
    </div>

    <div style="padding:22px 24px 8px;">
      <p style="margin:0 0 14px;font-size:14px;color:#2f4256;line-height:1.6;">
        Hi {html.escape(member.name.split()[0])}, it is {today.strftime('%A %d %B %Y')}.
        {heading}
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{''.join(rows)}</table>

      <div style="margin:20px 0 6px;">
        <a href="{portal_url}"
           style="display:inline-block;background:#d98c04;color:#ffffff;text-decoration:none;
                  font-weight:700;font-size:14px;padding:12px 22px;border-radius:9px;">
          Update my status
        </a>
      </div>
      <p style="margin:10px 0 0;font-size:11px;color:#7d8fa1;word-break:break-all;">
        If the button does not work, open your portal:<br>{portal_url}
      </p>
    </div>

    <div style="padding:14px 24px 18px;border-top:1px solid #eef2f7;color:#8496a8;font-size:11px;">
      You get this once a day at 6:00pm IST, and only while something with a due date
      is still open. Finish the work or move the due date and it stops.
      {f'<br><br>Starting with: {html.escape(first)}{f" and {extra} more." if extra else "."}' if tasks else ""}
    </div>
  </div>
</body></html>"""


def send_due_date_reminders(force=False, dry_run=False):
    """Remind everyone with an unfinished, dated task to update their portal.

    Runs at 6pm IST. A member is only mailed once per day unless force is set,
    so a retried cron or a double click cannot spam the team. dry_run renders
    the mail and logs nothing, which is what the Preview button uses.
    """
    module = _resolve_module()
    app, TeamMember, Task, EmailLog = (
        module.app, module.TeamMember, module.Task, module.EmailLog,
    )

    cfg = get_smtp_config()
    frontend_url = os.getenv("FRONTEND_URL", "http://localhost:5000").rstrip("/")

    # Reminders are a 6pm IST affair, so the date is decided in IST rather than
    # in UTC. Otherwise anyone east of Greenwich gets the wrong day's email.
    ist = dt_timezone(timedelta(hours=5, minutes=30))
    today = datetime.utcnow().replace(tzinfo=dt_timezone.utc).astimezone(ist).date()

    summary = {
        "checked_members": 0, "eligible": 0, "sent": 0, "simulated": 0,
        "failed": 0, "skipped_already_sent": 0, "date_ist": today.isoformat(),
        "dry_run": bool(dry_run), "sample": None,
    }

    with app.app_context():
        members = TeamMember.query.filter_by(active=True).all()
        summary["checked_members"] = len(members)

        for member in members:
            # The whole point: a due date exists and it is not finished.
            tasks = Task.query.filter(
                Task.member_id == member.id,
                Task.status != "done",
                Task.due_date.isnot(None),
            ).order_by(Task.due_date.asc()).all()

            if not tasks:
                continue
            summary["eligible"] += 1

            subject = (
                f"{REMINDER_MARKER} Please update your status — "
                f"{len(tasks)} task{'s' if len(tasks) != 1 else ''} still open"
            )

            if not force:
                # Only a send that actually got through counts as "already
                # reminded". A failed SMTP attempt must stay retryable, or one
                # blip would silence that person for the whole day.
                day_start = datetime.combine(today, datetime.min.time()) - timedelta(hours=5, minutes=30)
                day_end = datetime.combine(today, datetime.max.time()) - timedelta(hours=5, minutes=30)
                already = EmailLog.query.filter(
                    EmailLog.to_email == member.email,
                    EmailLog.subject.like(f"%{REMINDER_MARKER}%"),
                    EmailLog.status != "failed",
                    EmailLog.created_at >= day_start,
                    EmailLog.created_at < day_end,
                ).count()
                if already:
                    summary["skipped_already_sent"] += 1
                    continue

            portal_url = f"{frontend_url}/?portal={member.id}"
            body_html = _reminder_html(member, tasks, portal_url, today)

            text_lines = [
                f"Hi {member.name.split()[0]},", "",
                f"It is {today.strftime('%A %d %B %Y')}. You have {len(tasks)} task"
                f"{'s' if len(tasks) != 1 else ''} with a due date that "
                f"{'have' if len(tasks) != 1 else 'has'} not been marked complete:", "",
            ]
            for t in tasks:
                when = "overdue" if t.due_date < today else (
                    "due today" if t.due_date == today
                    else f"due {t.due_date.strftime('%d %b')}"
                )
                text_lines.append(f"- {t.title} ({t.status}) — {when}")
            text_lines += [
                "", "Update your status here:", portal_url, "",
                "You get this once a day at 6pm IST, and only while something with a",
                "due date is still open.", "", "— Office Task Hub",
            ]
            body_text = "\n".join(text_lines)

            if dry_run:
                # Show the manager what would go out, without sending or logging.
                if summary["sample"] is None:
                    summary["sample"] = {
                        "to": member.email,
                        "subject": subject,
                        "tasks": [t.title for t in tasks],
                        "portal_url": portal_url,
                        "body_html": body_html,
                    }
                summary["simulated"] += 1
                continue

            if not cfg["is_configured"]:
                log_email(member.email, subject, body_text, body_html,
                          "simulated", error="SMTP not configured")
                summary["simulated"] += 1
                continue

            try:
                msg = EmailMessage()
                msg["Subject"] = subject
                msg["From"] = cfg["from_email"]
                msg["To"] = member.email
                msg.set_content(body_text)
                msg.add_alternative(body_html, subtype="html")
                with smtplib.SMTP(cfg["host"], cfg["port"], timeout=12) as s:
                    s.starttls()
                    s.login(cfg["username"], cfg["password"])
                    s.send_message(msg)
                log_email(member.email, subject, body_text, body_html, "sent")
                summary["sent"] += 1
            except Exception as e:
                log_email(member.email, subject, body_text, body_html,
                          "failed", error=str(e))
                summary["failed"] += 1

    return summary


if __name__ == "__main__":
    send_daily_emails()
