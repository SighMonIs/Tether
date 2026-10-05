"""Readable URL segments for categories and notes.

Slugs are derived from the current name/title rather than stored, so renaming
a category or note changes its URL. That keeps one source of truth; the cost
is that an old link stops resolving, which for a personal tool is the better
trade than a slug that drifts away from what the thing is called.
"""

import re
import unicodedata

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


def tag_paths(conn, kind: str) -> dict:
    """{id: "parent-slug/child-slug"} for one side's tags. Slugs only need to be
    unique among siblings, since the parent's slug is in the path too."""
    rows = conn.execute(
        "SELECT id, name, parent_id FROM tags WHERE kind=? ORDER BY id", (kind,)
    ).fetchall()
    ids = {r["id"] for r in rows}
    parent = {r["id"]: (r["parent_id"] if r["parent_id"] in ids else None) for r in rows}
    groups: dict = {}
    for r in rows:
        groups.setdefault(parent[r["id"]], []).append({"id": r["id"], "name": r["name"]})
    slugs: dict = {}
    for siblings in groups.values():
        slugs.update(slug_map(siblings, "name"))
    return {i: (f"{slugs[parent[i]]}/" if parent[i] else "") + slugs[i] for i in ids}


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
