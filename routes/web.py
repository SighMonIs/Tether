import io
import os
import socket
import plistlib
import qrcode
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, Response, FileResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from pathlib import Path

from db import db, get_setting
from slugs import RESERVED, UNTAGGED, tag_slugs, note_slugs

router = APIRouter()
templates = Jinja2Templates(directory=str(Path(__file__).parent.parent / "templates"))


def _get_base_url() -> str:
    override = os.environ.get("TETHER_BASE_URL", "").strip().rstrip("/")
    if override:
        return override
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return f"http://{ip}:5225"
    except Exception:
        return "http://localhost:5225"


def _render_home(request: Request, view: dict):
    api_uuid = get_setting("uuid")
    with db() as conn:
        tags = conn.execute("SELECT id, name, color FROM tags ORDER BY position, name").fetchall()
        total = conn.execute("SELECT COUNT(*) FROM links").fetchone()[0]
    return templates.TemplateResponse("home.html", {
        "request": request,
        "tether_uuid": api_uuid,
        "tags": [dict(t) for t in tags],
        "total": total,
        "view": view,
    })


def _blank_view() -> dict:
    return {"tag": None, "uncategorised": False, "type": "all", "ct": None, "note": None}


def _view_from_query(request: Request) -> dict:
    """The old ?tag=&ct=&type= links still work, so bookmarks keep resolving."""
    q = request.query_params
    view = _blank_view()
    if q.get("tag") and q["tag"].isdigit():
        view["tag"] = int(q["tag"])
    view["uncategorised"] = q.get("uncategorised") == "true"
    if q.get("type") in ("all", "links", "notes"):
        view["type"] = q["type"]
    if q.get("ct") and q["ct"].isdigit():
        view["ct"] = int(q["ct"])
        view["type"] = "ct"
    return view


def _content_type_id(conn, tag_id: int, kind: str):
    row = conn.execute(
        "SELECT id FROM content_types WHERE tag_id=? AND kind=? ORDER BY position, id LIMIT 1",
        (tag_id, kind),
    ).fetchone()
    return row["id"] if row else None


def _resolve_category(conn, slug: str):
    """Returns (tag_id, uncategorised) or None when the slug matches nothing."""
    if slug == UNTAGGED:
        return (None, True)
    for tag_id, tag_slug in tag_slugs(conn).items():
        if tag_slug == slug:
            return (tag_id, False)
    return None


@router.get("/", response_class=HTMLResponse)
async def home(request: Request):
    return _render_home(request, _view_from_query(request))


@router.get("/links", response_class=HTMLResponse)
async def all_links(request: Request):
    view = _blank_view()
    view["type"] = "links"
    return _render_home(request, view)


@router.get("/notes", response_class=HTMLResponse)
async def all_notes(request: Request):
    view = _blank_view()
    view["type"] = "notes"
    return _render_home(request, view)


@router.get("/settings", response_class=HTMLResponse)
async def settings(request: Request):
    api_uuid = get_setting("uuid")
    base_url = _get_base_url()
    setup_url = f"{base_url}/shortcut-setup"
    with db() as conn:
        rows = conn.execute("""
            SELECT t.id, t.name, t.color,
                   COUNT(DISTINCT lt.link_id) as link_count,
                   COUNT(DISTINCT n.id) as note_count
            FROM tags t
            LEFT JOIN link_tags lt ON lt.tag_id = t.id
            LEFT JOIN notes n ON n.tag_id = t.id
            GROUP BY t.id
            ORDER BY t.name
        """).fetchall()
        uncat_links = conn.execute(
            "SELECT COUNT(*) FROM links l WHERE NOT EXISTS (SELECT 1 FROM link_tags lt WHERE lt.link_id = l.id)"
        ).fetchone()[0]
        uncat_notes = conn.execute("SELECT COUNT(*) FROM notes WHERE tag_id IS NULL").fetchone()[0]
    return templates.TemplateResponse("settings.html", {
        "request": request,
        "tether_uuid": api_uuid,
        "api_uuid": api_uuid,
        "setup_url": setup_url,
        "local_ip": base_url,
        "tags": [dict(r) for r in rows],
        "uncat_links": uncat_links,
        "uncat_notes": uncat_notes,
    })


@router.get("/qr.png")
async def qr_png():
    base_url = _get_base_url()
    setup_url = f"{base_url}/shortcut-setup"
    img = qrcode.make(setup_url)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png")


@router.get("/shortcut-setup", response_class=HTMLResponse)
async def shortcut_setup(request: Request):
    api_uuid = get_setting("uuid")
    base_url = _get_base_url()
    return templates.TemplateResponse("shortcut_setup.html", {
        "request": request,
        "api_uuid": api_uuid,
        "local_ip": base_url,
        "port": 5225,
    })


@router.get("/shortcut/tether.shortcut")
async def download_shortcut():
    """Dynamically generate a .shortcut plist with the correct server URL and UUID."""
    api_uuid = get_setting("uuid")
    base_url = _get_base_url()

    # iOS Shortcut plist structure
    shortcut = {
        "WFWorkflowClientVersion": "1140.0.3",
        "WFWorkflowClientRelease": "2.3",
        "WFWorkflowMinimumClientVersion": 900,
        "WFWorkflowMinimumClientVersionString": "900",
        "WFWorkflowIcon": {
            "WFWorkflowIconStartColor": 1088987135,
            "WFWorkflowIconGlyphNumber": 59511,
        },
        "WFWorkflowInputContentItemClasses": ["WFURLContentItem", "WFWebPageContentItem"],
        "WFWorkflowTypes": ["WFWorkflowTypeShareExtension"],
        "WFQuickActionSurfaces": [],
        "WFWorkflowHasShortcutInputVariables": True,
        "WFWorkflowActions": [
            # Action 1: Get shared URL from input
            {
                "WFWorkflowActionIdentifier": "is.workflow.actions.getitemfromlist",
                "WFWorkflowActionParameters": {
                    "WFItemIndex": {"Value": {"WFDictionaryFieldValueType": "Integer", "string": "1"}, "WFSerializationType": "WFTextTokenString"},
                    "WFInput": {"Value": {"Type": "ExtensionInput"}, "WFSerializationType": "WFTextTokenAttachment"},
                },
            },
            # Action 2: Store the URL in a variable
            {
                "WFWorkflowActionIdentifier": "is.workflow.actions.setvariable",
                "WFWorkflowActionParameters": {
                    "WFVariableName": "SharedURL",
                },
            },
            # Action 3: GET /api/tags to fetch categories
            {
                "WFWorkflowActionIdentifier": "is.workflow.actions.downloadurl",
                "WFWorkflowActionParameters": {
                    "WFURL": f"{base_url}/api/tags",
                    "WFHTTPMethod": "GET",
                    "WFHTTPHeaders": {
                        "Value": {
                            "WFDictionaryFieldValues": [
                                {
                                    "WFItemType": 0,
                                    "WFKey": {"Value": {"string": "X-Tether-UUID"}, "WFSerializationType": "WFTextTokenString"},
                                    "WFValue": {"Value": {"string": api_uuid}, "WFSerializationType": "WFTextTokenString"},
                                }
                            ]
                        },
                        "WFSerializationType": "WFDictionaryFieldValue",
                    },
                    "WFShowWebView": False,
                },
            },
            # Action 4: Parse JSON response
            {
                "WFWorkflowActionIdentifier": "is.workflow.actions.getvalueforkey",
                "WFWorkflowActionParameters": {
                    "WFInput": {"Value": {"Type": "ActionOutput", "Aggrandizements": [{"Type": "WFCoercionVariableAggrandizement", "CoercionItemClass": "WFDictionaryContentItem"}]}, "WFSerializationType": "WFTextTokenAttachment"},
                    "WFDictionaryKey": {"Value": {"string": ""}, "WFSerializationType": "WFTextTokenString"},
                },
            },
            # Action 5: Get names from tag objects
            {
                "WFWorkflowActionIdentifier": "is.workflow.actions.filter.files",
                "WFWorkflowActionParameters": {},
            },
            # Simpler: use a script to extract names, then choose from list
            # We'll use "Get Dictionary Value" to build the list
            # Action 5: Choose from list (tags)
            {
                "WFWorkflowActionIdentifier": "is.workflow.actions.choosefromlist",
                "WFWorkflowActionParameters": {
                    "WFChooseFromListActionPrompt": "Add tags to this link",
                    "WFChooseFromListActionSelectMultiple": True,
                    "WFChooseFromListActionSelectAll": False,
                },
            },
            # Action 6: Store chosen tags
            {
                "WFWorkflowActionIdentifier": "is.workflow.actions.setvariable",
                "WFWorkflowActionParameters": {
                    "WFVariableName": "ChosenTags",
                },
            },
            # Action 7: POST to /api/links
            {
                "WFWorkflowActionIdentifier": "is.workflow.actions.downloadurl",
                "WFWorkflowActionParameters": {
                    "WFURL": f"{base_url}/api/links",
                    "WFHTTPMethod": "POST",
                    "WFHTTPHeaders": {
                        "Value": {
                            "WFDictionaryFieldValues": [
                                {
                                    "WFItemType": 0,
                                    "WFKey": {"Value": {"string": "X-Tether-UUID"}, "WFSerializationType": "WFTextTokenString"},
                                    "WFValue": {"Value": {"string": api_uuid}, "WFSerializationType": "WFTextTokenString"},
                                },
                                {
                                    "WFItemType": 0,
                                    "WFKey": {"Value": {"string": "Content-Type"}, "WFSerializationType": "WFTextTokenString"},
                                    "WFValue": {"Value": {"string": "application/json"}, "WFSerializationType": "WFTextTokenString"},
                                },
                            ]
                        },
                        "WFSerializationType": "WFDictionaryFieldValue",
                    },
                    "WFHTTPBodyType": "JSON",
                    "WFJSONValues": {
                        "Value": {
                            "WFDictionaryFieldValues": [
                                {
                                    "WFItemType": 0,
                                    "WFKey": {"Value": {"string": "url"}, "WFSerializationType": "WFTextTokenString"},
                                    "WFValue": {"Value": {"Type": "Variable", "VariableName": "SharedURL"}, "WFSerializationType": "WFTextTokenAttachment"},
                                },
                                {
                                    "WFItemType": 0,
                                    "WFKey": {"Value": {"string": "tags"}, "WFSerializationType": "WFTextTokenString"},
                                    "WFValue": {"Value": {"Type": "Variable", "VariableName": "ChosenTags"}, "WFSerializationType": "WFTextTokenAttachment"},
                                },
                            ]
                        },
                        "WFSerializationType": "WFDictionaryFieldValue",
                    },
                    "WFShowWebView": False,
                },
            },
            # Action 8: Show notification
            {
                "WFWorkflowActionIdentifier": "is.workflow.actions.notification",
                "WFWorkflowActionParameters": {
                    "WFNotificationActionTitle": "Tethered!",
                    "WFNotificationActionBody": {"Value": {"Type": "Variable", "VariableName": "SharedURL"}, "WFSerializationType": "WFTextTokenAttachment"},
                    "WFNotificationActionSound": True,
                },
            },
        ],
    }

    data = plistlib.dumps(shortcut)
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": 'attachment; filename="tether.shortcut"'},
    )


# ── Readable category paths ───────────────────────────────────────────────────
# Declared last: these patterns would otherwise swallow /settings, /links, …


@router.get("/{category}", response_class=HTMLResponse)
async def category_overview(request: Request, category: str):
    if category in RESERVED:
        return RedirectResponse("/")
    with db() as conn:
        found = _resolve_category(conn, category)
    if not found:
        return RedirectResponse("/")
    tag_id, uncat = found
    view = _blank_view()
    view["tag"] = tag_id
    view["uncategorised"] = uncat
    return _render_home(request, view)


@router.get("/{category}/{kind}", response_class=HTMLResponse)
async def category_kind(request: Request, category: str, kind: str):
    if kind not in ("links", "notes"):
        return RedirectResponse(f"/{category}")
    with db() as conn:
        found = _resolve_category(conn, category)
        if not found:
            return RedirectResponse("/")
        tag_id, uncat = found
        view = _blank_view()
        view["tag"] = tag_id
        view["uncategorised"] = uncat
        # Untagged owns no content types, so it uses the filtered built-in views
        if tag_id is not None and kind == "links":
            ct = _content_type_id(conn, tag_id, "links")
            view["ct"] = ct
            view["type"] = "ct" if ct else "links"
        else:
            view["type"] = kind
    return _render_home(request, view)


@router.get("/{category}/notes/{note}", response_class=HTMLResponse)
async def category_note(request: Request, category: str, note: str):
    with db() as conn:
        found = _resolve_category(conn, category)
        if not found:
            return RedirectResponse("/")
        tag_id, uncat = found
        note_id = next((nid for nid, s in note_slugs(conn, tag_id).items() if s == note), None)
    if not note_id:
        return RedirectResponse(f"/{category}")
    view = _blank_view()
    view["tag"] = tag_id
    view["uncategorised"] = uncat
    view["type"] = "editor"
    view["note"] = note_id
    return _render_home(request, view)
