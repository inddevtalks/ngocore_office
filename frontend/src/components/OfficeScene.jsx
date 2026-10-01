import React, { useState, useEffect } from "react";
import { Coffee, Monitor, CheckCircle2, Sparkles, User, ExternalLink, Zap, Clock, RefreshCw, Send, AlertCircle } from "lucide-react";

/**
 * High-Clarity Animated Virtual Office
 * Features:
 * - Clear architectural zones (Workstations, Coffee Lounge, Water Cooler, Whiteboard, Meeting Table)
 * - Working animations: typing hands, monitor screens glowing with code/charts, head bobbing
 * - Walking animations: avatars periodically leave their desk and walk with moving legs/bobbing to coffee, whiteboard, or water cooler
 * - Interactive tooltips: click or hover to view current task, copy portal link, or view member profile
 */

const STATIONS = {
  coffee: { x: 78, y: 72, label: "Coffee Lounge ☕" },
  cooler: { x: 48, y: 76, label: "Water Cooler 💧" },
  whiteboard: { x: 88, y: 35, label: "Sprint Board 📋" },
  meeting: { x: 22, y: 76, label: "Meeting Table 👥" },
};

// Default desk positions (percentage based) for up to 8 team members
const DESK_SLOTS = [
  { deskX: 14, deskY: 38, facing: "right" },
  { deskX: 28, deskY: 38, facing: "left" },
  { deskX: 43, deskY: 38, facing: "right" },
  { deskX: 57, deskY: 38, facing: "left" },
  { deskX: 14, deskY: 62, facing: "right" },
  { deskX: 28, deskY: 62, facing: "left" },
  { deskX: 43, deskY: 62, facing: "right" },
  { deskX: 57, deskY: 62, facing: "left" },
];

export default function OfficeScene({ members = [], tasks = [], onSelectMember, onAssignTask }) {
  const [walkerState, setWalkerState] = useState({});
  const [hoveredMember, setHoveredMember] = useState(null);
  const [officeMode, setOfficeMode] = useState("normal"); // 'normal', 'busy', 'coffee'
  const [copiedId, setCopiedId] = useState(null);

  // Periodic walking routine: pick an active member and have them walk to a station, pause, and return
  useEffect(() => {
    if (members.length === 0) return;

    const interval = setInterval(() => {
      // Pick a random member to walk if not in static 'busy' mode
      if (officeMode === "busy") return;

      const randomIdx = Math.floor(Math.random() * Math.min(members.length, DESK_SLOTS.length));
      const member = members[randomIdx];
      if (!member) return;

      const stations = ["coffee", "cooler", "whiteboard", "meeting"];
      const targetStationKey = stations[Math.floor(Math.random() * stations.length)];
      const targetStation = STATIONS[targetStationKey];

      // Start walking to station
      setWalkerState(prev => ({
        ...prev,
        [member.id]: {
          isWalking: true,
          walkingTo: targetStationKey,
          currentX: targetStation.x,
          currentY: targetStation.y,
          statusText: targetStation.label,
          direction: targetStation.x > (DESK_SLOTS[randomIdx]?.deskX || 30) ? "right" : "left",
        }
      }));

      // After 5.5s at station, walk back to desk
      setTimeout(() => {
        setWalkerState(prev => {
          const current = prev[member.id];
          if (!current) return prev;
          const desk = DESK_SLOTS[randomIdx] || { deskX: 20, deskY: 40 };
          return {
            ...prev,
            [member.id]: {
              isWalking: true,
              walkingTo: "desk",
              currentX: desk.deskX,
              currentY: desk.deskY,
              statusText: "Heading back to desk 💻",
              direction: desk.deskX > current.currentX ? "right" : "left",
            }
          };
        });

        // After walking back, sit down
        setTimeout(() => {
          setWalkerState(prev => {
            const next = { ...prev };
            delete next[member.id];
            return next;
          });
        }, 3200);
      }, 5500);

    }, officeMode === "coffee" ? 6000 : 14000);

    return () => clearInterval(interval);
  }, [members, officeMode]);

  function copyPortalLink(memberId, e) {
    e.stopPropagation();
    const url = `${window.location.origin}${window.location.pathname}?portal=${memberId}`;
    navigator.clipboard.writeText(url);
    setCopiedId(memberId);
    setTimeout(() => setCopiedId(null), 2500);
  }

  return (
    <div className="office-canvas-container">
      {/* Office Header Control Bar */}
      <div className="office-controls-bar">
        <div className="office-title-badge">
          <span className="live-ping" />
          <strong>LIVE VIRTUAL HEADQUARTERS</strong>
          <span className="office-members-count">{members.length} Active Staff</span>
        </div>

        <div className="office-mode-toggles">
          <button
            className={`mode-btn ${officeMode === "normal" ? "active" : ""}`}
            onClick={() => setOfficeMode("normal")}
            title="Natural office flow with periodic walking & working"
          >
            🏢 Normal Flow
          </button>
          <button
            className={`mode-btn ${officeMode === "busy" ? "active" : ""}`}
            onClick={() => setOfficeMode("busy")}
            title="All avatars seated at desks typing intensely"
          >
            ⚡ Sprint Focus
          </button>
          <button
            className={`mode-btn ${officeMode === "coffee" ? "active" : ""}`}
            onClick={() => setOfficeMode("coffee")}
            title="More avatars walking around for coffee and water"
          >
            ☕ Break Walk
          </button>
        </div>
      </div>

      {/* Main Isometric/2.5D Office Stage */}
      <div className="office-stage">
        {/* Background Skyline Windows */}
        <div className="office-window-wall">
          <div className="window-frame">
            <div className="sky-gradient" />
            <div className="sun-glow" />
            <div className="skyline-buildings">
              <div className="bldg bldg-1" />
              <div className="bldg bldg-2" />
              <div className="bldg bldg-3" />
              <div className="bldg bldg-4" />
              <div className="bldg bldg-5" />
            </div>
            <div className="window-panes">
              <span className="pane-line v1" />
              <span className="pane-line v2" />
              <span className="pane-line v3" />
              <span className="pane-line h1" />
            </div>
          </div>

          <div className="wall-branding">
            <div className="wall-logo">NGOCORE &bull; OPERATIONS HQ</div>
            <div className="digital-clock">{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
          </div>
        </div>

        {/* Ceiling Ambient Lights */}
        <div className="ceiling-light-track">
          <div className="light-tube tube-1" />
          <div className="light-tube tube-2" />
          <div className="light-tube tube-3" />
        </div>

        {/* Isometric Office Floor Grid */}
        <div className="office-floor-grid">
          {/* ZONE 1: Sprint Strategy Whiteboard (Top Right) */}
          <div className="station-zone whiteboard-station">
            <div className="whiteboard-frame">
              <div className="wb-header">SPRINT BOARD &bull; WEEK 38</div>
              <div className="wb-columns">
                <div className="wb-col">
                  <div className="wb-tag yellow">API</div>
                  <div className="wb-tag pink">AUTH</div>
                </div>
                <div className="wb-col">
                  <div className="wb-tag cyan">UI</div>
                  <div className="wb-tag green">DONE</div>
                </div>
              </div>
              <div className="wb-marker-tray">
                <span className="marker m-blue" /><span className="marker m-red" />
              </div>
            </div>
            <div className="station-label">Strategy Whiteboard</div>
          </div>

          {/* ZONE 2: Coffee & Refreshment Lounge (Bottom Right) */}
          <div className="station-zone coffee-lounge-station">
            <div className="coffee-bar-counter">
              <div className="espresso-machine">
                <div className="steam-container">
                  <span className="steam-puff s1" />
                  <span className="steam-puff s2" />
                </div>
                <div className="coffee-spout" />
              </div>
              <div className="coffee-mug-rack">
                <span className="mini-mug m1">☕</span>
                <span className="mini-mug m2">☕</span>
              </div>
            </div>
            <div className="water-cooler">
              <div className="cooler-bottle">
                <div className="bubble-anim b1" />
                <div className="bubble-anim b2" />
              </div>
              <div className="cooler-base" />
            </div>
            <div className="lounge-plant">
              <div className="leaf l1" /><div className="leaf l2" /><div className="leaf l3" />
              <div className="pot" />
            </div>
            <div className="station-label">Coffee & Water Hub</div>
          </div>

          {/* ZONE 3: Meeting Table (Bottom Left) */}
          <div className="station-zone meeting-station">
            <div className="glass-table">
              <div className="table-laptop">
                <div className="laptop-screen" />
              </div>
            </div>
            <div className="meeting-chair c-left" />
            <div className="meeting-chair c-right" />
            <div className="station-label">Quick Sync Table</div>
          </div>

          {/* ZONE 4: Desks & Workstations (Center Floor) */}
          {DESK_SLOTS.slice(0, Math.max(members.length, 6)).map((slot, i) => {
            const member = members[i];
            const activeTask = member ? tasks.find(t => t.member_id === member.id && t.status === "in_progress") : null;
            const queuedTask = member ? tasks.find(t => t.member_id === member.id && t.status === "todo") : null;
            const currentTask = activeTask || queuedTask;
            const isWalking = member && walkerState[member.id]?.isWalking;

            return (
              <div
                key={`desk-${i}`}
                className={`workstation-pod ${slot.facing}`}
                style={{ left: `${slot.deskX}%`, top: `${slot.deskY}%` }}
              >
                {/* Modern Desk Setup */}
                <div className="desk-surface">
                  {/* Dual Glowing LED Monitors */}
                  <div className="monitor-rig">
                    <div className="desk-monitor mon-main">
                      <div className={`mon-screen ${activeTask ? "active-glow" : "idle-glow"}`}>
                        <div className="screen-code-lines">
                          <span /><span /><span /><span />
                        </div>
                      </div>
                      <div className="mon-stand" />
                    </div>
                    <div className="desk-monitor mon-sub">
                      <div className="mon-screen sub-glow">
                        <div className="screen-chart-bars">
                          <i /><i /><i />
                        </div>
                      </div>
                      <div className="mon-stand" />
                    </div>
                  </div>

                  {/* Keyboard & Desk Accessories */}
                  <div className="keyboard-base">
                    <span className="keys" />
                  </div>
                  <div className="mouse-pad" />
                  <div className="desk-mug">☕</div>
                </div>

                {/* Ergonomic Office Chair */}
                <div className="desk-chair" />

                {/* Avatar Seated at Desk (Shown when not walking) */}
                {member && !isWalking && (
                  <div
                    className="avatar-worker seated"
                    onClick={() => onSelectMember(String(member.id))}
                    onMouseEnter={() => setHoveredMember(member)}
                    onMouseLeave={() => setHoveredMember(null)}
                  >
                    {/* Animated Typing Hands */}
                    <div className="typing-arms">
                      <div className="arm arm-left" />
                      <div className="arm arm-right" />
                    </div>

                    {/* Head with Avatar Emoji */}
                    <div className="avatar-head">
                      <span className="avatar-emoji">{member.avatar || "👨‍💻"}</span>
                    </div>

                    {/* Torso */}
                    <div className="avatar-torso" />

                    {/* Status Thought/Action Bubble */}
                    <div className={`status-bubble ${activeTask ? "working" : queuedTask ? "queued" : "ready"}`}>
                      {activeTask ? (
                        <span className="bubble-content">
                          <Zap size={11} className="spin-slow" />
                          <b className="task-snip">{activeTask.title}</b>
                        </span>
                      ) : queuedTask ? (
                        <span className="bubble-content">
                          <Clock size={11} />
                          <b className="task-snip">Next: {queuedTask.title}</b>
                        </span>
                      ) : (
                        <span className="bubble-content">
                          <CheckCircle2 size={11} /> Ready
                        </span>
                      )}
                    </div>

                    {/* Nameplate tag on desk */}
                    <div className="desk-nameplate">
                      <b>{member.name}</b>
                      <small>{member.role}</small>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* DYNAMIC WALKING AVATARS (Rendered along their walk path) */}
          {members.map((member, i) => {
            const walk = walkerState[member.id];
            if (!walk || !walk.isWalking) return null;

            return (
              <div
                key={`walker-${member.id}`}
                className={`avatar-walker-entity walking ${walk.direction}`}
                style={{
                  left: `${walk.currentX}%`,
                  top: `${walk.currentY}%`,
                }}
                onClick={() => onSelectMember(String(member.id))}
                onMouseEnter={() => setHoveredMember(member)}
                onMouseLeave={() => setHoveredMember(null)}
              >
                {/* Walking Legs with moving step animation */}
                <div className="walking-legs">
                  <div className="leg leg-left" />
                  <div className="leg leg-right" />
                </div>

                {/* Torso & Head */}
                <div className="walker-body">
                  <div className="avatar-head">
                    <span className="avatar-emoji">{member.avatar || "🧑‍💻"}</span>
                  </div>
                  <div className="avatar-torso" />
                </div>

                {/* Floating Walking Message */}
                <div className="walking-bubble">
                  {walk.statusText || "Walking..."}
                </div>

                <div className="walker-shadow" />
              </div>
            );
          })}
        </div>

        {/* Decorative Plants on Floor */}
        <div className="floor-plant p-left">
          <div className="p-leaf l1"/><div className="p-leaf l2"/><div className="p-leaf l3"/>
          <div className="p-pot" />
        </div>
        <div className="floor-plant p-right">
          <div className="p-leaf l1"/><div className="p-leaf l2"/><div className="p-leaf l3"/>
          <div className="p-pot" />
        </div>
      </div>

      {/* Hovered Member Quick Inspection Card */}
      {hoveredMember && (
        <div className="office-hover-card">
          <div className="hover-card-top">
            <span className="hover-avatar">{hoveredMember.avatar}</span>
            <div>
              <strong>{hoveredMember.name}</strong>
              <div className="hover-role">{hoveredMember.role}</div>
              <div className="hover-email">{hoveredMember.email}</div>
            </div>
          </div>

          <div className="hover-task-status">
            <div className="hover-task-label">CURRENT FOCUS:</div>
            {(() => {
              const active = tasks.find(t => t.member_id === hoveredMember.id && t.status === "in_progress");
              const queued = tasks.find(t => t.member_id === hoveredMember.id && t.status === "todo");
              const task = active || queued;
              if (task) {
                return (
                  <div className="hover-task-box">
                    <span className={`task-badge ${task.status}`}>
                      {task.status === "in_progress" ? "⚡ DOING NOW" : "⏳ NEXT UP"}
                    </span>
                    <div className="hover-task-title">{task.title}</div>
                    {task.due_date && <small>Due: {task.due_date}</small>}
                  </div>
                );
              }
              return <div className="hover-free">☕ No tasks currently assigned. Available for work!</div>;
            })()}
          </div>

          <div className="hover-actions">
            <button
              className="hover-btn copy"
              onClick={(e) => copyPortalLink(hoveredMember.id, e)}
            >
              {copiedId === hoveredMember.id ? "✓ Copied Link!" : "📋 Copy Status Portal Link"}
            </button>
            <button
              className="hover-btn assign"
              onClick={() => onAssignTask(hoveredMember.id)}
            >
              + Assign Task
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
