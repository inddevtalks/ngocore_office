"""
Automated security review for a public website.

Runs a passive, read-only audit: it reads response headers, the TLS
certificate, and a short fixed list of well-known paths that should not be
publicly readable. It never sends credentials, never submits forms, never
tries to exploit anything, and never writes to the target.

Everything here uses the standard library plus qa_bot's fetch helper, so the
bundle stays small.
"""

import re
import socket
import ssl
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from qa_bot import fetch, normalise_url

# A short, fixed set of paths that are commonly left readable by accident.
# These are ordinary GET requests for files that should return 404.
SENSITIVE_PATHS = [
    ("/.env", "Environment file with secrets"),
    ("/.env.local", "Local environment file"),
    ("/.git/config", "Git repository config"),
    ("/.git/HEAD", "Git repository HEAD"),
    ("/package.json", "Node dependency manifest"),
    ("/package-lock.json", "Dependency lockfile"),
    ("/composer.json", "PHP dependency manifest"),
    ("/wp-config.php.bak", "WordPress config backup"),
    ("/config.json", "Application config"),
    ("/.DS_Store", "macOS directory listing"),
    ("/server-status", "Apache status page"),
    ("/phpinfo.php", "PHP configuration dump"),
]

# Headers that should be present on a public site.
EXPECTED_HEADERS = [
    ("strict-transport-security", "HSTS", "critical",
     "Tells browsers to only ever use HTTPS. Without it a visitor can be "
     "downgraded to http:// by anyone on the network."),
    ("content-security-policy", "CSP", "warning",
     "Limits where scripts and styles may be loaded from, which is the main "
     "defence against cross-site scripting."),
    ("x-content-type-options", "X-Content-Type-Options", "warning",
     "Stops browsers guessing a file's type, which prevents MIME confusion."),
    ("x-frame-options", "X-Frame-Options", "warning",
     "Stops other sites framing yours, which prevents clickjacking."),
    ("referrer-policy", "Referrer-Policy", "info",
     "Controls how much of the current URL is sent to other sites."),
    ("permissions-policy", "Permissions-Policy", "info",
     "Restricts access to camera, microphone and similar browser features."),
]

SEVERITY_WEIGHT = {"critical": 0, "warning": 1, "info": 2}


def check_tls(base_url):
    """Certificate validity and expiry for the site's hostname."""
    parsed = urllib.parse.urlparse(base_url)
    host = parsed.hostname
    if not host:
        return None

    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    info = {"host": host, "valid": False, "issuer": None, "expires": None,
            "days_left": None, "tls_version": None, "error": None}

    try:
        context = ssl.create_default_context()
        with socket.create_connection((host, port), timeout=12) as sock:
            with context.wrap_socket(sock, server_hostname=host) as tls:
                cert = tls.getpeercert()
                info["valid"] = True
                info["tls_version"] = tls.version()
                info["issuer"] = dict(x[0] for x in cert.get("issuer", ())).get(
                    "organizationName", "unknown"
                )
                not_after = cert.get("notAfter")
                if not_after:
                    expiry = datetime.strptime(not_after, "%b %d %H:%M:%S %Y %Z").replace(
                        tzinfo=timezone.utc
                    )
                    info["expires"] = expiry.isoformat()
                    info["days_left"] = (expiry - datetime.now(timezone.utc)).days
    except ssl.SSLCertVerificationError as e:
        info["error"] = f"Certificate not trusted: {e.verify_message or e}"
    except Exception as e:
        info["error"] = str(e)[:100]

    return info


def check_headers(base_url):
    """Presence and quality of the standard security headers.

    Returns (headers, status, findings, incomplete). When the host's bot
    protection refuses our request, the header findings are suppressed and
    `incomplete` is True, because "we could not read the headers" is not
    evidence of a problem.
    """
    parsed = urllib.parse.urlparse(base_url)

    # Reuse qa_bot's fetch so we send the same headers that already get
    # through; a plain "Accept: */*" is refused by some edge firewalls.
    result = fetch(base_url, timeout=20)

    if result.status == 0 or result.status >= 400:
        return None, result.status, [], (
            f"Could not read response headers (HTTP {result.status}). The host's "
            "firewall refused this automated request, so the header checks were "
            "skipped rather than reported as problems."
        )

    headers = result.headers
    status = result.status
    findings = []

    for header, label, severity, why in EXPECTED_HEADERS:
        if not headers.get(header):
            findings.append({
                "severity": severity, "category": "headers",
                "message": f"Missing {label} header. {why}",
            })

    # HSTS is present on many hosts but sometimes with a useless max-age.
    hsts = headers.get("strict-transport-security", "")
    if hsts and "max-age" in hsts:
        match = re.search(r"max-age=(\d+)", hsts)
        if match and int(match.group(1)) < 15552000:
            findings.append({
                "severity": "info", "category": "headers",
                "message": f"HSTS max-age is only {int(match.group(1))} seconds "
                           "(under 180 days). Long-lived values are more protective.",
            })

    cors = headers.get("access-control-allow-origin")
    if cors == "*":
        findings.append({
            "severity": "warning", "category": "cors",
            "message": "Access-Control-Allow-Origin is a wildcard (*), so any "
                       "website can read responses from this site. Fine for "
                       "public assets, risky if API responses carry user data.",
        })

    if parsed.scheme != "https":
        findings.append({
            "severity": "critical", "category": "tls",
            "message": "Site is not served over HTTPS.",
        })

    # Cookie flags only matter if the site actually sets cookies.
    set_cookie = headers.get("set-cookie", "")
    if set_cookie:
        if "secure" not in set_cookie.lower():
            findings.append({
                "severity": "warning", "category": "cookies",
                "message": "A cookie is set without the Secure flag, so it will "
                           "still be sent over plain HTTP.",
            })
        if "httponly" not in set_cookie.lower():
            findings.append({
                "severity": "warning", "category": "cookies",
                "message": "A cookie is set without the HttpOnly flag, so "
                           "JavaScript can read it.",
            })
        if "samesite" not in set_cookie.lower():
            findings.append({
                "severity": "info", "category": "cookies",
                "message": "A cookie is set without SameSite, which weakens "
                           "cross-site request forgery protection.",
            })

    return headers, status, findings, None


def check_sensitive_paths(base_url):
    """Confirm that well-known secret files are not publicly readable."""
    findings = []
    results = []

    for path, description in SENSITIVE_PATHS:
        result = fetch(base_url.rstrip("/") + path, timeout=12)
        exposed = result.status == 200 and len(result.body) > 0

        # A 404 is the correct answer. So is a 401/403.
        results.append({"path": path, "status": result.status, "exposed": exposed})

        if exposed:
            findings.append({
                "severity": "critical", "category": "exposed_files",
                "message": f"{path} is publicly readable ({description}). "
                           "Anyone can download it. Remove it from the deploy.",
            })

    return results, findings


def check_information_leak(headers, html):
    """Server banners, version strings and stray secrets in the markup."""
    findings = []

    server = headers.get("server", "") if headers else ""
    powered_by = headers.get("x-powered-by", "") if headers else ""
    if server and server.lower() not in ("cloudflare", "vercel"):
        findings.append({
            "severity": "info", "category": "info_disclosure",
            "message": f"Server banner reveals '{server}'. Consider suppressing it.",
        })
    if powered_by:
        findings.append({
            "severity": "info", "category": "info_disclosure",
            "message": f"X-Powered-By reveals '{powered_by}'.",
        })

    if html:
        # Source maps let anyone read your original source code.
        if ".js.map" in html:
            findings.append({
                "severity": "warning", "category": "info_disclosure",
                "message": "The page references a .js.map source map, which "
                           "publishes your original source to anyone.",
            })

        # API keys and tokens pasted into client-side code.
        patterns = [
            (r"sk-[A-Za-z0-9]{20,}", "an OpenAI-style API key"),
            (r"AKIA[0-9A-Z]{16}", "an AWS access key id"),
            (r"ghp_[A-Za-z0-9]{36}", "a GitHub personal access token"),
            (r"AIza[0-9A-Za-z_-]{35}", "a Google API key"),
            (r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", "a private key"),
            (r"(?:password|secret|api[_-]?key)\s*[:=]\s*['\"][^'\"]{12,}['\"]",
             "a hardcoded credential"),
        ]
        for pattern, what in patterns:
            match = re.search(pattern, html)
            if match:
                snippet = match.group(0)[:24]
                findings.append({
                    "severity": "critical", "category": "secrets",
                    "message": f"Found {what} in the delivered HTML "
                               f"(starting '{snippet}...'). Anything sent to a "
                               "browser is public. Rotate it immediately.",
                })

        # Plain http:// subresources on an https page.
        insecure = set(re.findall(r'(?:src|href)="http://(?!localhost|127\.0\.0\.1)[^"]+"', html))
        if insecure:
            hosts = ", ".join(sorted({h.split("/")[0] for h in insecure})[:3])
            findings.append({
                "severity": "warning", "category": "mixed_content",
                "message": f"Page loads resources over plain HTTP from {hosts}. "
                           "Browsers block these on an HTTPS page.",
            })

    return findings


def check_security_txt(base_url):
    """security.txt tells researchers how to report a vulnerability."""
    url = base_url.rstrip("/") + "/.well-known/security.txt"
    result = fetch(url, timeout=12)
    if result.status != 200:
        return {
            "present": False,
            "finding": {
                "severity": "info", "category": "disclosure",
                "message": "No /.well-known/security.txt. Adding one tells "
                           "researchers how to report vulnerabilities to you "
                           "instead of publishing them publicly.",
            },
        }
    return {"present": True, "finding": None, "body": result.body[:400]}


def grade(findings, blocked=None):
    """Overall risk grade, worst finding wins.

    A blocked scan is reported as "inconclusive" rather than "healthy",
    because reporting all-clear when nothing could be checked is worse than
    reporting nothing.
    """
    if blocked:
        return "inconclusive"
    if any(f["severity"] == "critical" for f in findings):
        return "critical"
    if any(f["severity"] == "warning" for f in findings):
        return "warning"
    return "healthy"


GRADE_COPY = {
    "healthy": "No security problems found.",
    "warning": "Some security improvements recommended.",
    "critical": "Action needed. At least one serious problem found.",
    "inconclusive": "Scan incomplete. The site could not be fully reviewed.",
}


def build_summary(grade_result, findings, scanned_paths, blocked=None):
    critical = sum(1 for f in findings if f["severity"] == "critical")
    warnings = sum(1 for f in findings if f["severity"] == "warning")

    parts = [GRADE_COPY[grade_result]]
    if blocked:
        parts.append(
            "This host's bot protection refused the automated request, so the "
            "header checks did not run. Treat this as untested rather than safe."
        )
        return " ".join(parts)

    if findings:
        parts.append(
            f"{critical} critical, {warnings} warning and "
            f"{len(findings) - critical - warnings} advisory findings "
            f"across {scanned_paths} checks."
        )
    else:
        parts.append(f"All {scanned_paths} checks passed cleanly.")
    return " ".join(parts)


def run_security_check(base_url):
    """Run every security pass. Returns a plain dict ready for storage."""
    base_url = base_url.rstrip("/")
    findings = []

    tls = check_tls(base_url)
    if tls and not tls["valid"] and tls["error"]:
        findings.append({
            "severity": "critical", "category": "tls",
            "message": f"TLS problem: {tls['error']}",
        })
    elif tls and tls["days_left"] is not None and tls["days_left"] < 15:
        findings.append({
            "severity": "critical", "category": "tls",
            "message": f"TLS certificate expires in {tls['days_left']} days. "
                       "Renew it before it lapses or browsers will warn visitors.",
        })
    elif tls and tls["days_left"] is not None and tls["days_left"] < 45:
        findings.append({
            "severity": "warning", "category": "tls",
            "message": f"TLS certificate expires in {tls['days_left']} days.",
        })

    headers, status, header_findings, blocked = check_headers(base_url)
    findings.extend(header_findings)
    if blocked:
        # Recorded as an advisory, not a critical: a blocked scan is a gap in
        # our coverage, not a defect in the site.
        findings.append({
            "severity": "info", "category": "scan_limit",
            "message": blocked,
        })

    paths, path_findings = check_sensitive_paths(base_url)
    findings.extend(path_findings)

    home = fetch(base_url, timeout=20)
    if home.status == 200 and home.body:
        findings.extend(check_information_leak(home.headers or headers, home.body))

    security_txt = check_security_txt(base_url)
    if security_txt.get("finding"):
        findings.append(security_txt["finding"])

    findings.sort(key=lambda f: SEVERITY_WEIGHT.get(f["severity"], 3))

    grade_result = grade(findings, blocked)
    scanned = len(SENSITIVE_PATHS) + len(EXPECTED_HEADERS) + 4

    return {
        "status": grade_result,
        "summary": build_summary(grade_result, findings, scanned, blocked),
        "scan_blocked": bool(blocked),
        "findings": findings,
        "critical_count": sum(1 for f in findings if f["severity"] == "critical"),
        "warning_count": sum(1 for f in findings if f["severity"] == "warning"),
        "info_count": sum(1 for f in findings if f["severity"] == "info"),
        "tls": tls,
        "headers_checked": [h[1] for h in EXPECTED_HEADERS],
        "paths_checked": paths,
        "security_txt": security_txt.get("present", False),
        "homepage_status": status,
        "checked_at": datetime.utcnow().isoformat(),
    }