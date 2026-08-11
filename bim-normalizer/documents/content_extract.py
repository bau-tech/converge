"""
Text extraction + chunking + indexing for CDE document content search
(db/documents.py's search_document_content, chat/agent.py's
search_document_content tool, converge_mcp.py's speckle_search_document_content).

PDF text comes from poppler's pdftotext (already installed in this image for
pdf_thumbnail.py's pdftoppm — no new dependency). DOCX/XLSX reuse this
module's sibling office_export.py's read_docx_text/read_xlsx_text, built
originally for reading back generated reports. No OCR — a scanned/image-only
PDF extracts to empty text and is simply not indexed (skipped, not an error).
"""

from __future__ import annotations

import logging
import subprocess
import tempfile

logger = logging.getLogger(__name__)

_PDFTOTEXT_TIMEOUT_S = 60

# Character-window chunking, not token-based — no tokenizer dependency.
# ~2000 chars is a reasonable proxy for staying under bge-small-en-v1.5's
# ~512 token limit for typical English prose (search/embeddings.py's model).
_CHUNK_SIZE = 2000
_CHUNK_OVERLAP = 200


def _extract_pdf_text(content: bytes) -> str | None:
    """Shells out to pdftotext -layout. Returns None (not raises) on any
    failure — a corrupt/encrypted/scanned PDF shouldn't break indexing for
    every other document in the batch."""
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(content)
        f.flush()
        try:
            result = subprocess.run(
                ["pdftotext", "-layout", f.name, "-"],
                capture_output=True, timeout=_PDFTOTEXT_TIMEOUT_S, check=True,
            )
            return result.stdout.decode("utf-8", errors="replace")
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as exc:
            logger.warning("pdftotext extraction failed: %s", exc)
            return None


def extract_text(filename: str, content: bytes) -> str | None:
    """Routes by file extension (not mime_type, which can be None or a
    generic application/octet-stream — see routers/documents.py's
    thumbnail_document for the same convention) to the right extractor.
    Returns None for unsupported types (images, DXF, IFC, legacy .doc,
    ...) rather than raising — same graceful-skip as converge_mcp.py's
    speckle_read_document already does for its own narrower docx/xlsx-only
    dispatch."""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext == "pdf":
        return _extract_pdf_text(content)
    if ext == "docx":
        from documents.office_export import read_docx_text
        return read_docx_text(content)
    if ext == "xlsx":
        from documents.office_export import read_xlsx_text
        return read_xlsx_text(content)
    return None


def _normalize_whitespace(text: str) -> str:
    """pdftotext -layout pads with spaces to preserve column alignment —
    collapse runs of horizontal whitespace so chunks aren't mostly padding,
    while keeping line breaks (paragraph structure still helps readability
    in a returned search snippet)."""
    lines = [" ".join(line.split()) for line in text.split("\n")]
    # Collapse 3+ consecutive blank lines down to one — layout mode also
    # leaves large vertical gaps around tables/figures.
    out: list[str] = []
    blank_run = 0
    for line in lines:
        if line:
            blank_run = 0
            out.append(line)
        else:
            blank_run += 1
            if blank_run <= 1:
                out.append(line)
    return "\n".join(out)


def _window_chunks(text: str, chunk_size: int, overlap: int) -> list[str]:
    text = text.strip()
    if not text:
        return []
    if len(text) <= chunk_size:
        return [text]
    chunks = []
    start = 0
    stride = max(chunk_size - overlap, 1)
    while start < len(text):
        chunks.append(text[start:start + chunk_size])
        start += stride
    return chunks


def chunk_pages(
    text: str, chunk_size: int = _CHUNK_SIZE, overlap: int = _CHUNK_OVERLAP,
) -> list[tuple[int | None, str]]:
    """Splits on pdftotext's page-separator form-feed (\\f) first, so PDF
    chunks carry a real page number for citable search results ("found in
    filename.pdf, page 3"). Any page (or the whole blob, for docx/xlsx text
    with no \\f at all) longer than chunk_size is further split into
    overlapping character windows. Returns [(page_num, chunk_text), ...] —
    page_num is None when the source had no form-feed pages (docx/xlsx)."""
    has_pages = "\f" in text
    pages = text.split("\f") if has_pages else [text]

    result: list[tuple[int | None, str]] = []
    for i, page_text in enumerate(pages):
        normalized = _normalize_whitespace(page_text)
        if not normalized.strip():
            continue
        page_num = (i + 1) if has_pages else None
        for chunk in _window_chunks(normalized, chunk_size, overlap):
            result.append((page_num, chunk))
    return result


def index_document(conn, doc: dict) -> int:
    """Downloads, extracts, chunks, embeds, and stores content for one
    bim_documents row (as returned by db.documents.get_document/list_documents
    — needs at least doc_id, nc_path, filename, revision). Deletes any
    existing chunks for this doc_id first, so this is safe to call both for
    first-time indexing and for re-indexing after a revision (bump_revision
    already has the same "content changed -> invalidate derived data"
    precedent for the thumbnail cache). Returns the number of chunks stored
    (0 if the file type is unsupported or extraction produced no usable
    text — not an error, just nothing to index). Raises on a real failure
    (Nextcloud unreachable, etc.) — the caller is responsible for catching,
    matching every other background-job convention in this codebase
    (see routers/ingest.py's _run_embeddings)."""
    from nextcloud.client import download_bytes
    from search.embeddings import embed_many

    content = download_bytes(doc["nc_path"])
    text = extract_text(doc["filename"], content)

    with conn.cursor() as cur:
        cur.execute("DELETE FROM bim_document_chunks WHERE doc_id = %s", (doc["doc_id"],))

    if not text or not text.strip():
        conn.commit()
        return 0

    chunks = chunk_pages(text)
    if not chunks:
        conn.commit()
        return 0

    vectors = embed_many([c for _, c in chunks])
    with conn.cursor() as cur:
        for i, ((page_num, chunk_text), vec) in enumerate(zip(chunks, vectors)):
            cur.execute(
                """
                INSERT INTO bim_document_chunks (doc_id, revision, page_num, chunk_index, chunk_text, embedding)
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                (doc["doc_id"], doc["revision"], page_num, i, chunk_text, vec),
            )
    conn.commit()
    return len(chunks)
