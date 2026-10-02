# NGOCORE &bull; OFFICE TASK HUB & OPERATIONS HQ

A comprehensive operations management platform with real-time task assignment, automated email dispatch to team members, dedicated employee status portals, a manager workload matrix, and a high-clarity virtual animated office with walking and working animations.

---

## 🌟 Key Features

1. **Automated Task Assignment Emails**:
   - Whenever you assign a task to a team member, an email is instantly dispatched containing the task details, priority, due date, description, and their **personal portal link**.
   - Built-in **Email Notification Center & Outbox**: View recent sent emails, preview email bodies, and test SMTP connectivity directly from the UI.
   - Safe Demo Mode: If SMTP credentials aren't configured yet, all emails are logged to the Outbox for instant preview without failing or crashing.

2. **Dedicated Employee Status Portal**:
   - Each team member gets a shareable, dedicated URL: `http://localhost:5173/?portal=<member_id>`
   - Employees can open this link on desktop or mobile.
   - Allows team members to easily update their status:
     - ⏳ **Yet to Start** (`todo`)
     - ⚡ **In Progress** (`in_progress`)
     - 🔍 **Submit for Review** (`review`)
     - ✓ **Completed** (`done`)
   - Add **Progress Notes / Blockers** so the manager knows exact progress without having to message them.
   - One-click **"Copy Status Link"** buttons on the manager dashboard make it effortless to send links via WhatsApp, Slack, or Email.

3. **Manager Dashboard: "Who is Working on What"**:
   - Live workload matrix answering who is working on what right now.
   - Shows current focus spotlight, queued tasks, and completed counts.
   - Actions to reassign, assign new tasks, resend email notifications, or open an employee portal preview.

4. **Full Task & Member Management**:
   - **Tasks** can be created, edited, reassigned to a different team member, and deleted. Reassigning optionally emails the new assignee automatically.
   - **Completed work** leaves the active board and moves to a dedicated **Completed** view, grouped by team member. Anything there can be reopened with one click or deleted.
   - **Members** can be added, edited, and removed. Removing a member also removes their tasks, and the confirmation dialog tells you how many before you commit.

5. **Manager Sign-In &amp; Employee Privacy**:
   - Set `ADMIN_PASSWORD` and the manager dashboard sits behind a sign-in screen, so nobody can read your full task list by opening the URL.
   - Team members never see the dashboard. They use their own portal link and can only update the **status** and **notes** on their own tasks, never retitle, reassign, or delete them.
   - Leave `ADMIN_PASSWORD` empty to skip the sign-in screen entirely. Useful during local development.

4. **High-Clarity Animated Virtual Office**:
   - Crystal-clear visual office environment with distinct zones:
     - 🖥️ **Workstations Pods**: Dual glowing LED monitors displaying animated scrolling code and charts with screen glow reflections, keyboards, and ergonomic chairs.
     - ☕ **Coffee & Water Hub**: Espresso machine with rising steam particles, water cooler with bubbling animations, and mug rack.
     - 📋 **Strategy Whiteboard**: Standing board with sprint sticky notes and marker tray.
     - 👥 **Meeting Table**: Glass conference table with laptop.
     - 🌿 **Greenery & Skyline**: Potted office plants and skyline windows.
   - **Walking & Working Animations**:
     - **Working**: Seated avatars typing rhythmically on keyboards, screen glow reflecting on desks, and floating status bubbles (`⚡ Doing now`, `⏳ Queued`, `✓ Ready`).
     - **Walking**: Avatars dynamically stand up and walk across the floor with moving legs and body bobbing to visit the coffee lounge, water cooler, whiteboard, or colleagues!
     - **Atmosphere Switcher**: Toggle between *Normal Flow*, *Sprint Focus*, and *Break Walk*.
     - **Interactive Tooltips**: Hover or click on any avatar to inspect their active work and copy their status link.

---

## 🚀 How to Run the Project

### Prerequisites
- **Python 3.10+** (Python 3.14+ supported)
- **Node.js 18+** & **npm**

---

### Step 1: Start the Backend (Terminal 1)

```powershell
cd backend

# If not already created:
# python -m venv .venv

# Activate virtual environment:
.\.venv\Scripts\Activate.ps1

# Install dependencies:
pip install -r requirements.txt

# Run the Flask API server:
python app.py
```
> The backend server starts at: `http://localhost:5000`

---

### Step 2: Start the Frontend (Terminal 2)

```powershell
cd frontend

# Install packages (if first time):
npm install

# Start the Vite development server:
npm run dev
```
> The frontend opens at: `http://localhost:5173`

---

## ✉️ Setting Up Real Email (Gmail SMTP)

To have the system send real emails to your employees when you assign tasks:

1. Go to your **Google Account** &rarr; **Security**.
2. Under "How you sign in to Google", ensure **2-Step Verification** is turned **ON**.
3. In the search bar at the top of your Google Account, search for **"App passwords"** (or visit `https://myaccount.google.com/apppasswords`).
4. Type an app name (e.g. `Office Task Hub`) and click **Create**.
5. Google will display a **16-character password** (e.g., `abcd efgh ijkl mnop`).
6. Open `backend/.env` and update the settings:
   ```env
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USERNAME=your-email@gmail.com
   SMTP_PASSWORD=abcd efgh ijkl mnop
   SMTP_FROM=your-email@gmail.com
   FRONTEND_URL=http://localhost:5173
   ```
7. Restart the backend (`python app.py`).
8. In the dashboard topbar, click the **"Email Center"** button and use the **"Send Test Email"** tool to verify delivery to your inbox!

*(Note: If you leave `SMTP_USERNAME` empty, the system runs in Demo Outbox mode where every email is safely generated and previewable in the UI!)*

---

## 📱 How to Use the Team Member Status Portal

1. On the main dashboard, locate any team member in **"Who is Working"** or **"Team Status & Direct Links"**.
2. Click **"Copy Status Link"** (e.g. `http://localhost:5173/?portal=1`).
3. Send this link to the team member via WhatsApp, Email, or Slack.
4. When the employee opens the link:
   - They see their personal dashboard with all assigned tasks.
   - They can click **"In Progress"**, **"Submit for Review"**, or **"Completed"**.
   - They can type a progress note (e.g. *"Completed backend testing, awaiting review"*).
   - As soon as they update it, the manager's dashboard and the virtual office avatars reflect the new status live!
