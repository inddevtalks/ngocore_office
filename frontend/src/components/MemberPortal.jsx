import React, { useState, useEffect } from "react";
import {
  CheckCircle2, Clock, PlayCircle, AlertCircle, ArrowLeft, Copy, Check,
  Sparkles, FileText, Send, Zap, ChevronRight, MessageSquare, Calendar,
  Sun, Moon
} from "lucide-react";

export default function MemberPortal({ memberId, onBackToManager, previewMode = false }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState("all");
  const [notesDraft, setNotesDraft] = useState({});
  const [savingTaskId, setSavingTaskId] = useState(null);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState("");

  // Same theme handling as the dashboard, kept local so the portal works on
  // its own from a bookmarked link with no manager session.
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("office-theme") === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("theme-switch");
    root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("office-theme", theme);
    } catch {
      // Private browsing refuses writes; it still applies for this visit.
    }
    const t = setTimeout(() => root.classList.remove("theme-switch"), 60);
    return () => clearTimeout(t);
  }, [theme]);

  const onToggleTheme = () => setTheme(t => (t === "light" ? "dark" : "light"));

  async function loadPortal() {
    try {
      setLoading(true);
      const res = await fetch(`/api/portal/${memberId}`, { credentials: "same-origin" });
      if (!res.ok) {
        throw new Error("Unable to load member status portal. Check the link or ID.");
      }
      const json = await res.json();
      setData(json);

      // Initialize notes draft
      const draft = {};
      json.tasks.forEach(t => {
        draft[t.id] = t.notes || "";
      });
      setNotesDraft(draft);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadPortal();
  }, [memberId]);

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  async function updateStatus(taskId, newStatus) {
    try {
      setSavingTaskId(taskId);
      const res = await fetch(`/api/portal/task/${taskId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error("Failed to update status.");
      const updated = await res.json();

      setData(prev => ({
        ...prev,
        tasks: prev.tasks.map(t => t.id === taskId ? { ...t, status: updated.status, updated_at: updated.updated_at } : t),
        stats: {
          ...prev.stats,
          todo: prev.tasks.filter(t => (t.id === taskId ? newStatus : t.status) === "todo").length,
          in_progress: prev.tasks.filter(t => (t.id === taskId ? newStatus : t.status) === "in_progress").length,
          review: prev.tasks.filter(t => (t.id === taskId ? newStatus : t.status) === "review").length,
          done: prev.tasks.filter(t => (t.id === taskId ? newStatus : t.status) === "done").length,
        }
      }));

      showToast(`Status updated to "${newStatus.replace('_', ' ')}"`);
    } catch (err) {
      showToast(err.message);
    } finally {
      setSavingTaskId(null);
    }
  }

  async function saveNotes(taskId) {
    try {
      setSavingTaskId(taskId);
      const notes = notesDraft[taskId] || "";
      const res = await fetch(`/api/portal/task/${taskId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes }),
      });
      if (!res.ok) throw new Error("Failed to save note.");
      const updated = await res.json();

      setData(prev => ({
        ...prev,
        tasks: prev.tasks.map(t => t.id === taskId ? { ...t, notes: updated.notes, updated_at: updated.updated_at } : t)
      }));

      showToast("Progress note saved!");
    } catch (err) {
      showToast(err.message);
    } finally {
      setSavingTaskId(null);
    }
  }

  function copyMyLink() {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    showToast("Portal link copied to clipboard!");
    setTimeout(() => setCopied(false), 2500);
  }

  if (loading) {
    return (
      <div className="portal-loading">
        <div className="loader" />
        <p>Loading your personal workspace...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="portal-error-card">
        <AlertCircle size={44} className="err-icon" />
        <h2>Workspace Not Found</h2>
        <p>{error || "We couldn't find a member with this ID."}</p>
        {previewMode && (
          <button className="primary-btn" onClick={onBackToManager}>
            <ArrowLeft size={16} /> Return to Main Office
          </button>
        )}
      </div>
    );
  }

  const { member, tasks, stats } = data;
  // Only the manager previewing a portal gets the "back to dashboard" control.
  const allowManagerReturn = previewMode && typeof onBackToManager === "function";

  const filteredTasks = tasks.filter(t => {
    if (activeTab === "all") return true;
    return t.status === activeTab;
  });

  return (
    <div className="member-portal-shell">
      {/* Top Navbar */}
      <header className="portal-topbar">
        <div className="portal-brand">
          <div className="brand-mark"><Zap size={18} /></div>
          <div>
            <strong>NGOCORE</strong>
            <span>EMPLOYEE WORKSPACE</span>
          </div>
        </div>

        <div className="portal-top-actions">
          {/* Employees get the same light/dark choice as the manager, saved on
              this device. */}
          <button
            className="theme-toggle"
            onClick={onToggleTheme}
            title={theme === "light" ? "Switch to the dark theme" : "Switch to the light theme"}
            aria-label="Toggle light or dark theme"
          >
            {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
          </button>
          <button className="secondary-btn copy-btn" onClick={copyMyLink}>
            {copied ? <Check size={16} /> : <Copy size={16} />}
            {copied ? "Link Copied" : "Bookmark / Copy Link"}
          </button>
        </div>
      </header>

      {/* Employees have no manager password, so this only shows for the manager
          previewing a workspace from the dashboard. */}
      {allowManagerReturn && (
        <div className="portal-manager-bar">
          <span>You are previewing a team member's workspace.</span>
          <button className="ghost-btn" onClick={onBackToManager}>
            <ArrowLeft size={14} /> Back to Manager Dashboard
          </button>
        </div>
      )}

      {/* Member Hero Banner */}
      <div className="portal-hero">
        <div className="portal-profile">
          <div className="profile-avatar">{member.avatar}</div>
          <div className="profile-info">
            <div className="greeting-pill">PERSONAL TASK DASHBOARD</div>
            <h1>Welcome back, {member.name}!</h1>
            <p className="profile-role">{member.role} &bull; {member.email}</p>
          </div>
        </div>

        {/* Quick Stat Counter */}
        <div className="portal-stats-row">
          <div className="p-stat">
            <span className="p-stat-val">{stats.total}</span>
            <span className="p-stat-lbl">Total Assigned</span>
          </div>
          <div className="p-stat highlight">
            <span className="p-stat-val">{stats.in_progress}</span>
            <span className="p-stat-lbl">In Progress</span>
          </div>
          <div className="p-stat">
            <span className="p-stat-val">{stats.todo}</span>
            <span className="p-stat-lbl">Yet to Start</span>
          </div>
          <div className="p-stat success">
            <span className="p-stat-val">{stats.done}</span>
            <span className="p-stat-lbl">Completed</span>
          </div>
        </div>
      </div>

      {/* Main Task List Area */}
      <div className="portal-body">
        <div className="portal-filter-bar">
          <div className="filter-title">
            <h2>Your Assigned Tasks</h2>
            <p>Update your progress so your manager and team can see live updates.</p>
          </div>

          <div className="status-tab-pills">
            <button
              className={`tab-pill ${activeTab === "all" ? "active" : ""}`}
              onClick={() => setActiveTab("all")}
            >
              All ({tasks.length})
            </button>
            <button
              className={`tab-pill in_progress ${activeTab === "in_progress" ? "active" : ""}`}
              onClick={() => setActiveTab("in_progress")}
            >
              ⚡ Doing Now ({stats.in_progress})
            </button>
            <button
              className={`tab-pill todo ${activeTab === "todo" ? "active" : ""}`}
              onClick={() => setActiveTab("todo")}
            >
              ⏳ Yet to Start ({stats.todo})
            </button>
            <button
              className={`tab-pill review ${activeTab === "review" ? "active" : ""}`}
              onClick={() => setActiveTab("review")}
            >
              🔍 Review ({stats.review})
            </button>
            <button
              className={`tab-pill done ${activeTab === "done" ? "active" : ""}`}
              onClick={() => setActiveTab("done")}
            >
              ✓ Completed ({stats.done})
            </button>
          </div>
        </div>

        {/* Task Cards */}
        <div className="portal-tasks-container">
          {filteredTasks.length === 0 ? (
            <div className="portal-empty-tasks">
              <Sparkles size={32} />
              <h3>No tasks found in this view</h3>
              <p>You're all caught up or no tasks match this filter!</p>
            </div>
          ) : (
            filteredTasks.map(task => {
              const isSaving = savingTaskId === task.id;
              return (
                <div key={task.id} className={`portal-task-card ${task.status}`}>
                  <div className="pt-top">
                    <div className="pt-badges">
                      <span className={`priority-tag ${task.priority}`}>
                        {task.priority.toUpperCase()}
                      </span>
                      <span className={`status-badge-live ${task.status}`}>
                        {task.status === "in_progress" && "⚡ In Progress"}
                        {task.status === "todo" && "⏳ Yet to Start"}
                        {task.status === "review" && "🔍 Ready for Review"}
                        {task.status === "done" && "✓ Completed"}
                      </span>
                    </div>

                    {task.due_date && (
                      <div className="pt-due">
                        <Calendar size={13} />
                        <span>Due: {task.due_date}</span>
                      </div>
                    )}
                  </div>

                  <h3 className="pt-title">{task.title}</h3>
                  {task.description && (
                    <p className="pt-desc">{task.description}</p>
                  )}

                  {/* Status Change Buttons */}
                  <div className="pt-status-section">
                    <div className="action-label">UPDATE STATUS:</div>
                    <div className="status-btn-group">
                      <button
                        className={`status-chip todo ${task.status === "todo" ? "selected" : ""}`}
                        disabled={isSaving}
                        onClick={() => updateStatus(task.id, "todo")}
                      >
                        <Clock size={13} /> Yet to Start
                      </button>
                      <button
                        className={`status-chip in_progress ${task.status === "in_progress" ? "selected" : ""}`}
                        disabled={isSaving}
                        onClick={() => updateStatus(task.id, "in_progress")}
                      >
                        <Zap size={13} /> In Progress
                      </button>
                      <button
                        className={`status-chip review ${task.status === "review" ? "selected" : ""}`}
                        disabled={isSaving}
                        onClick={() => updateStatus(task.id, "review")}
                      >
                        <FileText size={13} /> Submit for Review
                      </button>
                      <button
                        className={`status-chip done ${task.status === "done" ? "selected" : ""}`}
                        disabled={isSaving}
                        onClick={() => updateStatus(task.id, "done")}
                      >
                        <CheckCircle2 size={13} /> Completed
                      </button>
                    </div>
                  </div>

                  {/* Progress Notes / Blocker input */}
                  <div className="pt-notes-section">
                    <div className="action-label">PROGRESS NOTES / BLOCKERS:</div>
                    <div className="notes-input-wrapper">
                      <textarea
                        rows="2"
                        placeholder="Add comments on your progress, links, or mention if anything is blocking you..."
                        value={notesDraft[task.id] || ""}
                        onChange={(e) => setNotesDraft({ ...notesDraft, [task.id]: e.target.value })}
                      />
                      <button
                        className="save-note-btn"
                        disabled={isSaving || notesDraft[task.id] === (task.notes || "")}
                        onClick={() => saveNotes(task.id)}
                      >
                        {isSaving ? "Saving..." : "Save Note"}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {toast && (
        <div className="toast-portal">
          <CheckCircle2 size={16} />
          {toast}
        </div>
      )}
    </div>
  );
}
