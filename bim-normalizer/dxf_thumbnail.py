"""
Server-side DXF -> PNG thumbnail rendering (ezdxf + matplotlib, both MIT/
BSD-licensed, headless Agg backend) — used by routers/documents.py's
/thumbnail route when Nextcloud's own preview API can't produce one.
Nextcloud has no CAD preview provider at all (confirmed: always 404s for
.dxf/.dwg), so without this, every DWG/DXF document falls back to a generic
file icon in the Documents kanban board instead of an actual preview.

This function itself always renders fresh — its caller, /thumbnail
(thumbnail_document), is the one that caches the resulting PNG keyed by
(nc_fileid, etag) so a given file version is only ever rendered once. The
.dwg -> .dxf conversion route (preview_dwg_as_dxf) still re-converts on every
request; only the thumbnail path is cached.
"""
import io
import threading

import ezdxf
from ezdxf.addons.drawing import matplotlib as ezdxf_mpl
from ezdxf.addons.drawing import RenderContext, Frontend

# matplotlib.pyplot's figure/font-cache state is process-global and not
# thread-safe — FastAPI runs sync `def` routes in a thread-pool executor, so
# two concurrent /thumbnail requests can genuinely corrupt each other's
# rendering (confirmed: concurrent renders produced a spurious "cmap"
# KeyError from deep inside matplotlib's font handling, not a real problem
# with either DXF file). Used to also guard dxf_texture_export.py's render
# call before that module moved off matplotlib onto ezdxf's SVG backend +
# cairosvg, which carry no such global state.
MPL_RENDER_LOCK = threading.Lock()


class DxfThumbnailError(Exception):
    pass


def render_dxf_thumbnail(dxf_bytes: bytes, width_px: int = 320, height_px: int = 240) -> bytes:
    """Render a DXF file's modelspace to a PNG thumbnail. Raises
    DxfThumbnailError if the file can't be parsed or has nothing to draw."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    try:
        text = dxf_bytes.decode("utf-8", errors="replace")
        # LibreDWG's dwg2dxf writes CRLF line endings. A real file (`open(...,
        # encoding=...)`) normalizes that to bare "\n" automatically via
        # universal newlines; io.StringIO does not, so a stray trailing "\r"
        # survives on every line — which breaks ezdxf's parser specifically
        # around binary-chunk group codes (310), raising "Invalid binary
        # data" partway through. Normalize explicitly instead of relying on
        # StringIO to do it.
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        doc = ezdxf.read(io.StringIO(text))
    except Exception as exc:
        raise DxfThumbnailError(f"Could not parse DXF: {exc}")

    msp = doc.modelspace()
    with MPL_RENDER_LOCK:
        fig = plt.figure(figsize=(width_px / 96, height_px / 96), dpi=96)
        try:
            ax = fig.add_axes([0, 0, 1, 1])
            ax.set_axis_off()
            ctx = RenderContext(doc)
            ctx.set_current_layout(msp)
            backend = ezdxf_mpl.MatplotlibBackend(ax)
            try:
                Frontend(ctx, backend).draw_layout(msp, finalize=True)
            except Exception as exc:
                raise DxfThumbnailError(f"Could not render DXF layout: {exc}")
            buf = io.BytesIO()
            fig.savefig(buf, format="png", facecolor="#1a1a1a")
            return buf.getvalue()
        finally:
            plt.close(fig)
