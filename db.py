import os
import sqlite3
import uuid
from pathlib import Path
from contextlib import contextmanager

_data_dir = Path(os.environ.get("TETHER_DATA", Path(__file__).parent))
DB_PATH = _data_dir / "tether.db"


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
                id    INTEGER PRIMARY KEY AUTOINCREMENT,
                name  TEXT    NOT NULL UNIQUE COLLATE NOCASE,
                color TEXT    NOT NULL DEFAULT '#6366f1'
            );

            CREATE TABLE IF NOT EXISTS links (
                id           TEXT PRIMARY KEY,
                url          TEXT NOT NULL,
                title        TEXT,
                description  TEXT,
                favicon_url  TEXT,
                is_read      INTEGER NOT NULL DEFAULT 0,
                is_favourite INTEGER NOT NULL DEFAULT 0,
                created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
                read_at      TEXT
            );

            CREATE TABLE IF NOT EXISTS link_tags (
                link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
                tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                PRIMARY KEY (link_id, tag_id)
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
        """)

        # Migrations for existing databases
        cols = {r[1] for r in conn.execute("PRAGMA table_info(links)")}
        if "is_favourite" not in cols:
            conn.execute("ALTER TABLE links ADD COLUMN is_favourite INTEGER NOT NULL DEFAULT 0")

        # Generate UUID on first run
        existing = conn.execute("SELECT value FROM settings WHERE key='uuid'").fetchone()
        if not existing:
            conn.execute(
                "INSERT INTO settings(key, value) VALUES ('uuid', ?)",
                (str(uuid.uuid4()),)
            )



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
