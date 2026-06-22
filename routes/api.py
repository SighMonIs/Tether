import uuid
import json as _json
import traceback
from collections import deque
from datetime import datetime, timezone
import httpx
from bs4 import BeautifulSoup
from fastapi import APIRouter, Header, HTTPException, BackgroundTasks, Request, UploadFile, File
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, field_validator
from typing import Any

from db import db, get_setting, set_setting

router = APIRouter(prefix="/api")

# ── Error log ─────────────────────────────────────────────────────────────────
_error_log: deque = deque(maxlen=200)


def _log_error(source: str, exc: Exception):
    _error_log.appendleft({
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
        "error": type(exc).__name__,
        "detail": str(exc),
    })

TAG_COLORS = [
    "#6366f1", "#ec4899", "#10b981", "#f59e0b",
    "#3b82f6", "#ef4444", "#8b5cf6", "#14b8a6",
]


def _check_auth(x_tether_uuid: str | None):
    expected = get_setting("uuid")
    if not x_tether_uuid or x_tether_uuid != expected:
        raise HTTPException(status_code=401, detail="Invalid UUID")


def _next_color(conn) -> str:
    count = conn.execute("SELECT COUNT(*) FROM tags").fetchone()[0]
    return TAG_COLORS[count % len(TAG_COLORS)]


_BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


def _meta(soup, *args, **kwargs):
    tag = soup.find("meta", *args, **kwargs)
    return tag.get("content", "").strip() if tag else None


def _json_ld(soup):
    """Extract title/description from the first JSON-LD block that has them."""
    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            data = _json.loads(tag.string or "")
            # handle both single object and @graph array
            items = data.get("@graph", [data]) if isinstance(data, dict) else data
            for item in (items if isinstance(items, list) else [items]):
                t = item.get("name") or item.get("headline")
                d = item.get("description")
                if t:
                    return t.strip(), (d.strip() if d else None)
        except Exception:
            pass
    return None, None


_OEMBED_PROVIDERS = [
    ("youtube.com",  "https://www.youtube.com/oembed"),
    ("youtu.be",     "https://www.youtube.com/oembed"),
    ("tiktok.com",   "https://www.tiktok.com/oembed"),
    ("vt.tiktok.com","https://www.tiktok.com/oembed"),
]


async def _fetch_metadata(link_id: str, url: str):
    try:
        parsed = httpx.URL(url)
        domain = parsed.host
        favicon = f"https://www.google.com/s2/favicons?domain={domain}&sz=32"
        title = desc = None

        instagram_token = get_setting("instagram_app_token") or ""

        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:

            # Resolve any short/redirect URLs first so oEmbed gets the canonical URL
            try:
                head = await client.head(url, headers=_BROWSER_HEADERS)
                resolved_url = str(head.url)
                resolved_domain = httpx.URL(resolved_url).host
            except Exception:
                resolved_url, resolved_domain = url, domain

            # Instagram oEmbed (requires app token)
            if instagram_token and ("instagram.com" in resolved_domain or "instagr.am" in resolved_domain):
                oe = await client.get(
                    "https://graph.facebook.com/v22.0/instagram_oembed",
                    params={"url": resolved_url, "access_token": instagram_token},
                    headers=_BROWSER_HEADERS,
                )
                if oe.is_success:
                    data = oe.json()
                    title = data.get("title") or data.get("author_name")

            # oEmbed providers (YouTube, TikTok)
            for provider_domain, oembed_url in _OEMBED_PROVIDERS:
                if provider_domain in resolved_domain:
                    oe = await client.get(
                        oembed_url,
                        params={"url": resolved_url, "format": "json"},
                        headers=_BROWSER_HEADERS,
                    )
                    if oe.is_success:
                        data = oe.json()
                        title = data.get("title")
                        desc = data.get("author_name")
                    break

            if not title:
                resp = await client.get(resolved_url, headers=_BROWSER_HEADERS)
                soup = BeautifulSoup(resp.text, "html.parser")

                # 1. Open Graph / Twitter meta tags
                title = (
                    _meta(soup, property="og:title")
                    or _meta(soup, attrs={"name": "twitter:title"})
                )
                desc = (
                    _meta(soup, property="og:description")
                    or _meta(soup, attrs={"name": "twitter:description"})
                    or _meta(soup, attrs={"name": "description"})
                )

                # 2. JSON-LD structured data (MakerWorld, Reddit, news sites, etc.)
                if not title:
                    title, ld_desc = _json_ld(soup)
                    if not desc:
                        desc = ld_desc

                # 3. Plain <title> tag last resort
                if not title and soup.title:
                    title = soup.title.string.strip()

        with db() as conn:
            conn.execute(
                "UPDATE links SET title=?, description=?, favicon_url=? WHERE id=?",
                (
                    title and title.strip()[:500],
                    desc and desc.strip()[:1000],
                    favicon,
                    link_id,
                ),
            )
    except Exception as exc:
        _log_error(f"metadata:{url}", exc)


# ── Bulk refresh state ────────────────────────────────────────────────────────

_refresh_state: dict = {"running": False, "done": 0, "total": 0}


async def _run_bulk_refresh():
    with db() as conn:
        rows = conn.execute("SELECT id, url FROM links").fetchall()
    _refresh_state["total"] = len(rows)
    _refresh_state["done"] = 0
    _refresh_state["running"] = True
    try:
        for row in rows:
            await _fetch_metadata(row["id"], row["url"])
            _refresh_state["done"] += 1
    finally:
        _refresh_state["running"] = False


# ── Tags ──────────────────────────────────────────────────────────────────────

NEW_TAG_SENTINEL = "+ New"

@router.get("/tags")
def list_tags(
    x_tether_uuid: str | None = Header(default=None),
    shortcut: bool = False,
):
    _check_auth(x_tether_uuid)
    with db() as conn:
        rows = conn.execute("""
            SELECT t.id, t.name, t.color,
                   COUNT(CASE WHEN l.id IS NOT NULL AND l.read_at IS NULL THEN 1 END) AS unread_count
            FROM tags t
            LEFT JOIN link_tags lt ON lt.tag_id = t.id
            LEFT JOIN links l ON l.id = lt.link_id
            GROUP BY t.id
            ORDER BY t.name
        """).fetchall()
    result = [dict(r) for r in rows]
    if shortcut:
        result.append({"id": "__new__", "name": NEW_TAG_SENTINEL, "color": "#888899", "unread_count": 0})
    return result


class TagCreate(BaseModel):
    name: str
    color: str | None = None


@router.post("/tags", status_code=201)
def create_tag(body: TagCreate, x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    with db() as conn:
        color = body.color or _next_color(conn)
        conn.execute("INSERT OR IGNORE INTO tags(name, color) VALUES (?,?)", (body.name.strip(), color))
        row = conn.execute("SELECT id, name, color FROM tags WHERE name=?", (body.name.strip(),)).fetchone()
    return dict(row)


class TagUpdate(BaseModel):
    name: str | None = None
    color: str | None = None


@router.patch("/tags/{tag_id}")
def update_tag(tag_id: int, body: TagUpdate, x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    with db() as conn:
        if body.name is not None:
            conn.execute("UPDATE tags SET name=? WHERE id=?", (body.name.strip(), tag_id))
        if body.color is not None:
            conn.execute("UPDATE tags SET color=? WHERE id=?", (body.color, tag_id))
        row = conn.execute("SELECT id, name, color FROM tags WHERE id=?", (tag_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404)
        return dict(row)


@router.delete("/tags/{tag_id}", status_code=204)
def delete_tag(tag_id: int, x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    with db() as conn:
        conn.execute("DELETE FROM tags WHERE id=?", (tag_id,))


# ── Links ─────────────────────────────────────────────────────────────────────

class LinkCreate(BaseModel):
    url: str
    tags: Any = []

    @field_validator("tags", mode="before")
    @classmethod
    def coerce_tags(cls, v):
        # iOS Shortcuts may send tags as a newline-separated string,
        # a single string, or a proper list — normalise all cases.
        if v is None:
            return []
        if isinstance(v, list):
            return [str(i).strip() for i in v if str(i).strip()]
        if isinstance(v, str):
            parts = [p.strip() for p in v.replace(",", "\n").splitlines()]
            return [p for p in parts if p]
        return []


@router.post("/links", status_code=201)
async def create_link(
    request: Request,
    background_tasks: BackgroundTasks,
    x_tether_uuid: str | None = Header(default=None),
):
    _check_auth(x_tether_uuid)

    raw = await request.body()

    try:
        data = await request.json()
    except Exception:
        data = {}

    url = str(data.get("url") or "").strip()
    if not url:
        raise HTTPException(status_code=422, detail="url is required")

    raw_tags = data.get("tags", [])
    if isinstance(raw_tags, list):
        tags = [str(t).strip() for t in raw_tags if str(t).strip()]
    elif isinstance(raw_tags, str):
        tags = [p.strip() for p in raw_tags.replace(",", "\n").splitlines() if p.strip()]
    else:
        tags = []

    # new_tags field: comma-separated names entered by the user in the shortcut
    raw_new = data.get("new_tags", "") or ""
    if isinstance(raw_new, str):
        extra = [p.strip() for p in raw_new.replace(",", "\n").splitlines() if p.strip()]
        tags = [t for t in tags if t != NEW_TAG_SENTINEL] + extra

    with db() as conn:
        existing = conn.execute("SELECT id FROM links WHERE url=?", (url,)).fetchone()
        if existing:
            return {"id": existing["id"], "duplicate": True}

    link_id = str(uuid.uuid4())

    with db() as conn:
        conn.execute(
            "INSERT INTO links(id, url) VALUES (?,?)",
            (link_id, url)
        )
        for tag_name in tags:
            color = _next_color(conn)
            conn.execute("INSERT OR IGNORE INTO tags(name, color) VALUES (?,?)", (tag_name, color))
            tag_row = conn.execute("SELECT id FROM tags WHERE name=?", (tag_name,)).fetchone()
            if tag_row:
                conn.execute("INSERT OR IGNORE INTO link_tags VALUES (?,?)", (link_id, tag_row["id"]))

    background_tasks.add_task(_fetch_metadata, link_id, url)
    return {"id": link_id}


def _link_rows(conn, rows):
    result = []
    for r in rows:
        link = dict(r)
        tags = conn.execute(
            "SELECT t.id, t.name, t.color FROM tags t "
            "JOIN link_tags lt ON lt.tag_id=t.id WHERE lt.link_id=?",
            (link["id"],)
        ).fetchall()
        link["tags"] = [dict(t) for t in tags]
        result.append(link)
    return result


@router.get("/links/uncategorised-count")
def uncategorised_count(x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    with db() as conn:
        unread = conn.execute(
            "SELECT COUNT(*) FROM links WHERE read_at IS NULL AND NOT EXISTS "
            "(SELECT 1 FROM link_tags lt WHERE lt.link_id = links.id)"
        ).fetchone()[0]
    return {"unread_count": unread}


@router.get("/links/favourites-count")
def favourites_count(x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    with db() as conn:
        unread = conn.execute(
            "SELECT COUNT(*) FROM links WHERE is_favourite=1 AND read_at IS NULL"
        ).fetchone()[0]
    return {"unread_count": unread}


@router.get("/links")
def list_links(
    tag: int | None = None,
    unread: bool | None = None,
    read: bool | None = None,
    uncategorised: bool | None = None,
    favourites: bool | None = None,
    x_tether_uuid: str | None = Header(default=None),
):
    _check_auth(x_tether_uuid)
    with db() as conn:
        clauses, params = [], []
        if tag is not None:
            clauses.append("EXISTS (SELECT 1 FROM link_tags lt WHERE lt.link_id=l.id AND lt.tag_id=?)")
            params.append(tag)
        if uncategorised:
            clauses.append("NOT EXISTS (SELECT 1 FROM link_tags lt WHERE lt.link_id=l.id)")
        if favourites:
            clauses.append("l.is_favourite=1")
        if unread:
            clauses.append("l.is_read=0")
        elif read:
            clauses.append("l.is_read=1")
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        rows = conn.execute(
            f"SELECT l.* FROM links l {where} ORDER BY l.created_at DESC",
            params
        ).fetchall()
        return _link_rows(conn, rows)


@router.get("/links/search")
def search_links(q: str, x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    with db() as conn:
        rows = conn.execute(
            "SELECT l.* FROM links l "
            "JOIN links_fts f ON f.id=l.id "
            "WHERE links_fts MATCH ? "
            "ORDER BY rank",
            (q,)
        ).fetchall()
        return _link_rows(conn, rows)


class LinkUpdate(BaseModel):
    is_read: bool | None = None
    is_favourite: bool | None = None
    tags: list[str] | None = None
    title: str | None = None
    url: str | None = None


@router.get("/links/{link_id}")
def get_link(link_id: str, x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    with db() as conn:
        row = conn.execute("SELECT * FROM links WHERE id=?", (link_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404)
        return _link_rows(conn, [row])[0]


@router.patch("/links/{link_id}")
def update_link(
    link_id: str,
    body: LinkUpdate,
    x_tether_uuid: str | None = Header(default=None),
):
    _check_auth(x_tether_uuid)
    with db() as conn:
        if body.title is not None:
            conn.execute("UPDATE links SET title=? WHERE id=?", (body.title.strip(), link_id))
        if body.url is not None:
            conn.execute("UPDATE links SET url=? WHERE id=?", (body.url.strip(), link_id))
        if body.is_favourite is not None:
            conn.execute("UPDATE links SET is_favourite=? WHERE id=?", (int(body.is_favourite), link_id))
        if body.is_read is not None:
            if body.is_read:
                conn.execute(
                    "UPDATE links SET is_read=1, read_at=datetime('now') WHERE id=?",
                    (link_id,)
                )
            else:
                conn.execute(
                    "UPDATE links SET is_read=0, read_at=NULL WHERE id=?",
                    (link_id,)
                )
        if body.tags is not None:
            conn.execute("DELETE FROM link_tags WHERE link_id=?", (link_id,))
            for tag_name in body.tags:
                tag_name = tag_name.strip()
                if not tag_name:
                    continue
                color = _next_color(conn)
                conn.execute("INSERT OR IGNORE INTO tags(name, color) VALUES (?,?)", (tag_name, color))
                tag_row = conn.execute("SELECT id FROM tags WHERE name=?", (tag_name,)).fetchone()
                if tag_row:
                    conn.execute("INSERT OR IGNORE INTO link_tags VALUES (?,?)", (link_id, tag_row["id"]))
        row = conn.execute("SELECT * FROM links WHERE id=?", (link_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404)
        tags = conn.execute(
            "SELECT t.id, t.name, t.color FROM tags t JOIN link_tags lt ON lt.tag_id=t.id WHERE lt.link_id=?",
            (link_id,)
        ).fetchall()
        result = dict(row)
        result["tags"] = [dict(t) for t in tags]
        return result


class MarkAllBody(BaseModel):
    is_read: bool
    tag: int | None = None
    uncategorised: bool | None = None
    favourites: bool | None = None


@router.post("/links/mark-all", status_code=204)
def mark_all_links(body: MarkAllBody, x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    with db() as conn:
        clauses, params = [], []
        if body.tag is not None:
            clauses.append("id IN (SELECT link_id FROM link_tags WHERE tag_id=?)")
            params.append(body.tag)
        if body.uncategorised:
            clauses.append("NOT EXISTS (SELECT 1 FROM link_tags lt WHERE lt.link_id=links.id)")
        if body.favourites:
            clauses.append("is_favourite=1")
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        if body.is_read:
            conn.execute(f"UPDATE links SET is_read=1, read_at=datetime('now') {where}", params)
        else:
            conn.execute(f"UPDATE links SET is_read=0, read_at=NULL {where}", params)


@router.post("/links/{link_id}/refresh", status_code=204)
async def refresh_link_metadata(
    link_id: str,
    x_tether_uuid: str | None = Header(default=None),
):
    _check_auth(x_tether_uuid)
    with db() as conn:
        row = conn.execute("SELECT url FROM links WHERE id=?", (link_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404)
    await _fetch_metadata(link_id, row["url"])


@router.post("/links/refresh-all", status_code=202)
async def start_bulk_refresh(
    background_tasks: BackgroundTasks,
    x_tether_uuid: str | None = Header(default=None),
):
    _check_auth(x_tether_uuid)
    if _refresh_state["running"]:
        return {"status": "already_running"}
    background_tasks.add_task(_run_bulk_refresh)
    return {"status": "started"}


@router.get("/links/refresh-all/status")
async def bulk_refresh_status(x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    return dict(_refresh_state)


@router.delete("/links/{link_id}", status_code=204)
def delete_link(link_id: str, x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    with db() as conn:
        conn.execute("DELETE FROM links WHERE id=?", (link_id,))


# ── Settings ──────────────────────────────────────────────────────────────────

class SettingValue(BaseModel):
    value: str


@router.post("/settings/uuid", status_code=200)
def regenerate_uuid(body: SettingValue, x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    set_setting("uuid", body.value)
    return {"ok": True}


@router.get("/settings/instagram-token")
def get_instagram_token(x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    return {"value": get_setting("instagram_app_token") or ""}


@router.post("/settings/instagram-token", status_code=200)
def save_instagram_token(body: SettingValue, x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    set_setting("instagram_app_token", body.value.strip())
    return {"ok": True}


# ── Export / Import ───────────────────────────────────────────────────────────

@router.get("/export")
def export_data(x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    with db() as conn:
        links = [dict(r) for r in conn.execute(
            "SELECT id, url, title, description, favicon_url, is_read, is_favourite, created_at, read_at FROM links ORDER BY created_at"
        ).fetchall()]
        tags = [dict(r) for r in conn.execute("SELECT id, name, color FROM tags").fetchall()]
        link_tags = [dict(r) for r in conn.execute("SELECT link_id, tag_id FROM link_tags").fetchall()]

    payload = _json.dumps({"version": 1, "links": links, "tags": tags, "link_tags": link_tags}, indent=2)
    return Response(
        content=payload,
        media_type="application/json",
        headers={"Content-Disposition": "attachment; filename=tether-export.json"},
    )


@router.post("/import", status_code=200)
async def import_data(
    file: UploadFile = File(...),
    x_tether_uuid: str | None = Header(default=None),
):
    _check_auth(x_tether_uuid)
    try:
        raw = await file.read()
        data = _json.loads(raw)
        if data.get("version") not in (1, None):
            raise HTTPException(status_code=400, detail="Unsupported export version")

        with db() as conn:
            # Upsert tags (match by name, preserve existing ids where possible)
            tag_id_map: dict[int, int] = {}
            for tag in data.get("tags", []):
                existing = conn.execute("SELECT id FROM tags WHERE name=? COLLATE NOCASE", (tag["name"],)).fetchone()
                if existing:
                    tag_id_map[tag["id"]] = existing["id"]
                else:
                    cur = conn.execute("INSERT INTO tags(name, color) VALUES(?,?)", (tag["name"], tag["color"]))
                    tag_id_map[tag["id"]] = cur.lastrowid

            # Upsert links (skip duplicates by id)
            imported = 0
            skipped = 0
            for link in data.get("links", []):
                exists = conn.execute("SELECT 1 FROM links WHERE id=?", (link["id"],)).fetchone()
                if not exists:
                    conn.execute(
                        "INSERT INTO links(id, url, title, description, favicon_url, is_read, is_favourite, created_at, read_at) VALUES(?,?,?,?,?,?,?,?,?)",
                        (link["id"], link["url"], link.get("title"), link.get("description"),
                         link.get("favicon_url"), link.get("is_read", 0), link.get("is_favourite", 0),
                         link.get("created_at"), link.get("read_at")),
                    )
                    imported += 1
                else:
                    skipped += 1

            # Restore link→tag relationships
            for lt in data.get("link_tags", []):
                new_tag_id = tag_id_map.get(lt["tag_id"])
                if not new_tag_id:
                    continue
                conn.execute(
                    "INSERT OR IGNORE INTO link_tags(link_id, tag_id) VALUES(?,?)",
                    (lt["link_id"], new_tag_id),
                )

        return {"imported": imported, "skipped": skipped, "tags": len(tag_id_map)}
    except HTTPException:
        raise
    except _json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON file")
    except Exception as exc:
        _log_error("import", exc)
        raise HTTPException(status_code=500, detail=f"Import failed: {type(exc).__name__}: {exc}")


@router.get("/errors")
def get_errors(x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    return list(_error_log)


@router.delete("/errors", status_code=204)
def clear_errors(x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    _error_log.clear()
