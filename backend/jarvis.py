"""
Jarvis: a rule-based assistant for this workspace.

Every answer is worked out from the live database rather than generated, so
Jarvis cannot invent facts about your team. There is no model and no API key,
which means no cost, no rate limit and no data leaving your machine.

Each capability is an "intent": a matcher that decides whether a message asks
for it, plus a handler that queries the database and returns a reply.

Replies are returned as structured blocks rather than plain strings, so the UI
can render tables and buttons alongside the text.
"""

import re
from datetime import date, datetime, timedelta

STATUS_LABELS = {
    "todo": "yet to start",
    "in_progress": "in progress",
    "review": "waiting for review",
    "done": "completed",
}


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def _member_lookup(members):
    """Map several ways of naming someone to their record."""
    index = {}
    for m in members:
        name = _field(m, "name") or ""
        email = _field(m, "email") or ""
        role = _field(m, "role") or ""
        for key in (
            name,
            name.split()[0] if name else "",
            email,
            email.split("@")[0] if email else "",
            role.lower(),
        ):
            if key:
                index[key.lower().strip()] = m
    return index


def _find_member(text, index):
    """Longest match wins so 'priya' does not shadow 'priya sharma'."""
    lowered = text.lower()
    best = None
    best_len = 0
    for key, member in index.items():
        if key and key in lowered and len(key) > best_len:
            best, best_len = member, len(key)
    return best


def _find_task(text, tasks):
    """Match a task by title words, ignoring very short words."""
    lowered = " " + text.lower() + " "
    stop = {"the", "a", "to", "for", "and", "task", "on", "in", "of", "my", "is"}
    scored = []
    for t in tasks:
        words = [w for w in re.split(r"\W+", (t.title or "").lower()) if len(w) > 2 and w not in stop]
        hits = sum(1 for w in words if f" {w}" in lowered)
        if hits:
            scored.append((hits, len(t.title or ""), t))
    if not scored:
        return None
    scored.sort(key=lambda x: (-x[0], -x[1]))
    return scored[0][2]


def _open_tasks(tasks):
    return [t for t in tasks if t.status != "done"]


def _field(obj, key, default=None):
    """Read a key from either a dict (JSON) or a model instance."""
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _task_name(task):
    """Assignee display name; Task models do not carry it, to_dict() does."""
    return _field(task, "member_name") or "Unassigned"


def _title(task):
    return _field(task, "title") or ""


def _as_date(value):
    """Tasks arrive as ISO strings over JSON, but as date objects in-process."""
    if not value:
        return None
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _due_state(task):
    due = _as_date(task.due_date)
    if not due:
        return None
    today = date.today()
    if task.status == "done":
        return None
    if due < today:
        return "overdue"
    if due == today:
        return "today"
    if due <= today + timedelta(days=2):
        return "soon"
    return "later"


def _format_task_line(task, prefix=""):
    return (
        f"{prefix}**{task.title}** — {STATUS_LABELS.get(task.status, task.status)}, "
        f"{task.priority} priority"
        + (f", due {task.due_date}" if task.due_date else "")
    )


# --------------------------------------------------------------------------
# intents
# --------------------------------------------------------------------------

def intent_workload_overview(ctx):
    """Who is working and who is not."""
    members = ctx["members"]
    tasks = ctx["tasks"]
    if not members:
        return {"text": "No team yet, so there is nobody to report on."}

    working_rows, idle_rows = [], []
    for m in members:
        mine = [t for t in tasks if t.member_id == _field(m, "id")]
        open_mine = [t for t in mine if t.status != "done"]
        doing = [t for t in mine if t.status == "in_progress"]
        review = [t for t in mine if t.status == "review"]

        if doing:
            state = f"On it: {doing[0].title}"
        elif review:
            state = f"Done and waiting on you ({len(review)})"
        elif open_mine:
            state = f"{len(open_mine)} lined up, hasn't started"
        else:
            state = "Free"

        row = (f"| {_field(m, 'avatar')} {_field(m, 'name')} | "
               f"{_field(m, 'role')} | {len(open_mine)} | {state} |")
        (working_rows if open_mine else idle_rows).append(row)

    n_working = len(working_rows)
    if n_working == 0:
        verdict = "Nobody has anything on at the moment, which is worth a look."
    elif n_working == len(members):
        verdict = "Everyone is loaded up. Watch for burnout here."
    else:
        idle_names = ", ".join(
            _first_name(m) for m in members
            if not [t for t in tasks if t.member_id == _field(m, "id") and t.status != "done"]
        )
        verdict = f"{n_working} of {len(members)} are working. {idle_names or 'Nobody'} has room."

    blocks = ["| Person | Role | Open | Where they are |", "|---|---|---|---|"]
    blocks.extend(working_rows + idle_rows)

    return {
        "text": f"Straight answer: {verdict}",
        "table": blocks,
        "actions": [
            {"label": "See it laid out", "action": "goto", "view": "who_working"},
            {"label": "Tell me what to do next", "message": "what should I do next"},
        ],
    }


def intent_who_is_free(ctx):
    """Who has room for more work."""
    members = ctx["members"]
    tasks = ctx["tasks"]
    free = []
    for m in members:
        mine = [t for t in tasks if t.member_id == _field(m, "id") and t.status != "done"]
        if len(mine) <= 1:
            free.append((m, len(mine)))

    if not free:
        return {
            "text": "Honestly, nobody right now. Everyone is already carrying two or more. "
                    "If something has to go out, I would move it rather than add it.",
        }

    free.sort(key=lambda x: x[1])
    lines = []
    for m, n in free:
        lines.append(
            f"**{_first_name(m)}** ({_field(m, 'role')}) — "
            + ("nothing on right now" if n == 0 else f"just the one thing")
        )

    top = free[0][0]
    top_load = free[0][1]
    return {
        "text": (
            f"Give it to **{_first_name(top)}** — "
            + ("nothing is open for them at the moment"
               if top_load == 0 else "barely started, just the one thing")
            + f". {len(free)} of your {len(members)} people have room."
        ),
        "list": lines,
        "actions": [
            {"label": f"Assign to {_first_name(top)}", "action": "open_assign",
             "member_id": _field(top, "id")},
            {"label": "See everyone", "action": "goto", "view": "who_working"},
        ],
    }


def intent_who_is_overloaded(ctx):
    """Who has too much on."""
    members = ctx["members"]
    tasks = ctx["tasks"]
    threshold = 3
    rows = []
    for m in members:
        mine = [t for t in tasks if t.member_id == m.id and t.status != "done"]
        if len(mine) >= threshold:
            rows.append(f"- **{m.name}** has {len(mine)} open tasks: " +
                        ", ".join(t.title for t in mine[:4]))
    if not rows:
        return {"text": f"Nobody is above {threshold} open tasks. The workload is balanced."}
    return {
        "text": "These people are carrying too much. Move something to someone with room:",
        "list": rows,
        "actions": [{"label": "Open Who is Working", "action": "goto", "view": "who_working"}],
    }


def intent_overdue(ctx):
    """What is late."""
    tasks = _open_tasks(ctx["tasks"])
    overdue = [t for t in tasks if _due_state(t) == "overdue"]
    today = [t for t in tasks if _due_state(t) == "today"]

    if not overdue and not today:
        return {"text": "Nothing is late and nothing is due today. You are completely clear."}

    parts = []
    if overdue:
        parts.append(f"**Overdue ({len(overdue)}):**")
        parts += [f"- {_format_task_line(t, '')} — {_task_name(t)}" for t in overdue[:8]]
    if today:
        parts.append(f"**Due today ({len(today)}):**")
        parts += [f"- {_format_task_line(t, '')} — {_task_name(t)}" for t in today[:8]]

    return {
        "text": (
            f"{len(overdue)} overdue and {len(today)} due today. "
            + ("Nothing is actually running late, so relax." if not overdue
               else "Those late ones need a nudge.")
        ),
        "list": parts,
        "actions": [{"label": "Open All Tasks", "action": "goto", "view": "tasks"}],
    }


def intent_needs_review(ctx):
    """Tasks waiting for the manager."""
    tasks = [t for t in ctx["tasks"] if t.status == "review"]
    if not tasks:
        return {"text": "Nothing is waiting on you. No tasks are sitting in review."}
    return {
        "text": (
            f"{len(tasks)} {'task is' if len(tasks) == 1 else 'tasks are'} "
            "sitting with you waiting on a look:"
        ),
        "list": [f"- {_format_task_line(t, '')} — {_task_name(t)}" for t in tasks],
        "actions": [{"label": "Open All Tasks", "action": "goto", "view": "tasks"}],
    }


def intent_team_summary(ctx):
    """Counts and a one-line read on the week."""
    members = ctx["members"]
    tasks = ctx["tasks"]
    done = sum(1 for t in tasks if t.status == "done")
    open_n = len(tasks) - done
    reviewing = sum(1 for t in tasks if t.status == "review")
    active = sum(1 for t in tasks if t.status == "in_progress")

    if not tasks:
        return {"text": "No tasks yet. Assign one and I will start tracking progress."}

    verdict = []
    if active == 0 and open_n:
        verdict.append("Nobody is actively working, yet tasks are open.")
    if reviewing >= 3:
        verdict.append(f"{reviewing} tasks are stacked up waiting for you.")
    if not verdict:
        verdict.append("The board is moving normally.")

    return {
        "text": (
            f"{len(members)} people, {open_n} open tasks, {done} completed. "
            + " ".join(verdict)
        ),
        "stats": [
            {"label": "Team", "value": len(members)},
            {"label": "Open", "value": open_n},
            {"label": "In progress", "value": active},
            {"label": "Review", "value": reviewing},
            {"label": "Done", "value": done},
        ],
    }


def intent_member_status(ctx, text, index):
    """How one person is doing."""
    member = _find_member(text, index)
    if not member:
        return {"text": "I could not find that person. Try their first name."}
    tasks = [t for t in ctx["tasks"] if t.member_id == member.id]
    done = [t for t in tasks if t.status == "done"]
    open_n = len(tasks) - len(done)
    doing = [t for t in tasks if t.status == "in_progress"]
    overdue = [t for t in tasks if _due_state(t) == "overdue"]

    lines = []
    if doing:
        lines.append(f"Currently working on: **{doing[0].title}**")
    for t in done[:3]:
        lines.append(f"Completed: {t.title}")
    for t in overdue[:3]:
        lines.append(f"OVERDUE: {t.title} (due {t.due_date})")
    if not lines:
        lines = ["No tasks assigned yet."] if not tasks else ["Nothing open right now."]

    note = f" They also have {len(overdue)} overdue." if overdue else ""
    return {
        "text": f"**{member.name}** ({member.role}) has {open_n} open and {len(done)} done tasks.{note}",
        "list": lines,
        "actions": [
            {"label": f"Copy {member.name}'s portal link", "action": "copy_portal", "member_id": member.id},
            {"label": f"Assign a task to {member.name}", "message": f"assign a task to {member.name}"},
        ],
    }


def intent_today_plan(ctx):
    """Everything due today or overdue, grouped by person."""
    tasks = [t for t in ctx["tasks"] if _due_state(t) in ("overdue", "today")]
    if not tasks:
        return {"text": "Nothing is due today or overdue. Enjoy the quiet."}
    by_member = {}
    for t in tasks:
        by_member.setdefault(_task_name(t), []).append(t)
    parts = []
    for name, group in by_member.items():
        parts.append(f"**{name}**")
        parts += [f"- {t.title} ({STATUS_LABELS[t.status]})" for t in group]
    return {"text": f"Today's plan covers {len(tasks)} task(s):", "list": parts}


def intent_completed(ctx):
    """What got finished."""
    done = [t for t in ctx["tasks"] if t.status == "done"]
    if not done:
        return {"text": "Nothing completed yet, so there is no track record to show you."}
    recent = done[:10]
    return {
        "text": f"{len(done)} task(s) completed in total. Most recent:",
        "list": [f"- {t.title} — {_task_name(t)}"
                 + (f", finished {str(t.updated_at)[:10]}" if t.updated_at else "")
                 for t in recent],
        "actions": [{"label": "Open Completed view", "action": "goto", "view": "completed"}],
    }


def intent_task_status(ctx, text):
    """Where a specific task stands."""
    task = _find_task(text, ctx["tasks"])
    if not task:
        return {"text": "I could not match that to a task. Try a few words from its title."}
    return {
        "text": (
            f"**{task.title}** is {STATUS_LABELS.get(task.status, task.status)} "
            f"with {_task_name(task)}. Priority {task.priority}"
            + (f", due {task.due_date}." if task.due_date else ".")
        ),
        "list": [f"- Assignee: {task.member_avatar} {_task_name(task)} ({task.member_role})"]
        + ([f"- Notes: {task.notes}"] if task.notes else []),
        "actions": [
            {"label": "Edit this task", "action": "edit_task", "task_id": task.id},
            {"label": f"Open {_task_name(task)}'s portal", "action": "open_portal", "member_id": task.member_id},
        ],
    }


def intent_site_status(ctx):
    """Is the client site up."""
    run = ctx.get("qa_run")
    if not run:
        return {
            "text": "I have not run a Site QA check yet. Press Run Check Now on the Site QA page.",
            "actions": [{"label": "Open Site QA", "action": "goto", "view": "qa"}],
        }
    status = _field(run, "status")
    if status == "inconclusive":
        return {
            "text": "The last Site QA check could not complete because the firewall blocked it. That is not an outage.",
            "actions": [{"label": "Open Site QA", "action": "goto", "view": "qa"}],
        }
    lines = [
        f"- {_field(p, 'path')} returned {_field(p, 'status')} in {_field(p, 'ms')}ms"
        for p in (_field(run, "pages") or [])
    ]
    return {
        "text": f"**ngocore.in is {status}.** {_field(run, 'summary')}",
        "list": lines,
        "actions": [{"label": "Open Site QA", "action": "goto", "view": "qa"}],
    }


def intent_site_problems(ctx):
    """What is broken on the client site."""
    run = ctx.get("qa_run")
    issues = _field(run, "issues") or []
    if not issues:
        return {"text": "I have no QA findings recorded. Run a Site QA check first."}
    lines = [f"- [{_field(i, 'severity')}] {_field(i, 'message')}" for i in issues[:10]]
    return {
        "text": f"The last QA run found {len(issues)} issue(s) on ngocore.in:",
        "list": lines,
        "actions": [{"label": "Open Site QA", "action": "goto", "view": "qa"}],
    }


def intent_security(ctx):
    """Latest security review."""
    run = ctx.get("security_run")
    if not run:
        return {
            "text": "No security review has run yet. Use Run Review Now on the Security page.",
            "actions": [{"label": "Open Security", "action": "goto", "view": "security"}],
        }
    findings = _field(run, "findings") or []
    tls = _field(run, "tls") or {}
    lines = [f"- [{_field(f, 'severity')}] {_field(f, 'message')}" for f in findings[:8]]
    return {
        "text": (
            f"Latest security review: **{_field(run, 'status')}**. "
            f"{_field(run, 'critical_count', 0)} critical, "
            f"{_field(run, 'warning_count', 0)} warnings. "
            f"TLS {tls.get('tls_version', 'unknown')}, "
            f"certificate expires in {tls.get('days_left', '?')} days."
        ),
        "list": lines,
        "actions": [{"label": "Open Security", "action": "goto", "view": "security"}],
    }


def intent_assign_task(ctx, text, index):
    """Propose an assignee. Sending the email stays an explicit click."""
    members = ctx["members"]
    if not members:
        return {"text": "There is nobody to assign to yet. Add a team member first."}

    named = _find_member(text, index)
    free, busy = [], []
    for m in members:
        mine = [t for t in ctx["tasks"] if t.member_id == m.id and t.status != "done"]
        (free if len(mine) <= 1 else busy).append(m)

    if named:
        mine = [t for t in ctx["tasks"] if t.member_id == named.id and t.status != "done"]
        load = len(mine)
        note = (
            "they have room" if load <= 1
            else f"they already have {load} open tasks"
        )
        return {
            "text": f"**{named.name}** is the right person for that, {note}.",
            "actions": [
                {"label": f"Assign to {named.name}", "action": "open_assign", "member_id": named.id},
                {"label": "Copy their portal link", "action": "copy_portal", "member_id": named.id},
            ],
        }

    if not free:
        return {
            "text": "Everyone is busy right now. I would not add more to anyone until something lands in review.",
            "actions": [{"label": "Open Who is Working", "action": "goto", "view": "who_working"}],
        }

    best = sorted(
        free,
        key=lambda m: len([t for t in ctx["tasks"] if t.member_id == m.id and t.status != "done"]),
    )[0]
    return {
        "text": (
            f"Best fit right now is **{best.name}** ({best.role}), they have the lightest load. "
            "You have not told me the task yet, so I will open the assign form."
        ),
        "actions": [
            {"label": f"Assign to {best.name}", "action": "open_assign", "member_id": best.id},
            {"label": "See everyone's load", "action": "goto", "view": "who_working"},
        ],
    }


def intent_reassign(ctx, text, index):
    """Find a task and a person to move it to."""
    task = _find_task(text, ctx["tasks"])
    if not task:
        return {"text": "I could not match that to a task. Try a few words from its title."}
    target = _find_member(text, index)
    if not target or target.id == task.member_id:
        return {
            "text": f"**{task.title}** is currently with {_task_name(task)}. Who should take it over?",
            "actions": [
                {"label": f"Reassign {task.title}", "action": "edit_task", "task_id": task.id},
                {"label": "See who is free", "message": "who is free"},
            ],
        }
    return {
        "text": (
            f"Ready to move **{task.title}** from {_task_name(task)} to {target.name}. "
            "Open the edit and save to send the notification email."
        ),
        "actions": [{"label": "Open task editor", "action": "edit_task", "task_id": task.id}],
    }


def intent_complete_task(ctx, text):
    """Mark something done."""
    task = _find_task(text, ctx["tasks"])
    if not task:
        return {"text": "I could not match that to a task."}
    if task.status == "done":
        return {"text": f"**{task.title}** is already marked completed."}
    return {
        "text": f"**{task.title}** is {STATUS_LABELS[task.status]}. Open the task to mark it completed.",
        "actions": [{"label": "Open task editor", "action": "edit_task", "task_id": task.id}],
    }


def intent_list_members(ctx):
    members = ctx["members"]
    if not members:
        return {"text": "No team members yet."}
    return {
        "text": f"You have {len(members)} team members:",
        "list": [f"- {m.avatar} **{m.name}** — {m.role} ({m.email})" for m in members],
    }


def intent_send_email(ctx, text, index):
    """Point at the email surface rather than pretending to send."""
    member = _find_member(text, index)
    target = f"{member.name} ({member.email})" if member else "your team"
    return {
        "text": (
            f"Open the Mail page to email {target}. I can show recent mail and the "
            "notifications this system has sent, but sending needs the Mail page so "
            "you stay in control of what leaves your inbox."
        ),
        "actions": [{"label": "Open Mail", "action": "goto", "view": "mail"}],
    }


def intent_list_tasks(ctx):
    tasks = _open_tasks(ctx["tasks"])
    if not tasks:
        return {"text": "There are no open tasks. Everything is completed."}
    return {
        "text": f"You have {len(tasks)} open tasks:",
        "list": [f"- {_format_task_line(t, '')} — {_task_name(t)}" for t in tasks[:12]],
        "actions": [{"label": "Open All Tasks", "action": "goto", "view": "tasks"}],
    }


def intent_greeting(ctx):
    return {
        "text": greeting(),
        "actions": [
            {"label": "Team summary", "message": "team summary"},
            {"label": "Who is free?", "message": "who is free"},
            {"label": "What is overdue?", "message": "what is overdue"},
        ],
    }


def intent_ask_whats_next(ctx):
    """The 'what should I do next' answer, worked out from live data."""
    tasks = _open_tasks(ctx["tasks"])
    members = ctx["members"]
    if not members:
        return {"text": "No team set up yet, so there is nothing I can prioritise."}

    if not tasks:
        return {
            "text": (
                "Nothing open at the moment. I would use the time to plan the next "
                "round of work rather than rush something."
            ),
            "actions": [
                {"label": "See who's around", "message": "who is free"},
                {"label": "How's my site?", "message": "is my site up"},
            ],
        }

    steps = []

    review = [t for t in tasks if t.status == "review"]
    if review:
        steps.append(
            f"Clear your review queue first. **{len(review)}** "
            f"{'task is' if len(review) == 1 else 'tasks are'} sitting with you: "
            + ", ".join(t.title for t in review[:3])
        )

    overdue = [t for t in tasks if _due_state(t) == "overdue"]
    if overdue:
        steps.append(
            f"Then chase **{len(overdue)}** running late: "
            + ", ".join(t.title for t in overdue[:3])
        )

    idle = [m for m in members if len([t for t in tasks if t.member_id == _field(m, "id")]) <= 1]
    if idle:
        who = ", ".join(f"{_first_name(m)} ({_field(m, 'role')})" for m in idle[:3])
        steps.append(f"And hand the next bit of work to someone with room: {who}")

    qa = ctx.get("qa_run")
    if qa and _field(qa, "status") == "critical":
        steps.append("Worth knowing your website is throwing errors right now.")

    if not steps:
        steps.append(
            "Nothing is blocked. Honestly the best use of your time right now is checking "
            "in with the team rather than pushing more work on."
        )

    return {
        "text": (
            "Straight answer: work through these in order and you are clear. "
            "That is what your numbers say right now."
        ),
        "list": steps,
        "actions": [
            {"label": "Open All Tasks", "action": "goto", "view": "tasks"},
            {"label": "Who's working?", "message": "who is working"},
            {"label": "Anything late?", "message": "what is overdue"},
        ],
    }


def intent_help(ctx):
    return {
        "text": "Here is what I can do. Type or speak any of these:",
        "list": [
            "who is free / who is overloaded",
            "whats overdue / what needs my review",
            "whats todays plan / team summary",
            "how is <name> doing",
            "where is <task name>",
            "assign a task to <name>",
            "reassign <task name> to <name>",
            "is my site up / whats wrong with my site",
            "security review",
            "what is completed",
            "list my team / list open tasks",
            "email <name>",
        ],
        "text2": "Say the button in the corner to speak instead of typing.",
    }


# --------------------------------------------------------------------------
# router
# --------------------------------------------------------------------------

def _task_context(text):
    """Task-related intents, most specific first."""
    return [
        (r"\b(reassign|transfer|hand over|hand-off)\b", intent_reassign),
        (r"\bmove\b.*\btask\b.*\bto\b", intent_reassign),
        (r"\bmark\b.*\b(done|complete|finished)\b", intent_complete_task),
        (r"\b(mark|set)\b.*\bcomplete\b", intent_complete_task),
        (r"\b(where is|status of|progress on|whats the status of)\b", intent_task_status),
        (r"\b(delete|remove)\b.*\btask\b", intent_task_status),
    ]


def _person_context(text):
    return [
        (r"\bhow (is|is'|did|has)\b", intent_member_status),
        (r"\b(update|updates|progress)\b.*\bon\b", intent_member_status),
        (r"\b(is|are)\b.*\b(working on|busy with)\b", intent_member_status),
        (r"\bwhat (is|has) \w+ (doing|working on)\b", intent_member_status),
    ]


# (regex, handler, needs_member_lookup)
INTENTS = [
    (r"\b(how are you|how.s it going|how are things|how r u|whats next|what next|what should i do|suggest|advise|plan for me|where do i start)\b", intent_ask_whats_next, False),
    (r"^\s*(hi|hello|hey|good (morning|afternoon|evening)|jarvis|namaste)\b", intent_greeting, False),
    (r"\b(help|what can you do|commands|capabilit)\b", intent_help, False),
    (r"\b(overdue|overdue\?|late|behind schedule|missed|slipping)\b", intent_overdue, False),
    # Security and site intents come before the generic review intent, so
    # "security review" is not mistaken for "what needs my review".
    (r"\b(security|secure|hack|hacked|vulnerab\w*|pen test|penetration|breach|exposed|is my site safe)\b", intent_security, False),
    (r"\b(broken|wrong with my site|issues with the site|problems with (the|my) site|what.s broken)\b", intent_site_problems, False),
    (r"\b(is my site|my site (up|down|status|health)|site (up|down|status|health)|ngocore\.in|site is up)\b", intent_site_status, False),
    (r"\b(today|tonight|todays plan|today's plan|whats due|what is due|due today)\b", intent_today_plan, False),
    (r"\b(review|waiting on me|approve|sign off|need my approval)\b", intent_needs_review, False),
    (r"\b(overload\w*|too much|swamped|burnt out|burned out|stretched)\b", intent_who_is_overloaded, False),
    (r"\b(free|idle|available|spare|who can|who should|room for more)\b", intent_who_is_free, False),
    (r"\b(completed|finished|done recently|what did we finish|shipped)\b", intent_completed, False),
    (r"\b(assign|create a task|new task|give a task)\b", intent_assign_task, True),
    (r"\b(email|mail|message|notify)\b", intent_send_email, True),
    (r"\b(team summary|how is the team|how's the team|overall|dashboard|summar)", intent_team_summary, False),
    (r"\b(who is working|who.s doing|what is everyone|everyone|all hands|workload)\b", intent_workload_overview, False),
    (r"\b(list|show) (my |the )?(team|members|people|staff)\b", intent_list_members, False),
    (r"\b(list|show) (my |the )?(open |pending )?tasks\b", intent_list_tasks, False),
]


def build_context(members, tasks, qa_run=None, security_run=None):
    return {
        "members": members,
        "tasks": tasks,
        "index": _member_lookup(members),
        "qa_run": qa_run,
        "security_run": security_run,
    }


def _dispatch(handler, ctx, text, index):
    """Call a handler with whichever signature it takes.

    Signature is inspected rather than catching TypeError, so a genuine bug
    inside a handler surfaces instead of being retried as a bad call.
    """
    import inspect

    positional = [
        p for p in inspect.signature(handler).parameters.values()
        if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)
    ]
    if len(positional) >= 3:
        return handler(ctx, text, index)
    if len(positional) == 2:
        return handler(ctx, text)
    return handler(ctx)


def handle(message, members, tasks, qa_run=None, security_run=None):
    """Route one message to a handler and return a structured reply."""
    ctx = build_context(members, tasks, qa_run, security_run)
    text = (message or "").strip()
    index = ctx["index"]

    if not text:
        return intent_help(ctx)

    lowered = text.lower()

    # Task and person intents run first because they are the most specific.
    for pattern, handler in _task_context(lowered):
        if re.search(pattern, lowered):
            return _dispatch(handler, ctx, text, index)

    for pattern, handler in _person_context(lowered):
        if re.search(pattern, lowered):
            member = _find_member(text, index)
            if member:
                return _dispatch(handler, ctx, text, index)

    for pattern, handler, needs_lookup in INTENTS:
        if re.search(pattern, lowered):
            if needs_lookup and not _find_member(text, index):
                continue  # fall through to a more general handler
            return _dispatch(handler, ctx, text, index)

    # Nothing matched: offer the closest thing rather than a dead end.
    return {
        "text": (
            "I did not catch that. I work from your real task data, so I try to match "
            "your wording to what it can answer."
        ),
        "actions": [
            {"label": "What can you do?", "message": "help"},
            {"label": "Who is free?", "message": "who is free"},
            {"label": "Team summary", "message": "team summary"},
        ],
    }


def _first_name(member):
    name = (_field(member, "name") or "").strip()
    return name.split()[0] if name else "there"


def build_briefing(ctx):
    """A short, human status read for the moment the manager arrives."""
    members = ctx["members"]
    tasks = ctx["tasks"]
    if not members:
        return {
            "text": "Hey, good to see you. We have not got any team set up yet though, "
                    "so there is nothing for me to report. Add your people and I will "
                    "keep an eye on it for you.",
            "actions": [{"label": "Add a team member", "action": "goto", "view": "overview"}],
        }

    open_tasks = _open_tasks(tasks)
    working = [t for t in open_tasks if t.status == "in_progress"]
    review = [t for t in open_tasks if t.status == "review"]
    overdue = [t for t in open_tasks if _due_state(t) == "overdue"]
    idle = [
        m for m in members
        if len([t for t in open_tasks if t.member_id == _field(m, "id")]) == 0
    ]

    # Say the quiet days plainly instead of padding with numbers.
    if not open_tasks:
        return {
            "text": (
                f"Hey {_first_name(members[0])}, board is completely clear. "
                f"Nothing open across {len(members)} people. Good moment to plan ahead, "
                "or take the day off for once."
            ),
            "actions": [
                {"label": "Who should I give work to?", "message": "who is free"},
                {"label": "How's my site?", "message": "is my site up"},
            ],
        }

    lines = []
    if working:
        lines.append(
            f"**{len(working)}** {'task is' if len(working) == 1 else 'tasks are'} "
            f"actually in progress right now"
        )
    if review:
        lines.append(f"**{len(review)}** {'is' if len(review) == 1 else 'are'} sitting with you waiting on a look")
    if overdue:
        lines.append(f"**{len(overdue)}** {'is' if len(overdue) == 1 else 'are'} running late")
    if idle:
        who = ", ".join(_first_name(m) for m in idle[:3])
        lines.append(f"**{who}** {'has' if len(idle) == 1 else 'have'} nothing on, so there is room to hand something over")

    body = ", ".join(lines) if lines else "Things are ticking along quietly"

    return {
        "text": (
            f"Hey {_first_name(members[0])}, how are you doing? Here is where things stand. "
            f"You have {len(open_tasks)} open {'task' if len(open_tasks) == 1 else 'tasks'} "
            f"across {len(members)} people. {body}. "
            "What do you want to get on with?"
        ),
        "list": [],
        "actions": [
            {"label": "Tell me what to do next", "message": "what should I do next"},
            {"label": "Who's actually working?", "message": "who is working"},
            {"label": "Anyone free?", "message": "who is free"},
            {"label": "What's running late?", "message": "what is overdue"},
        ],
    }


def intent_greeting(ctx):
    return build_briefing(ctx)


def greeting(name=None):
    """Fallback greeting when there is no workspace context to read."""
    hour = datetime.utcnow().hour
    if hour < 12:
        part = "Morning"
    elif hour < 17:
        part = "Afternoon"
    else:
        part = "Evening"
    who = f" {_first_name_str(name)}" if name else ""
    return f"{part}{who}. Good to see you. What do you want to get on with?"


def _first_name_str(name):
    return str(name).strip().split()[0] if name else ""


def ask_whats_next(ctx):
    """The 'what should I do next' answer, worked out from live data."""
    tasks = _open_tasks(ctx["tasks"])
    members = ctx["members"]
    if not tasks:
        return {
            "text": "Your board is completely clear right now. Good moment to plan ahead.",
            "actions": [
                {"label": "See the team", "action": "goto", "view": "who_working"},
                {"label": "Check my site", "message": "is my site up"},
            ],
        }

    steps = []

    review = [t for t in tasks if t.status == "review"]
    if review:
        steps.append(
            f"**Review {len(review)} task(s)** that are waiting on you: "
            + ", ".join(t.title for t in review[:3])
        )

    overdue = [t for t in tasks if _due_state(t) == "overdue"]
    if overdue:
        steps.append(
            f"**Chase {len(overdue)} overdue task(s)**: "
            + ", ".join(t.title for t in overdue[:3])
        )

    idle = [
        m for m in members
        if len([t for t in tasks if t.member_id == m.id]) <= 1
    ]
    if idle:
        steps.append(
            f"**Put work to someone free**: "
            + ", ".join(f"{m.name} ({m.role})" for m in idle[:3])
        )

    qa = ctx.get("qa_run")
    if qa and _field(qa, "status") == "critical":
        steps.append("**Your website is reporting a problem.** I can tell you what.")

    if not steps:
        steps.append(
            "Nothing is blocked right now. It is a good time to check in with the team "
            "or pick up the next piece of work yourself."
        )

    return {
        "text": (
            f"How are you doing? Here is what I would tackle next, based on what I can see "
            f"across {len(members)} people and {len(tasks)} open tasks."
        ),
        "list": steps,
        "actions": [
            {"label": "Open All Tasks", "action": "goto", "view": "tasks"},
            {"label": "Who is free?", "message": "who is free"},
            {"label": "What is overdue?", "message": "what is overdue"},
        ],
    }


SUGGESTIONS = [
    "who is free",
    "what is overdue",
    "who is working on what",
    "team summary",
    "what needs my review",
    "is my site up",
    "security review",
    "todays plan",
]