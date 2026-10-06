import os
import sys
import hmac
import io
import json
from datetime import datetime, date, timedelta
from pathlib import Path
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory, session, send_file
from flask_cors import CORS
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import text
from werkzeug.security import check_password_hash, generate_password_hash

# Sibling modules (emailer) are imported by bare name below. Locally that works
# because you run from backend/, but serverless hosts set the working directory
# to the project root, so put this file's own directory on the path first.
BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

load_dotenv(BACKEND_DIR / ".env")

# Path to built React frontend
FRONTEND_DIST = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "frontend", "dist"))


def normalize_database_url(url):
    """
    Accepts the connection strings hosting providers hand out and returns one
    SQLAlchemy can open.

    Neon/Supabase/Vercel Postgres often give a "postgres://" URL with a query
    string. SQLAlchemy needs an explicit driver, and Neon requires TLS, which is
    expressed as "sslmode=require" rather than "ssl=true".
    """
    url = (url or "").strip()
    if not url:
        return "sqlite:///office_tasks.db"

    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]

    if url.startswith("postgresql+psycopg://") and "sslmode=" not in url:
        # libpq/psycopg expresses TLS as sslmode; ssl=true is the older spelling.
        if "ssl=true" in url:
            url = url.replace("ssl=true", "sslmode=require")
        else:
            url += ("&" if "?" in url else "?") + "sslmode=require"

    return url

app = Flask(
    __name__,
    static_folder=os.path.join(FRONTEND_DIST, "assets") if os.path.exists(FRONTEND_DIST) else None,
    static_url_path="/assets"
)
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "office-task-hub-secret-key-2026")
app.config["SQLALCHEMY_DATABASE_URI"] = normalize_database_url(
    os.getenv("DATABASE_URL", "sqlite:///office_tasks.db")
)
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
# Keep the manager signed in across browser restarts.
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
# HTTPS-only cookies are the default in production, but being explicit also
# covers an HTTP preview deployment.
app.config["SESSION_COOKIE_SECURE"] = os.getenv("VERCEL") is not None
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=7)
# Serverless platforms reuse warm containers; recycle connections after a while
# instead of holding them open until the pool times out.
app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {"pool_pre_ping": True}

CORS(app, resources={r"/api/*": {"origins": "*"}})
db = SQLAlchemy(app)

class TeamMember(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    email = db.Column(db.String(180), nullable=False, unique=True)
    role = db.Column(db.String(120), default="Team Member")
    avatar = db.Column(db.String(20), default="👨‍💻")
    active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    tasks = db.relationship("Task", backref="member", lazy=True, cascade="all, delete-orphan")


class AppSetting(db.Model):
    """Persisted settings that must survive refreshes and redeploys.

    The Email Center used to write to backend/.env, which is read-only on
    Vercel and discarded between containers, so the form asked for credentials
    on every page load.
    """
    id = db.Column(db.Integer, primary_key=True)
    key = db.Column(db.String(120), unique=True, nullable=False)
    value = db.Column(db.Text, default="")
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class EmailLog(db.Model):
    """Durable replacement for instance/outbox.json, which cannot persist on Vercel."""
    id = db.Column(db.Integer, primary_key=True)
    to_email = db.Column(db.String(180), nullable=False)
    subject = db.Column(db.String(400), default="")
    body_text = db.Column(db.Text, default="")
    body_html = db.Column(db.Text, default="")
    status = db.Column(db.String(20), default="sent")  # sent, simulated, failed
    error = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            "id": self.id,
            "to": self.to_email,
            "subject": self.subject or "",
            "body_text": self.body_text or "",
            "body_html": self.body_html or "",
            "status": self.status,
            "error": self.error,
            "timestamp": self.created_at.isoformat() if self.created_at else None,
        }


class QaRun(db.Model):
    """One automated QA pass over the client site."""
    id = db.Column(db.Integer, primary_key=True)
    site_url = db.Column(db.String(300), nullable=False)
    status = db.Column(db.String(20), default="healthy")  # healthy, warning, critical
    summary = db.Column(db.Text, default="")
    homepage_status = db.Column(db.Integer, default=0)
    response_ms = db.Column(db.Integer, default=0)
    issues = db.Column(db.Text, default="[]")       # JSON list
    pages = db.Column(db.Text, default="[]")        # JSON list
    assets = db.Column(db.Text, default="[]")       # JSON list
    content_added = db.Column(db.Text, default="[]")
    content_removed = db.Column(db.Text, default="[]")
    content_fingerprint = db.Column(db.String(80), nullable=True)
    checked_at = db.Column(db.DateTime, default=datetime.utcnow)
    # Set when a scheduled run happens, cleared when a human presses the button.
    trigger = db.Column(db.String(20), default="manual")

    def to_dict(self, include_detail=True):
        data = {
            "id": self.id,
            "site_url": self.site_url,
            "status": self.status,
            "summary": self.summary,
            "homepage_status": self.homepage_status,
            "response_ms": self.response_ms,
            "issue_count": len(self._json(self.issues)),
            "critical_count": sum(
                1 for i in self._json(self.issues) if i.get("severity") == "critical"
            ),
            "warning_count": sum(
                1 for i in self._json(self.issues) if i.get("severity") == "warning"
            ),
            "checked_at": self.checked_at.isoformat() if self.checked_at else None,
            "trigger": self.trigger,
        }
        if include_detail:
            data.update({
                "issues": self._json(self.issues),
                "pages": self._json(self.pages),
                "assets": self._json(self.assets),
                "content_added": self._json(self.content_added),
                "content_removed": self._json(self.content_removed),
            })
        return data

    @staticmethod
    def _json(raw):
        try:
            value = json.loads(raw or "[]")
            return value if isinstance(value, list) else []
        except (ValueError, TypeError):
            return []


class SecurityRun(db.Model):
    """One automated security review of the client site."""
    id = db.Column(db.Integer, primary_key=True)
    site_url = db.Column(db.String(300), nullable=False)
    status = db.Column(db.String(20), default="healthy")  # healthy, warning, critical
    summary = db.Column(db.Text, default="")
    findings = db.Column(db.Text, default="[]")     # JSON list
    tls = db.Column(db.Text, default="{}")          # JSON object
    paths_checked = db.Column(db.Text, default="[]")  # JSON list
    security_txt = db.Column(db.Boolean, default=False)
    homepage_status = db.Column(db.Integer, default=0)
    critical_count = db.Column(db.Integer, default=0)
    warning_count = db.Column(db.Integer, default=0)
    info_count = db.Column(db.Integer, default=0)
    checked_at = db.Column(db.DateTime, default=datetime.utcnow)
    trigger = db.Column(db.String(20), default="manual")

    def to_dict(self, include_detail=True):
        data = {
            "id": self.id,
            "site_url": self.site_url,
            "status": self.status,
            "summary": self.summary,
            "critical_count": self.critical_count or 0,
            "warning_count": self.warning_count or 0,
            "info_count": self.info_count or 0,
            "finding_count": len(self._json(self.findings)),
            "security_txt": bool(self.security_txt),
            "homepage_status": self.homepage_status,
            "checked_at": self.checked_at.isoformat() if self.checked_at else None,
            "trigger": self.trigger,
        }
        if include_detail:
            data.update({
                "findings": self._json(self.findings),
                "tls": self._json_object(self.tls),
                "paths_checked": self._json(self.paths_checked),
            })
        return data

    @staticmethod
    def _json(raw):
        try:
            value = json.loads(raw or "[]")
            return value if isinstance(value, list) else []
        except (ValueError, TypeError):
            return []

    @staticmethod
    def _json_object(raw):
        try:
            value = json.loads(raw or "{}")
            return value if isinstance(value, dict) else {}
        except (ValueError, TypeError):
            return {}


class Task(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(240), nullable=False)
    description = db.Column(db.Text, default="")
    status = db.Column(db.String(30), default="todo")  # todo, in_progress, review, done
    priority = db.Column(db.String(20), default="medium")
    due_date = db.Column(db.Date, nullable=True)
    position = db.Column(db.Integer, default=0)
    notes = db.Column(db.Text, default="")  # Member progress updates / notes
    member_id = db.Column(db.Integer, db.ForeignKey("team_member.id"), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def to_dict(self):
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description or "",
            "status": self.status,
            "priority": self.priority,
            "due_date": self.due_date.isoformat() if self.due_date else None,
            "position": self.position,
            "notes": self.notes or "",
            "member_id": self.member_id,
            "member_name": self.member.name if self.member else None,
            "member_avatar": self.member.avatar if self.member else "👨‍💻",
            "member_role": self.member.role if self.member else "",
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


def member_dict(m):
    return {
        "id": m.id,
        "name": m.name,
        "email": m.email,
        "role": m.role,
        "avatar": m.avatar,
        "active": m.active,
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


# Import emailer helpers after models are defined
from emailer import (
    send_task_assignment_email,
    get_outbox,
    send_test_email,
    get_smtp_config,
    update_smtp_config,
    send_daily_emails,
    send_due_date_reminders,
    decrypt_secret,
)

import qa_bot
import security_bot
import report_pdf
import jarvis
import gmail_service
from flask import redirect


DEFAULT_QA_SITE = os.getenv("QA_SITE_URL", "https://ngocore.in").rstrip("/")


def _latest_qa_run():
    return QaRun.query.order_by(QaRun.checked_at.desc(), QaRun.id.desc()).first()


def _store_qa_run(report, trigger):
    run = QaRun(
        site_url=report.get("site_url") or DEFAULT_QA_SITE,
        status=report["status"],
        summary=report["summary"],
        homepage_status=report["homepage_status"],
        response_ms=report["response_ms"],
        issues=json.dumps(report["issues"]),
        pages=json.dumps(report["pages"]),
        assets=json.dumps(report["assets"]),
        content_added=json.dumps(report["content_added"]),
        content_removed=json.dumps(report["content_removed"]),
        content_fingerprint=report.get("content_fingerprint"),
        trigger=trigger,
    )
    db.session.add(run)
    db.session.commit()
    return run


def _latest_security_run():
    return SecurityRun.query.order_by(
        SecurityRun.checked_at.desc(), SecurityRun.id.desc()
    ).first()


def _run_and_store_security_check(trigger):
    """Runs the passive security review and records it."""
    report = security_bot.run_security_check(DEFAULT_QA_SITE)
    run = SecurityRun(
        site_url=DEFAULT_QA_SITE,
        status=report["status"],
        summary=report["summary"],
        findings=json.dumps(report["findings"]),
        tls=json.dumps(report["tls"] or {}),
        paths_checked=json.dumps(report["paths_checked"]),
        security_txt=report["security_txt"],
        homepage_status=report["homepage_status"],
        critical_count=report["critical_count"],
        warning_count=report["warning_count"],
        info_count=report["info_count"],
        trigger=trigger,
    )
    db.session.add(run)
    db.session.commit()
    return run


def _run_and_store_qa_check(trigger):
    """Runs the full QA pass and records it. Shared by the cron and the button."""
    previous = _latest_qa_run()
    report = qa_bot.run_check(
        DEFAULT_QA_SITE,
        previous_text=None,
        previous_fingerprint=previous.content_fingerprint if previous else None,
    )
    report["site_url"] = DEFAULT_QA_SITE

    changed = bool(
        previous
        and previous.content_fingerprint
        and report.get("content_fingerprint")
        and previous.content_fingerprint != report["content_fingerprint"]
    )
    if not changed:
        report["content_added"] = []
        report["content_removed"] = []

    report["summary"] = qa_bot.build_summary(
        report["status"], report["issues"], report["pages"], report["assets"],
        {"added": report["content_added"], "removed": report["content_removed"]}
        if changed else None,
        blocked=report.get("scan_blocked", False),
    )
    return _store_qa_run(report, trigger)


# ---------------- Admin Authentication ----------------

def is_admin_auth_enabled():
    """Auth is enforced once a password exists, either as ADMIN_PASSWORD in the
    environment or one saved from the Security panel. Local development keeps
    working with neither set."""
    if os.getenv("ADMIN_PASSWORD", "").strip():
        return True
    return bool(AppSetting.query.filter_by(key="admin_password_hash").first())


def is_admin_authenticated():
    return session.get("is_admin") is True


def require_admin(fn):
    """Guards every manager-facing endpoint. Member portal routes stay open
    because employees reach them by their own shareable link."""
    from functools import wraps

    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not is_admin_auth_enabled():
            return fn(*args, **kwargs)
        if not is_admin_authenticated():
            return jsonify({"error": "Manager sign-in required.", "auth_required": True}), 401
        return fn(*args, **kwargs)

    return wrapper


# ---------------- STATIC SPA FRONTEND SERVING (SINGLE SERVER) ----------------

@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve_frontend(path):
    # Pass through API requests
    if path.startswith("api/"):
        return jsonify({"error": "Endpoint not found"}), 404

    # Serve static assets or index.html from compiled dist
    if os.path.exists(FRONTEND_DIST):
        file_path = os.path.join(FRONTEND_DIST, path)
        if path and os.path.exists(file_path) and os.path.isfile(file_path):
            return send_from_directory(FRONTEND_DIST, path)
        return send_from_directory(FRONTEND_DIST, "index.html")

    return jsonify({
        "service": "Office Task Hub Backend",
        "notice": "Frontend build not found. You can run 'npm run build' in frontend/ to serve everything from this port 5000, or run 'npm run dev' on port 5173."
    }), 200


# ---------------- API ENDPOINTS ----------------

def get_stored_admin_hash():
    """Password hash saved from the Security panel, if the manager set one.

    Takes precedence over ADMIN_PASSWORD once it exists, so changing the
    password from the UI actually takes effect.
    """
    row = AppSetting.query.filter_by(key="admin_password_hash").first()
    return row.value if row and row.value else ""


def admin_password_matches(candidate):
    """Check a password against the stored hash, falling back to the env var."""
    if not candidate:
        return False

    stored = get_stored_admin_hash()
    if stored:
        return check_password_hash(stored, candidate)

    expected = os.getenv("ADMIN_PASSWORD", "").strip()
    if not expected:
        return False
    return hmac.compare_digest(candidate, expected)


@app.get("/api/auth/status")
def auth_status():
    """Lets the frontend know whether it should show a sign-in screen."""
    return jsonify({
        "enabled": is_admin_auth_enabled(),
        "authenticated": is_admin_authenticated(),
        "password_source": "database" if get_stored_admin_hash() else "environment",
    })


@app.post("/api/auth/change-password")
@require_admin
def change_admin_password():
    """Lets the manager rotate their password from the UI.

    Only reachable while already signed in, and only with the current
    password, so a stolen session alone cannot lock the owner out.
    """
    if not is_admin_auth_enabled():
        return jsonify({"error": "No admin password is configured to change."}), 400

    data = request.get_json(silent=True) or {}
    current = data.get("current_password") or ""
    new_password = (data.get("new_password") or "").strip()
    confirm = data.get("confirm_password")

    if not admin_password_matches(current):
        return jsonify({"error": "Current password is incorrect."}), 401

    if len(new_password) < 8:
        return jsonify({"error": "New password must be at least 8 characters."}), 400
    if confirm is not None and confirm != new_password:
        return jsonify({"error": "New passwords do not match."}), 400
    if new_password == current:
        return jsonify({"error": "New password must be different from the current one."}), 400

    row = AppSetting.query.filter_by(key="admin_password_hash").first()
    if row:
        row.value = generate_password_hash(new_password)
    else:
        db.session.add(AppSetting(key="admin_password_hash", value=generate_password_hash(new_password)))
    db.session.commit()

    return jsonify({
        "ok": True,
        "message": "Password updated. Use the new password next time you sign in.",
    })


@app.post("/api/auth/login")
def auth_login():
    if not is_admin_auth_enabled():
        return jsonify({"ok": True, "enabled": False})

    data = request.get_json(silent=True) or {}
    supplied = (data.get("password") or "").strip()

    if not admin_password_matches(supplied):
        return jsonify({"error": "Incorrect password."}), 401

    session.permanent = True
    session["is_admin"] = True
    return jsonify({"ok": True, "enabled": True})


@app.post("/api/auth/logout")
def auth_logout():
    session.pop("is_admin", None)
    return jsonify({"ok": True})


@app.get("/api/health")
def health():
    cfg = get_smtp_config()
    return jsonify({
        "ok": True,
        "service": "Office Task Hub",
        "smtp_configured": cfg["is_configured"],
        "smtp_host": cfg["host"] or None,
    })


def get_manager_name():
    """What Jarvis calls you. Falls back to the MANAGER_NAME env var."""
    row = AppSetting.query.filter_by(key="manager_name").first()
    stored = (row.value if row else "").strip()
    return stored or os.getenv("MANAGER_NAME", "").strip()


def _browser_location():
    """Where the manager is, so the greeting uses their clock not the server's.

    The browser sends its IANA timezone (for example Asia/Kolkata) plus its
    current UTC offset in minutes. The saved preference wins when set, so a
    phone that travels or a browser with a misdetected zone still gets it right.
    """
    saved = AppSetting.query.filter_by(key="manager_timezone").first()
    stored_tz = (saved.value if saved else "").strip()
    if stored_tz:
        return stored_tz, None

    tz = (request.args.get("tz") or "").strip()[:64]
    offset = request.args.get("tzoffset")
    try:
        offset_minutes = float(offset) if offset not in (None, "") else None
    except (TypeError, ValueError):
        offset_minutes = None

    # Only trust a name Python can actually resolve, so it cannot become a
    # source of 500s from a mangled client.
    if tz:
        try:
            from zoneinfo import ZoneInfo
            ZoneInfo(tz)
        except Exception:
            tz = ""
    return tz or None, offset_minutes


@app.post("/api/manager/profile")
@require_admin
def manager_profile():
    """Save the name Jarvis greets you by, and the timezone it should use."""
    data = request.get_json(silent=True) or {}
    # Coerce rather than trust: a non-string here would otherwise 500.
    raw = data.get("name")
    name = (raw if isinstance(raw, str) else "").strip()[:60]

    tz = data.get("timezone")
    tz = (tz if isinstance(tz, str) else "").strip()[:64]
    if tz:
        try:
            from zoneinfo import ZoneInfo
            ZoneInfo(tz)
        except Exception:
            tz = ""   # not a zone Python knows, so fall back to auto-detect

    for key, value in (("manager_name", name), ("manager_timezone", tz)):
        row = AppSetting.query.filter_by(key=key).first()
        if row:
            row.value = value
        else:
            db.session.add(AppSetting(key=key, value=value))
    db.session.commit()

    return jsonify({"ok": True, "name": name, "timezone": tz})


@app.get("/api/dashboard")
@require_admin
def dashboard():
    members = TeamMember.query.filter_by(active=True).order_by(TeamMember.id).all()
    tasks = Task.query.order_by(Task.position.asc(), Task.created_at.desc()).all()

    today = date.today()
    cfg = get_smtp_config()

    return jsonify({
        "today": today.isoformat(),
        "smtp_status": {
            "configured": cfg["is_configured"],
            "host": cfg["host"],
            "from_email": cfg["from_email"],
            "username": cfg["username"],
        },
        "members": [member_dict(m) for m in members],
        "tasks": [t.to_dict() for t in tasks],
        "stats": {
            "team": len(members),
            "total": len(tasks),
            "todo": sum(t.status == "todo" for t in tasks),
            "in_progress": sum(t.status == "in_progress" for t in tasks),
            "review": sum(t.status == "review" for t in tasks),
            "done": sum(t.status == "done" for t in tasks),
            "due_today": sum(t.due_date == today and t.status != "done" for t in tasks),
        }
    })


@app.get("/api/members")
@require_admin
def get_members():
    return jsonify([member_dict(m) for m in TeamMember.query.order_by(TeamMember.id).all()])


@app.post("/api/members")
@require_admin
def create_member():
    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    email = (data.get("email") or "").strip().lower()
    if not name or not email:
        return jsonify({"error": "Name and email are required."}), 400
    if TeamMember.query.filter_by(email=email).first():
        return jsonify({"error": "A member with this email already exists."}), 409

    member = TeamMember(
        name=name,
        email=email,
        role=data.get("role") or "Team Member",
        avatar=data.get("avatar") or "👨‍💻",
    )
    db.session.add(member)
    db.session.commit()
    return jsonify(member_dict(member)), 201


@app.put("/api/members/<int:member_id>")
@require_admin
def update_member(member_id):
    member = db.get_or_404(TeamMember, member_id)
    data = request.get_json(force=True) or {}

    name = member.name
    email = member.email
    if "name" in data:
        name = (data["name"] or "").strip()
    if "email" in data:
        email = (data["email"] or "").strip().lower()

    if not name or not email:
        return jsonify({"error": "Name and email are required."}), 400

    clash = TeamMember.query.filter(TeamMember.email == email, TeamMember.id != member.id).first()
    if clash:
        return jsonify({"error": "A member with this email already exists."}), 409

    member.name = name
    member.email = email
    if "role" in data: member.role = data["role"]
    if "avatar" in data: member.avatar = data["avatar"]
    if "active" in data: member.active = bool(data["active"])

    db.session.commit()
    return jsonify(member_dict(member))


@app.delete("/api/members/<int:member_id>")
@require_admin
def delete_member(member_id):
    member = db.get_or_404(TeamMember, member_id)
    # tasks relationship uses cascade="all, delete-orphan", so assigned tasks go too
    removed_tasks = len(member.tasks)
    name = member.name
    db.session.delete(member)
    db.session.commit()
    return jsonify({
        "ok": True,
        "message": f"{name} removed from the office.",
        "deleted_tasks": removed_tasks,
    })


@app.get("/api/tasks")
@require_admin
def get_tasks():
    return jsonify([t.to_dict() for t in Task.query.order_by(Task.position.asc(), Task.created_at.desc()).all()])


@app.post("/api/tasks")
@require_admin
def create_task():
    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()
    member_id = data.get("member_id")
    if not title or not member_id:
        return jsonify({"error": "Task title and team member are required."}), 400

    try:
        member = db.session.get(TeamMember, int(member_id))
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid team member."}), 400
    if not member:
        return jsonify({"error": "Team member not found."}), 404

    status = data.get("status") or "todo"
    if status not in VALID_STATUSES:
        return jsonify({"error": f"Invalid status. Must be one of: {', '.join(VALID_STATUSES)}"}), 400

    priority = data.get("priority") or "medium"
    if priority not in VALID_PRIORITIES:
        return jsonify({"error": f"Invalid priority. Must be one of: {', '.join(VALID_PRIORITIES)}"}), 400

    due = None
    if data.get("due_date"):
        try:
            due = date.fromisoformat(data["due_date"])
        except ValueError:
            return jsonify({"error": "Due date must be in YYYY-MM-DD format."}), 400

    task = Task(
        title=title,
        description=data.get("description") or "",
        status=status,
        priority=priority,
        due_date=due,
        member_id=member.id,
        notes=data.get("notes") or "",
        position=int(data.get("position") or 0),
    )
    db.session.add(task)
    db.session.commit()

    # Automatically dispatch task assignment notification email
    email_result = None
    send_email = data.get("send_email", True)
    if send_email and member.email:
        email_result = send_task_assignment_email(task, member)

    response_data = task.to_dict()
    response_data["email_result"] = email_result
    return jsonify(response_data), 201


VALID_STATUSES = ("todo", "in_progress", "review", "done")
VALID_PRIORITIES = ("low", "medium", "high", "urgent")


@app.put("/api/tasks/<int:task_id>")
@require_admin
def update_task(task_id):
    task = db.get_or_404(Task, task_id)
    data = request.get_json(silent=True) or {}

    old_member_id = task.member_id

    if "title" in data:
        title = (data["title"] or "").strip()
        if not title:
            return jsonify({"error": "Task title cannot be empty."}), 400
        task.title = title

    if "status" in data:
        if data["status"] not in VALID_STATUSES:
            return jsonify({"error": f"Invalid status. Must be one of: {', '.join(VALID_STATUSES)}"}), 400
        task.status = data["status"]

    if "priority" in data:
        if data["priority"] not in VALID_PRIORITIES:
            return jsonify({"error": f"Invalid priority. Must be one of: {', '.join(VALID_PRIORITIES)}"}), 400
        task.priority = data["priority"]

    for field in ("description", "notes"):
        if field in data:
            setattr(task, field, data[field] or "")

    if "member_id" in data:
        try:
            new_id = int(data["member_id"])
        except (TypeError, ValueError):
            return jsonify({"error": "Invalid team member."}), 400
        member = db.session.get(TeamMember, new_id)
        if not member:
            return jsonify({"error": "Team member not found."}), 404
        task.member_id = member.id

    if "due_date" in data:
        if data["due_date"]:
            try:
                task.due_date = date.fromisoformat(data["due_date"])
            except ValueError:
                return jsonify({"error": "Due date must be in YYYY-MM-DD format."}), 400
        else:
            task.due_date = None

    if "position" in data:
        task.position = int(data["position"])

    task.updated_at = datetime.utcnow()
    db.session.commit()

    email_result = None
    reassigned = "member_id" in data and task.member_id != old_member_id
    if reassigned and data.get("notify_reassign", True):
        member = db.session.get(TeamMember, task.member_id)
        if member:
            email_result = send_task_assignment_email(task, member)

    res = task.to_dict()
    res["email_result"] = email_result
    res["reassigned"] = reassigned
    return jsonify(res)


@app.delete("/api/tasks/<int:task_id>")
@require_admin
def delete_task(task_id):
    task = db.get_or_404(Task, task_id)
    db.session.delete(task)
    db.session.commit()
    return jsonify({"ok": True})


@app.post("/api/tasks/<int:task_id>/resend-email")
@require_admin
def resend_task_email(task_id):
    task = db.get_or_404(Task, task_id)
    member = db.session.get(TeamMember, task.member_id)
    if not member:
        return jsonify({"error": "Assignee member not found."}), 404

    email_result = send_task_assignment_email(task, member)
    return jsonify({
        "ok": True,
        "message": f"Email notification sent to {member.email}.",
        "email_result": email_result
    })


# ---------------- Member Personal Status Portal Endpoints ----------------

@app.get("/api/portal/<int:member_id>")
def member_portal(member_id):
    member = db.get_or_404(TeamMember, member_id)
    tasks = Task.query.filter_by(member_id=member.id).order_by(
        Task.status.asc(),
        Task.due_date.asc().nullslast(),
        Task.created_at.desc()
    ).all()

    return jsonify({
        "member": member_dict(member),
        "tasks": [t.to_dict() for t in tasks],
        "stats": {
            "total": len(tasks),
            "todo": sum(t.status == "todo" for t in tasks),
            "in_progress": sum(t.status == "in_progress" for t in tasks),
            "review": sum(t.status == "review" for t in tasks),
            "done": sum(t.status == "done" for t in tasks),
        }
    })


@app.put("/api/portal/task/<int:task_id>")
def member_update_task(task_id):
    """Allows an employee to update status and notes from their direct link.

    Deliberately limited to those two fields. Employees may not retitle,
    reprioritise or reassign their own work, and must not be able to read or
    write another member's task.
    """
    task = db.get_or_404(Task, task_id)
    data = request.get_json(silent=True) or {}

    if "member_id" in data:
        return jsonify({"error": "Employees cannot reassign tasks."}), 403

    if "status" in data:
        new_status = data["status"]
        if new_status not in VALID_STATUSES:
            return jsonify({"error": f"Invalid status. Must be one of: {', '.join(VALID_STATUSES)}"}), 400
        task.status = new_status

    if "notes" in data:
        task.notes = (data["notes"] or "").strip()

    task.updated_at = datetime.utcnow()
    db.session.commit()
    return jsonify(task.to_dict())


# ---------------- Email Center Endpoints ----------------

@app.get("/api/email/outbox")
@require_admin
def email_outbox():
    cfg = get_smtp_config()
    outbox = get_outbox(limit=40)
    return jsonify({
        "smtp": {
            "configured": cfg["is_configured"],
            "host": cfg["host"],
            "port": cfg["port"],
            "from_email": cfg["from_email"],
            "username": cfg["username"],
        },
        "outbox": outbox,
    })


@app.post("/api/email/config")
@require_admin
def save_email_config():
    """Allows saving SMTP settings directly from the frontend UI."""
    data = request.get_json(force=True) or {}
    host = data.get("host") or "smtp.gmail.com"
    port = data.get("port") or 587
    username = (data.get("username") or "").strip()
    password = (data.get("password") or "").strip()
    from_email = (data.get("from_email") or username).strip()

    if not username or not password:
        return jsonify({"error": "Email address (username) and password are required."}), 400

    new_cfg = update_smtp_config(host, port, username, password, from_email)

    return jsonify({
        "ok": True,
        "message": "SMTP settings saved. They will stay configured after a refresh or redeploy.",
        "smtp": new_cfg,
    })


@app.post("/api/email/test")
@require_admin
def test_email():
    data = request.get_json(force=True) or {}
    to_email = data.get("to_email")
    if not to_email:
        return jsonify({"error": "Recipient email ('to_email') is required."}), 400

    res = send_test_email(to_email)
    if res.get("success"):
        return jsonify(res), 200
    else:
        return jsonify(res), 400


# ---------------- Seed Demo Office ----------------

@app.post("/api/seed")
@require_admin
def seed():
    if TeamMember.query.count() > 0:
        return jsonify({"message": "Demo data already exists."})

    demo_members = [
        ("Aarav", "aarav@example.com", "Full Stack Developer", "🧑‍💻"),
        ("Priya", "priya@example.com", "Frontend Developer", "👩‍💻"),
        ("Rahul", "rahul@example.com", "Backend Developer", "👨‍💻"),
        ("Ananya", "ananya@example.com", "UI/UX Designer", "👩‍🎨"),
        ("Vikram", "vikram@example.com", "QA Engineer", "🧪"),
        ("Neha", "neha@example.com", "Marketing & Growth", "📣"),
        ("Kabir", "kabir@example.com", "DevOps / Cloud", "🛡️"),
        ("Isha", "isha@example.com", "Project Coordinator", "📋"),
    ]
    members = []
    for name, email, role, avatar in demo_members:
        m = TeamMember(name=name, email=email, role=role, avatar=avatar)
        db.session.add(m)
        members.append(m)
    db.session.flush()

    today = date.today()
    demo_tasks = [
        ("Build dashboard API", "Finish team and task dashboard endpoints.", "in_progress", "high", members[0].id),
        ("Polish task board", "Responsive states and micro-interactions.", "todo", "medium", members[1].id),
        ("Database models", "Review relationships and indexes.", "review", "high", members[2].id),
        ("Office scene UI", "Create animated room and employee cards.", "in_progress", "urgent", members[3].id),
        ("Regression testing", "Test task CRUD and edge cases.", "todo", "medium", members[4].id),
        ("Partner follow-ups", "Call today's NGO prospects.", "todo", "high", members[5].id),
        ("Deployment checklist", "Prepare environment and security checks.", "review", "high", members[6].id),
        ("Daily planning", "Collect blockers and tomorrow's priorities.", "done", "medium", members[7].id),
    ]
    for i, (title, desc, status, priority, member_id) in enumerate(demo_tasks):
        t = Task(
            title=title, description=desc, status=status, priority=priority,
            due_date=today, member_id=member_id, position=i,
            notes="Initial setup underway." if status == "in_progress" else ""
        )
        db.session.add(t)
        send_task_assignment_email(t, next(m for m in members if m.id == member_id))

    db.session.commit()
    return jsonify({"ok": True, "message": "Demo office created with task assignment notifications."})


# ---------------- Cron Endpoint (replaces the local APScheduler process) ----------------

@app.get("/api/cron/qa-check")
def cron_qa_check():
    """
    Scheduled QA run over the client site.

    Vercel Cron sends CRON_SECRET as a Bearer token on scheduled invocations.
    Vercel's free plan allows one cron invocation per day, which is why the
    dashboard also has a manual trigger.
    """
    expected = os.getenv("CRON_SECRET", "").strip()
    if expected:
        provided = request.headers.get("Authorization", "").strip()
        if provided != f"Bearer {expected}":
            return jsonify({"error": "Unauthorized."}), 401
    elif not request.args.get("open"):
        return jsonify({
            "error": "CRON_SECRET is not set. Add it as a Vercel environment variable to protect this endpoint."
        }), 503

    run = _run_and_store_qa_check("scheduled")
    return jsonify({
        "ok": True,
        "message": f"QA check complete for {run.site_url}: {run.status}",
        "status": run.status,
        "summary": run.summary,
        "issues": len(run.to_dict()["issues"]),
    })


@app.get("/api/cron/security-check")
def cron_security_check():
    """Scheduled security review. Same CRON_SECRET protection as the other crons."""
    expected = os.getenv("CRON_SECRET", "").strip()
    if expected:
        provided = request.headers.get("Authorization", "").strip()
        if provided != f"Bearer {expected}":
            return jsonify({"error": "Unauthorized."}), 401
    elif not request.args.get("open"):
        return jsonify({
            "error": "CRON_SECRET is not set. Add it as a Vercel environment variable to protect this endpoint."
        }), 503

    run = _run_and_store_security_check("scheduled")
    return jsonify({
        "ok": True,
        "message": f"Security review complete for {run.site_url}: {run.status}",
        "status": run.status,
        "summary": run.summary,
        "critical": run.critical_count,
        "warnings": run.warning_count,
    })


@app.get("/api/cron/daily-emails")
def cron_daily_emails():
    """
    Sends the daily task digest. Invoked by Vercel Cron rather than a background
    thread, because serverless functions only run when a request arrives.

    Vercel sends the CRON_SECRET as a Bearer token on scheduled invocations.
    """
    expected = os.getenv("CRON_SECRET", "").strip()
    if expected:
        provided = request.headers.get("Authorization", "").strip()
        if provided != f"Bearer {expected}":
            return jsonify({"error": "Unauthorized."}), 401
    elif not request.args.get("open"):
        # Without a secret this endpoint would let anyone trigger mail sends.
        return jsonify({
            "error": "CRON_SECRET is not set. Add it as a Vercel environment variable to protect this endpoint."
        }), 503

    result = send_daily_emails()
    return jsonify({"ok": True, "message": "Daily task digest dispatched.", "result": result})


@app.get("/api/cron/due-reminders")
def cron_due_reminders():
    """
    6pm IST nudge to anyone with a dated task that is not finished yet.

    Runs from Vercel Cron at 12:30 UTC, which is 18:00 in India all year
    round because IST has no daylight saving.
    """
    expected = os.getenv("CRON_SECRET", "").strip()
    if expected:
        provided = request.headers.get("Authorization", "").strip()
        if provided != f"Bearer {expected}":
            return jsonify({"error": "Unauthorized."}), 401
    elif not request.args.get("open"):
        return jsonify({
            "error": "CRON_SECRET is not set. Add it as a Vercel environment variable to protect this endpoint."
        }), 503

    result = send_due_date_reminders()
    return jsonify({"ok": True, "message": "Due-date reminders dispatched.", "result": result})


@app.post("/api/reminders/send-now")
@require_admin
def reminders_send_now():
    """Preview or send the reminders on demand, from the Email Center."""
    preview = request.args.get("preview") == "1"
    result = send_due_date_reminders(force=True, dry_run=preview)
    return jsonify({"ok": True, "preview": preview, "result": result})


# ---------------- Site QA Bot Endpoints ----------------

@app.get("/api/qa/status")
@require_admin
def qa_status():
    """Latest stored result. Cheap enough for the dashboard to poll."""
    run = _latest_qa_run()
    if not run:
        return jsonify({
            "has_run": False,
            "site_url": DEFAULT_QA_SITE,
            "message": "No QA check has run yet. Press Run Check Now.",
        })
    return jsonify({"has_run": True, "site_url": DEFAULT_QA_SITE, "run": run.to_dict()})


@app.post("/api/qa/check")
@require_admin
def qa_check():
    """Run a fresh check on demand, from the Run Check Now button."""
    run = _run_and_store_qa_check("manual")
    return jsonify({"has_run": True, "run": run.to_dict()})


@app.get("/api/qa/history")
@require_admin
def qa_history():
    """The last 30 checks, newest first."""
    runs = QaRun.query.order_by(QaRun.checked_at.desc(), QaRun.id.desc()).limit(30).all()
    return jsonify({
        "site_url": DEFAULT_QA_SITE,
        "runs": [r.to_dict(include_detail=False) for r in runs],
    })


@app.get("/api/qa/runs/<int:run_id>")
@require_admin
def qa_run_detail(run_id):
    run = db.get_or_404(QaRun, run_id)
    return jsonify(run.to_dict())


@app.get("/api/qa/report.pdf")
@require_admin
def qa_report_pdf():
    """Downloads the latest QA result as a PDF."""
    run = _latest_qa_run()
    if not run:
        return jsonify({"error": "No QA check has run yet. Press Run Check Now first."}), 404

    try:
        pdf_bytes = report_pdf.build_qa_pdf(run.to_dict(), run.site_url)
    except Exception as e:
        print(f"[QA PDF ERROR] {e}")
        return jsonify({"error": f"Could not build the PDF: {e}"}), 500

    stamp = (run.checked_at or datetime.utcnow()).strftime("%Y-%m-%d")
    return send_file(
        io.BytesIO(pdf_bytes),
        mimetype="application/pdf",
        as_attachment=True,
        download_name=f"qa-report-{stamp}.pdf",
    )


# ---------------- Security Analyst Endpoints ----------------

@app.get("/api/security/status")
@require_admin
def security_status():
    run = _latest_security_run()
    if not run:
        return jsonify({
            "has_run": False,
            "site_url": DEFAULT_QA_SITE,
            "message": "No security review has run yet. Press Run Review Now.",
        })
    return jsonify({
        "has_run": True,
        "site_url": DEFAULT_QA_SITE,
        "run": run.to_dict(),
    })


@app.post("/api/security/check")
@require_admin
def security_check():
    run = _run_and_store_security_check("manual")
    return jsonify({"has_run": True, "site_url": DEFAULT_QA_SITE, "run": run.to_dict()})


@app.get("/api/security/history")
@require_admin
def security_history():
    runs = SecurityRun.query.order_by(
        SecurityRun.checked_at.desc(), SecurityRun.id.desc()
    ).limit(30).all()
    return jsonify({
        "site_url": DEFAULT_QA_SITE,
        "runs": [r.to_dict(include_detail=False) for r in runs],
    })


@app.get("/api/security/report.pdf")
@require_admin
def security_report_pdf():
    """Downloads the latest security review as a PDF."""
    run = _latest_security_run()
    if not run:
        return jsonify({"error": "No security review has run yet. Run one first."}), 404

    try:
        pdf_bytes = report_pdf.build_security_pdf(run.to_dict(), run.site_url)
    except Exception as e:
        print(f"[SECURITY PDF ERROR] {e}")
        return jsonify({"error": f"Could not build the PDF: {e}"}), 500

    stamp = (run.checked_at or datetime.utcnow()).strftime("%Y-%m-%d")
    return send_file(
        io.BytesIO(pdf_bytes),
        mimetype="application/pdf",
        as_attachment=True,
        download_name=f"security-review-{stamp}.pdf",
    )


# ---------------- Jarvis Assistant ----------------

@app.post("/api/jarvis/ask")
@require_admin
def jarvis_ask():
    """
    Answers one message from live workspace data.

    The reply is assembled by rule, not generated, so it cannot invent facts
    about the team. Email sending is deliberately not offered here: the
    suggestions point at surfaces where the manager can review first.
    """
    data = request.get_json(silent=True) or {}
    message = (data.get("message") or "").strip()
    if not message:
        return jsonify({"error": "Say something first."}), 400

    members = TeamMember.query.order_by(TeamMember.id).all()
    tasks = Task.query.order_by(Task.position.asc(), Task.created_at.desc()).all()

    qa_run = _latest_qa_run()
    sec_run = _latest_security_run()

    timezone, offset_minutes = _browser_location()
    try:
        reply = jarvis.handle(
            message,
            members,
            tasks,
            qa_run.to_dict() if qa_run else None,
            sec_run.to_dict() if sec_run else None,
            manager_name=get_manager_name(),
            timezone=timezone,
            offset_minutes=offset_minutes,
        )
    except Exception:
        # One bad phrasing must not leave the assistant dead for the whole
        # session, so fall back to something honest instead of a 500.
        current_app.logger.exception("jarvis failed on %r", message)
        reply = {
            "text": (
                "I stumbled on that one, sorry. Try asking who is working, "
                "what is overdue, or what needs your review."
            ),
            "actions": [
                {"label": "Who is working?", "message": "who is working"},
                {"label": "What needs my review?", "message": "what needs my review"},
            ],
        }

    reply["asked"] = message
    return jsonify(reply)


@app.get("/api/jarvis/greeting")
@require_admin
def jarvis_greeting():
    """Opens with a live read of the workspace, not a feature list."""
    members = TeamMember.query.order_by(TeamMember.id).all()
    tasks = Task.query.order_by(Task.position.asc(), Task.created_at.desc()).all()
    qa_run = _latest_qa_run()
    sec_run = _latest_security_run()

    timezone, offset_minutes = _browser_location()
    ctx = jarvis.build_context(
        members,
        tasks,
        qa_run.to_dict() if qa_run else None,
        sec_run.to_dict() if sec_run else None,
        manager_name=get_manager_name(),
        timezone=timezone,
        offset_minutes=offset_minutes,
    )
    briefing = jarvis.build_briefing(ctx)

    return jsonify({
        "text": briefing["text"],
        "actions": briefing.get("actions", []),
        "suggestions": jarvis.SUGGESTIONS,
        "manager_name": ctx.get("manager_name", ""),
        "timezone": timezone,
        "local_time": jarvis.local_now(timezone, offset_minutes).strftime("%H:%M"),
        "capability_count": len(jarvis.INTENTS)
        + len(jarvis._task_context(""))
        + len(jarvis._person_context("")),
    })


# ---------------- Mail (Gmail) ----------------

@app.get("/api/mail/status")
@require_admin
def mail_status():
    status = gmail_service.connection_status()
    # Outbox works with no Gmail setup at all, so the page is never empty.
    status["outbox_count"] = len(gmail_service.sent_notifications(limit=100))
    return jsonify(status)


@app.get("/api/mail/auth/start")
@require_admin
def mail_auth_start():
    """Redirects the manager to Google's consent screen."""
    try:
        return redirect(gmail_service.auth_url(), code=302)
    except gmail_service.GmailNotConfigured as e:
        return jsonify({"error": str(e)}), 503


@app.get("/api/mail/auth/callback")
def mail_auth_callback():
    """Google sends the user back here with an authorisation code."""
    if request.args.get("error"):
        return jsonify({
            "error": "You declined the Gmail connection.",
            "detail": request.args.get("error_description", ""),
        }), 400

    code = request.args.get("code")
    if not code:
        return jsonify({"error": "Google did not return an authorisation code."}), 400

    try:
        result = gmail_service.exchange_code(code)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 400

    frontend = os.getenv("FRONTEND_URL", "").rstrip("/")
    # Bounce the user back to the app with a marker the UI can read.
    return redirect(f"{frontend}/?mail=connected&account={result['email']}", code=302)


@app.post("/api/mail/disconnect")
@require_admin
def mail_disconnect():
    gmail_service.disconnect()
    return jsonify({"ok": True})


@app.get("/api/mail/messages")
@require_admin
def mail_messages():
    query = request.args.get("q", "").strip()
    try:
        if not gmail_service.is_configured() or not gmail_service.connection_status()["connected"]:
            return jsonify({
                "messages": gmail_service.sent_notifications(limit=30),
                "source": "outbox",
                "message": "Gmail is not connected yet, so this is the mail this "
                           "system has sent. Connect Gmail to see your inbox.",
            })
        return jsonify({
            "messages": gmail_service.list_messages(query=query),
            "source": "gmail",
        })
    except PermissionError as e:
        return jsonify({"error": str(e), "needs_reconnect": True}), 401
    except Exception as e:
        print(f"[MAIL LIST ERROR] {e}")
        return jsonify({"error": str(e)[:160]}), 502


@app.get("/api/mail/messages/<message_id>")
@require_admin
def mail_message_detail(message_id):
    # Outbox entries are previews, not Gmail messages.
    if message_id.startswith("outbox-"):
        from emailer import get_outbox
        raw_id = message_id.split("-", 1)[1]
        for entry in get_outbox(limit=200):
            if str(entry.get("id")) == raw_id:
                return jsonify({
                    "id": message_id,
                    "from": "Office Task Hub",
                    "to": entry.get("to"),
                    "subject": entry.get("subject"),
                    "date": entry.get("timestamp"),
                    "body": entry.get("body_html") or entry.get("body_text"),
                    "source": "outbox",
                })
        return jsonify({"error": "That notification is no longer available."}), 404

    try:
        return jsonify(gmail_service.read_message(message_id))
    except PermissionError as e:
        return jsonify({"error": str(e), "needs_reconnect": True}), 401
    except Exception as e:
        print(f"[MAIL READ ERROR] {e}")
        return jsonify({"error": str(e)[:160]}), 502


# ---------------- Startup & Database Migration ----------------

with app.app_context():
    db.create_all()
    # The PRAGMA-based migration below is SQLite-only; Postgres instances are
    # created fresh by create_all(), so skip it for other dialects.
    if db.engine.dialect.name == "sqlite":
        try:
            with db.engine.connect() as conn:
                columns = [row[1] for row in conn.execute(text("PRAGMA table_info(task)")).fetchall()]
                if "notes" not in columns:
                    conn.execute(text("ALTER TABLE task ADD COLUMN notes TEXT DEFAULT ''"))
                    conn.commit()
                    print("[DATABASE] Migrated: added 'notes' column to task table.")
        except Exception as e:
            print(f"[DATABASE MIGRATION NOTICE] {e}")

        # The Email Center reads from the email_log table now. Backfill it once
        # from the old outbox.json so existing local history is not lost.
        try:
            import json
            legacy = Path(__file__).resolve().parent / "instance" / "outbox.json"
            if legacy.exists() and EmailLog.query.count() == 0:
                entries = json.loads(legacy.read_text(encoding="utf-8"))
                for e in reversed(entries):  # file is newest-first, table is ascending
                    db.session.add(EmailLog(
                        to_email=(e.get("to") or e.get("to_email") or "unknown"),
                        subject=e.get("subject") or "",
                        body_text=e.get("body_text") or "",
                        body_html=e.get("body_html") or "",
                        status=e.get("status") or "sent",
                        error=e.get("error"),
                    ))
                db.session.commit()
                print(f"[DATABASE] Migrated: imported {len(entries)} emails from outbox.json.")
        except Exception as e:
            print(f"[EMAIL MIGRATION NOTICE] {e}")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
