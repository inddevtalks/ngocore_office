import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Bell, CalendarDays, CheckCircle2, ChevronDown, Circle,
  Clock3, Coffee, LayoutDashboard, Mail, MoreHorizontal,
  Plus, Search, Settings2, Sparkles, Users, X, Zap,
  ExternalLink, Copy, Check, Send, Eye, Shield, Menu,
  Pencil, Trash2, AlertTriangle, UserX, Undo2, UserCog, LogOut
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
    credentials: "same-origin",
    ...options,
  });

  if (res.status === 401) {
    const data = await res.json().catch(() => ({}));
    if (data.auth_required) {
      const err = new Error(data.error || "Manager sign-in required.");
      err.authRequired = true;
      throw err;
    }
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

function App() {
  const [data, setData] = useState({ members: [], tasks: [], stats: {}, smtp_status: {} });
  const [loading, setLoading] = useState(true);
  const [authState, setAuthState] = useState({ checked: false, enabled: false, authenticated: false });
  const [activeView, setActiveView] = useState("overview"); // 'overview', 'who_working', 'office', 'completed'
  const [selectedMember, setSelectedMember] = useState("all");
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState(null); // 'task', 'member', 'email_center'
  const [editingMember, setEditingMember] = useState(null);
  const [deletingMember, setDeletingMember] = useState(null);
  const [editingTask, setEditingTask] = useState(null);
  const [portalTask, setPortalTask] = useState(null);
  const [prefilledMemberId, setPrefilledMemberId] = useState(null);
  const [toast, setToast] = useState("");
  // Read during the first render, not in an effect. Otherwise an employee
  // following their own link sees a flash of the manager sign-in screen
  // before the portal takes over.
  const [portalMemberId, setPortalMemberId] = useState(
    () => new URLSearchParams(window.location.search).get("portal")
  );
  // True when the manager opened a portal from the dashboard rather than an
  // employee following their own share link.
  const [portalPreview, setPortalPreview] = useState(false);
  const [mobileKanbanStatus, setMobileKanbanStatus] = useState("all"); // 'all', 'todo', 'in_progress', 'review', 'done'
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Employees arriving on ?portal=<id> never need the manager dashboard, so
  // skip the auth check entirely for them.
  useEffect(() => {
    if (portalMemberId) return;
    load();
  }, [portalMemberId]);

  function openPortalPreview(id) {
    setPortalMemberId(String(id));
    setPortalPreview(true);
  }

  function closePortal() {
    const url = new URL(window.location.href);
    url.searchParams.delete("portal");
    window.history.pushState({}, "", url.toString());
    setPortalMemberId(null);
    setPortalPreview(false);
  }

  async function checkAuth() {
    try {
      const res = await fetch(`${API}/api/auth/status`, {
        credentials: "same-origin",
      });
      const json = await res.json();
      setAuthState({ checked: true, enabled: !!json.enabled, authenticated: !!json.authenticated });

      // When auth is switched off entirely (local dev), treat as signed in so
      // the sign-in screen never appears for a setup that has no password.
      if (!json.enabled) {
        setAuthState({ checked: true, enabled: false, authenticated: true });
      }
      return json.authenticated || !json.enabled;
    } catch {
      setAuthState({ checked: true, enabled: true, authenticated: false });
      return false;
    }
  }

  async function load() {
    // A portal visitor is never the manager, so don't demand a sign-in.
    const ok = portalMemberId ? false : await checkAuth();
    if (!ok) {
      if (portalMemberId) {
        // Portal members never load the dashboard payload.
        setLoading(false);
      }
      return;
    }
    try {
      setLoading(true);
      const dashboard = await api("/api/dashboard");
      setData(dashboard);
    } catch (e) {
      if (e.authRequired) {
        setAuthState(prev => ({ ...prev, authenticated: false }));
        return;
      }
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

  // Done tasks live in their own view, so the working board shows only live work.
  const completedTasks = useMemo(
    () => data.tasks.filter(t => t.status === "done"),
    [data.tasks]
  );

  const activeTasks = useMemo(
    () => data.tasks.filter(t => t.status !== "done"),
    [data.tasks]
  );

  const filteredTasks = useMemo(() => {
    return activeTasks.filter(t => {
      const memberOk = selectedMember === "all" || String(t.member_id) === String(selectedMember);
      const searchOk = !search || `${t.title} ${t.description} ${t.member_name}`.toLowerCase().includes(search.toLowerCase());
      const statusOk = mobileKanbanStatus === "all" || t.status === mobileKanbanStatus;
      return memberOk && searchOk && statusOk;
    });
  }, [activeTasks, selectedMember, search, mobileKanbanStatus]);

  // Any 401 from a manager endpoint drops straight back to the sign-in screen
  // instead of showing a raw error.
  function handleAuthLoss() {
    setAuthState(prev => ({ ...prev, authenticated: false }));
  }

  async function updateTask(id, patch) {
    try {
      await api(`/api/tasks/${id}`, { method: "PUT", body: JSON.stringify(patch) });
      await load();
      showToast("Task updated");
    } catch (e) {
      if (e.authRequired) return handleAuthLoss();
      showToast(e.message);
    }
  }

  async function logout() {
    try {
      await fetch(`${API}/api/auth/logout`, { method: "POST", credentials: "same-origin" });
    } catch {
      // Even if the call fails, clear local state so the UI locks.
    }
    setAuthState({ checked: true, enabled: true, authenticated: false });
    setData({ members: [], tasks: [], stats: {}, smtp_status: {} });
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
      if (e.authRequired) return handleAuthLoss();
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

  async function deleteTask(taskId) {
    try {
      await api(`/api/tasks/${taskId}`, { method: "DELETE" });
      await load();
      if (portalTask) setPortalTask(null);
      showToast("Task deleted");
    } catch (e) {
      if (e.authRequired) return handleAuthLoss();
      showToast(e.message);
    }
  }

  async function updateTaskFull(taskId, payload) {
    try {
      const res = await api(`/api/tasks/${taskId}`, { method: "PUT", body: JSON.stringify(payload) });
      await load();
      setEditingTask(null);
      const emailNotice = res.email_result?.message ? ` & ${res.email_result.message}` : "";
      showToast(
        res.reassigned
          ? `Task reassigned to ${res.member_name}${emailNotice}`
          : "Task updated"
      );
      return res;
    } catch (e) {
      if (e.authRequired) return handleAuthLoss();
      showToast(e.message);
      return null;
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
        previewMode={portalPreview}
        onBackToManager={closePortal}
      />
    );
  }

  // Manager sign-in gate. Employee portal links above stay reachable without it.
  if (!authState.authenticated && !portalMemberId) {
    return (
      <LoginScreen
        enabled={authState.enabled}
        checked={authState.checked}
        onSuccess={() => {
          setAuthState(prev => ({ ...prev, authenticated: true }));
          load();
        }}
      />
    );
  }

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
        onLogout={authState.enabled ? logout : null}
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
          <button
            className={`view-tab completed-tab ${activeView === "completed" ? "active" : ""}`}
            onClick={() => setActiveView("completed")}
          >
            <CheckCircle2 size={16} /> Completed
            <span className="tab-badge">{completedTasks.length}</span>
          </button>
        </div>

        {/* VIEW: COMPLETED TASKS */}
        {activeView === "completed" && (
          <CompletedView
            tasks={completedTasks}
            search={search}
            onSearch={setSearch}
            onEdit={setEditingTask}
            onDelete={setPortalTask}
            onRestore={(t) => updateTask(t.id, { status: "todo" })}
            onCopyPortalLink={copyPortalLink}
            onResendEmail={resendEmailNotification}
          />
        )}

        {/* VIEW 1: WHO IS WORKING ON WHAT */}
        {activeView === "who_working" && (
          <WhoIsWorking
            members={data.members}
            tasks={data.tasks}
            onAssignTask={handleOpenAssignModal}
            onOpenPortal={openPortalPreview}
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
                  className={`m-ktab done ${activeView === "completed" ? "active" : ""}`}
                  onClick={() => setActiveView("completed")}
                >
                  ✓ Done ({completedTasks.length})
                </button>
              </div>

              <div className="kanban">
                {[
                  ["todo", "Next up", "Waiting to start"],
                  ["in_progress", "Doing now", "Active execution"],
                  ["review", "Review", "Needs boss approval"],
                ].map(([status, title, desc]) => (
                    <KanbanColumn
                      key={status}
                      status={status}
                      title={title}
                      desc={desc}
                      tasks={filteredTasks.filter(t => t.status === status)}
                      onUpdate={updateTask}
                      onResendEmail={resendEmailNotification}
                      onCopyPortalLink={copyPortalLink}
                      onEdit={setEditingTask}
                      onDelete={setPortalTask}
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
                          onClick={() => openPortalPreview(member.id)}
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

      {editingTask && (
        <EditTaskModal
          task={editingTask}
          members={data.members}
          onClose={() => setEditingTask(null)}
          onSave={updateTaskFull}
          onDelete={(t) => {
            setEditingTask(null);
            setPortalTask(t);
          }}
        />
      )}

      {portalTask && (
        <DeleteTaskModal
          task={portalTask}
          onClose={() => setPortalTask(null)}
          onConfirm={() => deleteTask(portalTask.id)}
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

function LoginScreen({ enabled, checked, onSuccess }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ password }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || "Sign-in failed.");
        return;
      }
      onSuccess();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <div className="brand-mark"><Zap size={22} /></div>
          <strong>NGOCORE OFFICE</strong>
          <span>MANAGER SIGN-IN</span>
        </div>

        <h1>Operations Control Room</h1>
        <p className="login-sub">
          This dashboard holds your full team and task list. Enter the manager password to continue.
        </p>

        <label>
          Manager Password
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Enter your password"
            autoFocus
            required
          />
        </label>

        {error && <div className="login-error">{error}</div>}

        <button className="primary-btn full" type="submit" disabled={busy}>
          <Shield size={16} /> {busy ? "Signing in..." : "Unlock Dashboard"}
        </button>

        <p className="login-hint">
          Team members do not need this. They use their own portal link, which looks like{" "}
          <code>?portal=1</code>.
        </p>

        {!enabled && checked && (
          <p className="login-note">
            No ADMIN_PASSWORD is configured, so sign-in is currently disabled.
          </p>
        )}
      </form>
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
  onLogout,
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
        className={`nav-item ${activeView === "completed" ? "active" : ""}`}
        onClick={() => {
          setActiveView("completed");
          setSelectedMember("all");
        }}
      >
        <CheckCircle2 size={18} /> Completed Tasks
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
        {onLogout && (
          <button className="nav-item" onClick={onLogout} title="Sign out of the manager dashboard">
            <LogOut size={18} /> Sign Out
          </button>
        )}
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

function KanbanColumn({
  status, title, desc, tasks,
  onUpdate, onResendEmail, onCopyPortalLink, onEdit, onDelete
}) {
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
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}
      </div>
    </div>
  );
}

function TaskCard({ task, onUpdate, onResendEmail, onCopyPortalLink, onEdit, onDelete }) {
  const next = { todo: "in_progress", in_progress: "review", review: "done" }[task.status];
  return (
    <div className="task-card">
      <div className="task-card-top">
        <span className={`priority ${task.priority}`}>{task.priority}</span>
        <span className="task-card-tools">
          {onEdit && (
            <button
              className="task-tool-btn"
              title="Edit this task"
              onClick={() => onEdit(task)}
            >
              <Pencil size={13} />
            </button>
          )}
          {onDelete && (
            <button
              className="task-tool-btn danger"
              title="Delete this task"
              onClick={() => onDelete(task)}
            >
              <Trash2 size={13} />
            </button>
          )}
          <button
            className="task-email-btn"
            title="Resend assignment email notification"
            onClick={() => onResendEmail(task.id)}
          >
            <Mail size={13} />
          </button>
        </span>
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
        <ChevronDown size={14} /> Move to {next.replace("_", " ")}
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

function EditTaskModal({ task, members, onClose, onSave, onDelete }) {
  const [form, setForm] = useState({
    title: task.title || "",
    description: task.description || "",
    member_id: task.member_id,
    status: task.status,
    priority: task.priority,
    due_date: task.due_date || "",
    notify_reassign: true,
  });
  const [busy, setBusy] = useState(false);
  const isReassigning = String(form.member_id) !== String(task.member_id);

  const change = e => {
    const val = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    setForm({ ...form, [e.target.name]: val });
  };

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    await onSave(task.id, {
      title: form.title,
      description: form.description,
      member_id: Number(form.member_id),
      status: form.status,
      priority: form.priority,
      due_date: form.due_date || null,
      notify_reassign: form.notify_reassign,
    });
    setBusy(false);
  }

  const assignee = members.find(m => m.id === Number(form.member_id));

  return (
    <Modal title="Edit Task" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <label>
          Task title
          <input name="title" value={form.title} onChange={change} required />
        </label>

        <label>
          Assigned To
          <select name="member_id" value={form.member_id} onChange={change}>
            {members.map(m => (
              <option key={m.id} value={m.id}>
                {m.avatar} {m.name} &bull; {m.role} ({m.email})
              </option>
            ))}
          </select>
        </label>

        {isReassigning && (
          <div className="reassign-notice">
            <UserCog size={14} />
            <span>
              Reassigning to <b>{assignee?.name}</b>. Their portal link and task list update immediately.
            </span>
          </div>
        )}

        <div className="form-row">
          <label>
            Status
            <select name="status" value={form.status} onChange={change}>
              <option value="todo">Yet to Start</option>
              <option value="in_progress">In Progress</option>
              <option value="review">Submit for Review</option>
              <option value="done">Completed</option>
            </select>
          </label>

          <label>
            Priority
            <select name="priority" value={form.priority} onChange={change}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </label>
        </div>

        <label>
          Due date
          <input type="date" name="due_date" value={form.due_date || ""} onChange={change} />
        </label>

        <label>
          Description &amp; Instructions
          <textarea name="description" value={form.description} onChange={change} rows="3" />
        </label>

        {isReassigning && (
          <div className="checkbox-row">
            <input
              type="checkbox"
              id="notify_reassign"
              name="notify_reassign"
              checked={form.notify_reassign}
              onChange={change}
            />
            <label htmlFor="notify_reassign" className="checkbox-label">
              ✉️ Email {assignee?.name} about this reassignment
            </label>
          </div>
        )}

        <div className="form-actions-row">
          <button
            type="button"
            className="secondary-btn danger-outline"
            onClick={() => onDelete(task)}
          >
            <Trash2 size={15} /> Delete
          </button>
          <button className="primary-btn" type="submit" disabled={busy}>
            <Check size={16} /> {busy ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteTaskModal({ task, onClose, onConfirm }) {
  return (
    <Modal title="Delete Task" onClose={onClose}>
      <div className="confirm-body">
        <div className="confirm-icon"><AlertTriangle size={22} /></div>
        <p>
          Permanently delete <b>{task.title}</b>?
        </p>
        <p className="confirm-warn">
          <Trash2 size={14} />
          This cannot be undone. If you only want it off the active board, mark it Completed instead.
        </p>
      </div>
      <div className="confirm-actions">
        <button className="secondary-btn" onClick={onClose}>Cancel</button>
        <button className="danger-btn" onClick={onConfirm}>
          <Trash2 size={15} /> Delete Task
        </button>
      </div>
    </Modal>
  );
}

function CompletedView({
  tasks, search, onSearch,
  onEdit, onDelete, onRestore, onCopyPortalLink, onResendEmail
}) {
  const visible = tasks.filter(t =>
    !search || `${t.title} ${t.description} ${t.member_name}`.toLowerCase().includes(search.toLowerCase())
  );

  const byMember = visible.reduce((acc, t) => {
    const key = t.member_name || "Unassigned";
    (acc[key] = acc[key] || []).push(t);
    return acc;
  }, {});

  return (
    <section className="completed-view">
      <div className="section-head">
        <div>
          <div className="eyebrow">ARCHIVE</div>
          <h2>Completed Tasks</h2>
          <p>Everything your team has finished. Reopen a task to send it back to the board.</p>
        </div>
        <div className="search">
          <Search size={16} />
          <input
            value={search}
            onChange={e => onSearch(e.target.value)}
            placeholder="Search completed tasks..."
          />
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="column-empty completed-empty">
          <CheckCircle2 size={16} />
          {search ? "No completed tasks match that search." : "Nothing completed yet. Finished tasks land here automatically."}
        </div>
      ) : (
        Object.entries(byMember).map(([memberName, list]) => (
          <div key={memberName} className="completed-group">
            <div className="completed-group-head">
              <span>{memberName}</span>
              <span className="queue-count">{list.length} done</span>
            </div>
            <div className="completed-list">
              {list.map(t => (
                <div key={t.id} className="completed-row">
                  <span className="completed-check"><CheckCircle2 size={15} /></span>
                  <div className="completed-main">
                    <strong>{t.title}</strong>
                    <div className="completed-meta">
                      <span className={`priority ${t.priority}`}>{t.priority}</span>
                      <span>Due {t.due_date || "n/a"}</span>
                      {t.updated_at && <span>Closed {String(t.updated_at).slice(0, 10)}</span>}
                    </div>
                    {t.notes && <div className="completed-note">"{t.notes}"</div>}
                  </div>
                  <div className="completed-actions">
                    <button
                      className="member-edit-btn"
                      title="Reopen and put back on the board"
                      onClick={() => onRestore(t)}
                    >
                      <Undo2 size={13} /> Reopen
                    </button>
                    <button
                      className="member-edit-btn"
                      title="Edit this task"
                      onClick={() => onEdit(t)}
                    >
                      <Pencil size={13} /> Edit
                    </button>
                    <button
                      className="member-delete-btn"
                      title="Delete permanently"
                      onClick={() => onDelete(t)}
                    >
                      <Trash2 size={13} /> Delete
                    </button>
                    <button
                      className="member-edit-btn"
                      title="Copy employee portal link"
                      onClick={() => onCopyPortalLink(t.member_id)}
                    >
                      <Copy size={13} />
                    </button>
                    <button
                      className="member-edit-btn"
                      title="Resend assignment email"
                      onClick={() => onResendEmail(t.id)}
                    >
                      <Mail size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </section>
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
