import io
import os
import socket
import plistlib
import qrcode
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, Response, FileResponse
from fastapi.templating import Jinja2Templates
from pathlib import Path

from db import db, get_setting

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


@router.get("/", response_class=HTMLResponse)
async def home(request: Request):
    api_uuid = get_setting("uuid")
    with db() as conn:
        tags = conn.execute("SELECT id, name, color FROM tags ORDER BY name").fetchall()
        total = conn.execute("SELECT COUNT(*) FROM links").fetchone()[0]
        unread = conn.execute("SELECT COUNT(*) FROM links WHERE is_read=0").fetchone()[0]
    return templates.TemplateResponse("home.html", {
        "request": request,
        "tether_uuid": api_uuid,
        "tags": [dict(t) for t in tags],
        "total": total,
        "unread": unread,
    })


@router.get("/categories", response_class=HTMLResponse)
async def categories(request: Request):
    api_uuid = get_setting("uuid")
    with db() as conn:
        rows = conn.execute("""
            SELECT t.id, t.name, t.color, COUNT(lt.link_id) as link_count
            FROM tags t
            LEFT JOIN link_tags lt ON lt.tag_id = t.id
            GROUP BY t.id
            ORDER BY t.name
        """).fetchall()
    return templates.TemplateResponse("categories.html", {
        "request": request,
        "tether_uuid": api_uuid,
        "tags": [dict(r) for r in rows],
    })


@router.get("/settings", response_class=HTMLResponse)
async def settings(request: Request):
    api_uuid = get_setting("uuid")
    base_url = _get_base_url()
    setup_url = f"{base_url}/shortcut-setup"
    return templates.TemplateResponse("settings.html", {
        "request": request,
        "tether_uuid": api_uuid,
        "api_uuid": api_uuid,
        "setup_url": setup_url,
        "local_ip": base_url,
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
