import React, { useState, useEffect } from "react";
import {
  Mail, Send, CheckCircle2, AlertCircle, X, Shield, Key,
  ExternalLink, Eye, RefreshCw, Sparkles, HelpCircle, Settings, Check
} from "lucide-react";

export default function EmailCenterModal({ onClose, onSmtpUpdated }) {
  const [data, setData] = useState({ smtp: {}, outbox: [] });
  const [loading, setLoading] = useState(true);
  const [testEmail, setTestEmail] = useState("");
  const [testSending, setTestSending] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [previewEmail, setPreviewEmail] = useState(null);
  const [showGuide, setShowGuide] = useState(false);
  const [showConfigForm, setShowConfigForm] = useState(false);

  // SMTP Settings Form
  const [configForm, setConfigForm] = useState({
    host: "smtp.gmail.com",
    port: 587,
    username: "",
    password: "",
    from_email: "",
  });
  const [configSaving, setConfigSaving] = useState(false);
  const [configResult, setConfigResult] = useState(null);

  async function loadOutbox() {
    try {
      setLoading(true);
      const res = await fetch("/api/email/outbox", { credentials: "same-origin" });
      if (res.status === 401) {
        // Session expired while this modal was open; let the dashboard handle it.
        return;
      }
      const json = await res.json();
      setData(json);
      if (json.smtp) {
        setConfigForm(prev => ({
          ...prev,
          host: json.smtp.host || "smtp.gmail.com",
          port: json.smtp.port || 587,
          username: json.smtp.username || "",
          from_email: json.smtp.from_email || json.smtp.username || "",
        }));
        // Only nag for credentials when there genuinely are none. Once saved to
        // the database this stays closed across refreshes.
        if (!json.smtp.configured) {
          setShowConfigForm(true);
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadOutbox();
  }, []);

  async function handleSaveConfig(e) {
    e.preventDefault();
    try {
      setConfigSaving(true);
      setConfigResult(null);
      const res = await fetch("/api/email/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(configForm),
      });
      const json = await res.json();
      if (!res.ok) {
        setConfigResult({ ok: false, message: json.error || "Failed to save SMTP settings." });
      } else {
        setConfigResult({ ok: true, message: json.message || "Settings saved!" });
        // Credentials now live in the database, so close the form rather than
        // leaving it open to be re-entered on every refresh.
        setShowConfigForm(false);
        loadOutbox();
        if (onSmtpUpdated) onSmtpUpdated();
        if (configForm.username) {
          setTestEmail(configForm.username);
        }
      }
    } catch (err) {
      setConfigResult({ ok: false, message: err.message });
    } finally {
      setConfigSaving(false);
    }
  }

  async function handleSendTest(e) {
    e.preventDefault();
    if (!testEmail) return;
    try {
      setTestSending(true);
      setTestResult(null);
      const res = await fetch("/api/email/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ to_email: testEmail }),
      });
      const json = await res.json();
      if (!res.ok) {
        setTestResult({ ok: false, message: json.error || "Failed to send test email." });
      } else {
        setTestResult({ ok: true, message: json.message || "Test email sent successfully!" });
        loadOutbox();
      }
    } catch (err) {
      setTestResult({ ok: false, message: err.message });
    } finally {
      setTestSending(false);
    }
  }

  const { smtp, outbox } = data;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal email-center-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title-with-icon">
            <div className="modal-icon-badge"><Mail size={18} /></div>
            <div>
              <h2>Email Notification Center & Outbox</h2>
              <p>Configure SMTP, verify email delivery, and view dispatched notifications.</p>
            </div>
          </div>
          <button className="close-btn" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="email-modal-body">
          {/* SMTP Status Alert Card */}
          <div className={`smtp-status-card ${smtp.configured ? "configured" : "demo"}`}>
            <div className="status-indicator">
              <span className={`status-dot ${smtp.configured ? "green" : "gold"}`} />
              <div>
                <strong>
                  {smtp.configured
                    ? "Live SMTP Connected — Delivering Real Emails"
                    : "Demo & Outbox Mode Active (Safe Preview)"}
                </strong>
                <p>
                  {smtp.configured
                    ? `Emails are dispatched live via ${smtp.host} as ${smtp.from_email}.`
                    : "No emails will fail — they are safely logged in the Outbox below. Configure your credentials to enable real Gmail delivery."}
                </p>
              </div>
            </div>

            <div className="smtp-header-actions">
              <button
                className="toggle-config-btn"
                onClick={() => setShowConfigForm(!showConfigForm)}
              >
                <Settings size={14} />
                {showConfigForm ? "Close Settings" : "Configure SMTP"}
              </button>
              <button
                className="toggle-guide-btn"
                onClick={() => setShowGuide(!showGuide)}
              >
                <HelpCircle size={14} />
                {showGuide ? "Hide Guide" : "Gmail Guide"}
              </button>
            </div>
          </div>

          {/* Quick SMTP In-App Configuration Form */}
          {showConfigForm && (
            <div className="smtp-config-box">
              <div className="config-box-head">
                <h4><Key size={15} /> Enter Your Email / SMTP Credentials</h4>
                <p>Enter your details here to send live assignment emails directly to your team.</p>
              </div>

              <form onSubmit={handleSaveConfig} className="smtp-form">
                <div className="form-row">
                  <label>
                    SMTP Host
                    <input
                      value={configForm.host}
                      onChange={e => setConfigForm({ ...configForm, host: e.target.value })}
                      placeholder="smtp.gmail.com"
                      required
                    />
                  </label>
                  <label>
                    SMTP Port
                    <input
                      type="number"
                      value={configForm.port}
                      onChange={e => setConfigForm({ ...configForm, port: parseInt(e.target.value) || 587 })}
                      placeholder="587"
                      required
                    />
                  </label>
                </div>

                <div className="form-row">
                  <label>
                    Your Email Address (Username)
                    <input
                      type="email"
                      value={configForm.username}
                      onChange={e => setConfigForm({ ...configForm, username: e.target.value, from_email: configForm.from_email || e.target.value })}
                      placeholder="your-name@gmail.com"
                      required
                    />
                  </label>
                  <label>
                    Google App Password (16 characters)
                    <input
                      type="password"
                      value={configForm.password}
                      onChange={e => setConfigForm({ ...configForm, password: e.target.value })}
                      placeholder="abcd efgh ijkl mnop"
                      required
                    />
                  </label>
                </div>

                <div className="form-row">
                  <label>
                    From Email Address
                    <input
                      type="email"
                      value={configForm.from_email}
                      onChange={e => setConfigForm({ ...configForm, from_email: e.target.value })}
                      placeholder="your-name@gmail.com"
                    />
                  </label>
                  <div className="form-actions-inline">
                    <button
                      type="submit"
                      className="primary-btn sm full"
                      disabled={configSaving}
                    >
                      {configSaving ? "Saving & Connecting..." : "Save SMTP Credentials"}
                    </button>
                  </div>
                </div>

                {configResult && (
                  <div className={`test-feedback ${configResult.ok ? "success" : "error"}`}>
                    {configResult.ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
                    <span>{configResult.message}</span>
                  </div>
                )}
              </form>
            </div>
          )}

          {/* Expandable Gmail Setup Instructions */}
          {showGuide && (
            <div className="gmail-setup-guide">
              <div className="guide-title"><Key size={16} /> How to get a Gmail App Password in 2 minutes:</div>
              <ol className="guide-steps">
                <li>
                  Open your <b>Google Account</b> &rarr; <b>Security</b> &rarr; Make sure <b>2-Step Verification</b> is turned ON.
                </li>
                <li>
                  Go to <b><a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" style={{ color: "#54d8d1" }}>myaccount.google.com/apppasswords</a></b>.
                </li>
                <li>
                  Create an App Password (name it <b>"Office Hub"</b>) and copy the generated 16-character code (e.g. <code>abcd efgh ijkl mnop</code>).
                </li>
                <li>
                  Paste it in the form above and click <b>"Save SMTP Credentials"</b>!
                </li>
              </ol>
            </div>
          )}

          {/* Test Email Section */}
          <div className="test-email-box">
            <h4><Send size={15} /> Send a Test Email</h4>
            <form onSubmit={handleSendTest} className="test-email-form">
              <input
                type="email"
                placeholder="Enter recipient email (e.g. your-email@gmail.com)"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                required
              />
              <button
                type="submit"
                className="primary-btn sm"
                disabled={testSending}
              >
                {testSending ? "Sending..." : "Send Test"}
              </button>
            </form>

            {testResult && (
              <div className={`test-feedback ${testResult.ok ? "success" : "error"}`}>
                {testResult.ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
                <span>{testResult.message}</span>
              </div>
            )}
          </div>

          {/* Outbox Audit Log */}
          <div className="outbox-section">
            <div className="outbox-head">
              <h4>Recent Task Notifications & Outbox Log ({outbox.length})</h4>
              <button className="icon-btn sm" onClick={loadOutbox} title="Refresh log">
                <RefreshCw size={13} className={loading ? "spin" : ""} />
              </button>
            </div>

            {outbox.length === 0 ? (
              <div className="outbox-empty">
                <Mail size={24} />
                <p>No emails logged yet. Assign a task to generate an automated notification!</p>
              </div>
            ) : (
              <div className="outbox-list">
                {outbox.map((item) => (
                  <div key={item.id} className="outbox-item">
                    <div className="oi-left">
                      <span className={`status-badge-email ${item.status}`}>
                        {item.status === "sent" ? "Delivered" : item.status === "simulated" ? "Outbox Log" : "Failed"}
                      </span>
                      <div className="oi-details">
                        <strong className="oi-subject">{item.subject}</strong>
                        <div className="oi-meta">
                          To: <b>{item.to}</b> &bull; {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </div>
                    </div>

                    <button
                      className="preview-btn"
                      onClick={() => setPreviewEmail(item)}
                    >
                      <Eye size={13} /> Preview Body
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Email Preview Drawer/Modal */}
        {previewEmail && (
          <div className="preview-overlay" onClick={() => setPreviewEmail(null)}>
            <div className="preview-card" onClick={(e) => e.stopPropagation()}>
              <div className="pc-head">
                <div>
                  <strong>Email Preview: {previewEmail.subject}</strong>
                  <div className="pc-to">Recipient: {previewEmail.to}</div>
                </div>
                <button className="close-btn" onClick={() => setPreviewEmail(null)}><X size={16} /></button>
              </div>
              <div className="pc-body">
                {previewEmail.body_html ? (
                  <div
                    className="email-html-render"
                    dangerouslySetInnerHTML={{ __html: previewEmail.body_html }}
                  />
                ) : (
                  <pre className="email-text-render">{previewEmail.body_text}</pre>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
