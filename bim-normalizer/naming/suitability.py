"""
ISO 19650 "purpose of issue" suitability codes — see db/documents.py's
set_suitability_code and routers/documents.py's suitability endpoint.
"""

SUITABILITY_CODES = {
    "S0": "Initial status — work in progress",
    "S1": "Suitable for coordination",
    "S2": "Suitable for information",
    "S3": "Suitable for review and comment",
    "S4": "Suitable for stage approval",
    "A1": "Authorized — no comment",
    "A2": "Authorized with comments",
    "B1": "Authorized with reservations",
    "B2": "Partially authorized, resubmit",
    "C1": "Published for client",
    "D1": "Published for construction",
}
