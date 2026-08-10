"""
Server-side DXF -> PNG thumbnail rendering — used by routers/documents.py's
/thumbnail route when Nextcloud's own preview API can't produce one.
Nextcloud has no CAD preview provider at all (confirmed: always 404s for
.dxf/.dwg), so without this, every DWG/DXF document falls back to a generic
file icon in the Documents kanban board instead of an actual preview.

Renders through ezdxf's SVG backend + cairosvg — the same approach
dxf_texture_export.py already uses for the drawing-alignment overlay
texture — instead of matplotlib/Agg. matplotlib (~36MB) plus its
kiwisolver dependency (~5MB) had shrunk to exactly one remaining call site
in this codebase (this function), so migrating it off drops both from the
image; going through SVG also gives a CAD-grade vector rasterizer instead
of a general scientific-plotting one, matching dxf_texture_export's
sharper line/text antialiasing at the same pixel size.

This function itself always renders fresh — its caller, /thumbnail
(thumbnail_document), is the one that caches the resulting PNG keyed by
(nc_fileid, etag) so a given file version is only ever rendered once. The
.dwg -> .dxf conversion route (preview_dwg_as_dxf) still re-converts on every
request; only the thumbnail path is cached.
"""
import io

import cairosvg
import ezdxf
from ezdxf.addons.drawing import Frontend, RenderContext, layout
from ezdxf.addons.drawing.config import BackgroundPolicy, Configuration
from ezdxf.addons.drawing.svg import SVGBackend


class DxfThumbnailError(Exception):
    pass


def render_dxf_thumbnail(dxf_bytes: bytes, width_px: int = 320, height_px: int = 240) -> bytes:
    """Render a DXF file's modelspace to a PNG thumbnail. Raises
    DxfThumbnailError if the file can't be parsed or has nothing to draw."""
    try:
        # LibreDWG's dwg2dxf writes CRLF line endings. A real file (`open(...,
        # encoding=...)`) normalizes that to bare "\n" automatically via
        # universal newlines; io.StringIO does not, so a stray trailing "\r"
        # survives on every line — which breaks ezdxf's parser specifically
        # around binary-chunk group codes (310), raising "Invalid binary
        # data" partway through. Normalize explicitly instead of relying on
        # StringIO to do it.
        text = dxf_bytes.decode("utf-8", errors="replace")
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        doc = ezdxf.read(io.StringIO(text))
    except Exception as exc:
        raise DxfThumbnailError(f"Could not parse DXF: {exc}")

    msp = doc.modelspace()
    ctx = RenderContext(doc)
    ctx.set_current_layout(msp)
    backend = SVGBackend()
    # Same dark thumbnail backdrop the old matplotlib version used
    # (fig.savefig(..., facecolor="#1a1a1a")) — CUSTOM + custom_bg_color is
    # the SVG backend's equivalent; its own DEFAULT policy would otherwise
    # draw a white/DXF-derived background rect instead.
    config = Configuration(background_policy=BackgroundPolicy.CUSTOM, custom_bg_color="#1a1a1a")
    try:
        Frontend(ctx, backend, config=config).draw_layout(msp, finalize=True)
    except Exception as exc:
        raise DxfThumbnailError(f"Could not render DXF layout: {exc}")

    # No render_box passed (unlike dxf_texture_export.py, which pins exact
    # modelspace extents for UV-mapping) — a thumbnail just wants whatever
    # was actually drawn auto-fit to the page, which is get_string's default
    # behavior when render_box is omitted, matching the old matplotlib
    # backend's own auto-scaled axes.
    page = layout.Page(width=width_px, height=height_px, units=layout.Units.px,
                        margins=layout.Margins.all(0))
    settings = layout.Settings(fit_page=True, page_alignment=layout.PageAlignment.MIDDLE_CENTER)
    svg_string = backend.get_string(page, settings=settings)

    try:
        return cairosvg.svg2png(bytestring=svg_string.encode("utf-8"),
                                 output_width=width_px, output_height=height_px)
    except Exception as exc:
        raise DxfThumbnailError(f"Could not rasterize DXF thumbnail: {exc}")
