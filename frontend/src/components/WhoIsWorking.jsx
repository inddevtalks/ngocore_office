import React, { useState } from "react";
import {
  Users, Zap, Clock, CheckCircle2, Copy, Check, Plus, Send,
  ExternalLink, Search, AlertCircle, FileText, ChevronRight,
  Pencil, Trash2
} from "lucide-react";

export default function WhoIsWorking({
  members = [],
  tasks = [],
  onAssignTask,
  onOpenPortal,
  onResendEmail,
  onEditMember,
  onDeleteMember,
}) {
  const [search, setSearch] = useState("");
  const [filterMode, setFilterMode] = useState("all"); // 'all', 'working', 'free'
  const [copiedId, setCopiedId] = useState(null);
  const [toast, setToast] = useState("");

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  function copyPortalLink(memberId) {
    const url = `${window.location.origin}${window.location.pathname}?portal=${memberId}`;
    navigator.clipboard.writeText(url);
    setCopiedId(memberId);
    showToast("Employee portal link copied to clipboard!");
    setTimeout(() => setCopiedId(null), 2500);
  }

  const processedMembers = members.map(m => {
    const memberTasks = tasks.filter(t => t.member_id === m.id);
    const activeTask = memberTasks.find(t => t.status === "in_progress");
    const nextTask = memberTasks.find(t => t.status === "todo");
    const reviewTask = memberTasks.find(t => t.status === "review");
    const completedTasks = memberTasks.filter(t => t.status === "done");

    const currentFocus = activeTask || reviewTask || nextTask;

    return {
      ...m,
      tasks: memberTasks,
      activeTask,
      nextTask,
      reviewTask,
      completedTasks,
      currentFocus,
      isWorking: Boolean(activeTask),
      isFree: memberTasks.length === 0 || (!activeTask && !nextTask && !reviewTask),
    };
  });

  const filteredMembers = processedMembers.filter(m => {
    const matchesSearch = !search ||
      m.name.toLowerCase().includes(search.toLowerCase()) ||
      m.role.toLowerCase().includes(search.toLowerCase()) ||
      (m.currentFocus && m.currentFocus.title.toLowerCase().includes(search.toLowerCase()));

    if (!matchesSearch) return false;

    if (filterMode === "working") return m.isWorking;
    if (filterMode === "free") return m.isFree;
    return true;
  });

  return (
    <div className="who-working-container">
      {/* Header and Controls */}
      <div className="who-header">
        <div>
          <div className="eyebrow"><Zap size={14} /> WORKLOAD ALLOCATION MATRIX</div>
          <h2>Who is Working on What Right Now</h2>
          <p>Real-time monitor of task distribution, active work, and team capacity.</p>
        </div>

        <div className="who-actions">
          <div className="search-bar">
            <Search size={16} />
            <input
              type="text"
              placeholder="Search member, role, or task..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="filter-chips">
            <button
              className={`chip ${filterMode === "all" ? "active" : ""}`}
              onClick={() => setFilterMode("all")}
            >
              All ({members.length})
            </button>
            <button
              className={`chip working ${filterMode === "working" ? "active" : ""}`}
              onClick={() => setFilterMode("working")}
            >
              ⚡ Working Now ({processedMembers.filter(m => m.isWorking).length})
            </button>
            <button
              className={`chip free ${filterMode === "free" ? "active" : ""}`}
              onClick={() => setFilterMode("free")}
            >
              ☕ Available ({processedMembers.filter(m => m.isFree).length})
            </button>
          </div>
        </div>
      </div>

      {/* Grid of Member Workload Cards */}
      <div className="who-grid">
        {filteredMembers.map(member => {
          const current = member.currentFocus;

          return (
            <div
              key={member.id}
              className={`member-work-card ${member.isWorking ? "is-working" : member.isFree ? "is-free" : "is-queued"}`}
            >
              {/* Member Card Header */}
              <div className="mwc-top">
                <div className="mwc-profile">
                  <div className="mwc-avatar">{member.avatar}</div>
                  <div>
                    <h3 className="mwc-name">{member.name}</h3>
                    <div className="mwc-role">{member.role}</div>
                  </div>
                </div>

                <div className={`mwc-presence ${member.isWorking ? "active" : member.isFree ? "free" : "queued"}`}>
                  <span className="dot" />
                  {member.isWorking ? "Working Now" : member.isFree ? "Available" : "Queued"}
                </div>
              </div>

              {/* CURRENT ACTIVE WORK SPOTLIGHT */}
              <div className="mwc-focus-area">
                <div className="focus-label">CURRENT FOCUS:</div>

                {current ? (
                  <div className={`focus-box ${current.status}`}>
                    <div className="fb-top">
                      <span className={`status-pill ${current.status}`}>
                        {current.status === "in_progress" && "⚡ DOING NOW"}
                        {current.status === "todo" && "⏳ NEXT IN QUEUE"}
                        {current.status === "review" && "🔍 IN REVIEW"}
                        {current.status === "done" && "✓ DONE"}
                      </span>
                      <span className={`priority-tag ${current.priority}`}>
                        {current.priority}
                      </span>
                    </div>

                    <h4 className="fb-title">{current.title}</h4>

                    {current.description && (
                      <p className="fb-desc">{current.description}</p>
                    )}

                    {current.notes && (
                      <div className="fb-notes">
                        <FileText size={12} />
                        <span><b>Latest update:</b> {current.notes}</span>
                      </div>
                    )}

                    <div className="fb-meta">
                      <span>Due: <b>{current.due_date || "No due date"}</b></span>
                      {onResendEmail && (
                        <button
                          className="resend-email-btn"
                          title="Resend assignment email to employee"
                          onClick={() => onResendEmail(current.id)}
                        >
                          <Send size={11} /> Resend Email
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="focus-box-empty">
                    <span className="empty-emoji">☕</span>
                    <div>
                      <strong>No active tasks</strong>
                      <p>This team member is currently free and ready for new work.</p>
                    </div>
                    <button
                      className="primary-btn sm"
                      onClick={() => onAssignTask(member.id)}
                    >
                      <Plus size={14} /> Assign Task
                    </button>
                  </div>
                )}
              </div>

              {/* Other Tasks Queue */}
              {member.tasks.length > 1 && (
                <div className="mwc-queue">
                  <div className="queue-label">
                    <span>OTHER TASKS IN QUEUE:</span>
                    <span className="queue-count">{member.tasks.length - 1} more</span>
                  </div>
                  <div className="queue-list">
                    {member.tasks
                      .filter(t => !current || t.id !== current.id)
                      .slice(0, 3)
                      .map(t => (
                        <div key={t.id} className="queue-item">
                          <span className={`q-status-dot ${t.status}`} />
                          <span className="q-title">{t.title}</span>
                          <span className={`q-priority ${t.priority}`}>{t.priority}</span>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {/* Workload Stats & Manager Actions Bar */}
              <div className="mwc-footer">
                <div className="task-counts">
                  <span><b>{member.completedTasks.length}</b> done</span>
                  <span>&bull;</span>
                  <span><b>{member.tasks.filter(t => t.status !== "done").length}</b> open</span>
                </div>

                <div className="mwc-action-btns">
                  <button
                    className="action-icon-btn"
                    title="Copy Personal Status Link to send to employee"
                    onClick={() => copyPortalLink(member.id)}
                  >
                    {copiedId === member.id ? <Check size={14} className="copied" /> : <Copy size={14} />}
                    <span className="btn-text">{copiedId === member.id ? "Copied" : "Copy Link"}</span>
                  </button>

                  <button
                    className="action-icon-btn"
                    title="Preview this employee's portal"
                    onClick={() => onOpenPortal(member.id)}
                  >
                    <ExternalLink size={14} />
                    <span className="btn-text">Portal</span>
                  </button>

                  <button
                    className="action-icon-btn highlight"
                    title="Assign task to this member"
                    onClick={() => onAssignTask(member.id)}
                  >
                    <Plus size={14} />
                  </button>

                  {onEditMember && (
                    <button
                      className="action-icon-btn"
                      title={`Edit ${member.name}'s details`}
                      onClick={() => onEditMember(member)}
                    >
                      <Pencil size={14} />
                      <span className="btn-text">Edit</span>
                    </button>
                  )}

                  {onDeleteMember && (
                    <button
                      className="action-icon-btn danger"
                      title={`Delete ${member.name}`}
                      onClick={() => onDeleteMember(member)}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {toast && (
        <div className="toast">
          <CheckCircle2 size={16} />
          {toast}
        </div>
      )}
    </div>
  );
}
