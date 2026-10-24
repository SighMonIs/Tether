"""Nested tags and notes against a throwaway data dir: python test_nesting.py"""
import os
import tempfile

os.environ["TETHER_DATA"] = tempfile.mkdtemp()

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402
from db import get_setting  # noqa: E402

with TestClient(app) as c:
    h = {"X-Tether-UUID": get_setting("uuid")}

    # a tag can be made straight under a parent, one level deep only
    games = c.post("/api/tags", headers=h, json={"name": "Games", "kind": "notes"}).json()
    cd = c.post("/api/tags", headers=h, json={"name": "Crimson Desert", "kind": "notes", "parent_id": games["id"]})
    assert cd.status_code == 201 and cd.json()["parent_id"] == games["id"], cd.text
    cd = cd.json()
    assert c.post("/api/tags", headers=h, json={"name": "Deeper", "kind": "notes", "parent_id": cd["id"]}).status_code == 400
    links = c.post("/api/tags", headers=h, json={"name": "Elsewhere", "kind": "links"}).json()
    assert c.post("/api/tags", headers=h, json={"name": "Mixed", "kind": "notes", "parent_id": links["id"]}).status_code == 400
    paths = {t["name"]: t["path"] for t in c.get("/api/tags?kind=notes", headers=h).json()}
    assert paths["Crimson Desert"] == "games/crimson-desert"

    # a sub-note takes its parent's tag
    parent = c.post("/api/notes", headers=h, json={"title": "AI Projects", "tag_id": games["id"]}).json()
    kid = c.post("/api/notes", headers=h, json={"title": "Budget app", "parent_id": parent["id"]}).json()
    assert kid["parent_id"] == parent["id"] and kid["tag_id"] == games["id"]
    assert c.post("/api/notes", headers=h, json={"title": "x", "parent_id": kid["id"]}).status_code == 400

    # an existing note can be nested and un-nested
    other = c.post("/api/notes", headers=h, json={"title": "Weapons", "tag_id": cd["id"]}).json()
    r = c.patch(f"/api/notes/{other['id']}", headers=h, json={"parent_id": parent["id"]}).json()
    assert r["parent_id"] == parent["id"] and r["tag_id"] == games["id"]
    assert c.patch(f"/api/notes/{parent['id']}", headers=h, json={"parent_id": kid["id"]}).status_code == 400
    assert c.patch(f"/api/notes/{parent['id']}", headers=h, json={"parent_id": parent["id"]}).status_code == 400
    r = c.patch(f"/api/notes/{other['id']}", headers=h, json={"parent_id": None}).json()
    assert r["parent_id"] is None

    # moving a parent takes its sub-notes along; moving a sub-note away un-nests it
    c.patch(f"/api/notes/{parent['id']}", headers=h, json={"tag_id": cd["id"]})
    notes = {n["id"]: n for n in c.get(f"/api/notes?tag={cd['id']}", headers=h).json()}
    assert notes[kid["id"]]["parent_id"] == parent["id"]
    ct = next(t for t in c.get(f"/api/content-types?tag={cd['id']}", headers=h).json() if t["kind"] == "notes")
    assert ct["count"] == 2
    r = c.patch(f"/api/notes/{kid['id']}", headers=h, json={"tag_id": games["id"]}).json()
    assert r["parent_id"] is None and r["tag_id"] == games["id"]

    # deleting a parent leaves its sub-notes at the top level
    c.patch(f"/api/notes/{other['id']}", headers=h, json={"parent_id": parent["id"]})
    c.delete(f"/api/notes/{parent['id']}", headers=h)
    assert c.get(f"/api/notes/{other['id']}", headers=h).json()["parent_id"] is None

print("ok")
