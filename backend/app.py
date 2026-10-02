import os
import sys
import hmac
from datetime import datetime, date, timedelta
from pathlib import Path
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory, session
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
    decrypt_secret,
)


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
