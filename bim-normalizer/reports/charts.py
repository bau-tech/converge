"""
Minimal SVG chart rendering for report images (pie/bar), rasterized to PNG via
cairosvg — the same SVG->PNG pipeline already used for DXF thumbnails in
dxf_thumbnail.py/dxf_texture_export.py — so report charts don't need to pull
in matplotlib/Pillow just for a couple of simple distribution charts.
"""

import math

import cairosvg

# Muted blue-grey palette matching the report tables' #5a6b87 header/#f4f5f7
# zebra-stripe styling (documents/office_export.py) so charts read as part of
# the same document rather than a mismatched, garishly-coloured insert.
_PALETTE = [
    "#5a6b87", "#8aa0c4", "#c9a06a", "#6faa8a", "#b56576",
    "#7c93c9", "#d4b483", "#5f9ea0", "#9d7db2", "#7a8b99",
]


def _esc(s: str) -> str:
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _svg_to_png(svg: str, width: int, height: int) -> bytes:
    return cairosvg.svg2png(bytestring=svg.encode("utf-8"), output_width=width, output_height=height, background_color="white")


def bar_chart_png(labels: list[str], values: list[float], *, width: int = 760, height: int = 420, max_bars: int = 10) -> bytes:
    """Horizontal bar chart — reads better than vertical for long
    category/IFC-class names, and needs no axis-label rotation."""
    pairs = list(zip(labels, values))[:max_bars]
    if not pairs:
        return b""
    max_val = max(v for _, v in pairs) or 1
    pad_left, pad_right, pad_top, pad_bottom = 190, 50, 20, 20
    plot_w = width - pad_left - pad_right
    n = len(pairs)
    gap = (height - pad_top - pad_bottom) / n
    bar_h = gap * 0.62

    parts = [f'<rect width="{width}" height="{height}" fill="white"/>']
    for i, (label, val) in enumerate(pairs):
        y = pad_top + i * gap + (gap - bar_h) / 2
        bar_w = (val / max_val) * plot_w
        color = _PALETTE[i % len(_PALETTE)]
        label_text = _esc(label)
        if len(label_text) > 24:
            label_text = label_text[:23] + "…"
        parts.append(
            f'<text x="{pad_left - 10}" y="{y + bar_h / 2 + 4:.1f}" font-size="13" text-anchor="end" '
            f'font-family="Helvetica,Arial,sans-serif" fill="#333">{label_text}</text>'
            f'<rect x="{pad_left}" y="{y:.1f}" width="{max(bar_w, 1):.1f}" height="{bar_h:.1f}" fill="{color}" rx="2"/>'
            f'<text x="{pad_left + bar_w + 6:.1f}" y="{y + bar_h / 2 + 4:.1f}" font-size="12" '
            f'font-family="Helvetica,Arial,sans-serif" fill="#555">{val:g}</text>'
        )
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">' + "".join(parts) + "</svg>"
    return _svg_to_png(svg, width, height)


def pie_chart_png(labels: list[str], values: list[float], *, width: int = 640, height: int = 420, max_slices: int = 8) -> bytes:
    """Pie chart with a right-hand legend showing each slice's share."""
    pairs = sorted(zip(labels, values), key=lambda kv: -kv[1])
    if not pairs:
        return b""
    if len(pairs) > max_slices:
        head, tail = pairs[: max_slices - 1], pairs[max_slices - 1 :]
        pairs = head + [("Other", sum(v for _, v in tail))]
    total = sum(v for _, v in pairs) or 1

    cx, cy, r = 170, height / 2, 130
    legend_x = 360

    parts = [f'<rect width="{width}" height="{height}" fill="white"/>']
    angle = -90.0
    for i, (label, val) in enumerate(pairs):
        frac = val / total
        sweep = frac * 360
        color = _PALETTE[i % len(_PALETTE)]
        large_arc = 1 if sweep > 180 else 0
        end_angle = angle + sweep
        # A single-slice (100%) pie has no visible arc gap to draw a path
        # from/to itself, so render it as a full circle instead.
        if frac >= 0.9999:
            parts.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{color}" stroke="white" stroke-width="1.5"/>')
        else:
            x1 = cx + r * math.cos(math.radians(angle))
            y1 = cy + r * math.sin(math.radians(angle))
            x2 = cx + r * math.cos(math.radians(end_angle))
            y2 = cy + r * math.sin(math.radians(end_angle))
            path = f"M{cx},{cy} L{x1:.1f},{y1:.1f} A{r},{r} 0 {large_arc} 1 {x2:.1f},{y2:.1f} Z"
            parts.append(f'<path d="{path}" fill="{color}" stroke="white" stroke-width="1.5"/>')
        label_text = _esc(label)
        if len(label_text) > 22:
            label_text = label_text[:21] + "…"
        parts.append(
            f'<rect x="{legend_x}" y="{30 + i * 24}" width="14" height="14" fill="{color}"/>'
            f'<text x="{legend_x + 20}" y="{42 + i * 24}" font-size="12.5" '
            f'font-family="Helvetica,Arial,sans-serif" fill="#333">{label_text} ({frac:.0%})</text>'
        )
        angle = end_angle
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">' + "".join(parts) + "</svg>"
    return _svg_to_png(svg, width, height)
