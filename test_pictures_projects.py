"""Pictures and projects against a throwaway data dir: python test_pictures_projects.py"""
import os
import tempfile

os.environ["TETHER_DATA"] = tempfile.mkdtemp()

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402
from db import get_setting  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 32

with TestClient(app) as c:
    h = {"X-Tether-UUID": get_setting("uuid")}

    # a picture is sniffed from its bytes, whatever the upload claims
    r = c.post("/api/pictures", headers=h, files={"file": ("shot.png", PNG, "application/octet-stream")},
               data={"tag": "Screens"})
    assert r.status_code == 201, r.text
    pic = r.json()
    assert pic["title"] == "shot" and pic["mime"] == "image/png" and pic["tag"]["name"] == "Screens"
    assert c.get(pic["src"]).content == PNG
    bad = c.post("/api/pictures", headers=h, files={"file": ("x.svg", b"<svg onload=alert(1)>", "image/svg+xml")})
    assert bad.status_code == 415
    assert [t["kind"] for t in c.get("/api/tags?kind=pictures", headers=h).json()] == ["pictures"]

    # a project collects; removing or deleting never touches the item
    link = c.post("/api/links", headers=h, json={"url": "https://example.com", "title": "Ex"}).json()
    proj = c.post("/api/projects", headers=h, json={"name": "Kitchen reno"}).json()
    assert proj["slug"] == "kitchen-reno"
    for kind, item in (("link", link["id"]), ("picture", pic["id"])):
        assert c.post(f"/api/projects/{proj['id']}/items", headers=h,
                      json={"item_kind": kind, "item_id": item}).status_code == 204
    got = c.get(f"/api/projects/{proj['id']}", headers=h).json()
    assert (len(got["links"]), len(got["pictures"]), got["count"]) == (1, 1, 2)
    assert c.get("/project/kitchen-reno").status_code == 200

    # deleting the item drops it from the project (trigger), the project stays
    c.delete(f"/api/pictures/{pic['id']}", headers=h)
    assert c.get(pic["src"]).status_code == 404
    assert c.get(f"/api/projects/{proj['id']}", headers=h).json()["count"] == 1

    c.delete(f"/api/projects/{proj['id']}", headers=h)
    assert c.get(f"/api/links/{link['id']}", headers=h).status_code == 200

print("ok")
