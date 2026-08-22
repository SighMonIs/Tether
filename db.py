import os
import sqlite3
import uuid
from pathlib import Path
from contextlib import contextmanager

_data_dir = Path(os.environ.get("TETHER_DATA", Path(__file__).parent))
DB_PATH = _data_dir / "tether.db"
NOTES_DIR = _data_dir / "notes"

# A content type is a user-named bucket inside a category, e.g. Cooking > "Vegan".
CONTENT_KINDS = ("links", "notes")


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def db():
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    with db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tags (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                name     TEXT    NOT NULL UNIQUE COLLATE NOCASE,
                color    TEXT    NOT NULL DEFAULT '#6366f1',
                position INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS links (
                id           TEXT PRIMARY KEY,
                url          TEXT NOT NULL,
                title        TEXT,
                description  TEXT,
                favicon_url  TEXT,
                created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS links_fts USING fts5(
                id UNINDEXED,
                url,
                title,
                description,
                content='links',
                content_rowid='rowid'
            );

            CREATE TRIGGER IF NOT EXISTS links_ai AFTER INSERT ON links BEGIN
                INSERT INTO links_fts(rowid, id, url, title, description)
                VALUES (new.rowid, new.id, new.url, new.title, new.description);
            END;

            CREATE TRIGGER IF NOT EXISTS links_au AFTER UPDATE ON links BEGIN
                INSERT INTO links_fts(links_fts, rowid, id, url, title, description)
                VALUES ('delete', old.rowid, old.id, old.url, old.title, old.description);
                INSERT INTO links_fts(rowid, id, url, title, description)
                VALUES (new.rowid, new.id, new.url, new.title, new.description);
            END;

            CREATE TRIGGER IF NOT EXISTS links_ad AFTER DELETE ON links BEGIN
                INSERT INTO links_fts(links_fts, rowid, id, url, title, description)
                VALUES ('delete', old.rowid, old.id, old.url, old.title, old.description);
            END;

            CREATE TABLE IF NOT EXISTS notes (
                id         TEXT PRIMARY KEY,
                title      TEXT NOT NULL DEFAULT 'Untitled',
                tag_id     INTEGER REFERENCES tags(id) ON DELETE SET NULL,
                link_id    TEXT REFERENCES links(id) ON DELETE SET NULL,
                position   INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS content_types (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                kind     TEXT    NOT NULL,
                title    TEXT    NOT NULL,
                position INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS content_types_tag ON content_types(tag_id);

            CREATE TABLE IF NOT EXISTS link_content_types (
                link_id         TEXT    NOT NULL REFERENCES links(id) ON DELETE CASCADE,
                content_type_id INTEGER NOT NULL REFERENCES content_types(id) ON DELETE CASCADE,
                PRIMARY KEY (link_id, content_type_id)
            );
            CREATE TABLE IF NOT EXISTS note_content_types (
                note_id         TEXT    NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
                content_type_id INTEGER NOT NULL REFERENCES content_types(id) ON DELETE CASCADE,
                PRIMARY KEY (note_id, content_type_id)
            );
        """)

        # Migrations for existing databases
        note_cols = {r[1] for r in conn.execute("PRAGMA table_info(notes)")}
        if "tag_id" not in note_cols:
            conn.execute("ALTER TABLE notes ADD COLUMN tag_id INTEGER REFERENCES tags(id) ON DELETE SET NULL")
        if "link_id" not in note_cols:
            conn.execute("ALTER TABLE notes ADD COLUMN link_id TEXT REFERENCES links(id) ON DELETE SET NULL")
        if "position" not in note_cols:
            conn.execute("ALTER TABLE notes ADD COLUMN position INTEGER NOT NULL DEFAULT 0")
            rows = conn.execute("SELECT id FROM notes ORDER BY updated_at DESC").fetchall()
            conn.executemany(
                "UPDATE notes SET position=? WHERE id=?",
                [(i, r["id"]) for i, r in enumerate(rows)],
            )

        NOTES_DIR.mkdir(parents=True, exist_ok=True)
        _migrate_to_content_types(conn)
        _drop_unused_kinds(conn)
        _drop_read_columns(conn)
        _file_orphan_notes(conn)
        _add_tag_position(conn)
        _ensure_default_content_types(conn)

        # Generate UUID on first run
        existing = conn.execute("SELECT value FROM settings WHERE key='uuid'").fetchone()
        if not existing:
            conn.execute(
                "INSERT INTO settings(key, value) VALUES ('uuid', ?)",
                (str(uuid.uuid4()),)
            )



def _migrate_to_content_types(conn):
    """Give every existing category a Links and a Notes content type and move its
    items across. Lossless: link_tags is many-to-many and so is the replacement,
    so a link in two categories lands in both categories' Links type."""
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "link_tags" not in tables:
        _ensure_link_tags_view(conn)
        return  # already migrated

    for tag in conn.execute("SELECT id FROM tags").fetchall():
        made = {}
        for pos, kind in enumerate(("links", "notes")):
            row = conn.execute(
                "SELECT id FROM content_types WHERE tag_id=? AND kind=?", (tag["id"], kind)
            ).fetchone()
            if row:
                made[kind] = row["id"]
                continue
            cur = conn.execute(
                "INSERT INTO content_types(tag_id, kind, title, position) VALUES (?,?,?,?)",
                (tag["id"], kind, kind.capitalize(), pos),
            )
            made[kind] = cur.lastrowid

        conn.execute(
            "INSERT OR IGNORE INTO link_content_types(link_id, content_type_id) "
            "SELECT link_id, ? FROM link_tags WHERE tag_id=?",
            (made["links"], tag["id"]),
        )
        conn.execute(
            "INSERT OR IGNORE INTO note_content_types(note_id, content_type_id) "
            "SELECT id, ? FROM notes WHERE tag_id=?",
            (made["notes"], tag["id"]),
        )

    # link_tags is now derived from content_types, so drop the second source of
    # truth and expose the same shape as a view — every read query still works.
    conn.execute("DROP TABLE link_tags")
    _ensure_link_tags_view(conn)


def _add_tag_position(conn):
    """Categories are drag-orderable, so they need a stored order."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(tags)")}
    if "position" in cols:
        return
    conn.execute("ALTER TABLE tags ADD COLUMN position INTEGER NOT NULL DEFAULT 0")
    rows = conn.execute("SELECT id FROM tags ORDER BY name").fetchall()
    conn.executemany("UPDATE tags SET position=? WHERE id=?",
                     [(i, r["id"]) for i, r in enumerate(rows)])


def _ensure_default_content_types(conn):
    """Every category holds Links and Notes. Without this a freshly created
    category drills into an empty sidebar."""
    for tag in conn.execute("SELECT id FROM tags").fetchall():
        for pos, kind in enumerate(("links", "notes")):
            exists = conn.execute(
                "SELECT 1 FROM content_types WHERE tag_id=? AND kind=?", (tag["id"], kind)
            ).fetchone()
            if not exists:
                conn.execute(
                    "INSERT INTO content_types(tag_id, kind, title, position) VALUES (?,?,?,?)",
                    (tag["id"], kind, kind.capitalize(), pos),
                )


def _file_orphan_notes(conn):
    """Notes created before content types existed (or by the add-note-from-link
    flow) belong to no bucket, so nothing lists them. File them under their
    category's notes content type."""
    orphans = conn.execute("""
        SELECT id, tag_id FROM notes
        WHERE tag_id IS NOT NULL
          AND id NOT IN (SELECT note_id FROM note_content_types)
    """).fetchall()
    for note in orphans:
        row = conn.execute(
            "SELECT id FROM content_types WHERE tag_id=? AND kind='notes' ORDER BY position, id LIMIT 1",
            (note["tag_id"],),
        ).fetchone()
        if row:
            ct_id = row["id"]
        else:
            ct_id = conn.execute(
                "INSERT INTO content_types(tag_id, kind, title, position) VALUES (?,?,?,0)",
                (note["tag_id"], "notes", "Notes"),
            ).lastrowid
        conn.execute(
            "INSERT OR IGNORE INTO note_content_types(note_id, content_type_id) VALUES (?,?)",
            (note["id"], ct_id),
        )


def _drop_read_columns(conn):
    """Read/unread was removed from the app; drop the columns it used.

    DROP COLUMN needs SQLite 3.35+. On anything older the columns simply stay —
    nothing reads them — so a tidy-up must never stop the app from booting."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(links)")}
    for col in ("is_read", "read_at"):
        if col in cols:
            try:
                conn.execute(f"ALTER TABLE links DROP COLUMN {col}")
            except sqlite3.OperationalError:
                pass


def _drop_unused_kinds(conn):
    """Pictures and folders were dropped from the app. Clear the leftovers, but
    only while they hold nothing, so no data can go with them."""
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for t in ("picture_content_types", "pictures"):
        if t in tables and conn.execute(f"SELECT COUNT(*) c FROM {t}").fetchone()["c"] == 0:
            conn.execute(f"DROP TABLE {t}")
    empty_folders = conn.execute("""
        SELECT id FROM content_types WHERE kind NOT IN ('links', 'notes')
        AND id NOT IN (SELECT content_type_id FROM link_content_types)
        AND id NOT IN (SELECT content_type_id FROM note_content_types)
    """).fetchall()
    for row in empty_folders:
        conn.execute("DELETE FROM content_types WHERE id=?", (row["id"],))


def _ensure_link_tags_view(conn):
    conn.execute("""
        CREATE VIEW IF NOT EXISTS link_tags AS
        SELECT lct.link_id AS link_id, ct.tag_id AS tag_id
        FROM link_content_types lct
        JOIN content_types ct ON ct.id = lct.content_type_id
    """)


def get_setting(key: str) -> str | None:
    with db() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return row["value"] if row else None


def set_setting(key: str, value: str):
    with db() as conn:
        conn.execute(
            "INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value)
        )
