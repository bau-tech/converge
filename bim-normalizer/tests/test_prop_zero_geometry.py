"""
Pure unit tests for the "source app declares zero geometry" override in
pipeline/normalize.py.

Regression coverage for a real bug: Revit RPC ("Rich Photorealistic
Content") entourage — planting, furniture, people — is a render-only
billboard with no real solid geometry. Revit itself reports Volume=0 and
Area=0 for these elements (e.g. a "Prairie Dropseed" ornamental grass), but
extract_geometry() still derives a volume/area from whatever placeholder
mesh the connector exports for the billboard's silhouette — physically
meaningless (a live ingest produced volume_m3=21.888 for a single grass
tuft) but not obviously wrong-looking on its own, unlike the door/beam unit
bugs covered by test_geometry_unit_guard.py.

_prop_declares_zero must tell an explicit 0 (authoritative — override the
mesh value) apart from the property simply being absent (leave the mesh
value alone) — the opposite of _read_numeric's existing "0 means missing"
convention, which is still correct for _prop_volume_m3/_prop_area_m2's own
gap-filling use case and must not change.
"""
from pipeline.normalize import (
    _AREA_KEYS,
    _VOL_KEYS,
    _prop_declares_zero,
    _prop_volume_m3,
    _read_numeric,
    _read_numeric_zero_ok,
)


class _FakeObj:
    """Minimal stand-in for a specklepy Base: plain attributes, getattr-based."""
    def __init__(self, **attrs):
        for k, v in attrs.items():
            setattr(self, k, v)


def test_explicit_zero_volume_detected():
    # Revit RPC shrub: instance parameter "Volume" present and exactly 0.
    obj = _FakeObj(parameters={"Volume": {"value": 0, "units": "m3"}})
    assert _prop_declares_zero(obj, _VOL_KEYS) is True


def test_nonzero_volume_is_not_a_zero_declaration():
    obj = _FakeObj(parameters={"Volume": {"value": 4.7, "units": "m3"}})
    assert _prop_declares_zero(obj, _VOL_KEYS) is False


def test_missing_volume_property_is_not_a_zero_declaration():
    # No Volume key anywhere — absent, not zero. Mesh-derived value (if any)
    # must be left alone.
    obj = _FakeObj(parameters={"Comments": "some text"})
    assert _prop_declares_zero(obj, _VOL_KEYS) is False


def test_explicit_zero_area_detected_independently_of_volume():
    obj = _FakeObj(properties={"AREA": 0})
    assert _prop_declares_zero(obj, _AREA_KEYS) is True
    assert _prop_declares_zero(obj, _VOL_KEYS) is False


def test_read_numeric_zero_ok_keeps_zero_but_rejects_negative():
    assert _read_numeric_zero_ok(0) == 0
    assert _read_numeric_zero_ok({"value": 0}) == 0
    assert _read_numeric_zero_ok(-1) is None
    assert _read_numeric_zero_ok(None) is None


def test_read_numeric_still_treats_zero_as_absent():
    # Existing gap-filling behavior (_prop_volume_m3/_prop_area_m2) must be
    # unchanged: a 0 there still means "no authoritative value found",
    # otherwise a genuine IFC info-model gap could get silently zeroed.
    assert _read_numeric(0) is None
    assert _read_numeric({"value": 0}) is None


def test_prop_volume_m3_unaffected_by_explicit_zero():
    obj = _FakeObj(qtos={"NetVolume": 0})
    assert _prop_volume_m3(obj) is None
