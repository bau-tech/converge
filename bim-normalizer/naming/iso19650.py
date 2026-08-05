"""
ISO 19650 filename convention parsing — advisory only, never used to reject
an upload. See db/documents.py's upsert_document for where this feeds the
naming_compliant/naming_fields columns.
"""
import re

_ISO19650_RE = re.compile(
    r'^(?P<project>[A-Za-z0-9]{2,6})-(?P<originator>[A-Za-z0-9]{2,6})-'
    r'(?P<volume>[A-Za-z0-9]{1,3})-(?P<level>[A-Za-z0-9]{1,3})-'
    r'(?P<doc_type>[A-Za-z]{2})-(?P<role>[A-Za-z]{1,2})-(?P<number>\d{3,6})$'
)


def parse_filename(filename: str) -> dict | None:
    """Returns the parsed field breakdown if filename's stem matches the
    ISO 19650 Project-Originator-Volume-Level-Type-Role-Number pattern
    (e.g. PRJ-ABC-00-00-DR-A-000001.pdf), else None."""
    stem = filename.rsplit(".", 1)[0] if "." in filename else filename
    m = _ISO19650_RE.match(stem)
    return {k: v.upper() for k, v in m.groupdict().items()} if m else None
