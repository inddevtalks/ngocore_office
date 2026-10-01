import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Bell, CalendarDays, CheckCircle2, ChevronDown, Circle,
  Clock3, Coffee, LayoutDashboard, Mail, MoreHorizontal,
  Plus, Search, Settings2, Sparkles, Users, X, Zap,
  ExternalLink, Copy, Check, Send, Eye, Shield, Menu,
  Pencil, Trash2, AlertTriangle, UserX
} from "lucide-react";

import OfficeScene from "./components/OfficeScene";
import MemberPortal from "./components/MemberPortal";
import WhoIsWorking from "./components/WhoIsWorking";
import EmailCenterModal from "./components/EmailCenterModal";
import "./styles.css";

// Empty by default, which makes every request same-origin (e.g. /api/dashboard).
// That is correct on Vercel, where the API and the built frontend share a domain.
// Set VITE_API_URL only when the API is hosted somewhere else entirely.
const API = import.meta.env.VITE_API_URL || "";

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

function App() {
  const [data, setData] = useState({ members: [], tasks: [], stats: {}, smtp_status: {} });
  const [loading, setLoading] = useState(true);
  const [activeView, setActiveView] = useState("overview"); // 'overview', 'who_working', 'office'
  const [selectedMember, setSelectedMember] = useState("all");
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState(null); // 'task', 'member', 'email_center'
  const [editingMember, setEditingMember] = useState(null);
  const [deletingMember, setDeletingMember] = useState(null);
  const [prefilledMemberId, setPrefilledMemberId] = useState(null);
  const [toast, setToast] = useState("");
  const [portalMemberId, setPortalMemberId] = useState(null);
  const [mobileKanbanStatus, setMobileKanbanStatus] = useState("all"); // 'all', 'todo', 'in_progress', 'review', 'done'
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Check URL query parameters for employee portal link: ?portal=123
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const portalId = params.get("portal");
    if (portalId) {
      setPortalMemberId(portalId);
    }
  }, []);

  async function load() {
    try {
      setLoading(true);
      const dashboard = await api("/api/dashboard");
      setData(dashboard);
    } catch (e) {
      setToast(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function showToast(msg) {
    setToast(msg);
  }

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const filteredTasks = useMemo(() => {
    return data.tasks.filter(t => {
      const memberOk = selectedMember === "all" || String(t.member_id) === String(selectedMember);
      const searchOk = !search || `${t.title} ${t.description} ${t.member_name}`.toLowerCase().includes(search.toLowerCase());
      const statusOk = mobileKanbanStatus === "all" || t.status === mobileKanbanStatus;
      return memberOk && searchOk && statusOk;
    });
  }, [data.tasks, selectedMember, search, mobileKanbanStatus]);

  async function updateTask(id, patch) {
    try {
      await api(`/api/tasks/${id}`, { method: "PUT", body: JSON.stringify(patch) });
      await load();
      showToast("Task updated");
    } catch (e) {
      showToast(e.message);
    }
  }

  async function createTask(payload) {
    try {
      const res = await api("/api/tasks", { method: "POST", body: JSON.stringify(payload) });
      await load();
      setModal(null);
      setPrefilledMemberId(null);
      const emailNotice = res.email_result?.message ? ` & ${res.email_result.message}` : "";
      showToast(`Task assigned successfully${emailNotice}`);
    } catch (e) {
      showToast(e.message);
    }
  }

  async function createMember(payload) {
    try {
      await api("/api/members", { method: "POST", body: JSON.stringify(payload) });
      await load();
      setModal(null);
      setEditingMember(null);
      showToast("Team member added to office!");
    } catch (e) {
      showToast(e.message);
    }
  }

  async function updateMember(memberId, payload) {
    try {
      await api(`/api/members/${memberId}`, { method: "PUT", body: JSON.stringify(payload) });
      await load();
      setModal(null);
      setEditingMember(null);
      showToast("Member details updated!");
    } catch (e) {
      showToast(e.message);
    }
  }

  async function deleteMember(memberId) {
    try {
      const res = await api(`/api/members/${memberId}`, { method: "DELETE" });
      await load();
      setDeletingMember(null);
      if (selectedMember === String(memberId)) setSelectedMember("all");
      const extra = res.deleted_tasks ? ` (${res.deleted_tasks} task${res.deleted_tasks === 1 ? "" : "s"} removed)` : "";
      showToast(`${res.message || "Member removed"}${extra}`);
    } catch (e) {
      showToast(e.message);
    }
  }

  async function resendEmailNotification(taskId) {
    try {
      const res = await api(`/api/tasks/${taskId}/resend-email`, { method: "POST" });
      showToast(res.message || "Notification email sent!");
    } catch (e) {
      showToast(e.message);
    }
  }

  async function seedDemo() {
    try {
      await api("/api/seed", { method: "POST" });
      await load();
      showToast("Demo office loaded with assigned tasks!");
    } catch (e) {
      showToast(e.message);
    }
  }

  function handleOpenAssignModal(memberId = null) {
    setPrefilledMemberId(memberId);
    setModal("task");
  }

  function handleOpenAddMember() {
    setEditingMember(null);
    setModal("member");
  }

  function handleOpenEditMember(member) {
    setEditingMember(member);
    setModal("member");
  }

  function copyPortalLink(memberId) {
    const url = `${window.location.origin}${window.location.pathname}?portal=${memberId}`;
    navigator.clipboard.writeText(url);
    showToast("Employee portal link copied to clipboard!");
  }

  // If viewing a member's portal (e.g. employee opened link)
  if (portalMemberId) {
    return (
      <MemberPortal
        memberId={portalMemberId}
        onBackToManager={() => {
          const url = new URL(window.location.href);
          url.searchParams.delete("portal");
          window.history.pushState({}, "", url.toString());
          setPortalMemberId(null);
        }}
      />
    );
  }

  const activeTasks = filteredTasks.filter(t => t.status !== "done");

  return (
    <div className="app-shell">
      {/* Sidebar Navigation (Desktop) */}
      <Sidebar
        activeView={activeView}
        setActiveView={setActiveView}
        selectedMember={selectedMember}
        setSelectedMember={setSelectedMember}
        members={data.members}
        onAddMember={handleOpenAddMember}
        onEditMember={handleOpenEditMember}
        onDeleteMember={setDeletingMember}
        onOpenEmailCenter={() => setModal("email_center")}
        smtpStatus={data.smtp_status}
      />

      <main className="main">
        {/* Mobile Top App Bar */}
        <div className="mobile-header">
          <div className="brand-mobile">
            <div className="brand-mark-sm"><Zap size={16} /></div>
            <strong>NGOCORE OFFICE</strong>
          </div>
          <div className="mobile-header-actions">
            <button
              className="email-pill-btn-sm"
              onClick={() => setModal("email_center")}
              title="Email Center"
            >
              <Mail size={15} />
              <span className={`status-dot ${data.smtp_status?.configured ? "green" : "gold"}`} />
            </button>
            <button
              className="primary-btn sm"
              onClick={() => handleOpenAssignModal()}
            >
              <Plus size={14} /> Task
            </button>
          </div>
        </div>

        {/* Top Header (Desktop) */}
        <header className="topbar">
          <div>
            <div className="eyebrow">
              <Sparkles size={14} /> OPERATIONS CONTROL ROOM
            </div>
            <h1>Good day, boss.</h1>
            <p>Assign tasks, monitor real-time execution, and send automated email plans to your team.</p>
          </div>

          <div className="top-actions">
            <div className="date-pill">
              <CalendarDays size={16} />
              {data.today || "Today"}
            </div>

            <button
              className="email-pill-btn"
              onClick={() => setModal("email_center")}
              title="Open Email Center"
            >
              <Mail size={16} />
              <span>{data.smtp_status?.configured ? "SMTP Live" : "Email Center"}</span>
              <span className={`status-dot ${data.smtp_status?.configured ? "green" : "gold"}`} />
            </button>

            <div className="owner-chip">
              <span className="owner-avatar">P</span>
              <span>Peter (Admin)</span>
              <ChevronDown size={15} />
            </div>
          </div>
        </header>

        {/* View Switcher Tabs (Desktop & Tablet) */}
        <div className="main-view-switcher">
          <button
            className={`view-tab ${activeView === "overview" ? "active" : ""}`}
            onClick={() => setActiveView("overview")}
          >
            <LayoutDashboard size={16} /> Executive Overview
          </button>
          <button
            className={`view-tab ${activeView === "who_working" ? "active" : ""}`}
            onClick={() => setActiveView("who_working")}
          >
            <Users size={16} /> Who is Working on What
          </button>
          <button
            className={`view-tab ${activeView === "office" ? "active" : ""}`}
            onClick={() => setActiveView("office")}
          >
            <Coffee size={16} /> Virtual Animated Office
          </button>
        </div>

        {/* VIEW 1: WHO IS WORKING ON WHAT */}
        {activeView === "who_working" && (
          <WhoIsWorking
            members={data.members}
            tasks={data.tasks}
            onAssignTask={handleOpenAssignModal}
            onOpenPortal={(id) => setPortalMemberId(String(id))}
            onResendEmail={resendEmailNotification}
            onEditMember={handleOpenEditMember}
            onDeleteMember={setDeletingMember}
          />
        )}

        {/* VIEW 2: VIRTUAL ANIMATED OFFICE (FULL SCREEN FOCUS) */}
        {activeView === "office" && (
          <div className="full-office-view">
            <div className="section-head">
              <div>
                <div className="eyebrow">HEADQUARTERS FLOOR</div>
                <h2>Live Virtual Office Floor</h2>
                <p>Observe walking avatars, working monitors, coffee breaks, and strategy boards.</p>
              </div>
              <button className="primary-btn" onClick={() => handleOpenAssignModal()}>
                <Plus size={16} /> Assign a task
              </button>
            </div>
            <OfficeScene
              members={data.members}
              tasks={data.tasks}
              onSelectMember={(id) => {
                setSelectedMember(id);
                setActiveView("overview");
              }}
              onAssignTask={handleOpenAssignModal}
            />
          </div>
        )}

        {/* VIEW 3: EXECUTIVE OVERVIEW (DEFAULT) */}
        {activeView === "overview" && (
          <>
            {/* Hero Office Section with Animated Avatars */}
            <section className="hero-office">
              <div className="hero-copy">
                <div className="live"><span /> LIVE OFFICE PULSE</div>
                <h2>One room.<br /><strong>Everyone’s work.</strong></h2>
                <p>Monitor real-time execution with walking avatars and automated task emails.</p>
                <div className="hero-btn-row">
                  <button className="primary-btn" onClick={() => handleOpenAssignModal()}>
                    <Plus size={16} /> Assign task
                  </button>
                  <button className="secondary-btn" onClick={() => setActiveView("who_working")}>
                    <Users size={15} /> Who is working
                  </button>
                </div>
              </div>

              <div className="hero-scene-wrapper">
                <OfficeScene
                  members={data.members}
                  tasks={data.tasks}
                  onSelectMember={(id) => setSelectedMember(String(id))}
                  onAssignTask={handleOpenAssignModal}
                />
              </div>
            </section>

            {/* Metrics Row */}
            <section className="metrics">
              <Metric icon={<Users />} label="Team online" value={data.stats.team || 0} suffix=" people" />
              <Metric icon={<Zap />} label="In progress" value={data.stats.in_progress || 0} suffix=" tasks" />
              <Metric icon={<Clock3 />} label="Due today" value={data.stats.due_today || 0} suffix=" tasks" />
              <Metric icon={<CheckCircle2 />} label="Completed" value={data.stats.done || 0} suffix=" tasks" />
            </section>

            {/* Kanban Task Floor */}
            <section className="workspace">
              <div className="section-head">
                <div>
                  <div className="eyebrow">WORK CONTROL</div>
                  <h2>Today’s task floor</h2>
                </div>
                <div className="workspace-actions">
                  <div className="search">
                    <Search size={16} />
                    <input
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      placeholder="Search tasks..."
                    />
                  </div>
                  {selectedMember !== "all" && (
                    <button className="filter-clear-btn" onClick={() => setSelectedMember("all")}>
                      Clear filter (#{selectedMember}) <X size={13} />
                    </button>
                  )}
                  <button className="secondary-btn hide-on-mobile" onClick={handleOpenAddMember}>
                    <Users size={16} /> Add member
                  </button>
                  <button className="primary-btn hide-on-mobile" onClick={() => handleOpenAssignModal()}>
                    <Plus size={16} /> Assign Task
                  </button>
                </div>
              </div>

              {/* Mobile Kanban Filter Tabs */}
              <div className="mobile-kanban-tabs">
                <button
                  className={`m-ktab ${mobileKanbanStatus === "all" ? "active" : ""}`}
                  onClick={() => setMobileKanbanStatus("all")}
                >
                  All ({data.tasks.length})
                </button>
                <button
                  className={`m-ktab in_progress ${mobileKanbanStatus === "in_progress" ? "active" : ""}`}
                  onClick={() => setMobileKanbanStatus("in_progress")}
                >
                  ⚡ Doing ({data.stats.in_progress || 0})
                </button>
                <button
                  className={`m-ktab todo ${mobileKanbanStatus === "todo" ? "active" : ""}`}
                  onClick={() => setMobileKanbanStatus("todo")}
                >
                  ⏳ Next ({data.stats.todo || 0})
                </button>
                <button
                  className={`m-ktab review ${mobileKanbanStatus === "review" ? "active" : ""}`}
                  onClick={() => setMobileKanbanStatus("review")}
                >
                  🔍 Review ({data.stats.review || 0})
                </button>
                <button
                  className={`m-ktab done ${mobileKanbanStatus === "done" ? "active" : ""}`}
                  onClick={() => setMobileKanbanStatus("done")}
                >
                  ✓ Done ({data.stats.done || 0})
                </button>
              </div>

              <div className="kanban">
                {[
                  ["todo", "Next up", "Waiting to start"],
                  ["in_progress", "Doing now", "Active execution"],
                  ["review", "Review", "Needs boss approval"],
                  ["done", "Done", "Shipped today"],
                ]
                  .filter(([status]) => mobileKanbanStatus === "all" || mobileKanbanStatus === status)
                  .map(([status, title, desc]) => (
                    <KanbanColumn
                      key={status}
                      status={status}
                      title={title}
                      desc={desc}
                      tasks={filteredTasks.filter(t => t.status === status)}
                      onUpdate={updateTask}
                      onResendEmail={resendEmailNotification}
                      onCopyPortalLink={copyPortalLink}
                    />
                  ))}
              </div>
            </section>

            {/* Team Pulse Section */}
            <section className="people-section">
              <div className="section-head compact">
                <div>
                  <div className="eyebrow">TEAM PULSE & PORTAL ACCESS</div>
                  <h2>Team Status & Direct Links</h2>
                </div>
                <span className="muted">{activeTasks.length} open tasks</span>
              </div>

              <div className="people-grid">
                {data.members.map(member => {
                  const mt = data.tasks.filter(t => t.member_id === member.id);
                  const active = mt.find(t => t.status === "in_progress");
                  const next = mt.find(t => t.status === "todo");
                  const now = active || next;

                  return (
                    <div className="person-card" key={member.id}>
                      <div className="person-top">
                        <span className="big-avatar">{member.avatar}</span>
                        <span className={`presence ${active ? "busy" : "free"}`}>
                          {active ? "Working Now" : next ? "Queued" : "Free"}
                        </span>
                      </div>

                      <div className="person-name">{member.name}</div>
                      <div className="person-role">{member.role}</div>
                      <div className="person-task" title={now ? now.title : "No active task"}>
                        {now ? `${active ? "⚡" : "⏳"} ${now.title}` : "☕ No active task"}
                      </div>

                      <div className="person-portal-actions">
                        <button
                          className="portal-link-btn"
                          title="Copy employee portal link"
                          onClick={() => copyPortalLink(member.id)}
                        >
                          <Copy size={13} /> Copy Status Link
                        </button>
                        <button
                          className="portal-preview-btn"
                          title="Preview member dashboard"
                          onClick={() => setPortalMemberId(String(member.id))}
                        >
                          <ExternalLink size={13} /> Open
                        </button>
                      </div>

                      <div className="person-crud-actions">
                        <button
                          className="member-edit-btn"
                          title={`Edit ${member.name}'s details`}
                          onClick={() => handleOpenEditMember(member)}
                        >
                          <Pencil size={13} /> Edit
                        </button>
                        <button
                          className="member-delete-btn"
                          title={`Remove ${member.name} from the office`}
                          onClick={() => setDeletingMember(member)}
                        >
                          <Trash2 size={13} /> Delete
                        </button>
                      </div>

                      <div className="person-footer">
                        <span>{mt.filter(t => t.status === "done").length} done</span>
                        <span>{mt.filter(t => t.status !== "done").length} open</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          </>
        )}

        {/* Empty state if no team members exist */}
        {data.members.length === 0 && !loading && (
          <div className="empty-state">
            <div className="empty-icon"><Sparkles /></div>
            <h3>Your office is empty</h3>
            <p>Load the demo team to see the animated office and task system, or add your real team.</p>
            <div className="empty-actions">
              <button className="primary-btn" onClick={seedDemo}>Load demo office</button>
              <button className="secondary-btn" onClick={handleOpenAddMember}>Add first member</button>
            </div>
          </div>
        )}

        <footer>
          Office Task Hub Operations System &bull; Unified Flask + React Architecture &bull; Built for Peter
        </footer>
      </main>

      {/* Mobile Bottom Navigation Bar */}
      <nav className="mobile-bottom-nav">
        <button
          className={`mob-nav-btn ${activeView === "overview" ? "active" : ""}`}
          onClick={() => setActiveView("overview")}
        >
          <LayoutDashboard size={18} />
          <span>Executive</span>
        </button>

        <button
          className={`mob-nav-btn ${activeView === "who_working" ? "active" : ""}`}
          onClick={() => setActiveView("who_working")}
        >
          <Users size={18} />
          <span>Who's Working</span>
        </button>

        <button
          className="mob-nav-action-btn"
          onClick={() => handleOpenAssignModal()}
          title="Assign a task"
        >
          <Plus size={22} />
        </button>

        <button
          className={`mob-nav-btn ${activeView === "office" ? "active" : ""}`}
          onClick={() => setActiveView("office")}
        >
          <Coffee size={18} />
          <span>Office</span>
        </button>

        <button
          className="mob-nav-btn"
          onClick={() => setModal("email_center")}
        >
          <Mail size={18} />
          <span>Email</span>
        </button>
      </nav>

      {/* MODALS */}
      {modal === "task" && (
        <TaskModal
          members={data.members}
          prefillMemberId={prefilledMemberId}
          onClose={() => setModal(null)}
          onSave={createTask}
        />
      )}

      {modal === "member" && (
        <MemberModal
          member={editingMember}
          onClose={() => { setModal(null); setEditingMember(null); }}
          onSave={payload =>
            editingMember
              ? updateMember(editingMember.id, payload)
              : createMember(payload)
          }
        />
      )}

      {deletingMember && (
        <DeleteMemberModal
          member={deletingMember}
          taskCount={data.tasks.filter(t => t.member_id === deletingMember.id).length}
          onClose={() => setDeletingMember(null)}
          onConfirm={() => deleteMember(deletingMember.id)}
        />
      )}

      {modal === "email_center" && (
        <EmailCenterModal
          onClose={() => setModal(null)}
          onSmtpUpdated={load}
        />
      )}

      {toast && (
        <div className="toast">
          <CheckCircle2 size={17} />
          {toast}
        </div>
      )}

      {loading && (
        <div className="loading-screen">
          <div className="loader" />
          Loading office workspace...
        </div>
      )}
    </div>
  );
}

function Sidebar({
  activeView,
  setActiveView,
  selectedMember,
  setSelectedMember,
  members,
  onAddMember,
  onEditMember,
  onDeleteMember,
  onOpenEmailCenter,
  smtpStatus
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark"><Zap size={20} /></div>
        <div>
          <strong>OFFICE</strong>
          <span>OPERATIONS HUB</span>
        </div>
      </div>

      <div className="side-label">COMMAND ROOM</div>
      <button
        className={`nav-item ${activeView === "overview" && selectedMember === "all" ? "active" : ""}`}
        onClick={() => {
          setActiveView("overview");
          setSelectedMember("all");
        }}
      >
        <LayoutDashboard size={18} /> Executive Floor
      </button>

      <button
        className={`nav-item ${activeView === "who_working" ? "active" : ""}`}
        onClick={() => setActiveView("who_working")}
      >
        <Users size={18} /> Who is Working
      </button>

      <button
        className={`nav-item ${activeView === "office" ? "active" : ""}`}
        onClick={() => setActiveView("office")}
      >
        <Coffee size={18} /> Live Office Scene
      </button>

      <button
        className="nav-item"
        onClick={onOpenEmailCenter}
      >
        <Mail size={18} /> Email Center
        <span className={`soon ${smtpStatus?.configured ? "live-smtp" : "demo-smtp"}`}>
          {smtpStatus?.configured ? "LIVE" : "CONFIG"}
        </span>
      </button>

      <div className="side-label team-label">TEAM MEMBERS</div>
      <div className="side-team">
        {members.slice(0, 8).map(m => (
          <div
            className={`mini-member-wrap ${String(selectedMember) === String(m.id) ? "selected" : ""}`}
            key={m.id}
          >
            <button
              className="mini-member"
              onClick={() => {
                setSelectedMember(String(m.id));
                setActiveView("overview");
              }}
            >
              <span>{m.avatar}</span>
              <div>
                <b>{m.name}</b>
                <small>{m.role}</small>
              </div>
            </button>
            <span className="mini-member-crud">
              <button
                title={`Edit ${m.name}`}
                onClick={() => onEditMember(m)}
              >
                <Pencil size={12} />
              </button>
              <button
                className="danger"
                title={`Delete ${m.name}`}
                onClick={() => onDeleteMember(m)}
              >
                <Trash2 size={12} />
              </button>
            </span>
          </div>
        ))}
      </div>

      <button className="add-member" onClick={onAddMember}>
        <Plus size={15} /> Add team member
      </button>

      <div className="sidebar-bottom">
        <button className="nav-item" onClick={onOpenEmailCenter}>
          <Settings2 size={18} /> Email & Settings
        </button>
        <div className="secure">
          <span /> System operational
        </div>
      </div>
    </aside>
  );
}

function Metric({ icon, label, value, suffix }) {
  return (
    <div className="metric-card">
      <div className="metric-icon">{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}<small>{suffix}</small></strong>
      </div>
    </div>
  );
}

function KanbanColumn({ status, title, desc, tasks, onUpdate, onResendEmail, onCopyPortalLink }) {
  return (
    <div className={`kanban-column ${status}`}>
      <div className="column-head">
        <div>
          <h3>{title}</h3>
          <p>{desc}</p>
        </div>
        <span className="count">{tasks.length}</span>
      </div>
      <div className="task-list">
        {tasks.length === 0 && (
          <div className="column-empty"><Circle size={14} /> Nothing here</div>
        )}
        {tasks.map(t => (
          <TaskCard
            key={t.id}
            task={t}
            onUpdate={onUpdate}
            onResendEmail={onResendEmail}
            onCopyPortalLink={onCopyPortalLink}
          />
        ))}
      </div>
    </div>
  );
}

function TaskCard({ task, onUpdate, onResendEmail, onCopyPortalLink }) {
  const next = { todo: "in_progress", in_progress: "review", review: "done", done: "todo" }[task.status];
  return (
    <div className="task-card">
      <div className="task-card-top">
        <span className={`priority ${task.priority}`}>{task.priority}</span>
        <button
          className="task-email-btn"
          title="Resend assignment email notification"
          onClick={() => onResendEmail(task.id)}
        >
          <Mail size={13} />
        </button>
      </div>

      <h4>{task.title}</h4>
      {task.description && <p>{task.description}</p>}

      {task.notes && (
        <div className="task-notes-snippet">
          <small><b>Employee note:</b> {task.notes}</small>
        </div>
      )}

      <div className="task-meta">
        <span
          className="task-person clickable"
          title="Copy employee status link"
          onClick={() => onCopyPortalLink(task.member_id)}
        >
          {task.member_avatar} {task.member_name}
        </span>
        <span>{task.due_date || "No due date"}</span>
      </div>

      <button className="status-action" onClick={() => onUpdate(task.id, { status: next })}>
        {task.status === "done" ? (
          <><Circle size={14} /> Reopen</>
        ) : (
          <><ChevronDown size={14} /> Move to {next.replace("_", " ")}</>
        )}
      </button>
    </div>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button onClick={onClose}><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function TaskModal({ members, prefillMemberId, onClose, onSave }) {
  const [form, setForm] = useState({
    title: "",
    description: "",
    member_id: prefillMemberId || members[0]?.id || "",
    status: "todo",
    priority: "medium",
    due_date: new Date().toISOString().slice(0, 10),
    send_email: true,
  });

  const change = e => {
    const val = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    setForm({ ...form, [e.target.name]: val });
  };

  return (
    <Modal title="Assign a New Task" onClose={onClose}>
      <form onSubmit={e => { e.preventDefault(); onSave(form); }} className="form">
        <label>
          Task title
          <input
            name="title"
            value={form.title}
            onChange={change}
            required
            placeholder="e.g. Design homepage layout or Review backend API..."
          />
        </label>

        <label>
          Assign To
          <select name="member_id" value={form.member_id} onChange={change} required>
            {members.map(m => (
              <option key={m.id} value={m.id}>
                {m.avatar} {m.name} &bull; {m.role} ({m.email})
              </option>
            ))}
          </select>
        </label>

        <div className="form-row">
          <label>
            Priority
            <select name="priority" value={form.priority} onChange={change}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </label>

          <label>
            Due date
            <input type="date" name="due_date" value={form.due_date} onChange={change} />
          </label>
        </div>

        <label>
          Description & Instructions
          <textarea
            name="description"
            value={form.description}
            onChange={change}
            rows="3"
            placeholder="Add specific instructions, expected outcome, links, or context for the team member..."
          />
        </label>

        <div className="checkbox-row">
          <input
            type="checkbox"
            id="send_email"
            name="send_email"
            checked={form.send_email}
            onChange={change}
          />
          <label htmlFor="send_email" className="checkbox-label">
            ✉️ Send task assignment email notification with direct portal link
          </label>
        </div>

        <button className="primary-btn full" type="submit">
          <Zap size={16} /> Assign Task & Dispatch Email
        </button>
      </form>
    </Modal>
  );
}

function MemberModal({ member, onClose, onSave }) {
  const isEdit = Boolean(member);
  const [form, setForm] = useState({
    name: member?.name || "",
    email: member?.email || "",
    role: member?.role ?? "Team Member",
    avatar: member?.avatar || "👨‍💻",
  });
  const change = e => setForm({ ...form, [e.target.name]: e.target.value });

  return (
    <Modal title={isEdit ? `Edit ${member.name}` : "Add Team Member"} onClose={onClose}>
      <form onSubmit={e => { e.preventDefault(); onSave(form); }} className="form">
        <label>
          Full Name
          <input name="name" value={form.name} onChange={change} required placeholder="e.g. Alex Johnson" />
        </label>

        <label>
          Email Address
          <input
            type="email"
            name="email"
            value={form.email}
            onChange={change}
            required
            placeholder="alex@company.com"
          />
        </label>

        <label>
          Role / Department
          <input
            name="role"
            value={form.role}
            onChange={change}
            placeholder="Full Stack Developer, UI Designer, QA..."
          />
        </label>

        <label>
          Avatar Emoji
          <input name="avatar" value={form.avatar} onChange={change} maxLength="4" placeholder="👨‍💻" />
        </label>

        <button className="primary-btn full" type="submit">
          {isEdit ? (
            <><Check size={16} /> Save Changes</>
          ) : (
            <><Users size={16} /> Add to Office & Enable Status Portal</>
          )}
        </button>
      </form>
    </Modal>
  );
}

function DeleteMemberModal({ member, taskCount, onClose, onConfirm }) {
  return (
    <Modal title="Remove Team Member" onClose={onClose}>
      <div className="confirm-body">
        <div className="confirm-icon"><AlertTriangle size={22} /></div>
        <p>
          Remove <b>{member.name}</b> (<i>{member.email}</i>) from the office?
        </p>
        {taskCount > 0 && (
          <p className="confirm-warn">
            <UserX size={14} />
            Their {taskCount} assigned task{taskCount === 1 ? "" : "s"} will be permanently deleted too.
          </p>
        )}
      </div>
      <div className="confirm-actions">
        <button className="secondary-btn" onClick={onClose}>Cancel</button>
        <button className="danger-btn" onClick={onConfirm}>
          <Trash2 size={15} /> Delete Member
        </button>
      </div>
    </Modal>
  );
}

createRoot(document.getElementById("root")).render(<App />);
