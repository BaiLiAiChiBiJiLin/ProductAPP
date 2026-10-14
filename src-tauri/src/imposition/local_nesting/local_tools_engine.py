"""Millimetre adapter for the application's local nesting strategies.

Only contours enter the solver. A QT quantity reuses its source's uint8 mask
bank, and image pixels/SVG embedded images never enter collision searches.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import time
from collections import Counter
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from nesting_common import make_masks, pack_material_boards
from nest_uniform import pack_uniform_boards
from nesting_rust import MaskBank, core_status
from shapely import affinity
from shapely.geometry import Polygon, box
from shapely.strtree import STRtree


class Progress:
    def __init__(self):
        self.last = 0.0
        self.percent = 0.0

    def emit(self, phase, detail, completed=0, total=0, percent=0, force=False):
        now = time.monotonic()
        if not force and now - self.last < .5:
            return
        self.last = now
        self.percent = max(self.percent, min(100, percent))
        print("PRINTFLOW_PROGRESS " + json.dumps(dict(
            phase=phase, status="completed" if phase == "completed" else "running",
            detail=detail, completed=completed, total=total,
            percent=self.percent, algorithm="local-tools"), ensure_ascii=True),
            file=sys.stderr, flush=True)


def _qt_id(ident, ordinal):
    return ident if ordinal == 0 else f"{ident}#qt-{ordinal + 1}"


def _positive(value, label):
    value = float(value)
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f"{label}必须是正数")
    return value


def _cache_directory():
    base = Path(os.environ.get("LOCALAPPDATA", str(ROOT / ".tools")))
    result = base / "PrintFlow" / "nesting" / "local-tools-v3"
    result.mkdir(parents=True, exist_ok=True)
    return result


def _source(item, index, cache):
    ident = str(item["id"])
    width = _positive(item["widthMm"], "图片宽度")
    height = _positive(item["heightMm"], "图片高度")
    points = item.get("polygon", [])
    if len(points) < 3:
        raise ValueError("缺少真实轮廓")
    points = [[float(p[0]), float(p[1])] for p in points]
    if any(not math.isfinite(v) for p in points for v in p):
        raise ValueError("轮廓包含非有限坐标")
    poly = Polygon(points)
    if not poly.is_valid or poly.area <= 1e-8:
        raise ValueError("真实轮廓自交或退化，未参与拼版")
    # A frame is used only at board edges. Transparent corners do not become
    # obstacles between products, so opposite rotations can still interlock.
    frame = box(0, 0, width, height)
    if not frame.buffer(1e-7).covers(poly):
        raise ValueError("真实轮廓超出图片毫米尺寸，未参与拼版")
    encoded = json.dumps([points, width, height], separators=(",", ":")).encode()
    digest = hashlib.sha256(encoded).hexdigest()
    filename = cache / (digest + ".json")
    if not filename.exists():
        filename.write_bytes(encoded)
    return dict(i=index, id=ident, name=ident, file=filename, poly=poly,
                frame=frame, width=width, height=height, area=poly.area,
                quantity=int(item.get("quantity", 1)), digest=digest)


def _validate_boards(srcs, boards, width, height, gap):
    """Check final true polygons, not the raster search approximation."""
    region = box(0, 0, width, height).buffer(1e-7)
    checked = set()
    for board in boards:
        signature = tuple((p["i"], p["angle"], p["tx"], p["ty"]) for p in board)
        if signature in checked:
            continue
        checked.add(signature)
        polys = []
        for p in board:
            source = srcs[p["i"]]
            poly = affinity.translate(affinity.rotate(source["poly"], p["angle"], origin=(0, 0)), p["tx"], p["ty"])
            frame = affinity.translate(affinity.rotate(source["frame"], p["angle"], origin=(0, 0)), p["tx"], p["ty"])
            if not region.covers(poly) or not region.covers(frame):
                raise ValueError(f'图片 {source["id"]} 的最终位置越出有效区域')
            polys.append(poly)
        tree = STRtree(polys)
        for i, poly in enumerate(polys):
            for j in tree.query(poly.buffer(gap + 1e-7)):
                if j <= i:
                    continue
                other = polys[j]
                if poly.intersection(other).area > 1e-7 or poly.distance(other) < gap - 1e-6:
                    raise ValueError(f'图片 {srcs[board[i]["i"]]["id"]} 与 {srcs[board[j]["i"]]["id"]} 的最终轮廓间距不足')


def _solve(request, *, cache_dir=None, progress=None, resolution=.5):
    progress = progress or Progress()
    plate_width = _positive(request["plateWidthMm"], "板材宽度")
    plate_height = _positive(request["plateHeightMm"], "板材高度")
    right = max(0, float(request.get("effectiveRightMm", 0)))
    width = min(_positive(request["effectiveWidthMm"], "有效宽度"), plate_width - right)
    height = min(_positive(request["effectiveHeightMm"], "有效高度"), plate_height)
    if width <= 0 or not math.isfinite(right):
        raise ValueError("有效区域右侧距无效")
    gap = max(0, float(request.get("spacingMm", 3)))
    if not math.isfinite(gap):
        raise ValueError("图片间距无效")
    left, top = plate_width - right - width, (plate_height - height) / 2
    cache = Path(cache_dir) if cache_dir else _cache_directory()
    cache.mkdir(parents=True, exist_ok=True)
    args = SimpleNamespace(board_width=width, board_height=height, gap=gap, margin=0.,
                           resolution=resolution, rotation_step=15, runs=3, lookahead=1, seed=0)
    srcs, bank, excluded, warnings, requested = [], MaskBank(), [], [], []
    sources_by_digest = {}
    items = request.get("items", [])
    for item in items:
        qty = int(item.get("quantity", 1))
        if qty > 0:
            requested.append((str(item["id"]), qty))
    progress.emit("geometry", "读取唯一图片轮廓，QT 共用轮廓缓存", 0, len(items), 2, True)
    for item_index, item in enumerate(items):
        if int(item.get("quantity", 1)) <= 0:
            continue
        ident = str(item["id"])
        try:
            source = _source(item, len(srcs), cache)
            mask_key = (source["digest"], args.resolution)
            if mask_key not in sources_by_digest:
                # tools cache keys traditionally use source name and file
                # size. Use the contour/frame content hash as that name so
                # changing a path without changing its text length cannot
                # accidentally reuse old geometry.
                mask_source = dict(source, i=0, name=source["digest"])
                angles = list(range(0, 360, args.rotation_step))
                def mask_progress(_index, angle_no, count):
                    progress.emit("geometry", f"图片 {ident}：生成旋转轮廓 {angle_no}/{count}；其余 QT 复用", item_index, len(items), 2 + 23 * (item_index + angle_no / count) / max(1, len(items)))
                masks = make_masks([mask_source], cache, args.resolution, angles, gap, mask_progress)[0]
                sources_by_digest[mask_key] = masks
            masks = sources_by_digest[mask_key]
            usable = [m for m in masks if m["frame_width"] <= width + 1e-7 and m["frame_height"] <= height + 1e-7]
            if not usable:
                raise ValueError("尝试 0–345° 旋转后仍放不进有效区域，未参与拼版")
            srcs.append(source)
            bank[source["i"]] = usable
        except MemoryError:
            # Memory pressure belongs to the job, not to this artwork. The
            # public wrapper retries all sources together at the tool's 1 mm
            # fallback resolution rather than marking valid artwork invalid.
            raise
        except Exception as exc:
            excluded.append(dict(id=ident, reason=str(exc)))
        progress.emit("geometry", f"已处理 {item_index + 1}/{len(items)} 种图片；只缓存基础轮廓", item_index + 1, len(items), 2 + 23 * (item_index + 1) / max(1, len(items)))

    quantities = [source["quantity"] for source in srcs]
    total = sum(quantities)
    objective = request.get("objective", "least-material")
    strategy = "uniform" if objective == "least-cutting" else "material"
    if objective == "combined":
        warnings.append("tools 仅提供两种实际策略；旧综合最少设置已按节省板材处理")
    boards = []
    progress.emit("search", "开始搜索：" + ("切割方案优先，先排满模板再按 QT 配比复用" if strategy == "uniform" else "节省板材，每板多角度试排后选放入数量最多的方案"), 0, total, 25, True)
    if srcs and strategy == "uniform":
        def uniform_progress(template, repeat, count, remaining):
            done = total - remaining
            progress.emit("search", f"方案 {template + 1}：尝试复用 {repeat} 块，单板已放 {count} 张；尚余 {remaining} 张", done, total, 25 + 65 * done / max(1, total))
        boards, templates, summaries = pack_uniform_boards(dict(srcs=srcs, bank=bank, quantities=quantities), args, uniform_progress)
    elif srcs:
        def material_progress(board, attempt, count, remaining):
            done = total - remaining - count
            progress.emit("search", f"第 {board + 1} 块板材，第 {attempt} 次试排：当前放入 {count} 张；尚余 {remaining} 张", done, total, 25 + 65 * done / max(1, total))
        boards = pack_material_boards(srcs, bank, quantities, args, progress=material_progress)
    progress.emit("validation", "验证真实轮廓间距、完整图片边界和 QT 数量", total, total, 93, True)
    _validate_boards(srcs, boards, width, height, gap)
    counts, placements, frame_origins = Counter(), [], {}
    for sheet_index, board in enumerate(boards):
        for p in board:
            source = srcs[p["i"]]
            ident = source["id"]
            frame_key = (source["digest"], p["angle"])
            if frame_key not in frame_origins:
                frame = affinity.rotate(source["frame"], p["angle"], origin=(0, 0))
                frame_origins[frame_key] = frame.bounds[:2]
            min_x, min_y = frame_origins[frame_key]
            placements.append(dict(id=_qt_id(ident, counts[ident]), sheetIndex=sheet_index,
                                   xMm=left + p["tx"] + min_x, yMm=top + p["ty"] + min_y,
                                   widthMm=source["width"], heightMm=source["height"], rotationDeg=p["angle"]))
            counts[ident] += 1
    for source in srcs:
        if counts[source["id"]] != source["quantity"]:
            raise ValueError(f'图片 {source["id"]} 的 QT 数量校验失败')
    unplaced = [_qt_id(ident, ordinal) for ident, qty in requested for ordinal in range(counts[ident], qty)]
    area = sum(source["area"] * counts[source["id"]] for source in srcs)
    search_core = core_status(bank)
    if search_core.get("reason"):
        warnings.append("搜索核心回退说明：" + str(search_core["reason"]))
    if search_core.get("backend") == "rust":
        core_label = f"Rust 位图 · {search_core.get('threads', 1)} 线程"
    elif search_core.get("backend") == "mixed":
        core_label = "Rust / Python 回退"
    else:
        core_label = "Python 搜索"
    progress.emit("completed", f"计算完成：{len(placements)} 张，{len(boards)} 块板材；{core_label}", len(placements), len(placements) + len(unplaced), 100, True)
    return dict(placements=placements, unplaced=unplaced, sheetsUsed=len(boards),
                utilization=area / (len(boards) * width * height) if boards else 0,
                algorithm="tools/" + ("uniform（切割方案优先，重复统一版式）" if strategy == "uniform" else "material（节省板材，单板尽量多放）") + " · " + core_label,
                excludedItems=excluded, warnings=warnings, searchCore=search_core)


def solve(request, *, cache_dir=None, progress=None):
    progress = progress or Progress()
    try:
        return _solve(request, cache_dir=cache_dir, progress=progress)
    except MemoryError:
        import gc
        gc.collect()
        detail = "0.5 mm 轮廓缓存内存不足，按 tools 原有策略改用 1 mm 栅格重新计算；旋转步进和图片间距不变"
        progress.emit("geometry", detail, force=True)
        result = _solve(request, cache_dir=cache_dir, progress=progress, resolution=1.)
        result["warnings"].append(detail)
        return result


def main():
    try:
        envelope = json.load(sys.stdin)
        # Third-party progress and CLI prints must never corrupt stdout JSON.
        with contextlib.redirect_stdout(sys.stderr):
            result = solve(envelope.get("request", envelope))
        json.dump(result, sys.stdout, ensure_ascii=True)
        return 0
    except (Exception, SystemExit) as exc:
        json.dump(dict(ok=False, error=dict(engine="local-tools", message=str(exc))), sys.stdout, ensure_ascii=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
