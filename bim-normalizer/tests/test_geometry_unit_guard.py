"""
Pure unit tests for _plausible_length_factor's declared-unit-vs-raw-scale
guard in ifc/geometry.py.

Regression coverage for a real bug: the guard originally trusted the RAW
(unconverted) bbox diagonal alone to decide whether a declared unit was
mistagged. That correctly caught the mm-mistagged-door case it was designed
for (declared "mm" on coordinates already in metres — a ~1000x error), but
also produced false positives on legitimately-declared feet (only a ~3.3x
factor, so a feet object's raw diagonal coincidentally often falls in the
same "looks like plausible metres" window as a real metre-scale object) —
silently discarding the correct 0.3048 factor and inflating volumes by
1/0.3048^3 ~= 35x. The fix checks the DECLARED unit's converted diagonal for
plausibility first, only falling back to the raw-diagonal heuristic when
that fails.
"""
from ifc.geometry import _plausible_length_factor


def test_mm_mistagged_door_still_detected():
    # Door raw bbox is already metre-scale (~0.47m wide) despite being
    # declared "mm" — the mm->m conversion (factor 0.001) would shrink an
    # already-correct value 1000x, so the guard must override it to 1.0.
    factor = _plausible_length_factor([0, 0, 0], [0.47, 0.9, 2.1], "mm")
    assert factor == 1.0


def test_correctly_declared_feet_not_misdetected_as_mm_error():
    # Steel beam raw bbox diagonal is ~27 in its native feet — a real,
    # correctly-declared measurement, not a unit-tagging error. Previously
    # this coincidentally fell inside the "plausible raw metres" window
    # (0.01-300) and got wrongly forced to factor=1.0 instead of 0.3048.
    factor = _plausible_length_factor([0, 0, 0], [1.0, 1.0, 26.98], "ft")
    assert abs(factor - 0.3048) < 1e-6


def test_already_metres_short_circuits():
    factor = _plausible_length_factor([0, 0, 0], [5, 5, 5], "m")
    assert factor == 1.0


def test_implausible_either_way_falls_back_to_declared_factor():
    # Neither the raw diagonal nor the declared-unit-converted diagonal is
    # plausible (a 0.0005 raw diagonal is implausibly tiny for a building
    # element even before or after a km->m conversion) — nothing to
    # override, so trust the declared unit's own factor.
    factor = _plausible_length_factor([0, 0, 0], [0.0005, 0.0005, 0.0005], "km")
    assert factor == 1000.0
