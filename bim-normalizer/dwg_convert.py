"""
DWG -> DXF conversion via LibreDWG's dwg2dxf CLI (built in the Dockerfile,
see the comment there for why). No free/open library renders DWG directly,
so routers/documents.py's DWG preview route converts server-side first and
feeds the result into the frontend's existing DxfCanvas.jsx — no separate
DWG viewer needed.

LibreDWG's own docs note some very advanced R2010+ objects can fail to read
and get skipped — dwg2dxf still produces a (partial) DXF in that case, so
success here is judged by whether an output file exists at all, not by a
clean exit code / empty stderr.
"""
import os
import subprocess
import tempfile


class DwgConversionError(Exception):
    pass


def convert_dwg_to_dxf(dwg_bytes: bytes, timeout: int = 60) -> bytes:
    with tempfile.TemporaryDirectory() as tmp:
        in_path = os.path.join(tmp, "input.dwg")
        out_path = os.path.join(tmp, "output.dxf")
        with open(in_path, "wb") as f:
            f.write(dwg_bytes)

        try:
            result = subprocess.run(
                ["dwg2dxf", "-y", "-o", out_path, in_path],
                capture_output=True, timeout=timeout,
            )
        except FileNotFoundError:
            raise DwgConversionError("dwg2dxf is not installed on this server")
        except subprocess.TimeoutExpired:
            raise DwgConversionError(f"Conversion timed out after {timeout}s")

        if not os.path.exists(out_path):
            stderr = result.stderr.decode("utf-8", "ignore").strip()[-500:]
            raise DwgConversionError(f"Conversion produced no output: {stderr or 'unknown error'}")

        with open(out_path, "rb") as f:
            return f.read()
