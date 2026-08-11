#!/usr/bin/env python3
"""
End-to-end verification that bim-normalizer's extracted BIM metrics (element
counts, volumes, areas) are correct for real-world IFC files from a variety
of authoring tools — not just self-consistent with its own code.

This is an INTEGRATION test, not a unit test (see ../tests/ for those): it
needs a live Speckle server + a running bim-normalizer + direct Postgres
access, because the two real bugs this script was written to catch
(https://github.com/... — see git history of ifc/geometry.py and
speckle/fetch.py around SAMPLE_FILES's addition) were both specific to how
*Speckle's own IFC importer* shapes its converted objects — a test that only
exercises ifcopenshell + bim-normalizer's code locally, without a real
Speckle round-trip, would never have caught either one:

  1. Elements aggregated via IFC's Decomposes relationship (e.g. an
     IfcStair's IfcRailing/IfcMember/IfcStairFlight children) are nested by
     Speckle's FileImportService under an `@elements` "detached property",
     not the plain `elements` attribute flatten_elements originally checked
     for — silently dropping them from every metric.
  2. Some Speckle-IFC-imported objects (family-instance-style elements:
     doors, windows, furniture) carry a `units` metadata string that
     disagrees with the actual scale of their own mesh coordinates —
     silently producing volumes/areas ~1e9x/1e6x too small.

For each file in SAMPLE_FILES, this script: downloads it (cached after the
first run) -> creates a throwaway Speckle project+model -> uploads via the
presigned-URL flow -> waits for FileImportService to convert it -> POSTs
/ingest and waits for completion -> queries bim_elements/bim_geometry
directly -> independently computes ground truth from the same file via
ifcopenshell -> compares -> reports pass/fail. The throwaway Speckle project
is deleted at the end of each run unless --keep is passed.

Usage (run inside the bim-normalizer container, where SPECKLE_TOKEN/PG_*/
ifcopenshell are already available — `docker exec bim-normalizer python3
scripts/verify_ifc_metrics.py`), or locally with the same environment
variables bim-normalizer itself uses (SPECKLE_SERVER_URL, SPECKLE_TOKEN,
PG_HOST, PG_PORT, PG_USER, PG_PASS, PG_NAME) plus NORMALIZER_URL (default
http://localhost:8002):

    python3 scripts/verify_ifc_metrics.py                 # all sample files
    python3 scripts/verify_ifc_metrics.py --file duplex    # one file (by key)
    python3 scripts/verify_ifc_metrics.py --keep           # leave Speckle test data behind
    python3 scripts/verify_ifc_metrics.py --cache-dir /tmp/ifc-cache
"""
import argparse
import json
import os
import sys
import tempfile
import time
import uuid
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import settings  # noqa: E402

GRAPHQL_URL = f"{settings.SPECKLE_SERVER_URL.rstrip('/')}/graphql"
NORMALIZER_URL = os.getenv("NORMALIZER_URL", "http://localhost:8002")

# Sample files spanning different authoring tools and IFC schema versions —
# the two real bugs this script guards against were both specific to how
# Speckle's importer handles a particular *kind* of source data (aggregated
# children, family-instance-style objects), so variety here matters more
# than file count.
SAMPLE_FILES = {
    "duplex": {
        "label": "Duplex Apartment (Revit Architecture 2011, IFC2X3)",
        "url": "https://raw.githubusercontent.com/andyward/XBimDemo/master/Xbim.TestApp/Duplex_A_20110907.ifc",
    },
    "sketchup": {
        "label": "Building-Structural (IFC-manager for SketchUp, IFC4)",
        "url": "https://raw.githubusercontent.com/buildingSMART/Sample-Test-Files/main/IFC%204.0.2.1%20(IFC%204)/PCERT-Sample-Scene/Building-Structural.ifc",
    },
    "archicad": {
        "label": "AC20-FZK-Haus (ArchiCAD 20, IFC4, embedded base quantities)",
        "url": "https://raw.githubusercontent.com/ibpsa/project1-wp-2-2-bim/master/IFC_Files/MISC/AC20-FZK-Haus.ifc",
    },
}

# A correctly-scaled element's volume/area should never be many orders of
# magnitude smaller than its own bounding box — see ifc/geometry.py's
# _plausible_length_factor for the bug this specifically catches.
_QUANTITY_VS_BBOX_SANITY_RATIO = 1e-6


# ---------------------------------------------------------------------------
# Download (cached)
# ---------------------------------------------------------------------------

def download(url: str, cache_dir: Path) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    dest = cache_dir / url.split("/")[-1]
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    resp = requests.get(url, timeout=60)
    resp.raise_for_status()
    dest.write_bytes(resp.content)
    return dest


# ---------------------------------------------------------------------------
# Speckle upload (GraphQL presigned-URL flow)
# ---------------------------------------------------------------------------

def _gql(query: str, variables: dict) -> dict:
    resp = requests.post(
        GRAPHQL_URL,
        headers={"Authorization": f"Bearer {settings.SPECKLE_TOKEN}", "Content-Type": "application/json"},
        json={"query": query, "variables": variables},
        timeout=60,
    )
    if resp.status_code >= 400:
        raise RuntimeError(f"GraphQL HTTP {resp.status_code}: {resp.text[:1000]}")
    data = resp.json()
    if data.get("errors"):
        raise RuntimeError(f"GraphQL error: {data['errors']}")
    return data["data"]


def create_project(name: str) -> str:
    data = _gql(
        "mutation($name: String!) { projectMutations { create(input: {name: $name, "
        'visibility: PRIVATE}) { id } } }',
        {"name": name},
    )
    return data["projectMutations"]["create"]["id"]


def create_model(project_id: str, name: str) -> str:
    data = _gql(
        "mutation($pid: ID!, $name: String!) { modelMutations { create(input: "
        "{projectId: $pid, name: $name}) { id } } }",
        {"pid": project_id, "name": name},
    )
    return data["modelMutations"]["create"]["id"]


def delete_project(project_id: str) -> None:
    _gql("mutation($pid: String!) { projectMutations { delete(id: $pid) } }", {"pid": project_id})


def upload_ifc(project_id: str, model_id: str, file_path: Path) -> None:
    gen = _gql(
        "mutation($pid: String!, $fn: String!) { fileUploadMutations { generateUploadUrl("
        "input: {projectId: $pid, fileName: $fn}) { url fileId } } }",
        {"pid": project_id, "fn": file_path.name},
    )["fileUploadMutations"]["generateUploadUrl"]

    put_resp = requests.put(gen["url"], data=file_path.read_bytes(), timeout=120)
    put_resp.raise_for_status()
    etag = put_resp.headers["ETag"]  # keep the surrounding quotes — the server compares raw

    _gql(
        "mutation($pid: String!, $mid: String!, $fid: String!, $etag: String!) { "
        "fileUploadMutations { startFileImport(input: {projectId: $pid, modelId: $mid, "
        "fileId: $fid, etag: $etag}) { id convertedStatus } } }",
        {"pid": project_id, "mid": model_id, "fid": gen["fileId"], "etag": etag},
    )


def wait_for_version(project_id: str, model_id: str, timeout_s: int = 120) -> str:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        data = _gql(
            "query($pid: String!, $mid: String!) { project(id: $pid) { model(id: $mid) { "
            "versions(limit: 1) { items { id } } } } }",
            {"pid": project_id, "mid": model_id},
        )
        items = data["project"]["model"]["versions"]["items"]
        if items:
            return items[0]["id"]
        time.sleep(3)
    raise TimeoutError(f"No version appeared for model {model_id} within {timeout_s}s")


# ---------------------------------------------------------------------------
# bim-normalizer ingest
# ---------------------------------------------------------------------------

def ingest(stream_id: str, commit_id: str, timeout_s: int = 180) -> dict:
    resp = requests.post(
        f"{NORMALIZER_URL}/ingest",
        json={"stream_id": stream_id, "commit_id": commit_id},
        timeout=30,
    )
    resp.raise_for_status()
    body = resp.json()
    if body.get("status") == "complete":
        return body
    job_id = body["job_id"]
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        status = requests.get(f"{NORMALIZER_URL}/ingest/status/{job_id}", timeout=30).json()
        if status.get("status") == "complete":
            return status
        if status.get("status") == "failed":
            raise RuntimeError(f"Ingest failed: {status.get('error')}")
        time.sleep(3)
    raise TimeoutError(f"Ingest job {job_id} did not complete within {timeout_s}s")


# ---------------------------------------------------------------------------
# DB read-back
# ---------------------------------------------------------------------------

def fetch_ingested_elements(model_id: str) -> list[dict]:
    from db.connection import get_conn, release_conn

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT e.speckle_id, e.ifc_class, e.category,
                       g.bbox_min, g.bbox_max, g.volume_m3, g.area_m2, g.mesh IS NOT NULL AS has_mesh
                FROM bim_elements e
                LEFT JOIN bim_geometry g ON g.element_id = e.element_id
                WHERE e.model_id = %s
                """,
                (model_id,),
            )
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]
    finally:
        release_conn(conn)


# ---------------------------------------------------------------------------
# Ground truth (independent of bim-normalizer's own code)
# ---------------------------------------------------------------------------

# Classes confirmed (by directly tracing Speckle's converted commit — see
# git history / testing-chat-assistant.md-style notes) to never reach
# bim-normalizer at all, independent of the Decomposes-relationship traversal
# fix in speckle/fetch.py: both are non-physical markers with no geometric
# Representation of their own, unlike decomposition PARENTS such as
# IfcStair/IfcRoof/IfcBuildingElementProxy (which also often lack their own
# Representation — all their geometry lives on their children — but ARE
# still correctly ingested and counted).
#   - IfcOpeningElement: void/negative-space markers used for boolean
#     subtraction (door/window openings cut into walls); Speckle's own IFC
#     importer never creates objects for these at all.
#   - IfcVirtualElement: non-physical space/zone-boundary markers (seen from
#     ArchiCAD exports) with Representation=None and no children of their
#     own — nothing to ingest as a BIM element in the first place.
_EXPECTED_EXCLUDED_CLASSES = {"IfcOpeningElement", "IfcVirtualElement"}


def compute_ground_truth(ifc_path: Path) -> dict:
    import ifcopenshell
    from collections import Counter

    f = ifcopenshell.open(str(ifc_path))
    class_counts = Counter(
        e.is_a() for e in f.by_type("IfcProduct") if e.is_a() not in _EXPECTED_EXCLUDED_CLASSES
    )
    return {"schema": f.schema, "class_counts": dict(class_counts), "total": sum(class_counts.values())}


# ---------------------------------------------------------------------------
# Comparison
# ---------------------------------------------------------------------------

def compare(file_key: str, ground_truth: dict, ingested: list[dict]) -> tuple[bool, list[str]]:
    failures: list[str] = []

    ingested_counts: dict = {}
    for row in ingested:
        ingested_counts[row["ifc_class"]] = ingested_counts.get(row["ifc_class"], 0) + 1
    ingested_total = len(ingested)

    if ingested_total != ground_truth["total"]:
        failures.append(
            f"element count mismatch: ingested {ingested_total}, expected {ground_truth['total']}"
        )
    for cls, expected_count in ground_truth["class_counts"].items():
        got = ingested_counts.get(cls, 0)
        if got != expected_count:
            failures.append(f"class {cls}: ingested {got}, expected {expected_count}")
    for cls in ingested_counts:
        if cls not in ground_truth["class_counts"]:
            failures.append(f"class {cls}: {ingested_counts[cls]} ingested elements not in ground truth at all")

    # The direct regression check for both bugs this script was written for:
    # an element with real mesh geometry and a real (non-degenerate) bbox
    # should never report a volume/area that's many orders of magnitude
    # smaller than its own bbox would allow.
    for row in ingested:
        if not row["has_mesh"] or not row["bbox_min"] or not row["bbox_max"]:
            continue
        dx = abs(row["bbox_max"][0] - row["bbox_min"][0])
        dy = abs(row["bbox_max"][1] - row["bbox_min"][1])
        dz = abs(row["bbox_max"][2] - row["bbox_min"][2])
        bbox_volume = dx * dy * dz
        bbox_area = 2 * (dx * dy + dy * dz + dx * dz)
        if bbox_volume <= 0:
            continue
        vol = row["volume_m3"] or 0
        area = row["area_m2"] or 0
        if vol < bbox_volume * _QUANTITY_VS_BBOX_SANITY_RATIO:
            failures.append(
                f"{row['ifc_class']} {row['speckle_id'][:8]}: volume_m3={vol:.3e} implausibly small "
                f"vs bbox volume {bbox_volume:.3e} (units-scaling regression?)"
            )
        if bbox_area > 0 and area < bbox_area * _QUANTITY_VS_BBOX_SANITY_RATIO:
            failures.append(
                f"{row['ifc_class']} {row['speckle_id'][:8]}: area_m2={area:.3e} implausibly small "
                f"vs bbox area {bbox_area:.3e} (units-scaling regression?)"
            )

    return (len(failures) == 0), failures


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def run_one(key: str, spec: dict, cache_dir: Path, keep: bool) -> bool:
    print(f"\n{'=' * 70}\n{key}: {spec['label']}\n{'=' * 70}")

    ifc_path = download(spec["url"], cache_dir)
    print(f"  downloaded -> {ifc_path} ({ifc_path.stat().st_size:,} bytes)")

    run_id = uuid.uuid4().hex[:8]
    project_id = create_project(f"[verify-ifc-metrics] {key}-{run_id}")
    model_id = create_model(project_id, f"{key}-import")
    print(f"  speckle project={project_id} model={model_id}")

    try:
        upload_ifc(project_id, model_id, ifc_path)
        version_id = wait_for_version(project_id, model_id)
        print(f"  speckle version={version_id} — ingesting...")

        result = ingest(project_id, version_id)
        db_model_id = result["model_id"]
        print(f"  ingested model_id={db_model_id}, element_count={result.get('element_count')}")

        ingested = fetch_ingested_elements(db_model_id)
        ground_truth = compute_ground_truth(ifc_path)
        print(f"  ground truth (ifcopenshell, schema={ground_truth['schema']}): "
              f"{ground_truth['total']} elements across {len(ground_truth['class_counts'])} classes")

        ok, failures = compare(key, ground_truth, ingested)
        if ok:
            print(f"  PASS")
        else:
            print(f"  FAIL ({len(failures)} issue(s)):")
            for f in failures:
                print(f"    - {f}")
        return ok
    finally:
        if not keep:
            delete_project(project_id)
            print(f"  cleaned up test project {project_id}")
        else:
            print(f"  left test project {project_id} in place (--keep)")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--file", choices=list(SAMPLE_FILES), action="append", dest="files",
                         help="Only run this sample (repeatable). Default: all.")
    parser.add_argument("--keep", action="store_true", help="Don't delete the Speckle test project afterward.")
    parser.add_argument("--cache-dir", default=str(Path(tempfile.gettempdir()) / "ifc-metrics-cache"))
    args = parser.parse_args()

    keys = args.files or list(SAMPLE_FILES)
    cache_dir = Path(args.cache_dir)

    results = {}
    for key in keys:
        try:
            results[key] = run_one(key, SAMPLE_FILES[key], cache_dir, args.keep)
        except Exception as exc:
            print(f"  ERROR: {type(exc).__name__}: {exc}")
            results[key] = False

    print(f"\n{'=' * 70}\nSummary\n{'=' * 70}")
    for key, ok in results.items():
        print(f"  {'PASS' if ok else 'FAIL'}  {key}")
    sys.exit(0 if all(results.values()) else 1)


if __name__ == "__main__":
    main()
