import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Bell, CalendarDays, CheckCircle2, ChevronDown, Circle,
  Clock3, Coffee, LayoutDashboard, Mail, MoreHorizontal,
  Plus, Search, Settings2, Sparkles, Users, X, Zap,
  ExternalLink, Copy, Check, Send, Eye, Shield, Menu,
  Pencil, Trash2, AlertTriangle, UserX, Undo2, UserCog, LogOut, ListChecks,
  ShieldCheck, RefreshCw, GitCompare, Download, ShieldAlert,
  Bot, Mic, Square, Info, Volume2, VolumeX
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

const MORE_SECTIONS = [
  { view: "tasks", label: "All Tasks", icon: <ListChecks size={20} /> },
  { view: "qa", label: "Site QA", icon: <ShieldCheck size={20} /> },
  { view: "security", label: "Security", icon: <ShieldAlert size={20} /> },
  { view: "completed", label: "Completed", icon: <CheckCircle2 size={20} /> },
  { view: "office", label: "Office Scene", icon: <Coffee size={20} /> },
  { view: "who_working", label: "Who's Working", icon: <Users size={20} /> },
];

function App() {
  const [data, setData] = useState({ members: [], tasks: [], stats: {}, smtp_status: {} });
  const [loading, setLoading] = useState(true);
  const [authState, setAuthState] = useState({
    checked: false, enabled: false, authenticated: false, passwordSource: "environment",
  });
  const [activeView, setActiveView] = useState("overview"); // 'overview', 'who_working', 'office', 'completed'
  const [selectedMember, setSelectedMember] = useState("all");
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState(null); // 'task', 'member', 'email_center'
  const [editingMember, setEditingMember] = useState(null);
  const [deletingMember, setDeletingMember] = useState(null);
  const [editingTask, setEditingTask] = useState(null);
  const [portalTask, setPortalTask] = useState(null);
  const [taskMemberFilter, setTaskMemberFilter] = useState("all");
  const [taskStatusFilter, setTaskStatusFilter] = useState("all");
  const [securityOpen, setSecurityOpen] = useState(false);
  // What Jarvis greets you by, editable from the Security panel.
  const [managerName, setManagerName] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);

  // Tells the stylesheet that the More sheet is up, so the floating Jarvis
  // button and greeting step out of its way instead of overlapping it.
  useEffect(() => {
    document.body.classList.toggle("more-open", moreOpen);
    return () => document.body.classList.remove("more-open");
  }, [moreOpen]);
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
      setAuthState({
        checked: true,
        enabled: !!json.enabled,
        authenticated: !!json.authenticated,
        passwordSource: json.password_source || "environment",
      });

      // When auth is switched off entirely (local dev), treat as signed in so
      // the sign-in screen never appears for a setup that has no password.
      if (!json.enabled) {
        setAuthState(prev => ({ ...prev, checked: true, enabled: false, authenticated: true }));
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
    setAuthState(prev => ({ ...prev, checked: true, enabled: true, authenticated: false }));
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
        onOpenSecurity={authState.enabled ? () => setSecurityOpen(true) : null}
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
            className={`view-tab ${activeView === "tasks" ? "active" : ""}`}
            onClick={() => setActiveView("tasks")}
          >
            <ListChecks size={16} /> All Tasks
            <span className="tab-badge">{data.tasks.length}</span>
          </button>
          <button
            className={`view-tab ${activeView === "qa" ? "active" : ""}`}
            onClick={() => setActiveView("qa")}
          >
            <ShieldCheck size={16} /> Site QA
          </button>
          <button
            className={`view-tab ${activeView === "security" ? "active" : ""}`}
            onClick={() => setActiveView("security")}
          >
            <ShieldAlert size={16} /> Security
          </button>
          <button
            className={`view-tab ${activeView === "mail" ? "active" : ""}`}
            onClick={() => setActiveView("mail")}
          >
            <Mail size={16} /> Mail
          </button>
          <button
            className={`view-tab completed-tab ${activeView === "completed" ? "active" : ""}`}
            onClick={() => setActiveView("completed")}
          >
            <CheckCircle2 size={16} /> Completed
            <span className="tab-badge">{completedTasks.length}</span>
          </button>
        </div>

        {/* VIEW: SITE QA BOT */}
        {activeView === "qa" && (
          <SiteQaView onToast={showToast} onAuthLoss={handleAuthLoss} />
        )}

        {/* VIEW: SECURITY ANALYST */}
        {activeView === "security" && (
          <SecurityView onToast={showToast} onAuthLoss={handleAuthLoss} />
        )}

        {/* VIEW: MAIL */}
        {activeView === "mail" && (
          <MailView onToast={showToast} onAuthLoss={handleAuthLoss} />
        )}

        {/* VIEW: ALL TASKS REGISTER */}
        {activeView === "tasks" && (
          <AllTasksView
            tasks={data.tasks}
            members={data.members}
            search={search}
            onSearch={setSearch}
            memberFilter={taskMemberFilter}
            onMemberFilter={setTaskMemberFilter}
            statusFilter={taskStatusFilter}
            onStatusFilter={setTaskStatusFilter}
            onEdit={setEditingTask}
            onDelete={setPortalTask}
            onAdvance={(t, next) => updateTask(t.id, { status: next })}
            onCopyPortalLink={copyPortalLink}
            onResendEmail={resendEmailNotification}
          />
        )}

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
          className={`mob-nav-btn ${activeView === "mail" ? "active" : ""}`}
          onClick={() => setActiveView("mail")}
        >
          <Mail size={18} />
          <span>Mail</span>
        </button>

        <button
          className={`mob-nav-btn ${moreOpen ? "active" : ""}`}
          onClick={() => setMoreOpen(!moreOpen)}
          aria-label="More sections"
        >
          <Menu size={18} />
          <span>More</span>
        </button>
      </nav>

      {/* Everything that does not fit in the bottom bar */}
      {moreOpen && (
        <>
          <div className="more-sheet-backdrop" onClick={() => setMoreOpen(false)} />
          <div className="more-sheet">
            <div className="more-sheet-head">
              <strong>All sections</strong>
              <button className="close-btn" onClick={() => setMoreOpen(false)}>
                <X size={17} />
              </button>
            </div>
            <div className="more-sheet-grid">
              {MORE_SECTIONS.map(s => (
                <button
                  key={s.view}
                  className={activeView === s.view ? "active" : ""}
                  onClick={() => {
                    setActiveView(s.view);
                    setSelectedMember("all");
                    setMoreOpen(false);
                  }}
                >
                  {s.icon}
                  <span>{s.label}</span>
                </button>
              ))}
            </div>
            <button
              className="more-sheet-email"
              onClick={() => { setModal("email_center"); setMoreOpen(false); }}
            >
              <Mail size={16} /> Email &amp; Outbox
            </button>
          </div>
        </>
      )}

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

      {securityOpen && (
        <SecurityModal
          passwordSource={authState.passwordSource}
          managerName={managerName}
          onSaved={setManagerName}
          onClose={() => setSecurityOpen(false)}
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

      <JarvisPanel
        onToast={showToast}
        onAuthLoss={handleAuthLoss}
        setActiveView={setActiveView}
        data={data}
        openAssign={handleOpenAssignModal}
        editTask={setEditingTask}
        copyPortal={copyPortalLink}
        managerName={managerName}
      />

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
  onOpenSecurity,
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
        className={`nav-item ${activeView === "qa" ? "active" : ""}`}
        onClick={() => {
          setActiveView("qa");
          setSelectedMember("all");
        }}
      >
        <ShieldCheck size={18} /> Site QA
      </button>

      <button
        className={`nav-item ${activeView === "security" ? "active" : ""}`}
        onClick={() => {
          setActiveView("security");
          setSelectedMember("all");
        }}
      >
        <ShieldAlert size={18} /> Security Analyst
      </button>

      <button
        className={`nav-item ${activeView === "mail" ? "active" : ""}`}
        onClick={() => {
          setActiveView("mail");
          setSelectedMember("all");
        }}
      >
        <Mail size={18} /> Mail
      </button>

      <button
        className={`nav-item ${activeView === "tasks" ? "active" : ""}`}
        onClick={() => {
          setActiveView("tasks");
          setSelectedMember("all");
        }}
      >
        <ListChecks size={18} /> All Tasks
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
        {onOpenSecurity && (
          <button className="nav-item" onClick={onOpenSecurity}>
            <Shield size={18} /> Security
          </button>
        )}
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

function SecurityModal({ passwordSource, managerName, onSaved, onClose }) {
  const [form, setForm] = useState({
    current_password: "",
    new_password: "",
    confirm_password: "",
  });
  const [name, setName] = useState(managerName || "");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [errors, setErrors] = useState({});

  const change = e => setForm({ ...form, [e.target.name]: e.target.value });

  // Saved on its own so the manager does not have to re-enter their password
  // just to tell Jarvis what to call them.
  async function saveName() {
    const trimmed = name.trim();
    if (trimmed === (managerName || "")) return;
    try {
      const res = await fetch(`${API}/api/manager/profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) throw new Error("Could not save your name.");
      onSaved(trimmed);
      setResult({ ok: true, message: `Jarvis will call you ${trimmed}.` });
    } catch (err) {
      setResult({ ok: false, message: err.message });
    }
  }

  async function submit(e) {
    e.preventDefault();
    setErrors({});

    if (!form.current_password) {
      setErrors({ current_password: "Enter your current password." });
      return;
    }
    if (form.new_password.length < 8) {
      setErrors({ new_password: "Use at least 8 characters." });
      return;
    }
    if (form.new_password !== form.confirm_password) {
      setErrors({ confirm_password: "Passwords do not match." });
      return;
    }

    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(`${API}/api/auth/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(form),
      });
      const json = await res.json();
      if (!res.ok) {
        setResult({ ok: false, message: json.error || "Could not update the password." });
        return;
      }
      setResult({ ok: true, message: json.message });
      setForm({ current_password: "", new_password: "", confirm_password: "" });
    } catch (err) {
      setResult({ ok: false, message: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Security" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <label>
          What Jarvis calls you
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            onBlur={saveName}
            placeholder="Your first name is enough"
          />
          <span className="field-hint">
            Used for the greeting when you open the office. Leave it blank and Jarvis
            just says hello without a name.
          </span>
        </label>

        <div className="security-banner">
          <Shield size={16} />
          <div>
            <strong>Manager password</strong>
            <p>
              {passwordSource === "database"
                ? "Currently using the password you saved on this page."
                : "Currently using the ADMIN_PASSWORD environment variable. Saving a password here takes over from it."}
            </p>
          </div>
        </div>

        <label>
          Current password
          <div className="password-input">
            <input
              type={show ? "text" : "password"}
              name="current_password"
              value={form.current_password}
              onChange={change}
              required
              placeholder="Your current password"
            />
            <button type="button" onClick={() => setShow(!show)}>
              <Eye size={15} />
            </button>
          </div>
          {errors.current_password && <span className="field-error">{errors.current_password}</span>}
        </label>

        <label>
          New password
          <input
            type={show ? "text" : "password"}
            name="new_password"
            value={form.new_password}
            onChange={change}
            required
            minLength={8}
            placeholder="At least 8 characters"
          />
          {errors.new_password && <span className="field-error">{errors.new_password}</span>}
        </label>

        <label>
          Confirm new password
          <input
            type={show ? "text" : "password"}
            name="confirm_password"
            value={form.confirm_password}
            onChange={change}
            required
            placeholder="Repeat the new password"
          />
          {errors.confirm_password && <span className="field-error">{errors.confirm_password}</span>}
        </label>

        {result && (
          <div className={`test-feedback ${result.ok ? "success" : "error"}`}>
            {result.ok ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
            <span>{result.message}</span>
          </div>
        )}

        <button className="primary-btn full" type="submit" disabled={busy}>
          <Shield size={16} /> {busy ? "Updating..." : "Update Password"}
        </button>

        <p className="login-hint">
          Team members do not use this password. Their access is through their own portal link.
        </p>
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

const STATUS_META = {
  todo: { label: "Yet to Start", short: "To Do" },
  in_progress: { label: "In Progress", short: "Doing" },
  review: { label: "In Review", short: "Review" },
  done: { label: "Completed", short: "Done" },
};

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

function SiteQaView({ onToast, onAuthLoss }) {
  const [status, setStatus] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [expanded, setExpanded] = useState(false);

  async function load() {
    try {
      setLoading(true);
      const [s, h] = await Promise.all([api("/api/qa/status"), api("/api/qa/history")]);
      setStatus(s);
      setHistory(h.runs || []);
    } catch (e) {
      if (e.authRequired) return onAuthLoss();
      onToast(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function runNow() {
    try {
      setRunning(true);
      await api("/api/qa/check", { method: "POST" });
      await load();
      onToast("QA check finished");
    } catch (e) {
      if (e.authRequired) return onAuthLoss();
      onToast(e.message);
    } finally {
      setRunning(false);
    }
  }

  if (loading) {
    return (
      <div className="qa-loading">
        <div className="loader" />
        <p>Loading QA results...</p>
      </div>
    );
  }

  const run = status?.run;
  const siteUrl = status?.site_url || history.site_url;
  const issues = [...(run?.issues || [])].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3)
  );

  return (
    <section className="qa-view">
      <div className="section-head">
        <div>
          <div className="eyebrow">AUTOMATED QUALITY ASSURANCE</div>
          <h2>Site QA</h2>
          <p>
            Every day this checks {siteUrl} for downtime, broken links and assets,
            slow pages, SEO problems and accessibility gaps. Press the button to
            run it now.
          </p>
        </div>
        <div className="workspace-actions">
          <a className="secondary-btn" href={siteUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={15} /> Open Site
          </a>
          {run && (
            <a className="secondary-btn" href={`${API}/api/qa/report.pdf`}>
              <Download size={15} /> Export PDF
            </a>
          )}
          <button className="primary-btn" onClick={runNow} disabled={running}>
            <RefreshCw size={15} className={running ? "spin" : ""} />
            {running ? "Checking..." : "Run Check Now"}
          </button>
        </div>
      </div>

      {!run ? (
        <div className="qa-empty">
          <ShieldCheck size={34} />
          <h3>No check has run yet</h3>
          <p>Press Run Check Now to scan the site, or wait for the daily scheduled run.</p>
        </div>
      ) : (
        <>
          <div className={`qa-hero ${run.status}`}>
            <div className="qa-hero-left">
              <span className={`qa-status-pill ${run.status}`}>
                {run.status === "healthy" && "Healthy"}
                {run.status === "warning" && "Warnings"}
                {run.status === "critical" && "Critical"}
                {run.status === "inconclusive" && "Scan Incomplete"}
              </span>
              <h3>{run.summary}</h3>
              <div className="qa-hero-meta">
                <span>Checked {new Date(run.checked_at).toLocaleString()}</span>
                <span className="dot-sep">&bull;</span>
                <span className={`trigger-tag ${run.trigger}`}>
                  {run.trigger === "manual" ? "Run by you" : "Scheduled"}
                </span>
              </div>
            </div>
            <div className="qa-hero-stats">
              <div className="qa-stat">
                <span className="qa-stat-val good">{run.homepage_status || "down"}</span>
                <span className="qa-stat-lbl">Homepage</span>
              </div>
              <div className="qa-stat">
                <span className="qa-stat-val">{run.response_ms}ms</span>
                <span className="qa-stat-lbl">Response</span>
              </div>
              <div className="qa-stat">
                <span className="qa-stat-val">{run.pages.length}</span>
                <span className="qa-stat-lbl">Pages</span>
              </div>
              <div className="qa-stat">
                <span className="qa-stat-val">{run.assets.length}</span>
                <span className="qa-stat-lbl">Assets</span>
              </div>
              <div className="qa-stat">
                <span className="qa-stat-val danger">{run.critical_count}</span>
                <span className="qa-stat-lbl">Critical</span>
              </div>
              <div className="qa-stat">
                <span className="qa-stat-val warn">{run.warning_count}</span>
                <span className="qa-stat-lbl">Warnings</span>
              </div>
            </div>
          </div>

          {(run.content_added?.length > 0 || run.content_removed?.length > 0) && (
            <div className="qa-content-change">
              <h4><GitCompare size={15} /> Homepage copy changed since the last check</h4>
              {run.content_added?.slice(0, 5).map((line, i) => (
                <div key={`a${i}`} className="qa-diff added">+ {line}</div>
              ))}
              {run.content_removed?.slice(0, 5).map((line, i) => (
                <div key={`r${i}`} className="qa-diff removed">- {line}</div>
              ))}
            </div>
          )}

          <div className="qa-panel">
            <div className="qa-panel-head">
              <h4>Findings ({issues.length})</h4>
            </div>
            {issues.length === 0 ? (
              <div className="qa-no-issues">
                <CheckCircle2 size={16} /> Nothing to fix. Everything passed.
              </div>
            ) : (
              <div className="qa-issues">
                {issues.map((issue, i) => (
                  <div key={i} className={`qa-issue ${issue.severity}`}>
                    <span className="qa-sev">{issue.severity}</span>
                    <span className="qa-cat">{issue.category}</span>
                    <span className="qa-msg">{issue.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="qa-columns">
            <div className="qa-panel">
              <div className="qa-panel-head">
                <h4>Pages ({run.pages.length})</h4>
              </div>
              <table className="qa-table">
                <thead>
                  <tr><th>Path</th><th>Status</th><th>Time</th><th>Size</th></tr>
                </thead>
                <tbody>
                  {run.pages.map(p => (
                    <tr key={p.path}>
                      <td>
                        <a href={siteUrl + p.path} target="_blank" rel="noreferrer">{p.path}</a>
                      </td>
                      <td><span className={`qa-code ${p.status < 400 ? "ok" : "bad"}`}>{p.status}</span></td>
                      <td className={p.ms > 3000 ? "slow" : ""}>{p.ms}ms</td>
                      <td>{Math.round(p.bytes / 1024)} KB</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="qa-panel">
              <div className="qa-panel-head">
                <h4>Assets ({run.assets.length})</h4>
                <button className="link-btn" onClick={() => setExpanded(!expanded)}>
                  {expanded ? "Show problems only" : "Show all"}
                </button>
              </div>
              <div className="qa-assets">
                {run.assets
                  .filter(a => expanded || a.status !== 200)
                  .slice(0, expanded ? run.assets.length : 12)
                  .map(a => (
                    <div key={a.url} className="qa-asset">
                      <span className={`qa-code ${a.status === 200 ? "ok" : "bad"}`}>{a.status}</span>
                      <span className="qa-asset-url">{a.url}</span>
                      <span className="qa-asset-size">{Math.round(a.bytes / 1024)} KB</span>
                    </div>
                  ))}
                {run.assets.every(a => a.status === 200) && !expanded && (
                  <div className="qa-assets-ok">All {run.assets.length} assets loaded correctly.</div>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {history.length > 1 && (
        <div className="qa-panel">
          <div className="qa-panel-head">
            <h4>Check History</h4>
          </div>
          <table className="qa-table">
            <thead>
              <tr><th>When</th><th>Status</th><th>Response</th><th>Issues</th><th>Trigger</th></tr>
            </thead>
            <tbody>
              {history.map(h => (
                <tr key={h.id}>
                  <td>{new Date(h.checked_at).toLocaleString()}</td>
                  <td><span className={`qa-status-pill sm ${h.status}`}>{h.status}</span></td>
                  <td>{h.response_ms}ms</td>
                  <td>
                    <span className={h.critical_count ? "bad-text" : ""}>
                      {h.critical_count} critical / {h.warning_count} warnings
                    </span>
                  </td>
                  <td><span className={`trigger-tag ${h.trigger}`}>{h.trigger}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function JarvisPanel({ onToast, onAuthLoss, setActiveView, data, openAssign, editTask, copyPortal, managerName }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [caps, setCaps] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const scrollRef = useRef(null);
  const [speaking, setSpeaking] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [ttsSupported, setTtsSupported] = useState(false);
  const [pendingGreeting, setPendingGreeting] = useState(null);
  // The arrival greeting sits on the page instead of opening the chat, so
  // Jarvis says hello without taking the screen over every time you refresh.
  const [greeting, setGreeting] = useState(null);
  const [heard, setHeard] = useState("");

  const voicesRef = useRef([]);
  const speechTokenRef = useRef(0);
  const pendingGreetingRef = useRef(null);
  const busyRef = useRef(false);
  const queueRef = useRef([]);

  // Chrome populates the voice list asynchronously, so getVoices() usually
  // returns nothing on the very first call. Reading it once left Jarvis on
  // the flat default voice, which is what made it sound robotic.
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const load = () => { voicesRef.current = window.speechSynthesis.getVoices() || []; };
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);

  // Ranks voices so the best-sounding one wins rather than whatever is first.
  function pickVoice() {
    const voices = voicesRef.current;
    if (!voices.length) return null;
    const score = v => {
      const n = (v.name || "").toLowerCase();
      const l = (v.lang || "").toLowerCase();
      let s = 0;
      if (/natural|neural/.test(n)) s += 100;   // the genuinely natural ones
      if (/google/.test(n)) s += 60;
      if (/^en/.test(l)) s += 40;
      if (/en-in/.test(l)) s += 25;            // matches the accent
      if (/^en-us/.test(l)) s += 20;
      if (/^en-gb/.test(l)) s += 18;
      if (/female|woman|samantha|jenny|swara|zira|susan|karen|serena|aria/.test(n)) s += 12;
      if (/compact|espeak|pico/.test(n)) s -= 60; // the famously robotic ones
      if (!v.localService) s -= 5;
      return s;
    };
    const english = voices.filter(v => /^en/i.test(v.lang || ""));
    const pool = english.length ? english : voices;
    return pool.slice().sort((a, b) => score(b) - score(a))[0] || null;
  }

  // Strips markdown and emoji so the synthesiser does not read punctuation
  // marks aloud or announce an icon.
  function speechify(text) {
    return String(text)
      .replace(/\*\*/g, "")
      .replace(/[`#>|]/g, "")
      .replace(/^\s*[-•]\s*/gm, "")
      .replace(/\s*[—–]\s*/g, ", ")
      .replace(/\s*->\s*/g, ", ")
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
      .replace(/\s{2,}/g, " ")
      .replace(/\s+([.,!?])/g, "$1")
      .trim();
  }

  // Speaking one long block makes it drone. Sentence-sized pieces with a
  // short gap between them is what makes it sound like someone talking.
  function splitSentences(text, max = 200) {
    const chunks = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
    const out = [];
    let buf = "";
    for (const chunk of chunks) {
      if (buf && (buf + chunk).length > max) {
        out.push(buf.trim());
        buf = "";
      }
      buf += chunk;
    }
    if (buf.trim()) out.push(buf.trim());
    return out.filter(Boolean);
  }

  // Speech output uses the browser's own synthesis engine: no API key, no cost.
  function speak(text) {
    if (!voiceOn || !ttsSupported || !text) return;
    const clean = speechify(text);
    if (!clean) return;

    // Cancels anything already playing and invalidates its queue.
    stopSpeaking();
    const token = speechTokenRef.current;
    const parts = splitSentences(clean);
    let i = 0;

    const next = () => {
      if (token !== speechTokenRef.current) return;
      if (i >= parts.length) { setSpeaking(false); return; }
      const utter = new SpeechSynthesisUtterance(parts[i++]);
      utter.rate = 0.97;   // a shade slower reads far more natural
      utter.pitch = 1;
      const voice = pickVoice();
      if (voice) utter.voice = voice;
      utter.onstart = () => setSpeaking(true);
      utter.onend = () => {
        if (token !== speechTokenRef.current) return;
        if (i < parts.length) setTimeout(next, 80);
        else setSpeaking(false);
      };
      utter.onerror = () => { if (token === speechTokenRef.current) setSpeaking(false); };
      window.speechSynthesis.speak(utter);
    };

    next();
  }

  function stopSpeaking() {
    // Bumping the token makes any in-flight queue abandon itself.
    speechTokenRef.current += 1;
    try {
      window.speechSynthesis?.cancel();
    } catch {
      // Nothing to cancel when synthesis is unavailable.
    }
    setSpeaking(false);
  }

  function toggleVoice() {
    const next = !voiceOn;
    setVoiceOn(next);
    if (!next) {
      stopSpeaking();
      return;
    }
    const last = [...messages].reverse().find(m => m.role === "jarvis");
    if (last?.blocks?.text) speak(last.blocks.text);
  }
  const recognitionRef = useRef(null);
  // Mirrors `listening` in a ref, because the click handler needs the current
  // value immediately and React state is not updated yet inside the handler.
  const listeningRef = useRef(false);

  // Re-fetching when the saved name changes means the greeting updates the
  // moment it is saved, without needing a page reload.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const g = await api("/api/jarvis/greeting");
        if (cancelled) return;
        setSuggestions(g.suggestions || []);
        setCaps(g.capability_count || 0);
        setMessages([{ role: "jarvis", blocks: { text: g.text, actions: g.actions } }]);
        setGreeting({ text: g.text, actions: g.actions || [] });
        // Browsers refuse to play audio until the page has been interacted
        // with, so the greeting waits for the first tap, keypress or scroll
        // anywhere on the page rather than only when the button is pressed.
        setPendingGreeting(g.text);
        pendingGreetingRef.current = g.text;
      } catch (e) {
        if (cancelled) return;
        if (e.authRequired) return onAuthLoss();
        onToast(e.message);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managerName]);

  // Chrome, Edge and Safari all block spoken audio until the user has touched
  // the page. Listening for the very first interaction anywhere on the page is
  // what lets the greeting actually be heard on arrival, instead of the user
  // having to find and press the Jarvis button first.
  useEffect(() => {
    if (!pendingGreeting) return;

    const fire = () => {
      const text = pendingGreetingRef.current;
      if (!text) return;
      pendingGreetingRef.current = null;
      setPendingGreeting(null);
      // Let the click that triggered this finish before starting audio.
      setTimeout(() => speak(text), 60);
    };

    const events = ["pointerdown", "keydown", "touchstart", "wheel"];
    events.forEach(e =>
      window.addEventListener(e, fire, { once: true, passive: true, capture: true })
    );
    return () => {
      events.forEach(e => window.removeEventListener(e, fire, { capture: true }));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingGreeting]);

  useEffect(() => {
    // Web Speech API is free and browser-native: no API key, no cost.
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR) {
      setSpeechSupported(true);
      if (window.speechSynthesis) { setTtsSupported(true); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Builds a fresh recogniser each time. Chrome marks an instance unusable
  // once it has ended, so reusing the same one made the second attempt fail.
  function buildRecognition(SR) {
    const recognition = new SR();
    // Continuous, because with it off a normal pause in speech ends the
    // session and the rest of the sentence is lost.
    recognition.continuous = true;
    // Interim results show the words as they arrive, which is the clearest
    // sign that the microphone is genuinely live.
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = "en-IN";

    let finalText = "";
    let consumed = 0;      // results already folded in, so nothing doubles up
    let silent = null;

    // Chrome only ends a session after its own long pause, which felt far too
    // slow. Stopping after a short silence makes it answer when you finish.
    const resetSilenceTimer = () => {
      clearTimeout(silent);
      silent = setTimeout(() => {
        try { recognition.stop(); } catch { /* already stopped */ }
      }, 1500);
    };

    recognition.onresult = (event) => {
      let interim = "";
      // results is cumulative and each event restarts at resultIndex, so only
      // genuinely new entries are read. Re-reading old ones duplicated words.
      for (let i = Math.max(event.resultIndex, consumed); i < event.results.length; i++) {
        const chunk = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += chunk;
        else interim += chunk;
      }
      consumed = event.results.length;

      const live = (finalText + interim).trim();
      setHeard(live);
      setInput(live);
      resetSilenceTimer();
    };

    recognition.onerror = (event) => {
      listeningRef.current = false;
      setListening(false);
      clearTimeout(silent);
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        onToast("Microphone is blocked. Allow it in your browser settings, then tap the mic again.");
      } else if (event.error === "no-speech") {
        onToast("I did not catch any words. Tap the mic and speak straight after.");
      } else if (event.error === "network") {
        onToast("Voice recognition needs a connection. Check you are online and try again.");
      } else if (event.error !== "aborted") {
        onToast("Voice input did not work in this browser. You can type instead.");
      }
    };

    // Chrome ends the session on its own after a pause. Rather than throwing
    // the sentence away, submit whatever was heard.
    recognition.onend = () => {
      listeningRef.current = false;
      setListening(false);
      clearTimeout(silent);
      const said = finalText.trim();
      finalText = "";
      consumed = 0;
      if (said) {
        setHeard("");
        setInput("");
        send(said);
      }
    };

    return recognition;
  }

  function startListening() {
    if (listeningRef.current) { stopListening(); return; }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      onToast("This browser cannot listen. Try Chrome or Edge, or just type instead.");
      return;
    }

    // The microphone must not be listening to Jarvis answering.
    stopSpeaking();
    // If the greeting was still waiting to speak, drop it rather than have it
    // talk over the question.
    pendingGreetingRef.current = null;
    setPendingGreeting(null);

    setIsOpen(true);
    setGreeting(null);
    setHeard("");

    try {
      const recognition = buildRecognition(SR);
      recognitionRef.current = recognition;
      listeningRef.current = true;
      recognition.start();
      setListening(true);
    } catch (err) {
      listeningRef.current = false;
      setListening(false);
      onToast("I could not open the microphone. Check the browser permission.");
    }
  }

  function stopListening() {
    listeningRef.current = false;
    setListening(false);
    try {
      recognitionRef.current?.stop();
    } catch {
      // Already stopped, nothing to do.
    }
  }

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  async function send(text) {
    const message = (text ?? input).trim();
    if (!message) return;

    // A spoken question used to be thrown away whenever a reply was already
    // being fetched, so the microphone appeared to do nothing. Queue instead.
    if (busyRef.current) {
      queueRef.current.push(message);
      return;
    }

    setMessages(prev => [...prev, { role: "user", blocks: { text: message } }]);
    setInput("");
    setHeard("");
    busyRef.current = true;
    setBusy(true);
    try {
      const reply = await api("/api/jarvis/ask", {
        method: "POST",
        body: JSON.stringify({ message }),
      });
      setMessages(prev => [...prev, { role: "jarvis", blocks: reply }]);
      speak(reply.text);
    } catch (e) {
      if (e.authRequired) return onAuthLoss();
      setMessages(prev => [...prev, {
        role: "jarvis",
        blocks: { text: e.message, list: ["Please try that again."] },
      }]);
    } finally {
      busyRef.current = false;
      setBusy(false);
      // Anything spoken while we were busy gets asked now.
      const queued = queueRef.current.shift();
      if (queued) setTimeout(() => send(queued), 120);
    }
  }

  function dismissGreeting() {
    setGreeting(null);
    setPendingGreeting(null);
  }

  // Tapping the greeting opens the chat and clears it from the page, so the
  // two never sit on top of each other.
  function openFromGreeting() {
    if (pendingGreeting) {
      speak(pendingGreeting);
      setPendingGreeting(null);
    }
    dismissGreeting();
    setIsOpen(true);
  }

  // Every suggested button funnels through here: actions that only carry a
  // question get asked, and the rest navigate or open the right editor.
  function runAction(action) {
    if (action.message) {
      setGreeting(null);
      if (!isOpen) setIsOpen(true);
      send(action.message);
      return;
    }
    if (action.action === "goto" && setActiveView) {
      setGreeting(null);
      setActiveView(action.view);
    }
    if (action.action === "open_assign" && openAssign) {
      setGreeting(null);
      setIsOpen(false);
      openAssign(action.member_id);
    }
    if (action.action === "edit_task" && editTask) {
      setGreeting(null);
      setIsOpen(false);
      const task = (data.tasks || []).find(t => t.id === action.task_id);
      if (task) editTask(task);
    }
    if (action.action === "copy_portal" && copyPortal) copyPortal(action.member_id);
    if (action.action === "open_portal" && setActiveView) {
      setGreeting(null);
      setIsOpen(false);
      setActiveView("who_working");
    }
  }

  return (
    <>
      {/* Arrival greeting. Sits on the page like being greeted at the door,
          rather than opening a chat that covers the dashboard on every reload. */}
      {greeting && !isOpen && (
        <div className="jarvis-greeting-card" role="status">
          <button className="jarvis-greeting-close" onClick={dismissGreeting} aria-label="Dismiss greeting">
            <X size={14} />
          </button>
          <div className="jarvis-greeting-head">
            <span className="jarvis-greeting-orb"><Bot size={15} /></span>
            <strong>Jarvis</strong>
          </div>
          <p className="jarvis-greeting-text">
            <JarvisBlocks blocks={greeting} onAction={runAction} />
          </p>
          <div className="jarvis-greeting-actions">
            <button className="jarvis-greeting-ask" onClick={openFromGreeting}>
              <Bot size={13} /> Ask Jarvis
            </button>
            {speechSupported && (
              <button className="jarvis-greeting-mic" onClick={startListening} title="Speak your question">
                <Mic size={13} /> Speak
              </button>
            )}
            <button className="jarvis-greeting-mute" onClick={toggleVoice} title={voiceOn ? "Mute Jarvis" : "Unmute Jarvis"}>
              {voiceOn ? <Volume2 size={13} /> : <VolumeX size={13} />}
            </button>
          </div>
        </div>
      )}

      <button
        className={`jarvis-fab ${listening ? "listening" : ""} ${isOpen ? "active" : ""} ${greeting && !isOpen ? "nudge" : ""}`}
        onClick={() => {
          // First tap satisfies the browser's autoplay rule, so the greeting
          // can finally be spoken aloud.
          if (pendingGreeting) {
            speak(pendingGreeting);
            setPendingGreeting(null);
          }
          if (isOpen) setIsOpen(false);
          else {
            dismissGreeting();
            setIsOpen(true);
          }
        }}
        data-testid="jarvis-fab"
        title={speechSupported ? "Ask Jarvis by voice" : "Voice input not supported in this browser"}
        aria-label="Ask Jarvis"
      >
        {listening ? <Square size={18} /> : <Bot size={18} />}
        <span className="jarvis-fab-label">{listening ? "Listening..." : "Jarvis"}</span>
      </button>

      {isOpen && (
        <div className="jarvis-overlay" onMouseDown={() => setIsOpen(false)}>
          <div className="jarvis-panel" onMouseDown={e => e.stopPropagation()}>
            <div className="jarvis-head">
              <div className="jarvis-head-left">
                <div className="jarvis-orb"><Bot size={18} /></div>
                <div>
                  <strong>JARVIS</strong>
                  <span>{caps || 27} capabilities &middot; answers from your live data</span>
                </div>
              </div>
              <div className="jarvis-head-right">
                {speechSupported && (
                  <button
                    className={`jarvis-mic ${listening ? "on" : ""}`}
                    onClick={startListening}
                    title={listening ? "Stop listening" : "Speak your question"}
                  >
                    {listening ? <Square size={15} /> : <Mic size={15} />}
                  </button>
                )}
                {ttsSupported && (
                  <button
                    className={`jarvis-mic ${speaking ? "on" : ""}`}
                    onClick={() => (speaking ? stopSpeaking() : toggleVoice())}
                    title={voiceOn ? "Jarvis speaks replies. Click to mute." : "Jarvis is muted. Click to unmute."}
                  >
                    {voiceOn ? <Volume2 size={15} /> : <VolumeX size={15} />}
                  </button>
                )}
                <button className="close-btn" onClick={() => setIsOpen(false)}><X size={17} /></button>
              </div>
            </div>

            {listening && (
              <div className="jarvis-hearing">
                <span className="jarvis-hearing-dot" />
                <span className="jarvis-hearing-text">
                  {heard ? `Heard: "${heard}"` : "Listening, speak now..."}
                </span>
              </div>
            )}

            <div className="jarvis-log" ref={scrollRef}>
              {messages.map((m, i) => (
                <div key={i} className={`jarvis-msg ${m.role}`}>
                  {m.role === "jarvis" && <div className="jarvis-msg-orb"><Bot size={13} /></div>}
                  <div className="jarvis-bubble">
                    <JarvisBlocks blocks={m.blocks} onAction={runAction} />
                  </div>
                </div>
              ))}
              {busy && (
                <div className="jarvis-msg jarvis">
                  <div className="jarvis-msg-orb"><Bot size={13} /></div>
                  <div className="jarvis-bubble typing"><span /><span /><span /></div>
                </div>
              )}
            </div>

            {suggestions.length > 0 && (
              <div className="jarvis-suggestions">
                {suggestions.map(s => (
                  <button key={s} onClick={() => send(s)}>{s}</button>
                ))}
              </div>
            )}

            <form
              className="jarvis-input"
              onSubmit={e => {
                e.preventDefault();
                stopListening();
                send();
              }}
            >
              <input
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder={listening ? "Listening, speak now..." : "Ask Jarvis, or press the mic to speak"}
                disabled={busy && !input.trim()}
              />
              {speechSupported && (
                <button
                  type="button"
                  onClick={startListening}
                  className={listening ? "on" : ""}
                  title={listening ? "Stop listening" : "Speak your question"}
                  aria-label={listening ? "Stop listening" : "Speak your question"}
                >
                  {listening ? <Square size={16} /> : <Mic size={16} />}
                </button>
              )}
              <button type="submit" className="jarvis-send" disabled={busy || !input.trim()} title="Send">
                <Send size={16} />
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

function JarvisBlocks({ blocks, onAction }) {
  if (!blocks) return null;

  function inline(text) {
    // Minimal markdown: **bold** only, which is all the backend emits.
    return String(text || "")
      .split(/(\*\*[^*]+\*\*)/g)
      .map((part, i) =>
        part.startsWith("**") && part.endsWith("**")
          ? <b key={i}>{part.slice(2, -2)}</b>
          : <span key={i}>{part}</span>
      );
  }

  return (
    <>
      <p className="jarvis-text">{inline(blocks.text)}</p>
      {blocks.text2 && <p className="jarvis-text dim">{inline(blocks.text2)}</p>}

      {blocks.stats && (
        <div className="jarvis-stats">
          {blocks.stats.map(s => (
            <div key={s.label}>
              <strong>{s.value}</strong>
              <span>{s.label}</span>
            </div>
          ))}
        </div>
      )}

      {blocks.table && (
        <div className="jarvis-table-wrap">
          {blocks.table.map((row, i) => (
            <div key={i} className={`jarvis-tr ${i === 0 || i === 1 ? "head" : ""}`}>
              {row.split("|").filter(c => c.trim()).map((cell, j) => (
                <span key={j}>{inline(cell.trim())}</span>
              ))}
            </div>
          ))}
        </div>
      )}

      {blocks.list && (
        <ul className="jarvis-list">
          {blocks.list.map((line, i) => (
            <li key={i}>{inline(line)}</li>
          ))}
        </ul>
      )}

      {blocks.actions && blocks.actions.length > 0 && (
        <div className="jarvis-actions">
          {blocks.actions.map((a, i) => (
            // Everything routes through onAction. send() lives in the parent,
            // so calling it here directly threw and the button did nothing.
            <button
              key={i}
              onClick={() => onAction(a)}
              title={a.message || a.action || ""}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function MailView({ onToast, onAuthLoss }) {
  const [status, setStatus] = useState({ configured: false, connected: false, missing_env: [] });
  const [messages, setMessages] = useState([]);
  const [source, setSource] = useState("outbox");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("mail") === "connected") {
      setNotice("Gmail connected successfully.");
      params.delete("mail");
      params.delete("account");
      window.history.pushState({}, "", `${window.location.pathname}${params.toString()}`);
    }
  }, []);

  async function load(query = "") {
    try {
      setLoading(true);
      const [s, m] = await Promise.all([
        api("/api/mail/status"),
        api(`/api/mail/messages${query ? `?q=${encodeURIComponent(query)}` : ""}`),
      ]);
      setStatus(s);
      setMessages(m.messages || []);
      setSource(m.source);
      if (m.message) setNotice(m.message);
    } catch (e) {
      if (e.authRequired) return onAuthLoss();
      if (e.needsReconnect || /reconnect/i.test(e.message)) setNotice(e.message);
      else onToast(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function openMessage(m) {
    setOpen({ id: m.id, loading: true });
    try {
      const full = await api(`/api/mail/messages/${m.id}`);
      setOpen(full);
    } catch (e) {
      if (e.authRequired) return onAuthLoss();
      setOpen({ error: e.message });
    }
  }

  async function disconnect() {
    try {
      await api("/api/mail/disconnect", { method: "POST" });
      await load();
      onToast("Gmail disconnected");
    } catch (e) {
      onToast(e.message);
    }
  }

  return (
    <section className="mail-view">
      <div className="section-head">
        <div>
          <div className="eyebrow">MAIL</div>
          <h2>Mail</h2>
          <p>
            {status.connected
              ? `Reading ${status.email} directly, so you do not need to open Gmail.`
              : "Read the notifications this system sends. Connect Gmail to see your real inbox here too."}
          </p>
        </div>
        <div className="workspace-actions">
          <div className="search">
            <Search size={16} />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => e.key === "Enter" && load(search)}
              placeholder="Search mail..."
            />
          </div>
          <button className="secondary-btn" onClick={() => load(search)}>
            <RefreshCw size={15} /> Refresh
          </button>
          {status.connected ? (
            <button className="secondary-btn danger-outline" onClick={disconnect}>
              Disconnect
            </button>
          ) : (
            <a className="primary-btn" href="/api/mail/auth/start">
              <Mail size={15} /> Connect Gmail
            </a>
          )}
        </div>
      </div>

      {!status.configured && (
        <div className="mail-setup">
          <AlertTriangle size={18} />
          <div>
            <strong>Gmail is not set up yet</strong>
            <p>
              Add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> as
              environment variables, then press Connect Gmail. Until then you can
              still read every notification this system has sent.
            </p>
          </div>
        </div>
      )}

      {notice && (
        <div className="mail-notice"><Info size={15} /> {notice}</div>
      )}

      <div className="mail-source-tag">
        Showing <b>{source === "gmail" ? "your Gmail inbox" : "sent notifications"}</b>
        {" "}({messages.length})
      </div>

      {loading ? (
        <div className="qa-loading"><div className="loader" /><p>Loading mail...</p></div>
      ) : messages.length === 0 ? (
        <div className="qa-empty">
          <Mail size={34} />
          <h3>No mail to show</h3>
          <p>
            {source === "gmail"
              ? "Your inbox has no matching messages."
              : "Nothing has been sent yet. Assign a task and the notification will appear here."}
          </p>
        </div>
      ) : (
        <div className="mail-list">
          {messages.map(m => (
            <button key={m.id} className="mail-row" onClick={() => openMessage(m)}>
              <div className={`mail-dot ${m.unread ? "unread" : ""}`} />
              <div className="mail-row-main">
                <strong>{m.subject}</strong>
                <span className="mail-from">{m.from}</span>
                <span className="mail-snippet">{m.snippet}</span>
              </div>
              <div className="mail-row-meta">
                {m.status && m.status !== "sent" && (
                  <span className={`mail-status ${m.status}`}>{m.status}</span>
                )}
                <span className="mail-date">{m.date ? new Date(m.date).toLocaleString() : ""}</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {open && (
        <div className="mail-reader" onMouseDown={() => setOpen(null)}>
          <div className="mail-reader-card" onMouseDown={e => e.stopPropagation()}>
            <div className="mail-reader-head">
              <div>
                <strong>{open.subject || (open.loading ? "Loading..." : "")}</strong>
                <div className="mail-reader-meta">
                  {open.from} {open.to && <>&bull; to {open.to}</>}
                  {open.date && <>&bull; {new Date(open.date).toLocaleString()}</>}
                </div>
              </div>
              <button className="close-btn" onClick={() => setOpen(null)}><X size={17} /></button>
            </div>
            <div className="mail-reader-body">
              {open.loading && <div className="loader" />}
              {open.error && <p className="bad-text">{open.error}</p>}
              {open.body && (
                open.body.trim().startsWith("<")
                  ? <div className="email-html-render" dangerouslySetInnerHTML={{ __html: open.body }} />
                  : <pre className="mail-text">{open.body}</pre>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function SecurityView({ onToast, onAuthLoss }) {
  const [status, setStatus] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  async function load() {
    try {
      setLoading(true);
      const [s, h] = await Promise.all([
        api("/api/security/status"),
        api("/api/security/history"),
      ]);
      setStatus(s);
      setHistory(h.runs || []);
    } catch (e) {
      if (e.authRequired) return onAuthLoss();
      onToast(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function runNow() {
    try {
      setRunning(true);
      await api("/api/security/check", { method: "POST" });
      await load();
      onToast("Security review finished");
    } catch (e) {
      if (e.authRequired) return onAuthLoss();
      onToast(e.message);
    } finally {
      setRunning(false);
    }
  }

  if (loading) {
    return (
      <div className="qa-loading">
        <div className="loader" />
        <p>Loading security review...</p>
      </div>
    );
  }

  const run = status?.run;
  const siteUrl = status?.site_url || "https://ngocore.in";
  const findings = run?.findings || [];
  const tls = run?.tls || {};

  return (
    <section className="qa-view">
      <div className="section-head">
        <div>
          <div className="eyebrow">SECURITY ANALYST</div>
          <h2>Security Review</h2>
          <p>
            A read-only audit of {siteUrl}: TLS certificate, response headers,
            cookies, CORS, information disclosure and any accidentally public
            files. It never logs in or attacks anything.
          </p>
        </div>
        <div className="workspace-actions">
          <a className="secondary-btn" href={siteUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={15} /> Open Site
          </a>
          {run && (
            <a className="secondary-btn" href={`${API}/api/security/report.pdf`}>
              <Download size={15} /> Export PDF
            </a>
          )}
          <button className="primary-btn" onClick={runNow} disabled={running}>
            <RefreshCw size={15} className={running ? "spin" : ""} />
            {running ? "Reviewing..." : "Run Review Now"}
          </button>
        </div>
      </div>

      {!run ? (
        <div className="qa-empty">
          <ShieldCheck size={34} />
          <h3>No review has run yet</h3>
          <p>Press Run Review Now to audit the site, or wait for the daily scheduled run.</p>
        </div>
      ) : (
        <>
          <div className={`qa-hero ${run.status}`}>
            <div className="qa-hero-left">
              <span className={`qa-status-pill ${run.status}`}>
                {run.status === "healthy" && "Secure"}
                {run.status === "warning" && "Improvements"}
                {run.status === "critical" && "Action Needed"}
                {run.status === "inconclusive" && "Scan Incomplete"}
              </span>
              <h3>{run.summary}</h3>
              <div className="qa-hero-meta">
                <span>Checked {new Date(run.checked_at).toLocaleString()}</span>
                <span className="dot-sep">&bull;</span>
                <span className={`trigger-tag ${run.trigger}`}>
                  {run.trigger === "manual" ? "Run by you" : "Scheduled"}
                </span>
              </div>
            </div>
            <div className="qa-hero-stats">
              <div className="qa-stat">
                <span className="qa-stat-val danger">{run.critical_count}</span>
                <span className="qa-stat-lbl">Critical</span>
              </div>
              <div className="qa-stat">
                <span className="qa-stat-val warn">{run.warning_count}</span>
                <span className="qa-stat-lbl">Warnings</span>
              </div>
              <div className="qa-stat">
                <span className="qa-stat-val">{run.info_count}</span>
                <span className="qa-stat-lbl">Advisory</span>
              </div>
              <div className="qa-stat">
                <span className={`qa-stat-val ${tls.valid ? "good" : "danger"}`}>
                  {tls.valid ? tls.tls_version || "OK" : "BAD"}
                </span>
                <span className="qa-stat-lbl">TLS</span>
              </div>
            </div>
          </div>

          <div className="qa-columns">
            <div className="qa-panel">
              <div className="qa-panel-head"><h4>TLS Certificate</h4></div>
              <table className="qa-table">
                <tbody>
                  <tr><td>Valid</td><td>{tls.valid ? "Yes" : "No"}</td></tr>
                  <tr><td>Protocol</td><td>{tls.tls_version || "-"}</td></tr>
                  <tr><td>Issuer</td><td>{tls.issuer || "-"}</td></tr>
                  <tr>
                    <td>Expires</td>
                    <td>
                      {tls.expires ? String(tls.expires).slice(0, 10) : "-"}
                      {tls.days_left != null && (
                        <span className={tls.days_left < 30 ? " slow" : ""}>
                          {" "}({tls.days_left} days)
                        </span>
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="qa-panel">
              <div className="qa-panel-head">
                <h4>Sensitive Files ({run.paths_checked?.length || 0})</h4>
              </div>
              <table className="qa-table">
                <thead>
                  <tr><th>Path</th><th>Status</th><th>Result</th></tr>
                </thead>
                <tbody>
                  {(run.paths_checked || []).map(p => (
                    <tr key={p.path}>
                      <td>{p.path}</td>
                      <td><span className={`qa-code ${p.status === 200 ? "bad" : "ok"}`}>{p.status}</span></td>
                      <td>
                        {p.exposed
                          ? <span className="qa-code bad">EXPOSED</span>
                          : <span className="qa-code ok">Protected</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="qa-panel">
            <div className="qa-panel-head">
              <h4>Findings ({findings.length})</h4>
            </div>
            {findings.length === 0 ? (
              <div className="qa-no-issues">
                <CheckCircle2 size={16} /> No security problems found.
              </div>
            ) : (
              <div className="qa-issues">
                {findings.map((f, i) => (
                  <div key={i} className={`qa-issue ${f.severity}`}>
                    <span className="qa-sev">{f.severity}</span>
                    <span className="qa-cat">{f.category}</span>
                    <span className="qa-msg">{f.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {history.length > 1 && (
        <div className="qa-panel">
          <div className="qa-panel-head"><h4>Review History</h4></div>
          <table className="qa-table">
            <thead>
              <tr><th>When</th><th>Grade</th><th>Critical</th><th>Warnings</th><th>Trigger</th></tr>
            </thead>
            <tbody>
              {history.map(h => (
                <tr key={h.id}>
                  <td>{new Date(h.checked_at).toLocaleString()}</td>
                  <td><span className={`qa-status-pill sm ${h.status}`}>{h.status}</span></td>
                  <td className={h.critical_count ? "bad-text" : ""}>{h.critical_count}</td>
                  <td>{h.warning_count}</td>
                  <td><span className={`trigger-tag ${h.trigger}`}>{h.trigger}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AllTasksView({
  tasks, members, search, onSearch,
  memberFilter, onMemberFilter, statusFilter, onStatusFilter,
  onEdit, onDelete, onAdvance, onCopyPortalLink, onResendEmail
}) {
  const [sortKey, setSortKey] = useState("created_desc");
  const [sortAsc, setSortAsc] = useState(false);

  const filtered = useMemo(() => {
    const out = tasks.filter(t => {
      const okMember = memberFilter === "all" || String(t.member_id) === String(memberFilter);
      const okStatus = statusFilter === "all" || t.status === statusFilter;
      const okSearch = !search || `${t.title} ${t.description} ${t.member_name} ${t.notes || ""}`
        .toLowerCase().includes(search.toLowerCase());
      return okMember && okStatus && okSearch;
    });

    const dir = sortAsc ? 1 : -1;
    const byDue = (a, b) => {
      if (!a.due_date && !b.due_date) return 0;
      if (!a.due_date) return 1;   // undated last regardless of direction
      if (!b.due_date) return -1;
      return a.due_date.localeCompare(b.due_date) * dir;
    };
    const comparators = {
      created_desc: (a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")) * dir,
      due_asc: byDue,
      member: (a, b) => (a.member_name || "").localeCompare(b.member_name || "") * dir,
      status: (a, b) => (a.status || "").localeCompare(b.status || "") * dir,
      priority: (a, b) => {
        const rank = { urgent: 4, high: 3, medium: 2, low: 1 };
        return ((rank[a.priority] || 0) - (rank[b.priority] || 0)) * dir;
      },
    };
    return [...out].sort(comparators[sortKey] || comparators.created_desc);
  }, [tasks, memberFilter, statusFilter, search, sortKey, sortAsc]);

  function header(label, key) {
    return (
      <th
        className={`sortable ${sortKey === key ? "sorted" : ""}`}
        onClick={() => {
          if (sortKey === key) setSortAsc(!sortAsc);
          else { setSortKey(key); setSortAsc(true); }
        }}
      >
        {label}
        <span className="sort-arrow">{sortKey === key ? (sortAsc ? "▲" : "▼") : ""}</span>
      </th>
    );
  }

  return (
    <section className="all-tasks-view">
      <div className="section-head">
        <div>
          <div className="eyebrow">TASK REGISTER</div>
          <h2>All Tasks</h2>
          <p>Every task in one place. Edits here update the kanban board, the team matrix and the office scene instantly.</p>
        </div>

        <div className="workspace-actions">
          <div className="search">
            <Search size={16} />
            <input
              value={search}
              onChange={e => onSearch(e.target.value)}
              placeholder="Search title, notes or assignee..."
            />
          </div>
          <select
            className="table-filter"
            value={memberFilter}
            onChange={e => onMemberFilter(e.target.value)}
          >
            <option value="all">All members ({tasks.length})</option>
            {members.map(m => {
              const n = tasks.filter(t => t.member_id === m.id).length;
              return <option key={m.id} value={m.id}>{m.avatar} {m.name} ({n})</option>;
            })}
          </select>
          <select
            className="table-filter"
            value={statusFilter}
            onChange={e => onStatusFilter(e.target.value)}
          >
            <option value="all">All statuses</option>
            {Object.entries(STATUS_META).map(([k, v]) => {
              const n = tasks.filter(t => t.status === k).length;
              return <option key={k} value={k}>{v.label} ({n})</option>;
            })}
          </select>
        </div>
      </div>

      <div className="task-table-wrap">
        <table className="task-table">
          <thead>
            <tr>
              {header("Task", "created_desc")}
              {header("Assignee", "member")}
              {header("Status", "status")}
              {header("Priority", "priority")}
              {header("Due", "due_asc")}
              <th>Progress note</th>
              <th className="actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan="7" className="table-empty">
                  <Search size={15} /> No tasks match these filters.
                </td>
              </tr>
            ) : (
              filtered.map(t => {
                const next = { todo: "in_progress", in_progress: "review", review: "done" }[t.status];
                return (
                  <tr key={t.id} className={`task-row ${t.status}`}>
                    <td className="cell-title">
                      <strong>{t.title}</strong>
                      {t.description && <small>{t.description}</small>}
                    </td>
                    <td>
                      <button
                        className="table-person"
                        title="Copy this member's portal link"
                        onClick={() => onCopyPortalLink(t.member_id)}
                      >
                        <span>{t.member_avatar}</span> {t.member_name}
                      </button>
                    </td>
                    <td>
                      <span className={`status-badge-live ${t.status}`}>
                        {STATUS_META[t.status]?.label || t.status}
                      </span>
                    </td>
                    <td>
                      <span className={`priority-tag ${t.priority}`}>{t.priority}</span>
                    </td>
                    <td className="cell-due">
                      {t.due_date || "—"}
                    </td>
                    <td className="cell-note">
                      {t.notes ? <span className="note-preview">{t.notes}</span> : <span className="note-empty">none</span>}
                    </td>
                    <td className="actions-col">
                      <div className="row-actions">
                        {next && (
                          <button
                            className="row-btn"
                            title={`Move to ${STATUS_META[next].label}`}
                            onClick={() => onAdvance(t, next)}
                          >
                            <ChevronDown size={13} />
                          </button>
                        )}
                        <button
                          className="row-btn"
                          title="Edit task"
                          onClick={() => onEdit(t)}
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          className="row-btn"
                          title="Copy member portal link"
                          onClick={() => onCopyPortalLink(t.member_id)}
                        >
                          <Copy size={13} />
                        </button>
                        <button
                          className="row-btn"
                          title="Resend assignment email"
                          onClick={() => onResendEmail(t.id)}
                        >
                          <Mail size={13} />
                        </button>
                        <button
                          className="row-btn danger"
                          title="Delete task"
                          onClick={() => onDelete(t)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="table-footer">
        Showing {filtered.length} of {tasks.length} tasks
      </div>
    </section>
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
