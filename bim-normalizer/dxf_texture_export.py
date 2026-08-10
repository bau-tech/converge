"""
DXF -> transparent PNG texture rendering, for the drawing-to-3D-model
alignment feature (routers/documents.py's /align-texture.png route). Unlike
dxf_thumbnail.py, this renders through ezdxf's SVG backend + cairosvg rather
than the matplotlib/Agg backend — matplotlib is a general scientific-
plotting rasterizer, not a CAD-grade one, and its line/hatch/text
antialiasing is visibly softer than a proper vector rasterizer at the same
pixel size. Going through SVG keeps the intermediate representation
resolution-independent right up until the final raster step.

This also differs from a thumbnail in three ways a thumbnail doesn't need:

  1. Transparent background (a thumbnail wants an opaque dark backdrop; an
     overlay plane in the 3D viewer must not paint over the model with an
     opaque rectangle). ezdxf's SVG backend draws its own background rect
     by default (unlike the matplotlib backend, where background is purely
     a savefig-time concern) — BackgroundPolicy.OFF below suppresses it.
  2. The render box is pinned to exact modelspace extents ($EXTMIN/$EXTMAX,
     or a bbox computed from the actual entity geometry — see below), not
     autoscaled — the returned extents are what the frontend uses to size/
     UV-map the plane, so the rendered image must fill that exact rectangle
     edge-to-edge with no padding. Sizing width_px/height_px off that same
     rectangle's aspect ratio (below) means the SVG layout's uniform
     fit-to-page scaling fills it exactly with no letterboxing — no need
     for matplotlib's non-aspect-locked axes trick.
  3. Higher resolution (thumbnails are ~320px; a 3D overlay wants to still
     read as a drawing when the user is close to it).
"""
import io

import cairosvg
import ezdxf
import ezdxf.bbox
from ezdxf.addons.drawing import RenderContext, Frontend, layout
from ezdxf.addons.drawing.config import BackgroundPolicy, Configuration
from ezdxf.addons.drawing.svg import SVGBackend
from ezdxf.math import BoundingBox2d


class DxfTextureExportError(Exception):
    pass


def _parse_dxf(dxf_bytes: bytes):
    try:
        # Same CRLF gotcha as dxf_thumbnail.py — dwg2dxf writes CRLF, and
        # io.StringIO doesn't universal-newline-normalize like a real
        # open(..., encoding=...) file handle would.
        text = dxf_bytes.decode("utf-8", errors="replace")
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        return ezdxf.read(io.StringIO(text))
    except Exception as exc:
        raise DxfTextureExportError(f"Could not parse DXF: {exc}")


def _extents(doc) -> tuple[float, float, float, float]:
    """($EXTMIN, $EXTMAX) header values if present and non-degenerate,
    else a bbox computed directly from the actual entity geometry —
    the fallback recommended in the drawing-alignment plan's spike #2:
    LibreDWG's dwg2dxf can emit noisy parser warnings on real-world DWGs
    without that ever affecting geometry, but a defensive fallback for the
    rarer case where the header itself is missing/degenerate is cheap and
    keeps this route from ever handing back a zero-size or bogus extent."""
    hdr = doc.header
    extmin = hdr.get("$EXTMIN")
    extmax = hdr.get("$EXTMAX")
    if extmin and extmax and extmax[0] > extmin[0] and extmax[1] > extmin[1]:
        return extmin[0], extmin[1], extmax[0], extmax[1]

    msp = doc.modelspace()
    bbox = ezdxf.bbox.extents(msp)
    if not bbox.has_data or bbox.extmax.x <= bbox.extmin.x or bbox.extmax.y <= bbox.extmin.y:
        raise DxfTextureExportError("Drawing has no usable extents (empty or degenerate geometry)")
    return bbox.extmin.x, bbox.extmin.y, bbox.extmax.x, bbox.extmax.y


# DXF files carry no reliable unit metadata this pipeline reads ($INSUNITS
# is unused elsewhere in the codebase too), so "pixels per drawing unit"
# alone can't target a real-world sharpness — a drawing in mm and one in m
# would want wildly different pixel densities for the same on-screen crispness.
# The alignment transform's `scale` (world-units-per-drawing-unit, solved by
# alignmentTransform.js from the user's 2 picked points) sidesteps that
# entirely: multiplying it by the drawing's extents gives the true physical
# size in the 3D model's own units (Speckle models are effectively metric),
# so resolution can be sized off *that* instead of guessing.
TARGET_PX_PER_WORLD_UNIT = 150
MIN_TEXTURE_PX = 512
MAX_TEXTURE_PX = 4096  # comfortably under common GPU 2D-texture size limits
DEFAULT_MAX_PX = 2048  # used when scale isn't known yet (unaligned calibration preview)


def render_dxf_texture(
    dxf_bytes: bytes, scale: float | None = None, max_px: int | None = None,
) -> tuple[bytes, tuple[float, float, float, float]]:
    """Renders a DXF's modelspace to a transparent PNG sized/scaled to
    `max_px` on its longer edge, at the drawing's true aspect ratio. Returns
    (png_bytes, (extmin_x, extmin_y, extmax_x, extmax_y)) — the frontend
    maps its plane's UV space 0..1 linearly onto these same extents, so the
    image must span them exactly with no autoscale padding.

    `max_px`, if given, overrides sizing entirely. Otherwise, if `scale` is
    given, resolution is derived from the drawing's real physical size (see
    TARGET_PX_PER_WORLD_UNIT above); with neither, falls back to a flat
    DEFAULT_MAX_PX.

    Raises DxfTextureExportError if the file can't be parsed or has no
    usable extents."""
    doc = _parse_dxf(dxf_bytes)
    extmin_x, extmin_y, extmax_x, extmax_y = _extents(doc)
    width, height = extmax_x - extmin_x, extmax_y - extmin_y

    if max_px is None:
        if scale:
            world_span = max(width, height) * scale
            max_px = round(world_span * TARGET_PX_PER_WORLD_UNIT)
            max_px = max(MIN_TEXTURE_PX, min(MAX_TEXTURE_PX, max_px))
        else:
            max_px = DEFAULT_MAX_PX

    if width >= height:
        width_px = max_px
        height_px = max(1, round(max_px * height / width))
    else:
        height_px = max_px
        width_px = max(1, round(max_px * width / height))

    msp = doc.modelspace()
    ctx = RenderContext(doc)
    ctx.set_current_layout(msp)
    backend = SVGBackend()
    config = Configuration(background_policy=BackgroundPolicy.OFF)
    try:
        Frontend(ctx, backend, config=config).draw_layout(msp, finalize=True)
    except Exception as exc:
        raise DxfTextureExportError(f"Could not render DXF layout: {exc}")

    # Units.px + zero margins + a page sized off the render box's own aspect
    # ratio (above) makes the fit-to-page uniform scale land exactly on
    # width_px/height_px with nothing left over to letterbox.
    page = layout.Page(width=width_px, height=height_px, units=layout.Units.px,
                        margins=layout.Margins.all(0))
    settings = layout.Settings(fit_page=True, page_alignment=layout.PageAlignment.MIDDLE_CENTER)
    render_box = BoundingBox2d([(extmin_x, extmin_y), (extmax_x, extmax_y)])
    svg_string = backend.get_string(page, settings=settings, render_box=render_box)

    png_bytes = cairosvg.svg2png(bytestring=svg_string.encode("utf-8"),
                                  output_width=width_px, output_height=height_px)
    return png_bytes, (extmin_x, extmin_y, extmax_x, extmax_y)
