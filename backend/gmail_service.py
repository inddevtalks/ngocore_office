"""
Gmail integration for the Mail page.

Uses OAuth 2.0 with Google's installed-app flow. Tokens are encrypted with
SECRET_KEY before they touch the database, and the refresh token is never sent
to the browser.

Scope is read-only on purpose: gmail.readonly lets the Mail page list and open
messages. Sending from this module is deliberately not implemented, so a
mis-click in the app can never email your team. Task-assignment email already
goes out through emailer.py.
"""

import base64
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me"

SCOPES = "https://www.googleapis.com/auth/gmail.readonly"

TOKEN_KEY = "gmail_oauth_token"


class GmailNotConfigured(Exception):
    pass


def is_configured():
    """True when both Google OAuth values are present."""
    from emailer import ENV_PATH
    import os
    return bool(
        os.getenv("GOOGLE_CLIENT_ID", "").strip()
        and os.getenv("GOOGLE_CLIENT_SECRET", "").strip()
    )


def client_config():
    import os
    client_id = os.getenv("GOOGLE_CLIENT_ID", "").strip()
    secret = os.getenv("GOOGLE_CLIENT_SECRET", "").strip()
    if not client_id or not secret:
        raise GmailNotConfigured(
            "Gmail is not set up. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET "
            "to your environment variables."
        )
    return client_id, secret


def redirect_uri():
    """Where Google sends the user back to. Override for tunnels or proxies."""
    import os
    override = os.getenv("GOOGLE_REDIRECT_URI", "").strip()
    if override:
        return override
    base = os.getenv("FRONTEND_URL", "").strip() or "http://localhost:5173"
    return base.rstrip("/") + "/api/mail/callback"


def auth_url(state=None):
    import os
    client_id, _ = client_config()
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri(),
        "response_type": "code",
        "scope": SCOPES,
        "access_type": "offline",       # gives us a refresh token
        "prompt": "consent",            # so we get one even on repeat logins
        "include_granted_scopes": "true",
    }
    if state:
        params["state"] = state
    return AUTH_URL + "?" + urllib.parse.urlencode(params)


def _post_token(payload):
    client_id, secret = client_config()
    body = urllib.parse.urlencode({**payload, "client_id": client_id, "client_secret": secret})
    req = urllib.request.Request(
        TOKEN_URL, data=body.encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        try:
            detail = json.loads(detail).get("error_description", detail)
        except Exception:
            pass
        raise RuntimeError(f"Google rejected the token request: {detail[:160]}")


def exchange_code(code):
    """Turn the authorisation code into tokens and store them encrypted."""
    from emailer import encrypt_secret

    tokens = _post_token({
        "code": code,
        "grant_type": "authorization_code",
        "redirect_uri": redirect_uri(),
    })

    access = tokens.get("access_token", "")
    refresh = tokens.get("refresh_token", "")
    if not refresh:
        # Happens when Google thinks we already granted access.
        raise RuntimeError(
            "Google did not return a refresh token. Revoke the app at "
            "myaccount.google.com/permissions, then connect again."
        )

    payload = {
        "access_token": access,
        "refresh_token": encrypt_secret(refresh),
        "expires_at": (datetime.utcnow() + timedelta(seconds=int(tokens.get("expires_in", 3600)))).isoformat(),
        "email": _probe_email(access),
    }

    from app import AppSetting, db

    row = AppSetting.query.filter_by(key=TOKEN_KEY).first()
    if row:
        row.value = encrypt_secret(json.dumps(payload))
    else:
        db.session.add(AppSetting(key=TOKEN_KEY, value=encrypt_secret(json.dumps(payload))))
    db.session.commit()
    return {"email": payload["email"], "connected": True}


def _stored_token():
    """Load and decrypt the token bundle."""
    from emailer import decrypt_secret
    from app import AppSetting

    row = AppSetting.query.filter_by(key=TOKEN_KEY).first()
    if not row or not row.value:
        return None
    raw = decrypt_secret(row.value)
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


def _api_get(path, token, params=None):
    url = GMAIL_API + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise PermissionError("Gmail rejected the token. Reconnect your account.")
        detail = e.read().decode("utf-8", "replace")
        raise RuntimeError(f"Gmail API error {e.code}: {detail[:160]}")


def get_access_token():
    """Return a valid access token, refreshing it when needed."""
    stored = _stored_token()
    if not stored:
        raise PermissionError("Gmail is not connected yet.")

    expires_at = datetime.fromisoformat(stored["expires_at"]) if stored.get("expires_at") else None
    if expires_at and expires_at > datetime.utcnow() + timedelta(minutes=2):
        return stored["access_token"]

    from emailer import encrypt_secret, decrypt_secret
    refresh = decrypt_secret(stored.get("refresh_token", ""))
    if not refresh:
        raise PermissionError("Stored Gmail token could not be decrypted. Reconnect.")

    tokens = _post_token({
        "refresh_token": refresh,
        "grant_type": "refresh_token",
    })

    stored["access_token"] = tokens.get("access_token", "")
    stored["expires_at"] = (
        datetime.utcnow() + timedelta(seconds=int(tokens.get("expires_in", 3600)))
    ).isoformat()

    from app import AppSetting, db
    row = AppSetting.query.filter_by(key=TOKEN_KEY).first()
    if row:
        row.value = encrypt_secret(json.dumps(stored))
    else:
        db.session.add(AppSetting(key=TOKEN_KEY, value=encrypt_secret(json.dumps(stored))))
    db.session.commit()

    return stored["access_token"]


def _probe_email(access_token):
    """Look up the connected address so the UI can show which account it is."""
    try:
        profile = _api_get("/messages/profile", access_token, {"fields": "emailAddress"})
        return profile.get("emailAddress", "")
    except Exception:
        return ""


def connection_status():
    import os
    stored = _stored_token() if is_configured() else None
    return {
        "configured": is_configured(),
        "connected": bool(stored),
        "email": (stored or {}).get("email", ""),
        "missing_env": [
            name for name in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET")
            if not os.getenv(name, "").strip()
        ],
    }


def disconnect():
    from app import AppSetting, db
    row = AppSetting.query.filter_by(key=TOKEN_KEY).first()
    if row:
        db.session.delete(row)
        db.session.commit()
    return True


def _strip_html(html):
    text = re.sub(r"<style[^>]*>.*?</style>", " ", html, flags=re.S | re.I)
    text = re.sub(r"<script[^>]*>.*?</script>", " ", text, flags=re.S | re.I)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</p>", "\n\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = (
        text.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<")
        .replace("&gt;", ">").replace("&quot;", '"').replace("&#39;", "'")
    )
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _decode_body(message):
    """Pull the plain-text or HTML part out of a Gmail message payload."""
    def walk(part):
        if part.get("mimeType") == "text/plain" and part.get("body", {}).get("data"):
            return part["body"]["data"]
        for child in part.get("parts", []) or []:
            found = walk(child)
            if found:
                return found
        return None

    data = walk(message.get("payload", {}))
    if not data:
        return ""
    try:
        raw = base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode("utf-8", "replace")
    except Exception:
        return ""
    if "<" in raw and ">" in raw:
        return _strip_html(raw)
    return raw.strip()


def _header(message, name):
    for h in message.get("payload", {}).get("headers", []):
        if h.get("name", "").lower() == name.lower():
            return h.get("value", "")
    return ""


def list_messages(query="", max_results=25):
    """List inbox messages, newest first."""
    token = get_access_token()
    params = {"maxResults": min(max_results, 50)}
    if query:
        params["q"] = query
    result = _api_get("/messages", token, params)

    messages = []
    for item in result.get("messages", [])[:max_results]:
        detail = _api_get(f"/messages/{item['id']}", token, {
            "format": "metadata",
            "metadataHeaders": "From",
            "metadataHeaders": "Subject",
            "metadataHeaders": "Date",
        })
        messages.append({
            "id": item["id"],
            "thread_id": item.get("threadId"),
            "from": _header(detail, "From"),
            "subject": _header(detail, "Subject") or "(no subject)",
            "date": _header(detail, "Date"),
            "snippet": detail.get("snippet", ""),
            "unread": "UNREAD" in detail.get("labelIds", []),
        })
    return messages


def read_message(message_id):
    """Full body of one message."""
    token = get_access_token()
    detail = _api_get(f"/messages/{message_id}", token, {"format": "full"})
    return {
        "id": detail.get("id"),
        "from": _header(detail, "From"),
        "to": _header(detail, "To"),
        "subject": _header(detail, "Subject") or "(no subject)",
        "date": _header(detail, "Date"),
        "body": _decode_body(detail),
        "snippet": detail.get("snippet", ""),
    }


def sent_notifications(limit=30):
    """
    Emails this system sent, from the existing outbox.

    Shown alongside the Gmail inbox so the Mail page is useful even before
    Gmail is connected.
    """
    from emailer import get_outbox
    outbox = get_outbox(limit=limit)
    return [
        {
            "id": f"outbox-{e.get('id')}",
            "from": "Office Task Hub",
            "to": e.get("to"),
            "subject": e.get("subject"),
            "date": e.get("timestamp"),
            "snippet": (e.get("body_text") or "")[:200],
            "status": e.get("status"),
            "source": "outbox",
        }
        for e in outbox
    ]