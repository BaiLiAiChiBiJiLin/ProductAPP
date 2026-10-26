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
from nest_replan import pack_template_replan, _placement
from nest_combined import pack_combined_boards
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
    return dict(i=index, id=ident, name=ident, file=filename, poly=poly, polygon=points,
                frame=frame, width=width, height=height, area=poly.area,
                quantity=int(item.get("quantity", 1)), digest=digest,
                line_only=item.get("lineOnly") is True)


def _validate_boards(srcs, boards, width, height, gap, allow_base_mixing=False):
    """Check final true polygons, not the raster search approximation."""
    region = box(0, 0, width, height).buffer(1e-7)
    checked = set()
    for board in boards:
        if not allow_base_mixing and len({srcs[p["i"]].get("line_only", False) for p in board}) > 1:
            raise ValueError("纯线条 SVG 必须单独开板，不能与其他图片混排")
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


def _replan_partition(request, srcs, origin, validate, allow_base_mixing=False):
    """Preserve other-class sheets unless the user enables base mixing.

    The complete source/bank indexes stay unchanged. Repeated untouched sheets
    share their placement lists and never rebuild their contour masks.
    """
    if not isinstance(request, dict) or not isinstance(request.get("templates"), list):
        raise ValueError("跨方案重排缺少原始版式")
    by_id = {source["id"]: source for source in srcs}
    parsed = {}
    for template in request["templates"]:
        if not isinstance(template, dict):
            raise ValueError("跨方案重排的原始版式无效")
        ident = str(template.get("id", ""))
        repeat = template.get("repeatCount")
        raw = template.get("placements")
        if not ident or ident in parsed or isinstance(repeat, bool) or not isinstance(repeat, int) or repeat < 1:
            raise ValueError("原始版式编号或生产份数无效")
        if not isinstance(raw, list) or not raw:
            raise ValueError("原始版式不能为空")
        placements = [_placement(item, by_id, origin) for item in raw]
        kinds = {False if allow_base_mixing else srcs[p["i"]].get("line_only", False) for p in placements}
        if len(kinds) != 1:
            raise ValueError("原版式混有纯线条 SVG 和其他图片，请先重新计算以单独开板")
        validate([placements])
        parsed[ident] = (template, placements, kinds.pop())
    source_id, target_id = request.get("sourceTemplateId"), request.get("targetTemplateId")
    if source_id == target_id or source_id not in parsed or target_id not in parsed:
        raise ValueError("跨方案重排的来源或目标版式无效")
    line_only = parsed[source_id][2]
    if line_only != parsed[target_id][2]:
        raise ValueError("纯线条 SVG 与其他图片必须分别开板，不能跨这两类版式移动")
    preserved, preserved_counts, scoped = [], Counter(), []
    for template, placements, kind in parsed.values():
        if kind == line_only:
            scoped.append(template)
        else:
            repeat = template["repeatCount"]
            preserved.extend([placements] * repeat)
            for p in placements:
                preserved_counts[p["i"]] += repeat
    if any(preserved_counts[s["i"]] != s["quantity"] for s in srcs if not allow_base_mixing and s.get("line_only", False) != line_only):
        raise ValueError("未参与跨方案重排的另一类版式 QT 不完整，请先重新计算")
    return dict(request, templates=scoped), line_only, preserved


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
    template_repack = request.get("templateRepack")
    allow_base_mixing = request.get("allowBaseMixing") is True
    strategy = "combined" if objective in ("combined", "least-combined") else ("uniform" if objective == "least-cutting" else "material")
    combined_diagnostics = {}
    boards = []
    progress.emit("search", "开始搜索：" + ("综合最少，权重 60:40，比较基线后补排余隙并重组版式" if strategy == "combined" else ("切割方案优先，先排满模板再按 QT 配比复用" if strategy == "uniform" else "节省板材，每板多角度试排后选放入数量最多的方案")), 0, total, 25, True)
    if template_repack is not None:
        if excluded:
            raise ValueError('跨方案重排的完整 QT 包含无效图片，结果未提交：' + '; '.join(item['id'] + '：' + item['reason'] for item in excluded))
        if not srcs:
            raise ValueError('跨方案重排没有有效图片')
        scoped, line_only, preserved = _replan_partition(
            template_repack, srcs, (left, top),
            lambda pages: _validate_boards(srcs, pages, width, height, gap, allow_base_mixing),
            allow_base_mixing=allow_base_mixing)
        scoped_quantities = [quantity if allow_base_mixing or source["line_only"] == line_only else 0
                             for source, quantity in zip(srcs, quantities)]
        def replan_progress(detail, done, count):
            progress.emit("search", detail, done, count, 25 + 65 * done / max(1, count))
        boards = pack_template_replan(dict(srcs=srcs, bank=bank, quantities=scoped_quantities), args,
                                      scoped, origin=(left, top), objective=objective,
                                      validate=lambda pages: _validate_boards(srcs, pages, width, height, gap, allow_base_mixing),
                                      progress=replan_progress)
        boards.extend(preserved)
    elif srcs:
        # Keep global source indexes and a single native MaskBank. A zero QT
        # removes the other class from every baseline, tail repair and template
        # recombination without rebuilding masks or expanding QT into sources.
        completed = 0
        for line_only in ((False,) if allow_base_mixing else (False, True)):
            group_quantities = [quantity if allow_base_mixing or source["line_only"] == line_only else 0
                                for source, quantity in zip(srcs, quantities)]
            group_total = sum(group_quantities)
            if not group_total:
                continue
            label = "底座与其他图片混排" if allow_base_mixing else ("纯线条 SVG 独立板材" if line_only else "其他图片板材")
            group_job = dict(srcs=srcs, bank=bank, quantities=group_quantities)

            def group_progress(detail, done, count):
                fraction = max(0., min(1., done / max(1, count)))
                progress.emit("search", label + "：" + detail,
                              completed + int(group_total * fraction), total,
                              25 + 65 * (completed + group_total * fraction) / max(1, total))

            progress.emit("search", f"{label}：{group_total} 张；共用唯一轮廓缓存",
                          completed, total, 25 + 65 * completed / max(1, total), True)
            if strategy == "combined":
                group_boards = pack_combined_boards(
                    group_job, args, group_progress, origin=(left, top),
                    validate=lambda pages: _validate_boards(srcs, pages, width, height, gap, allow_base_mixing))
                combined_diagnostics["mixed" if allow_base_mixing else ("lineOnly" if line_only else "other")] = group_job.get("combinedDiagnostics", {})
            elif strategy == "uniform":
                def uniform_progress(template, repeat, count, remaining):
                    group_progress(f"方案 {template + 1}：尝试复用 {repeat} 块，单板已放 {count} 张；尚余 {remaining} 张",
                                   group_total - remaining, group_total)
                group_boards, _, _ = pack_uniform_boards(group_job, args, uniform_progress)
            else:
                def material_progress(board, attempt, count, remaining):
                    group_progress(f"第 {board + 1} 块板材，第 {attempt} 次试排：当前放入 {count} 张；尚余 {remaining} 张",
                                   group_total - remaining - count, group_total)
                group_boards = pack_material_boards(srcs, bank, group_quantities, args, progress=material_progress)
            boards.extend(group_boards)
            completed += group_total
    progress.emit("validation", "验证真实轮廓间距、完整图片边界和 QT 数量", total, total, 93, True)
    _validate_boards(srcs, boards, width, height, gap, allow_base_mixing)
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
    result = dict(placements=placements, unplaced=unplaced, sheetsUsed=len(boards),
                utilization=area / (len(boards) * width * height) if boards else 0,
                algorithm="tools/" + ("template-repack（整款数量迁移，固定落点与余隙补排）" if template_repack is not None else ("combined（综合最少，权重 60:40 · 余隙补排与版式重组）" if strategy == "combined" else ("uniform（切割方案优先，重复统一版式）" if strategy == "uniform" else "material（节省板材，单板尽量多放）"))) + " · " + core_label,
                excludedItems=excluded, warnings=warnings, searchCore=search_core)
    if combined_diagnostics:
        result['combinedDiagnostics'] = (next(iter(combined_diagnostics.values()))
                                         if len(combined_diagnostics) == 1 else dict(groups=combined_diagnostics))
    return result


def solve(request, *, cache_dir=None, progress=None):
    progress = progress or Progress()
    try:
        return _solve(request, cache_dir=cache_dir, progress=progress)
    except MemoryError:
        # Leave the handler before retrying: its active exception traceback
        # retains _solve's original mask bank and native search buffers.
        pass
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
