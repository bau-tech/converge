"""
PDF -> first-page PNG thumbnail via poppler-utils' pdftoppm CLI (built in
the Dockerfile). Lightweight fallback used only when Nextcloud's own
preview provider can't handle a given PDF (routers/documents.py's
thumbnail_document) — unlike DOCX/XLSX, PDF rasterization doesn't need a
full office suite, so this deliberately doesn't reuse the (still
unimplemented, still deliberately deprioritized) LibreOffice path.
"""
import glob
import os
import subprocess
import tempfile


class PdfThumbnailError(Exception):
    pass


def render_pdf_thumbnail(pdf_bytes: bytes, width_px: int = 320, timeout: int = 20) -> bytes:
    with tempfile.TemporaryDirectory() as tmp:
        in_path = os.path.join(tmp, "input.pdf")
        out_prefix = os.path.join(tmp, "out")
        with open(in_path, "wb") as f:
            f.write(pdf_bytes)

        try:
            result = subprocess.run(
                [
                    "pdftoppm", "-png", "-f", "1", "-l", "1",
                    "-scale-to-x", str(width_px), "-scale-to-y", "-1",
                    in_path, out_prefix,
                ],
                capture_output=True, timeout=timeout,
            )
        except FileNotFoundError:
            raise PdfThumbnailError("pdftoppm (poppler-utils) is not installed on this server")
        except subprocess.TimeoutExpired:
            raise PdfThumbnailError(f"Conversion timed out after {timeout}s")

        # pdftoppm appends a page-number suffix (e.g. out-1.png) — match by
        # glob rather than assuming the exact name, same "existence of
        # output = success" judgment as dwg_convert.py.
        matches = glob.glob(f"{out_prefix}*.png")
        if not matches:
            stderr = result.stderr.decode("utf-8", "ignore").strip()[-500:]
            raise PdfThumbnailError(f"Conversion produced no output: {stderr or 'unknown error'}")

        with open(matches[0], "rb") as f:
            return f.read()
