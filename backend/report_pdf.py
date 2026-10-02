"""
PDF report generation for the QA and Security scans.

Uses ReportLab, which ships as a self-contained wheel. ReportLab is a real
dependency rather than hand-rolled PDF syntax, which would be fragile and
produce unreadable output.
"""

import io
from datetime import datetime

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    KeepTogether,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

PAGE_WIDTH, PAGE_HEIGHT = A4

INK = colors.HexColor("#0f1a28")
MUTED = colors.HexColor("#5b7185")
RULE = colors.HexColor("#d9e2ec")

SEVERITY_COLOURS = {
    "critical": colors.HexColor("#b4231f"),
    "warning": colors.HexColor("#b45309"),
    "info": colors.HexColor("#1e5f8f"),
    "pass": colors.HexColor("#0f7b44"),
}

GRADE_COLOURS = {
    "healthy": colors.HexColor("#0f7b44"),
    "warning": colors.HexColor("#b45309"),
    "critical": colors.HexColor("#b4231f"),
}


def _styles():
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "Title", parent=base["Title"], fontName="Helvetica-Bold",
            fontSize=21, leading=25, textColor=INK, alignment=TA_LEFT, spaceAfter=2,
        ),
        "subtitle": ParagraphStyle(
            "Subtitle", parent=base["Normal"], fontName="Helvetica",
            fontSize=9.5, leading=13, textColor=MUTED, spaceAfter=14,
        ),
        "h2": ParagraphStyle(
            "H2", parent=base["Heading2"], fontName="Helvetica-Bold",
            fontSize=12.5, leading=15, textColor=INK, spaceBefore=14, spaceAfter=7,
        ),
        "body": ParagraphStyle(
            "Body", parent=base["Normal"], fontName="Helvetica",
            fontSize=9.5, leading=13.5, textColor=INK,
        ),
        "small": ParagraphStyle(
            "Small", parent=base["Normal"], fontName="Helvetica",
            fontSize=8, leading=11, textColor=MUTED,
        ),
        "finding": ParagraphStyle(
            "Finding", parent=base["Normal"], fontName="Helvetica",
            fontSize=9, leading=12.5, textColor=INK,
        ),
        "cell": ParagraphStyle(
            "Cell", parent=base["Normal"], fontName="Helvetica",
            fontSize=8.5, leading=11.5, textColor=INK,
        ),
    }


def _escape(text):
    """PDF strings are markup, so user-supplied text must be escaped."""
    if text is None:
        return ""
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.6)
    canvas.line(18 * mm, 14 * mm, PAGE_WIDTH - 18 * mm, 14 * mm)
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(MUTED)
    canvas.drawString(18 * mm, 9 * mm, "NGOCORE OFFICE  ·  Automated Report")
    canvas.drawRightString(
        PAGE_WIDTH - 18 * mm, 9 * mm, f"Page {doc.page}"
    )
    canvas.restoreState()


def _build_document(buffer, title):
    doc = BaseDocTemplate(
        buffer, pagesize=A4,
        leftMargin=18 * mm, rightMargin=18 * mm,
        topMargin=16 * mm, bottomMargin=20 * mm,
        title=title, author="NGOCORE OFFICE",
    )
    frame = Frame(
        doc.leftMargin, doc.bottomMargin,
        doc.width, doc.height, id="body",
    )
    doc.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=_footer)])
    return doc


def _status_banner(styles, status, headline, subtitle):
    colour = GRADE_COLOURS.get(status, MUTED)
    table = Table(
        [[Paragraph(
            f'<font size="13"><b>{_escape(status.upper())}</b></font><br/>'
            f'<font size="9">{_escape(headline)}</font>',
            styles["body"],
        )]],
        colWidths=[PAGE_WIDTH - 36 * mm],
    )
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f6f8fa")),
        ("LINEBEFORE", (0, 0), (0, -1), 3.5, colour),
        ("LEFTPADDING", (0, 0), (-1, -1), 12),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 11),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 11),
    ]))
    return [table, Spacer(1, 5), Paragraph(_escape(subtitle), styles["small"]), Spacer(1, 12)]


def _severity_table(styles, issues, label="Finding"):
    if not issues:
        return [Paragraph("Nothing to report.", styles["small"])]

    rows = [["Severity", "Area", label]]
    for issue in issues:
        rows.append([
            issue.get("severity", "").upper(),
            issue.get("category", ""),
            issue.get("message", ""),
        ])

    data = [[Paragraph(_escape(c), styles["cell"]) for c in row] for row in rows]
    table = Table(
        data,
        colWidths=[26 * mm, 30 * mm, PAGE_WIDTH - 36 * mm - 56 * mm],
        repeatRows=1,
    )
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), INK),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 8),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.5, RULE),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f6f8fa")]),
    ]
    for i, issue in enumerate(issues, start=1):
        colour = SEVERITY_COLOURS.get(issue.get("severity"), MUTED)
        style.append(("TEXTCOLOR", (0, i), (0, i), colour))
        style.append(("FONTNAME", (0, i), (0, i), "Helvetica-Bold"))
    table.setStyle(TableStyle(style))
    return [table]


def _simple_table(styles, headers, rows):
    data = [[Paragraph(_escape(h), styles["cell"]) for h in headers]]
    for row in rows:
        data.append([Paragraph(_escape(c), styles["cell"]) for c in row])

    table = Table(data, repeatRows=1, colWidths=None)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), INK),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 8),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.5, RULE),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f6f8fa")]),
    ]))
    return table


def build_qa_pdf(run, site_url):
    """Render a stored QA run as a PDF."""
    styles = _styles()
    buffer = io.BytesIO()
    doc = _build_document(buffer, f"QA Report - {site_url}")

    checked = datetime.fromisoformat(run["checked_at"]).strftime("%d %B %Y at %H:%M UTC") \
        if run.get("checked_at") else "unknown"

    story = [
        Paragraph("Quality Assurance Report", styles["title"]),
        Paragraph(f"{_escape(site_url)} &nbsp;&middot;&nbsp; checked {checked} &nbsp;&middot;&nbsp; "
                  f"triggered by {_escape(run.get('trigger', 'manual'))}", styles["subtitle"]),
    ]

    story += _status_banner(
        styles, run["status"], run["summary"],
        "Automated availability, link, asset, performance, SEO and accessibility audit.",
    )

    metrics = [
        ["Homepage status", str(run.get("homepage_status") or "unreachable")],
        ["Response time", f"{run.get('response_ms', 0)} ms"],
        ["Pages checked", str(len(run.get("pages", [])))],
        ["Assets checked", str(len(run.get("assets", [])))],
        ["Critical findings", str(run.get("critical_count", 0))],
        ["Warnings", str(run.get("warning_count", 0))],
        ["Total findings", str(run.get("issue_count", 0))],
    ]
    story += [
        Paragraph("Summary", styles["h2"]),
        _simple_table(styles, ["Metric", "Value"], metrics),
    ]

    issues = run.get("issues", [])
    story += [Paragraph(f"Findings ({len(issues)})", styles["h2"])]
    story += _severity_table(styles, issues)

    pages = run.get("pages", [])
    if pages:
        rows = [
            [p.get("path", "/"), p.get("status", ""), f"{p.get('ms', 0)} ms",
             f"{round(p.get('bytes', 0) / 1024)} KB", p.get("title") or "-"]
            for p in pages
        ]
        story += [
            Paragraph("Pages", styles["h2"]),
            _simple_table(styles, ["Path", "Status", "Time", "Size", "Title"], rows),
        ]

    assets = run.get("assets", [])
    if assets:
        broken = [a for a in assets if a.get("status") != 200]
        rows = [
            [a.get("url", ""), a.get("status", ""), f"{round(a.get('bytes', 0) / 1024)} KB"]
            for a in (broken or assets[:25])
        ]
        story += [
            Paragraph(
                f"Assets ({len(assets)} checked, {len(broken)} broken)",
                styles["h2"],
            ),
            _simple_table(styles, ["Asset", "Status", "Size"], rows),
        ]

    added = run.get("content_added", [])
    removed = run.get("content_removed", [])
    if added or removed:
        story += [Paragraph("Homepage content change", styles["h2"])]
        for line in added[:10]:
            story.append(Paragraph(f'<font color="#0f7b44">+ {_escape(line)}</font>', styles["finding"]))
        for line in removed[:10]:
            story.append(Paragraph(f'<font color="#b4231f">- {_escape(line)}</font>', styles["finding"]))
        if not added and not removed:
            story.append(Paragraph("No changes detected.", styles["small"]))

    doc.build(story)
    buffer.seek(0)
    return buffer.getvalue()


def build_security_pdf(run, site_url):
    """Render a stored security run as a PDF."""
    styles = _styles()
    buffer = io.BytesIO()
    doc = _build_document(buffer, f"Security Report - {site_url}")

    checked = datetime.fromisoformat(run["checked_at"]).strftime("%d %B %Y at %H:%M UTC") \
        if run.get("checked_at") else "unknown"

    story = [
        Paragraph("Security Review", styles["title"]),
        Paragraph(f"{_escape(site_url)} &nbsp;&middot;&nbsp; checked {checked}", styles["subtitle"]),
    ]

    story += _status_banner(
        styles, run["status"], run["summary"],
        "Passive review: TLS certificate, response headers, cookies, CORS, "
        "information disclosure and accidentally public files.",
    )

    tls = run.get("tls") or {}
    metrics = [
        ["TLS valid", "Yes" if tls.get("valid") else "No"],
        ["TLS version", tls.get("tls_version") or "-"],
        ["Certificate issuer", tls.get("issuer") or "-"],
        ["Certificate expires", (tls.get("expires") or "-")[:10]],
        ["Days until expiry", str(tls.get("days_left") if tls.get("days_left") is not None else "-")],
        ["Critical findings", str(run.get("critical_count", 0))],
        ["Warnings", str(run.get("warning_count", 0))],
        ["Advisory", str(run.get("info_count", 0))],
        ["security.txt present", "Yes" if run.get("security_txt") else "No"],
    ]
    story += [
        Paragraph("Summary", styles["h2"]),
        _simple_table(styles, ["Metric", "Value"], metrics),
    ]

    findings = run.get("findings", [])
    story += [Paragraph(f"Findings ({len(findings)})", styles["h2"])]
    story += _severity_table(styles, findings)

    paths = run.get("paths_checked", [])
    if paths:
        rows = [
            [p.get("path", ""), str(p.get("status", "")),
             "EXPOSED" if p.get("exposed") else "Not accessible"]
            for p in paths
        ]
        story += [
            Paragraph("Sensitive file exposure", styles["h2"]),
            _simple_table(styles, ["Path", "Status", "Result"], rows),
        ]

    story += [Spacer(1, 12), Paragraph(
        "This review is read-only and automated. It cannot confirm the absence "
        "of vulnerabilities, and does not replace a manual penetration test.",
        styles["small"],
    )]

    doc.build(story)
    buffer.seek(0)
    return buffer.getvalue()