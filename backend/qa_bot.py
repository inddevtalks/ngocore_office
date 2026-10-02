"""
Automated QA checks for ngocore.in.

Runs a set of standard quality-assurance passes against the public site and
records the results, so the manager can see what changed and what broke
without opening the site manually.

Deliberately dependency-free: only the Python standard library, because this
runs inside a serverless function where every dependency costs bundle size.
"""

import difflib
import hashlib
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from html.parser import HTMLParser

USER_AGENT = "NgocoreOffice-QABot/1.0 (+https://ngocore-office.vercel.app)"
REQUEST_TIMEOUT = 20

# A page slower than this is flagged. Generous enough not to cry wolf on a
# cold Next.js start, tight enough to catch real regressions.
SLOW_MS = 3000

# Anything larger than this is a runaway asset worth flagging.
LARGE_BYTES = 3_000_000


class FetchResult:
    def __init__(self, path, status, ms, body, error=None, headers=None):
        self.path = path
        self.status = status
        self.ms = ms
        self.body = body
        self.error = error
        # Lower-cased header names, so callers can check presence without guessing.
        self.headers = headers or {}


def fetch(url, timeout=REQUEST_TIMEOUT):
    """GET a URL and time it. Never raises; failures come back as data."""
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,*/*",
            "Accept-Language": "en-IN,en;q=0.9",
        },
    )
    start = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            charset = response.headers.get_content_charset() or "utf-8"
            return FetchResult(
                url, response.status, int((time.perf_counter() - start) * 1000),
                raw.decode(charset, "replace"),
                headers={k.lower(): v for k, v in response.getheaders()},
            )
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")
        except Exception:
            pass
        return FetchResult(
            url, e.code, int((time.perf_counter() - start) * 1000), body, f"HTTP {e.code}",
            headers={k.lower(): v for k, v in (e.headers.items() if e.headers else [])},
        )
    except Exception as e:
        return FetchResult(
            url, 0, int((time.perf_counter() - start) * 1000), "", str(e)[:120]
        )


class PageInspector(HTMLParser):
    """Pulls the bits QA cares about out of a page."""

    def __init__(self):
        super().__init__()
        self.links = []
        self.assets = []
        self.images = 0
        self.images_missing_alt = 0
        self.h1_count = 0
        self.title = None
        self.meta_description = None
        self.canonical = None
        self.og_title = None
        self.lang = None
        self.has_viewport = False
        self.form_count = 0
        self.inputs_missing_label = 0
        self._in_title = False
        self._skip_depth = 0
        self._in_script_or_style = False
        self.text_chunks = []

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): v for k, v in attrs}

        if tag in ("script", "style", "noscript"):
            self._in_script_or_style = True

        if tag == "a" and a.get("href"):
            self.links.append(a["href"])
        elif tag == "img":
            self.images += 1
            if not a.get("alt"):
                self.images_missing_alt += 1
            if a.get("src"):
                self.assets.append(a["src"])
        elif tag == "script" and a.get("src"):
            self.assets.append(a["src"])
        elif tag == "link" and a.get("href") and a.get("rel") in (
            "stylesheet", "icon", "preload", "manifest",
        ):
            self.assets.append(a["href"])
        elif tag == "form":
            self.form_count += 1
        elif tag in ("input", "select", "textarea"):
            has_label = (
                a.get("aria-label")
                or a.get("aria-labelledby")
                or a.get("id")
                or a.get("title")
            )
            if not has_label and a.get("type", "text") not in ("hidden", "submit"):
                self.inputs_missing_label += 1

        if tag == "h1":
            self.h1_count += 1
        if tag == "html":
            self.lang = a.get("lang")
        if tag == "meta":
            if a.get("name", "").lower() == "description":
                self.meta_description = a.get("content")
            if a.get("name", "").lower() == "viewport":
                self.has_viewport = True
            if a.get("property", "").lower() == "og:title":
                self.og_title = a.get("content")
        if tag == "link" and (a.get("rel") or "").lower() == "canonical":
            self.canonical = a.get("href")
        if tag == "title":
            self._in_title = True

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        if tag in ("script", "style", "noscript"):
            self._in_script_or_style = False

    def handle_data(self, data):
        if self._in_title:
            self.title = (self.title or "") + data.strip()
        elif not self._in_script_or_style and data.strip():
            self.text_chunks.append(data.strip())

    @property
    def text(self):
        return re.sub(r"\s+", " ", " ".join(self.text_chunks)).strip()


def normalise_url(base, href):
    """Turn a possibly relative href into an absolute URL."""
    if not href:
        return None
    href = href.strip()
    if href.startswith(("mailto:", "tel:", "javascript:", "data:", "#")):
        return None
    try:
        return urllib.parse.urljoin(base, href)
    except Exception:
        return None


def same_host(url, base_url):
    try:
        return urllib.parse.urlparse(url).netloc == urllib.parse.urlparse(base_url).netloc
    except Exception:
        return False


def is_bot_challenge(result):
    """
    True when the edge firewall challenged us rather than the site failing.

    Vercel and similar hosts answer automated traffic with 403 plus
    x-vercel-mitigated: challenge. Treating that as an outage would report the
    site as down when it is perfectly healthy.
    """
    if result.status != 403:
        return False
    return bool(
        result.headers.get("x-vercel-mitigated")
        or result.headers.get("cf-mitigated")
        or "challenge" in (result.headers.get("server") or "").lower()
    )


def check_availability(base_url):
    """Pass 1: is the site up at all?"""
    result = fetch(base_url)
    issues = []

    if is_bot_challenge(result):
        # Report as an incomplete scan, never as an outage.
        return result, [], True

    if result.status == 0:
        issues.append({
            "severity": "critical", "category": "availability",
            "message": f"Site unreachable: {result.error}",
        })
    elif result.status >= 500:
        issues.append({
            "severity": "critical", "category": "availability",
            "message": f"Server error {result.status} on the homepage.",
        })
    elif result.status >= 400:
        issues.append({
            "severity": "critical", "category": "availability",
            "message": f"Homepage returned {result.status}.",
        })

    if result.ms > SLOW_MS and result.status == 200:
        issues.append({
            "severity": "warning", "category": "performance",
            "message": f"Homepage took {result.ms}ms to respond.",
        })

    return result, issues, False


def check_pages(base_url, home_result):
    """Pass 2: every linked internal page must resolve."""
    parser = PageInspector()
    parser.feed(home_result.body)

    paths = []
    seen = set()
    for href in parser.links:
        url = normalise_url(base_url, href.split("#")[0])
        if not url or not same_host(url, base_url):
            continue
        path = urllib.parse.urlparse(url).path
        if not path or path in seen or path.startswith("/_next"):
            continue
        seen.add(path)
        paths.append(path)

    issues = []
    pages = []
    for path in paths:
        result = fetch(base_url.rstrip("/") + path)
        page_issues = []

        if result.status == 0:
            page_issues.append({
                "severity": "critical", "category": "availability",
                "message": f"{path} is unreachable: {result.error}",
            })
        elif result.status >= 400:
            page_issues.append({
                "severity": "critical", "category": "broken_link",
                "message": f"{path} returned {result.status}.",
            })
        elif result.ms > SLOW_MS:
            page_issues.append({
                "severity": "warning", "category": "performance",
                "message": f"{path} took {result.ms}ms to respond.",
            })

        title = None
        h1 = 0
        if result.status == 200 and result.body:
            sub = PageInspector()
            sub.feed(result.body)
            title, h1 = sub.title, sub.h1_count
            if not title:
                page_issues.append({
                    "severity": "warning", "category": "seo",
                    "message": f"{path} has no <title> tag.",
                })
            elif len(title) > 70:
                page_issues.append({
                    "severity": "info", "category": "seo",
                    "message": f"{path} title is {len(title)} characters (over 70).",
                })
            if h1 == 0:
                page_issues.append({
                    "severity": "warning", "category": "seo",
                    "message": f"{path} has no <h1> heading.",
                })
            elif h1 > 1:
                page_issues.append({
                    "severity": "info", "category": "seo",
                    "message": f"{path} has {h1} <h1> tags (usually one is best).",
                })

        issues.extend(page_issues)
        pages.append({
            "path": path,
            "status": result.status,
            "ms": result.ms,
            "bytes": len(result.body),
            "title": title,
            "h1_count": h1,
            "issues": len(page_issues),
        })

    return pages, issues


def check_assets(base_url, home_result):
    """Pass 3: images, scripts and stylesheets must load."""
    parser = PageInspector()
    parser.feed(home_result.body)

    urls = []
    seen = set()
    for src in parser.assets:
        url = normalise_url(base_url, src)
        if not url or not same_host(url, base_url) or url in seen:
            continue
        seen.add(url)
        urls.append(url)

    issues = []
    checked = []
    for url in urls:
        result = fetch(url, timeout=REQUEST_TIMEOUT)
        ok = result.status == 200
        if not ok:
            issues.append({
                "severity": "critical", "category": "broken_asset",
                "message": f"Asset failed to load ({result.status}): "
                           f"{urllib.parse.urlparse(url).path[-70:]}",
            })
        elif len(result.body) > LARGE_BYTES:
            issues.append({
                "severity": "warning", "category": "performance",
                "message": f"Large asset ({len(result.body) // 1024} KB): "
                           f"{urllib.parse.urlparse(url).path[-70:]}",
            })
        checked.append({
            "url": url.replace(base_url, "")[:100],
            "status": result.status,
            "bytes": len(result.body),
        })

    return checked, issues


def check_seo_and_a11y(base_url, home_result):
    """Pass 4: metadata, headings, alt text and form labels."""
    parser = PageInspector()
    parser.feed(home_result.body)
    issues = []

    if not parser.title:
        issues.append({
            "severity": "critical", "category": "seo",
            "message": "Homepage has no <title> tag.",
        })
    elif not (10 <= len(parser.title) <= 70):
        issues.append({
            "severity": "info", "category": "seo",
            "message": f"Homepage title is {len(parser.title)} characters; "
                       "aim for 10-70.",
        })

    if not parser.meta_description:
        issues.append({
            "severity": "warning", "category": "seo",
            "message": "Homepage has no meta description.",
        })
    elif len(parser.meta_description) > 165:
        issues.append({
            "severity": "info", "category": "seo",
            "message": f"Meta description is {len(parser.meta_description)} "
                       "characters; aim for under 165.",
        })

    if not parser.og_title:
        issues.append({
            "severity": "info", "category": "seo",
            "message": "No Open Graph title, so link previews on WhatsApp and "
                       "Slack may look plain.",
        })

    if not parser.canonical:
        issues.append({
            "severity": "info", "category": "seo",
            "message": "No canonical URL set on the homepage.",
        })

    if not parser.lang:
        issues.append({
            "severity": "warning", "category": "accessibility",
            "message": "Homepage <html> tag has no lang attribute.",
        })

    if not parser.has_viewport:
        issues.append({
            "severity": "critical", "category": "mobile",
            "message": "No viewport meta tag, so the site will not scale on phones.",
        })

    if parser.h1_count == 0:
        issues.append({
            "severity": "warning", "category": "seo",
            "message": "Homepage has no <h1> heading.",
        })

    if parser.images and parser.images_missing_alt:
        issues.append({
            "severity": "warning", "category": "accessibility",
            "message": f"{parser.images_missing_alt} of {parser.images} images "
                       "have no alt text, so screen readers skip them.",
        })

    if parser.inputs_missing_label:
        issues.append({
            "severity": "warning", "category": "accessibility",
            "message": f"{parser.inputs_missing_label} form field(s) have no "
                       "label or aria-label.",
        })

    return issues


def check_email_and_phone(base_url, home_result):
    """Pass 5: the contact details shown to users must be reachable.

    Flags exposed addresses for manual review rather than probing them, which
    avoids sending stray mail to the addresses found.
    """
    parser = PageInspector()
    parser.feed(home_result.body)
    issues = []

    emails = set(re.findall(r"[\w.+-]+@[\w-]+\.[\w.]+", home_result.body))
    if not emails:
        issues.append({
            "severity": "info", "category": "contact",
            "message": "No email address found on the homepage.",
        })

    return issues


def content_fingerprint(html):
    """Stable hash of the visible text, so content edits are detectable."""
    parser = PageInspector()
    parser.feed(html)
    return hashlib.sha256(parser.text.encode("utf-8")).hexdigest()


def content_diff(previous_text, current_text, limit=12):
    """Human-readable summary of what changed in the visible copy."""
    if previous_text is None:
        return [], []

    a = re.sub(r"\s+", " ", previous_text).split()
    b = re.sub(r"\s+", " ", current_text).split()
    matcher = difflib.SequenceMatcher(None, a, b)

    added, removed = [], []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "insert":
            added.append(" ".join(b[j1:j2]))
        elif tag == "delete":
            removed.append(" ".join(a[i1:i2]))

    return added[:limit], removed[:limit]


def build_summary(status, issues, pages, assets, diff, blocked=False):
    """Plain-English headline the manager reads first."""
    if blocked:
        return (
            "Scan incomplete. The host's firewall blocked this automated "
            "request, so the site could not be checked. This is not an outage."
        )

    critical = [i for i in issues if i["severity"] == "critical"]
    warnings = [i for i in issues if i["severity"] == "warning"]

    if status == "critical":
        headline = f"Site is DOWN. {critical[0]['message']}"
    elif critical:
        headline = (f"{len(critical)} critical problem"
                    f"{'s' if len(critical) != 1 else ''} found. "
                    f"{critical[0]['message']}")
    elif warnings:
        headline = (f"Site is up. {len(warnings)} warning"
                    f"{'s' if len(warnings) != 1 else ''} worth fixing.")
    else:
        headline = "Site is up and healthy. No problems found."

    parts = [headline, f"Checked {len(pages)} pages and {len(assets)} assets."]
    if diff and (diff["added"] or diff["removed"]):
        parts.append("Homepage copy changed since the last check.")
    return " ".join(parts)


def run_check(base_url, previous_text=None, previous_fingerprint=None):
    """Run every pass. Returns a plain dict ready for storage or JSON."""
    base_url = base_url.rstrip("/")

    home, issues, blocked = check_availability(base_url)

    if blocked:
        return {
            "status": "inconclusive",
            "homepage_status": home.status,
            "response_ms": home.ms,
            "pages": [],
            "assets": [],
            "issues": issues,
            "scan_blocked": True,
            "summary": build_summary("inconclusive", [], [], [], None, blocked=True),
            "content_fingerprint": None,
            "content_text": None,
            "content_added": [],
            "content_removed": [],
            "checked_at": datetime.utcnow().isoformat(),
        }

    if home.status == 0 or home.status >= 400:
        # Down or erroring: there is nothing further worth testing.
        return {
            "status": "critical",
            "homepage_status": home.status,
            "response_ms": home.ms,
            "pages": [],
            "assets": [],
            "issues": issues,
            "scan_blocked": False,
            "summary": build_summary("critical", issues, [], [], None),
            "content_fingerprint": None,
            "content_text": None,
            "content_added": [],
            "content_removed": [],
            "checked_at": datetime.utcnow().isoformat(),
        }

    pages, page_issues = check_pages(base_url, home)
    assets, asset_issues = check_assets(base_url, home)
    seo_issues = check_seo_and_a11y(base_url, home)
    contact_issues = check_email_and_phone(base_url, home)

    all_issues = issues + page_issues + asset_issues + seo_issues + contact_issues

    fingerprint = content_fingerprint(home.body)
    text = PageInspector()
    text.feed(home.body)
    added, removed = content_diff(previous_text, text.text)

    critical = [i for i in all_issues if i["severity"] == "critical"]
    status = "critical" if critical else ("warning" if all_issues else "healthy")

    diff = {"added": added, "removed": removed} if fingerprint != previous_fingerprint else None

    return {
        "status": status,
        "homepage_status": home.status,
        "response_ms": home.ms,
        "pages": pages,
        "assets": assets,
        "issues": all_issues,
        "scan_blocked": False,
        "summary": build_summary(status, all_issues, pages, assets, diff),
        "content_fingerprint": fingerprint,
        "content_text": text.text,
        "content_added": added,
        "content_removed": removed,
        "checked_at": datetime.utcnow().isoformat(),
    }