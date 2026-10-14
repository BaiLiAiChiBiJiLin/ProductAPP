"""Independent SVG contour sampling for real-asset benchmarks only.

Production reads contours through the Rust SVG extractor. This preserved
Python sampler is a test reference and is never imported by the runtime.
"""
import math
import os
import xml.etree.ElementTree as ET

for _thread_env in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_thread_env] = '1'

import shapely
from shapely import affinity
from shapely.geometry import Polygon, box
from svgpathtools import parse_path

NS = 'http://www.w3.org/2000/svg'


def rounded_rect(x, y, width, height, rx=0.0, ry=0.0, segments=20):
    """Approximate an SVG rounded rectangle with a Shapely polygon."""
    x, y, width, height = map(float, (x, y, width, height))
    rx = abs(float(rx or 0))
    ry = abs(float(ry or 0))
    if rx == 0 and ry:
        rx = ry
    if ry == 0 and rx:
        ry = rx
    rx = min(rx, width / 2)
    ry = min(ry, height / 2)
    if rx < 1e-9 or ry < 1e-9:
        return box(x, y, x + width, y + height)
    points = []
    corners = [
        (x + rx, y + ry, 180, 270),
        (x + width - rx, y + ry, 270, 360),
        (x + width - rx, y + height - ry, 0, 90),
        (x + rx, y + height - ry, 90, 180),
    ]
    for cx, cy, start, end in corners:
        for j in range(segments + 1):
            angle = math.radians(start + (end - start) * j / segments)
            points.append((cx + rx * math.cos(angle), cy + ry * math.sin(angle)))
    return Polygon(points)


def flat(seg, scale, t0=0.0, t1=1.0, depth=0):
    a, b = seg.point(t0), seg.point(t1)
    delta = b - a
    error = 0.0
    for f in (.25, .5, .75):
        p = seg.point(t0 + (t1 - t0) * f)
        if abs(delta) > 1e-10:
            u = max(0.0, min(1.0, ((p - a).real * delta.real + (p - a).imag * delta.imag) / (abs(delta) ** 2)))
            d = abs(p - (a + u * delta))
        else:
            d = abs(p - a)
        error = max(error, d * scale)
    if error <= .003 or depth >= 14:
        return [a, b]
    mid = (t0 + t1) / 2
    return flat(seg, scale, t0, mid, depth + 1)[:-1] + flat(seg, scale, mid, t1, depth + 1)


def parse_sources(files):
    result = []
    for i, f in enumerate(files):
        root = ET.parse(f).getroot()
        vb = list(map(float, root.get('viewBox').split()))
        width = float(root.get('width').removesuffix('mm'))
        height = float(root.get('height').removesuffix('mm'))
        sx, sy = width / vb[2], height / vb[3]
        if abs(sx - sy) > 1e-7:
            raise ValueError(f'Non-uniform SVG scale: {f}')
        g = root.find(f'{{{NS}}}g')
        if g is None:
            g = root.find(f'.//{{{NS}}}g')
        if g is None:
            raise ValueError(f'No rendered group in {f}')
        paths = [e for e in g.iter() if e.tag.endswith('}path') and e.get('d')]
        stroked = [e for e in paths if 'str' in (e.get('class') or '')]
        if stroked or paths:
            contour_paths = stroked or paths
            # The longest stroked path is the outer contour for the supplied
            # production SVGs; this avoids selecting a small hole path.
            path_el = max(contour_paths, key=lambda e: len(e.get('d', '')))
            p = parse_path(path_el.get('d'))
            xy = []
            for seg in p:
                xy.extend([((z.real - vb[0]) * sx, (z.imag - vb[1]) * sy) for z in flat(seg, sx)[:-1]])
            poly = Polygon(xy)
        else:
            # Some CorelDRAW exports store the visible cut contour as a
            # rounded <rect> instead of a <path>. Select the largest stroked
            # rectangle and convert it to the same mm-space polygon used by
            # path inputs. The smaller rectangle is artwork/detail, not the
            # product boundary.
            rects = [e for e in g.iter() if e.tag.endswith('}rect') and e.get('width') and e.get('height')]
            stroked_rects = [e for e in rects if 'str' in (e.get('class') or '')]
            rects = stroked_rects or rects
            if not rects:
                raise ValueError(f'No closed contour path or supported shape in {f}')
            rect_el = max(rects, key=lambda e: float(e.get('width')) * float(e.get('height')))
            raw = rounded_rect(rect_el.get('x', 0), rect_el.get('y', 0), rect_el.get('width'),
                               rect_el.get('height'), rect_el.get('rx', 0), rect_el.get('ry', 0))
            poly = affinity.scale(raw, sx, sy, origin=(0, 0))
            poly = affinity.translate(poly, -vb[0] * sx, -vb[1] * sy)
        invalid = not poly.is_valid
        poly = poly.buffer(0)
        if poly.geom_type == 'MultiPolygon':
            poly = shapely.union_all([Polygon(x.exterior) for x in poly.geoms])
        else:
            poly = Polygon(poly.exterior)
        result.append(dict(i=i, file=str(f), name=f.name, poly=poly, scale=sx, vb=vb,
                           invalid_repaired=invalid, area=poly.area))
    return result
