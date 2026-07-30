# Testing the IFC5 (.ifcx) EXPERIMENTAL export

Covers `ifc/export_ifcx.py` and the `/models/{model_id}/export/ifcx*` routes
in `routers/ifc_export.py` — a second, deliberately minimal and clearly
EXPERIMENTAL export alongside the mature IFC4X3 export (`ifc/export.py`).

IFC5 is buildingSMART's next-generation, still-**unratified alpha** spec.
`.ifcx` is a flat JSON changeset format (confirmed against
`buildingSMART/IFC5-development`'s own example files), not STEP/EXPRESS —
no `usd-core`/`pxr` dependency is involved. v1 scope is intentionally
narrow: spatial hierarchy, IFC class, body mesh geometry (always
triangulated), and flat properties. Materials, type objects, quantities,
element relationships, and the 4D schedule are **not** included — that's
`ifc/export.py::export_model`'s job.

This repo has no `tests/`/`test_*.py` for the export path — verification is
manual, following the same convention as `testing-documents.md` etc.

## 1. Round trip

```bash
curl -sX POST "http://<host>:<port>/models/<model_id>/export/ifcx" | tee /tmp/start.json
# {"job_id": "...", "status": "pending"}

job_id=$(python3 -c "import json;print(json.load(open('/tmp/start.json'))['job_id'])")

# poll until status == "complete"
curl -s "http://<host>:<port>/models/<model_id>/export/ifcx/$job_id/status"

curl -s "http://<host>:<port>/models/<model_id>/export/ifcx/$job_id/download" -o out.ifcx
python3 -c "import json; json.load(open('out.ifcx'))"   # must not raise
```

## 2. Structural sanity checks

```python
import json

doc = json.load(open("out.ifcx"))

# header has all required keys
assert set(doc["header"]) >= {"id", "ifcxVersion", "dataVersion", "author", "timestamp"}
assert doc["ifcxVersion"] == "ifcx_alpha"

# every class assertion has a URI that matches the class code
for entry in doc["data"]:
    cls = entry.get("attributes", {}).get("bsi::ifc::class")
    if cls:
        assert cls["code"].startswith("Ifc")
        assert cls["uri"].endswith(f"/class/{cls['code']}")

# every mesh is fully triangulated and every index is in range
for entry in doc["data"]:
    mesh = entry.get("attributes", {}).get("usd::usdgeom::mesh")
    if mesh:
        idx = mesh["faceVertexIndices"]
        n_pts = len(mesh["points"])
        assert len(idx) % 3 == 0
        assert all(0 <= i < n_pts for i in idx)
```

## 3. Reference-integrity check (children resolve to real paths)

`.ifcx`'s `data` array is a flat list of assertions keyed by `path` — the
same path can appear multiple times, and hierarchy is expressed only via
`children` maps. This validates that structure isn't broken (a `children`
entry pointing at a path that never appears anywhere else in `data` would
render as a dangling/missing node in any real IFC5 viewer):

```python
all_paths = {entry["path"] for entry in doc["data"]}
referenced = {
    child_id
    for entry in doc["data"]
    for child_id in entry.get("children", {}).values()
}
assert referenced <= all_paths, referenced - all_paths

# exactly one path (the IfcProject root) is never referenced as anyone's child
roots = all_paths - referenced
assert len(roots) == 1, roots
```

## 4. Element-count parity

Count prims carrying `bsi::ifc::class` in the output and confirm it matches
the element count for the same model (`bim_elements` rows), mirroring the
log line `export_model_ifcx()` already emits:

```python
class_count = sum(1 for e in doc["data"] if "bsi::ifc::class" in e.get("attributes", {}))
# compare against len(elements) from _load_export_data(model_id, coord_unit) —
# note this also counts Project/Site/Building/Storey (4 + n_storeys extra),
# not just building elements.
```

## 5. Manual spot-check (required once per non-trivial change to this exporter)

Open a generated `.ifcx` file in buildingSMART's own published viewer:
**https://ifc5.technical.buildingsmart.org/viewer/** — confirm the spatial
hierarchy (Project → Site → Building → Storey → elements) and body geometry
render correctly. This is the only step that actually confirms an external
IFC5 tool accepts the file, not just that our own JSON is self-consistent.
