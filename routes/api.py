import re
import io
import uuid
import zipfile
import json as _json
import traceback
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
import httpx
from bs4 import BeautifulSoup
from fastapi import APIRouter, Header, HTTPException, BackgroundTasks, Request, UploadFile, File
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, field_validator
from typing import Any

from db import db, get_setting, set_setting, NOTES_DIR

router = APIRouter(prefix="/api")

# ── Error log ─────────────────────────────────────────────────────────────────
_error_log: deque = deque(maxlen=200)


def _log_error(source: str, exc: Exception):
    _error_log.appendleft({
        "ts": datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S"),
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

_INSTAGRAM_DOMAINS = ("instagram.com", "instagr.am")


async def _scrape_metadata(url: str) -> dict:
    parsed = httpx.URL(url)
    domain = parsed.host
    favicon = f"https://www.google.com/s2/favicons?domain={domain}&sz=32"
    title = desc = None

    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:

        # Resolve any short/redirect URLs first so oEmbed gets the canonical URL
        try:
            head = await client.head(url, headers=_BROWSER_HEADERS)
            resolved_url = str(head.url)
            resolved_domain = httpx.URL(resolved_url).host
        except Exception:
            resolved_url, resolved_domain = url, domain

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

            # Instagram serves a login wall with no usable meta tags; fall
            # back to a generic label instead of the bare "Instagram" title.
            if any(d in resolved_domain for d in _INSTAGRAM_DOMAINS) and (
                not title or title.strip().lower() == "instagram"
            ):
                title = "Instagram reel" if "/reel/" in resolved_url else "Instagram post"
                desc = None

    return {
        "title": title and title.strip()[:500],
        "description": desc and desc.strip()[:1000],
        "favicon_url": favicon,
    }


async def _fetch_metadata(link_id: str, url: str):
    try:
        meta = await _scrape_metadata(url)
        with db() as conn:
            conn.execute(
                "UPDATE links SET title=?, description=?, favicon_url=? WHERE id=?",
                (meta["title"], meta["description"], meta["favicon_url"], link_id),
            )
    except Exception as exc:
        _log_error(f"metadata:{url}", exc)


@router.get("/metadata/preview")
async def preview_metadata(url: str, x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    try:
        return await _scrape_metadata(url)
    except Exception as exc:
        _log_error(f"metadata-preview:{url}", exc)
        return {"title": None, "description": None, "favicon_url": None}


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
            SELECT t.id, t.name, t.color, t.position
            FROM tags t
            ORDER BY t.position, t.name
        """).fetchall()
    result = [dict(r) for r in rows]
    if shortcut:
        result.append({"id": "__new__", "name": NEW_TAG_SENTINEL, "color": "#888899", "position": 9999})
    return result


class TagCreate(BaseModel):
    name: str
    color: str | None = None


@router.post("/tags", status_code=201)
def create_tag(body: TagCreate, x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    with db() as conn:
        color = body.color or _next_color(conn)
        pos = conn.execute("SELECT COALESCE(MAX(position), -1) + 1 p FROM tags").fetchone()["p"]
        conn.execute("INSERT OR IGNORE INTO tags(name, color, position) VALUES (?,?,?)",
                     (body.name.strip(), color, pos))
        row = conn.execute("SELECT id, name, color, position FROM tags WHERE name=?",
                           (body.name.strip(),)).fetchone()
        for i, kind in enumerate(("links", "notes")):
            if not conn.execute("SELECT 1 FROM content_types WHERE tag_id=? AND kind=?",
                                (row["id"], kind)).fetchone():
                conn.execute(
                    "INSERT INTO content_types(tag_id, kind, title, position) VALUES (?,?,?,?)",
                    (row["id"], kind, kind.capitalize(), i),
                )
    return dict(row)


class TagReorder(BaseModel):
    order: list[int]


@router.patch("/tags/reorder", status_code=204)
def reorder_tags(body: TagReorder, x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    with db() as conn:
        conn.executemany("UPDATE tags SET position=? WHERE id=?",
                         [(i, tag_id) for i, tag_id in enumerate(body.order)])


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


class TagReassign(BaseModel):
    to_tag_id: int | None = None


@router.post("/tags/{tag_id}/reassign", status_code=204)
def reassign_tag(tag_id: int, body: TagReassign, x_tether_uuid: str | None = Header(default=None)):
    """Move every link/note off this tag (to another tag, or uncategorised) then delete it."""
    _check_auth(x_tether_uuid)
    with db() as conn:
        if body.to_tag_id is not None:
            link_ids = [r["link_id"] for r in conn.execute(
                "SELECT link_id FROM link_tags WHERE tag_id=?", (tag_id,)
            ).fetchall()]
            for link_id in link_ids:
                _link_tag_write(conn, link_id, body.to_tag_id)
            conn.execute("UPDATE notes SET tag_id=? WHERE tag_id=?", (body.to_tag_id, tag_id))
        # deleting the tag cascades: link_tags rows for it are removed (CASCADE),
        # and any notes still pointing at it are uncategorised (SET NULL)
        conn.execute("DELETE FROM tags WHERE id=?", (tag_id,))


@router.delete("/tags/{tag_id}/purge", status_code=204)
def purge_tag(tag_id: int, x_tether_uuid: str | None = Header(default=None)):
    """Delete every link and note tagged with this category, then the category itself."""
    _check_auth(x_tether_uuid)
    with db() as conn:
        note_ids = [r["id"] for r in conn.execute("SELECT id FROM notes WHERE tag_id=?", (tag_id,)).fetchall()]
        link_ids = [r["link_id"] for r in conn.execute("SELECT link_id FROM link_tags WHERE tag_id=?", (tag_id,)).fetchall()]
        for note_id in note_ids:
            conn.execute("DELETE FROM notes WHERE id=?", (note_id,))
        for link_id in link_ids:
            conn.execute("DELETE FROM links WHERE id=?", (link_id,))
        conn.execute("DELETE FROM tags WHERE id=?", (tag_id,))
    for note_id in note_ids:
        path = NOTES_DIR / f"{note_id}.md"
        if path.exists():
            path.unlink()


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

    # the add form previews the metadata and may have edited it, so take what it sends
    title = (data.get("title") or "").strip() or None
    description = (data.get("description") or "").strip() or None
    favicon_url = (data.get("favicon_url") or "").strip() or None

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
            "INSERT INTO links(id, url, title, description, favicon_url) VALUES (?,?,?,?,?)",
            (link_id, url, title, description, favicon_url)
        )
        for tag_name in tags:
            color = _next_color(conn)
            conn.execute("INSERT OR IGNORE INTO tags(name, color) VALUES (?,?)", (tag_name, color))
            tag_row = conn.execute("SELECT id FROM tags WHERE name=?", (tag_name,)).fetchone()
            if tag_row:
                _link_tag_write(conn, link_id, tag_row["id"])

    # only go scraping when the caller had nothing to give us
    if not title:
        background_tasks.add_task(_fetch_metadata, link_id, url)
    return {"id": link_id}


def _default_content_type(conn, tag_id: int, kind: str = "links") -> int:
    """The content type new items land in when only a category is known."""
    row = conn.execute(
        "SELECT id FROM content_types WHERE tag_id=? AND kind=? ORDER BY position, id LIMIT 1",
        (tag_id, kind),
    ).fetchone()
    if row:
        return row["id"]
    cur = conn.execute(
        "INSERT INTO content_types(tag_id, kind, title, position) VALUES (?,?,?,0)",
        (tag_id, kind, kind.capitalize()),
    )
    return cur.lastrowid


def _link_tag_write(conn, link_id: str, tag_id: int):
    conn.execute(
        "INSERT OR IGNORE INTO link_content_types(link_id, content_type_id) VALUES (?,?)",
        (link_id, _default_content_type(conn, tag_id)),
    )


def _file_note(conn, note_id: str, tag_id: int | None):
    """Put a note in its category's notes content type, so the sidebar lists it.
    Without this a note exists but belongs to no bucket and stays invisible."""
    conn.execute(
        "DELETE FROM note_content_types WHERE note_id=? AND content_type_id IN "
        "(SELECT id FROM content_types WHERE kind='notes')",
        (note_id,),
    )
    if tag_id:
        conn.execute(
            "INSERT OR IGNORE INTO note_content_types(note_id, content_type_id) VALUES (?,?)",
            (note_id, _default_content_type(conn, tag_id, "notes")),
        )


def _clear_link_tags(conn, link_id: str):
    """Drop membership of every links-kind content type."""
    conn.execute(
        "DELETE FROM link_content_types WHERE link_id=? AND content_type_id IN "
        "(SELECT id FROM content_types WHERE kind='links')",
        (link_id,),
    )


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
        note = conn.execute("SELECT id FROM notes WHERE link_id=?", (link["id"],)).fetchone()
        link["note_id"] = note["id"] if note else None
        result.append(link)
    return result


@router.get("/links/uncategorised-count")
def uncategorised_count(x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    with db() as conn:
        links = conn.execute(
            "SELECT COUNT(*) FROM links WHERE NOT EXISTS "
            "(SELECT 1 FROM link_tags lt WHERE lt.link_id = links.id)"
        ).fetchone()[0]
        notes = conn.execute("SELECT COUNT(*) FROM notes WHERE tag_id IS NULL").fetchone()[0]
    return {"count": links + notes, "links": links, "notes": notes}


@router.get("/links")
def list_links(
    tag: int | None = None,
    uncategorised: bool | None = None,
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


_CLEANUP_UNITS = {"days", "weeks", "months", "years"}


def _cleanup_cutoff_modifier(value: int, unit: str) -> str:
    if value <= 0:
        raise HTTPException(status_code=422, detail="value must be positive")
    unit = unit.lower()
    if unit not in _CLEANUP_UNITS:
        raise HTTPException(status_code=422, detail="invalid unit")
    if unit == "weeks":
        return f"-{value * 7} days"
    return f"-{value} {unit}"


@router.get("/links/cleanup-preview")
def cleanup_preview(value: int, unit: str, x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    modifier = _cleanup_cutoff_modifier(value, unit)
    with db() as conn:
        count = conn.execute(
            "SELECT COUNT(*) FROM links WHERE created_at < datetime('now', ?)", (modifier,)
        ).fetchone()[0]
    return {"count": count}


@router.delete("/links/cleanup")
def cleanup_links(value: int, unit: str, x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    modifier = _cleanup_cutoff_modifier(value, unit)
    with db() as conn:
        cur = conn.execute("DELETE FROM links WHERE created_at < datetime('now', ?)", (modifier,))
        deleted = cur.rowcount
    return {"deleted": deleted}


class LinkUpdate(BaseModel):
    tags: list[str] | None = None
    title: str | None = None
    description: str | None = None
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
        if body.description is not None:
            conn.execute("UPDATE links SET description=? WHERE id=?", (body.description.strip(), link_id))
        if body.url is not None:
            conn.execute("UPDATE links SET url=? WHERE id=?", (body.url.strip(), link_id))
        if body.tags is not None:
            _clear_link_tags(conn, link_id)
            for tag_name in body.tags:
                tag_name = tag_name.strip()
                if not tag_name:
                    continue
                color = _next_color(conn)
                conn.execute("INSERT OR IGNORE INTO tags(name, color) VALUES (?,?)", (tag_name, color))
                tag_row = conn.execute("SELECT id FROM tags WHERE name=?", (tag_name,)).fetchone()
                if tag_row:
                    _link_tag_write(conn, link_id, tag_row["id"])
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


# ── Notes ─────────────────────────────────────────────────────────────────────

_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def _note_path(note_id: str) -> Path:
    if not _UUID_RE.match(note_id):
        raise HTTPException(status_code=404)
    return NOTES_DIR / f"{note_id}.md"


_NOTE_SELECT = """
    SELECT n.id, n.title, n.tag_id, n.link_id, n.created_at, n.updated_at,
           t.name AS tag_name, t.color AS tag_color
    FROM notes n
    LEFT JOIN tags t ON t.id = n.tag_id
"""


def _note_dict(row) -> dict:
    d = dict(row)
    tag_name = d.pop("tag_name")
    tag_color = d.pop("tag_color")
    tag_id = d["tag_id"]
    d["tag"] = {"id": tag_id, "name": tag_name, "color": tag_color} if tag_id else None
    return d


@router.get("/notes")
def list_notes(
    tag: int | None = None,
    uncategorised: bool | None = None,
    x_tether_uuid: str | None = Header(default=None),
):
    _check_auth(x_tether_uuid)
    with db() as conn:
        clauses, params = [], []
        if tag is not None:
            clauses.append("n.tag_id=?")
            params.append(tag)
        if uncategorised:
            clauses.append("n.tag_id IS NULL")
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        rows = conn.execute(
            f"{_NOTE_SELECT} {where} ORDER BY n.position ASC", params
        ).fetchall()
    return [_note_dict(r) for r in rows]


class NoteCreate(BaseModel):
    title: str | None = None
    tag_id: int | None = None
    link_id: str | None = None


@router.post("/notes", status_code=201)
def create_note(body: NoteCreate, x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    note_id = str(uuid.uuid4())
    title = (body.title or "Untitled").strip() or "Untitled"
    (NOTES_DIR / f"{note_id}.md").write_text("", encoding="utf-8")
    with db() as conn:
        min_pos = conn.execute("SELECT MIN(position) FROM notes").fetchone()[0]
        position = (min_pos - 1) if min_pos is not None else 0
        conn.execute(
            "INSERT INTO notes(id, title, tag_id, link_id, position) VALUES (?,?,?,?,?)",
            (note_id, title, body.tag_id, body.link_id, position),
        )
        _file_note(conn, note_id, body.tag_id)
        row = conn.execute(f"{_NOTE_SELECT} WHERE n.id=?", (note_id,)).fetchone()
    return _note_dict(row)


class NoteReorder(BaseModel):
    order: list[str]


@router.patch("/notes/reorder", status_code=204)
def reorder_notes(body: NoteReorder, x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    with db() as conn:
        conn.executemany(
            "UPDATE notes SET position=? WHERE id=?",
            [(i, note_id) for i, note_id in enumerate(body.order)],
        )


@router.get("/notes/{note_id}")
def get_note(note_id: str, x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    path = _note_path(note_id)
    with db() as conn:
        row = conn.execute(f"{_NOTE_SELECT} WHERE n.id=?", (note_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404)
    result = _note_dict(row)
    result["content"] = path.read_text(encoding="utf-8") if path.exists() else ""
    return result


class NoteUpdate(BaseModel):
    title: str | None = None
    content: str | None = None
    tag_id: int | None = None  # 0 clears the category; omit/None leaves it unchanged


@router.patch("/notes/{note_id}")
def update_note(note_id: str, body: NoteUpdate, x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    path = _note_path(note_id)
    with db() as conn:
        row = conn.execute("SELECT id FROM notes WHERE id=?", (note_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404)
        if body.title is not None:
            conn.execute(
                "UPDATE notes SET title=?, updated_at=datetime('now') WHERE id=?",
                (body.title.strip() or "Untitled", note_id),
            )
        if body.tag_id is not None:
            conn.execute(
                "UPDATE notes SET tag_id=?, updated_at=datetime('now') WHERE id=?",
                (body.tag_id or None, note_id),
            )
            _file_note(conn, note_id, body.tag_id or None)
        if body.content is not None:
            path.write_text(body.content, encoding="utf-8")
            conn.execute("UPDATE notes SET updated_at=datetime('now') WHERE id=?", (note_id,))
        result = conn.execute(f"{_NOTE_SELECT} WHERE n.id=?", (note_id,)).fetchone()
    return _note_dict(result)


@router.delete("/notes/{note_id}", status_code=204)
def delete_note(note_id: str, x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    with db() as conn:
        conn.execute("DELETE FROM notes WHERE id=?", (note_id,))
    path = _note_path(note_id)
    if path.exists():
        path.unlink()


# ── Settings ──────────────────────────────────────────────────────────────────

class SettingValue(BaseModel):
    value: str


# ── Content types ────────────────────────────────────────────
def _content_type_dict(conn, row) -> dict:
    d = dict(row)
    table, col = (("link_content_types", "link_id") if d["kind"] == "links"
                  else ("note_content_types", "note_id"))
    d["count"] = conn.execute(
        f"SELECT COUNT(*) c FROM {table} WHERE content_type_id=?", (d["id"],)
    ).fetchone()["c"]
    return d


@router.get("/content-types")
def list_content_types(tag: int | None = None, x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    with db() as conn:
        sql = "SELECT id, tag_id, kind, title, position FROM content_types"
        params: list = []
        if tag is not None:
            sql += " WHERE tag_id=?"
            params.append(tag)
        sql += " ORDER BY position, id"
        return [_content_type_dict(conn, r) for r in conn.execute(sql, params).fetchall()]


class MembershipBody(BaseModel):
    item_kind: str          # link | note
    item_id: str


_MEMBER_TABLES = {
    "link": ("link_content_types", "link_id"),
    "note": ("note_content_types", "note_id"),
}


@router.post("/content-types/{ct_id}/items", status_code=204)
def add_item_to_content_type(ct_id: int, body: MembershipBody, x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    if body.item_kind not in _MEMBER_TABLES:
        raise HTTPException(status_code=400, detail="unknown item_kind")
    table, col = _MEMBER_TABLES[body.item_kind]
    with db() as conn:
        if not conn.execute("SELECT 1 FROM content_types WHERE id=?", (ct_id,)).fetchone():
            raise HTTPException(status_code=404)
        conn.execute(
            f"INSERT OR IGNORE INTO {table}({col}, content_type_id) VALUES (?,?)", (body.item_id, ct_id)
        )


@router.delete("/content-types/{ct_id}/items", status_code=204)
def remove_item_from_content_type(ct_id: int, item_kind: str, item_id: str,
                                  x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    if item_kind not in _MEMBER_TABLES:
        raise HTTPException(status_code=400, detail="unknown item_kind")
    table, col = _MEMBER_TABLES[item_kind]
    with db() as conn:
        conn.execute(f"DELETE FROM {table} WHERE {col}=? AND content_type_id=?", (item_id, ct_id))


@router.get("/content-types/{ct_id}/items")
def list_content_type_items(ct_id: int, x_tether_uuid: str | None = Header(default=None)):
    """Everything in this bucket."""
    _check_auth(x_tether_uuid)
    with db() as conn:
        row = conn.execute("SELECT * FROM content_types WHERE id=?", (ct_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404)
        kind = row["kind"]
        out: dict = {"content_type": dict(row), "links": [], "notes": []}

        if kind == "links":
            rows = conn.execute(
                "SELECT l.* FROM links l JOIN link_content_types lct ON lct.link_id=l.id "
                "WHERE lct.content_type_id=? ORDER BY l.created_at DESC", (ct_id,)
            ).fetchall()
            out["links"] = _link_rows(conn, rows)
        else:
            rows = conn.execute(
                f"{_NOTE_SELECT} JOIN note_content_types nct ON nct.note_id=n.id "
                "WHERE nct.content_type_id=? ORDER BY n.position ASC", (ct_id,)
            ).fetchall()
            out["notes"] = [_note_dict(r) for r in rows]
        return out


@router.post("/settings/uuid", status_code=200)
def regenerate_uuid(body: SettingValue, x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    set_setting("uuid", body.value)
    return {"ok": True}


# ── Export / Import ───────────────────────────────────────────────────────────

def _parse_tags(tag: int | None, tags: str | None) -> list[int] | None:
    """Accept ?tag=1 or ?tags=1,2,3. None means every category."""
    ids: list[int] = []
    if tag is not None:
        ids.append(tag)
    for part in (tags or "").split(","):
        part = part.strip()
        if part.isdigit():
            ids.append(int(part))
    return sorted(set(ids)) or None


def _links_export_payload(conn, tag_ids: list[int] | None = None) -> dict:
    if tag_ids:
        marks = ",".join("?" * len(tag_ids))
        links = [dict(r) for r in conn.execute(
            "SELECT DISTINCT l.id, l.url, l.title, l.description, l.favicon_url, l.created_at "
            f"FROM links l JOIN link_tags lt ON lt.link_id=l.id WHERE lt.tag_id IN ({marks}) "
            "ORDER BY l.created_at",
            tag_ids
        ).fetchall()]
        tags = [dict(r) for r in conn.execute(
            f"SELECT id, name, color FROM tags WHERE id IN ({marks})", tag_ids).fetchall()]
        link_tags = [dict(r) for r in conn.execute(
            f"SELECT link_id, tag_id FROM link_tags WHERE tag_id IN ({marks})", tag_ids
        ).fetchall()]
    else:
        links = [dict(r) for r in conn.execute(
            "SELECT id, url, title, description, favicon_url, created_at FROM links ORDER BY created_at"
        ).fetchall()]
        tags = [dict(r) for r in conn.execute("SELECT id, name, color FROM tags").fetchall()]
        link_tags = [dict(r) for r in conn.execute("SELECT link_id, tag_id FROM link_tags").fetchall()]
    return {"version": 1, "links": links, "tags": tags, "link_tags": link_tags}


def _note_export_filename(title: str, note_id: str) -> str:
    name = re.sub(r"[^\w\s-]", "", title or "Untitled").strip()
    name = re.sub(r"\s+", "-", name)[:60] or "Untitled"
    return f"{name}-{note_id[:8]}.md"


def _write_notes_to_zip(zf: zipfile.ZipFile, conn, prefix: str = "", tag_ids: list[int] | None = None):
    query = "SELECT id, title FROM notes"
    params: tuple = ()
    if tag_ids:
        query += f" WHERE tag_id IN ({','.join('?' * len(tag_ids))})"
        params = tuple(tag_ids)
    for n in conn.execute(query, params).fetchall():
        path = NOTES_DIR / f"{n['id']}.md"
        content = path.read_text(encoding="utf-8") if path.exists() else ""
        zf.writestr(f"{prefix}{_note_export_filename(n['title'], n['id'])}", content)


@router.get("/export")
def export_data(tag: int | None = None, tags: str | None = None,
                x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    with db() as conn:
        payload = _json.dumps(_links_export_payload(conn, _parse_tags(tag, tags)), indent=2)
    return Response(
        content=payload,
        media_type="application/json",
        headers={"Content-Disposition": "attachment; filename=tether-export.json"},
    )


@router.get("/export/notes")
def export_notes(tag: int | None = None, tags: str | None = None,
                 x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    buf = io.BytesIO()
    with db() as conn, zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        _write_notes_to_zip(zf, conn, tag_ids=_parse_tags(tag, tags))
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=tether-notes.zip"},
    )


@router.get("/export/all")
def export_all(tag: int | None = None, tags: str | None = None,
               x_tether_uuid: str | None = Header(default=None)):
    _check_auth(x_tether_uuid)
    tag_ids = _parse_tags(tag, tags)
    buf = io.BytesIO()
    with db() as conn, zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("links.json", _json.dumps(_links_export_payload(conn, tag_ids), indent=2))
        _write_notes_to_zip(zf, conn, prefix="notes/", tag_ids=tag_ids)
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=tether-export.zip"},
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
                        "INSERT INTO links(id, url, title, description, favicon_url, created_at) VALUES(?,?,?,?,?,?)",
                        (link["id"], link["url"], link.get("title"), link.get("description"),
                         link.get("favicon_url"), link.get("created_at")),
                    )
                    imported += 1
                else:
                    skipped += 1

            # Restore link→tag relationships
            for lt in data.get("link_tags", []):
                new_tag_id = tag_id_map.get(lt["tag_id"])
                if not new_tag_id:
                    continue
                _link_tag_write(conn, lt["link_id"], new_tag_id)

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
