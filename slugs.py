"""Readable URL segments for categories and notes.

Slugs are derived from the current name/title rather than stored, so renaming
a category or note changes its URL. That keeps one source of truth; the cost
is that an old link stops resolving, which for a personal tool is the better
trade than a slug that drifts away from what the thing is called.
"""

import re
import unicodedata

# top-level paths that can never be a category slug
RESERVED = {
    "api", "static", "settings", "qr.png", "shortcut", "shortcut-setup",
    "links", "notes", "favicon.ico",
}

UNTAGGED = "untagged"


def slugify(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode()
    text = re.sub(r"[^\w\s-]", "", text).strip().lower()
    text = re.sub(r"[\s_]+", "-", text)
    text = re.sub(r"-{2,}", "-", text).strip("-")
    return text or "untitled"


def slug_map(rows, key: str) -> dict:
    """{id: slug} for a set of rows, with duplicates suffixed -2, -3, …

    Rows must arrive in a stable order or the suffixes will move around.
    """
    seen: dict[str, int] = {}
    out: dict = {}
    for row in rows:
        base = slugify(row[key])
        seen[base] = seen.get(base, 0) + 1
        n = seen[base]
        out[row["id"]] = base if n == 1 else f"{base}-{n}"
    return out


def tag_slugs(conn) -> dict:
    rows = conn.execute("SELECT id, name FROM tags ORDER BY id").fetchall()
    return slug_map([{"id": r["id"], "name": r["name"]} for r in rows], "name")


def note_slugs(conn, tag_id: int | None) -> dict:
    """Notes are only unique within their category, so scope the map to one."""
    if tag_id is None:
        rows = conn.execute(
            "SELECT id, title FROM notes WHERE tag_id IS NULL ORDER BY position, id"
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT id, title FROM notes WHERE tag_id=? ORDER BY position, id", (tag_id,)
        ).fetchall()
    return slug_map([{"id": r["id"], "title": r["title"]} for r in rows], "title")
