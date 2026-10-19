"""Atomic quantity-aware replanning after moving a slot between templates.

This strategy is intentionally separate from normal material/uniform nesting.
The target's manual anchor and other slots stay at their exact millimetre
coordinates. Existing boards become occupied search surfaces, not just a set of
slots to copy. Production repetitions and all remaining QT are solved again.
"""
from collections import Counter
import math

import numpy as np
import shapely
from shapely import affinity

from nesting_common import pack_one, pack_material_boards
from nest_uniform import pack_uniform_boards
from nesting_rust import collision_grid


def _integer(value, label, minimum=0):
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ValueError(f'{label}必须是大于等于 {minimum} 的整数')
    return value


def _finite(value, label):
    value = float(value)
    if not math.isfinite(value):
        raise ValueError(f'{label}必须是有限毫米数值')
    return value


def _counts(placements):
    return Counter(p['i'] for p in placements)


def _repeat_limit(fixed, remaining):
    return min((remaining[i] // count for i, count in _counts(fixed).items()), default=0)


def _placement(raw, by_id, origin):
    if not isinstance(raw, dict) or str(raw.get('sourceId')) not in by_id:
        raise ValueError('手排方案包含未知的图片轮廓')
    source = by_id[str(raw['sourceId'])]
    angle = _finite(raw['rotationDeg'], '旋转角度')
    x, y = _finite(raw['xMm'], '图片位置'), _finite(raw['yMm'], '图片位置')
    # Canvas x/y are the rotated full SVG frame's top-left, not the origin of
    # the rotated polygon. Keep a non-grid manual anchor completely unchanged.
    min_x, min_y, _, _ = affinity.rotate(source['frame'], angle, origin=(0, 0)).bounds
    return dict(i=source['i'], angle=angle, tx=x - origin[0] - min_x,
                ty=y - origin[1] - min_y)


def occupied_grid(srcs, fixed, args):
    """Conservative fixed-outline occupancy in the exact same grid as pack_one.

    Fixed slots are never snapped to grid or changed to a 15-degree angle.
    Allocate one byte per sheet cell and rasterise only each contour's bounds.
    """
    origin, cols, rows = collision_grid(srcs, args.board_width, args.board_height,
                                       args.gap, args.margin, args.resolution)
    occupancy = np.zeros((rows, cols), dtype=np.uint8)
    guard = args.gap / 2 + .12 + args.resolution * math.sqrt(2) / 2 + 1e-7
    for placement in fixed:
        source = srcs[placement['i']]
        polygon = affinity.translate(affinity.rotate(source['poly'], placement['angle'], origin=(0, 0)),
                                     placement['tx'], placement['ty']).buffer(guard, quad_segs=12)
        min_x, min_y, max_x, max_y = polygon.bounds
        x0, y0 = max(0, math.floor((min_x - origin) / args.resolution)), max(0, math.floor((min_y - origin) / args.resolution))
        x1, y1 = min(cols, math.ceil((max_x - origin) / args.resolution)), min(rows, math.ceil((max_y - origin) / args.resolution))
        if x0 >= x1 or y0 >= y1:
            continue
        xx = origin + (np.arange(x0, x1)[None, :] + .5) * args.resolution
        yy = origin + (np.arange(y0, y1)[:, None] + .5) * args.resolution
        occupancy[y0:y1, x0:x1] |= shapely.contains_xy(polygon, xx, yy).astype(np.uint8)
    return occupancy


def _search(srcs, bank, remaining, fixed, repeat, priority, args, seed, mode, validate, progress):
    quota = [quantity // repeat for quantity in remaining]
    for i, count in _counts(fixed).items():
        if count > quota[i]:
            raise ValueError('固定版式的数量超出该重复份数的 QT 配额')
        quota[i] -= count
    occupancy = occupied_grid(srcs, fixed, args)
    new = []
    if quota[priority] > 0:
        # Search every usable orientation and all free grid origins for the
        # moved artwork before other products can consume the target's gaps.
        new = pack_one([srcs[priority]], bank, quota, args.board_width, args.board_height,
                       args.gap, args.margin, args.resolution, seed, mode, 'small', 1,
                       progress, initial_occupancy=occupancy)
    if any(quota):
        if new:
            occupancy = occupied_grid(srcs, fixed + new, args)
        new += pack_one(srcs, bank, quota, args.board_width, args.board_height,
                        args.gap, args.margin, args.resolution, seed, mode, 'small',
                        max(1, args.lookahead), progress, initial_occupancy=occupancy)
    placed = fixed + new
    validate([placed])
    return placed


def _repeat_candidates(remaining, fixed, baseline_count):
    maximum = _repeat_limit(fixed, remaining)
    choices = {1, maximum}
    # Quantity quotient breakpoints bound searches without capping QT. Raising
    # QT only changes repetition arithmetic, never expands the contour bank.
    for quantity in remaining:
        for per_board in range(1, min(quantity, baseline_count) + 1):
            repeat = quantity // per_board
            if 1 <= repeat <= maximum:
                choices.add(repeat)
    ordered = sorted(choices)
    if len(ordered) <= 6:
        return ordered
    return sorted({ordered[round(i * (len(ordered) - 1) / 5)] for i in range(6)})


def _best_template(srcs, bank, remaining, fixed, priority, args, validate, progress, target):
    cache = {}

    def search(repeat, mode='top'):
        quota = tuple(quantity // repeat for quantity in remaining)
        key = (quota, mode)
        if key not in cache:
            cache[key] = _search(srcs, bank, remaining, fixed, repeat, priority, args,
                                 args.seed, mode, validate, progress)
        placed = cache[key]
        # Repeat only as much as all products on the finished sheet permit.
        actual_repeat = _repeat_limit(placed, remaining)
        return placed, actual_repeat

    baseline = search(1)
    candidates = [baseline]
    for repeat in _repeat_candidates(remaining, fixed, len(baseline[0])):
        if repeat != 1:
            candidates.append(search(repeat))

    def score(candidate):
        placed, repeat = candidate
        moved = sum(p['i'] == priority for p in placed)
        area = sum(srcs[p['i']]['area'] for p in placed)
        if target:
            # The cross-template gesture concerns the full artwork quantity.
            # Maximise its production on the target, then favour dense sheets.
            return moved * repeat, len(placed), area, len(placed) * repeat, -repeat
        # Other templates compact the remaining demand rather than producing
        # many nearly empty repeated sheets just to reuse one cutting program.
        return len(placed), area, repeat, moved * repeat, -repeat

    promising = max(candidates, key=score)
    candidates.append(search(max(1, promising[1]), 'low'))
    return max(candidates, key=score)


def pack_template_replan(job, args, request, *, origin, objective, validate, progress=None):
    """Return all physical sheets atomically, or fail without an old-plan fallback."""
    srcs, bank = job['srcs'], job['bank']
    remaining = list(job['quantities'])
    initial = list(remaining)
    by_id = {source['id']: source for source in srcs}
    if not isinstance(request, dict):
        raise ValueError('跨方案重排请求无效')
    templates = request.get('templates')
    if not isinstance(templates, list) or not templates:
        raise ValueError('跨方案重排缺少原始版式')
    parsed, old_counts = {}, Counter()
    for template in templates:
        ident = str(template.get('id', ''))
        if not ident or ident in parsed:
            raise ValueError('原始版式编号为空或重复')
        repeats = _integer(template.get('repeatCount'), '生产份数', 1)
        raw = template.get('placements')
        if not isinstance(raw, list) or not raw:
            raise ValueError('原始版式不能为空')
        placements = [_placement(item, by_id, origin) for item in raw]
        validate([placements])
        parsed[ident] = placements
        for i, count in _counts(placements).items():
            old_counts[i] += count * repeats
    if any(old_counts[i] > quantity for i, quantity in enumerate(initial)):
        raise ValueError('原始版式生产数量超出所选图片 QT，无法执行跨方案重排')
    source_id, target_id = request.get('sourceTemplateId'), request.get('targetTemplateId')
    if source_id == target_id or source_id not in parsed or target_id not in parsed:
        raise ValueError('跨方案重排的来源或目标版式无效')
    slot = _integer(request.get('sourceSlotIndex'), '来源图片位置')
    if slot >= len(parsed[source_id]):
        raise ValueError('来源图片位置不存在')
    moved = parsed[source_id][slot]
    anchor = _placement(request.get('targetPlacement'), by_id, origin)
    if moved['i'] != anchor['i']:
        raise ValueError('目标落点必须属于被拖动的同一款图片')
    priority = moved['i']
    parsed[source_id] = [placement for index, placement in enumerate(parsed[source_id]) if index != slot]
    target = parsed[target_id] + [anchor]
    validate([target])
    if _repeat_limit(target, remaining) < 1:
        raise ValueError('目标版式固定图片超出 QT 数量')

    boards = []
    total = sum(initial)

    def report(label):
        if progress:
            progress(label, total - sum(remaining), total)

    def search_progress(count, unused):
        report(f'搜索目标/余料空间：本轮新增 {count} 张；所有 QT 共用基础轮廓')

    def commit(placed, repeat):
        if repeat < 1 or not placed:
            raise ValueError('跨方案重排未生成可生产的版式')
        for i, count in _counts(placed).items():
            if count * repeat > remaining[i]:
                raise ValueError('跨方案重排产生超出 QT 的副本')
            remaining[i] -= count * repeat
        boards.extend([placed] * repeat)

    report('固定目标落点，按整款 QT 重新搜索目标方案与生产份数')
    placed, repeat = _best_template(srcs, bank, remaining, target, priority, args, validate, search_progress, True)
    commit(placed, repeat)
    report(f'目标方案重新安排为 {repeat} 块；继续向来源及其他方案空隙补排')

    order = [source_id] + [ident for ident in parsed if ident not in (source_id, target_id)]
    for ident in order:
        if not any(remaining):
            break
        # Products already completed on the target disappear from the other
        # templates. Retain the exact positions of still-needed background slots.
        available = list(remaining)
        fixed = []
        for placement in parsed[ident]:
            i = placement['i']
            if available[i] > 0:
                fixed.append(placement)
                available[i] -= 1
        if not fixed:
            continue
        report(f'利用已有方案 {ident} 的空隙，重新计算剩余生产份数')
        placed, repeat = _best_template(srcs, bank, remaining, fixed, priority, args, validate, search_progress, False)
        commit(placed, repeat)

    if any(remaining):
        report(f'已有方案空隙已搜索，余下 {sum(remaining)} 张继续排入新板材')
        if objective in ('combined', 'least-combined'):
            # The combined search reuses occupied_grid above. Import it only
            # after this module is initialized, so neither strategy owns the other.
            from nest_combined import pack_combined_boards
            tail = pack_combined_boards(dict(srcs=srcs, bank=bank, quantities=remaining), args,
                                        progress=lambda *_: report('综合比较剩余图片的板材与切割方案'),
                                        validate=validate, origin=origin)
        elif objective == 'least-cutting':
            tail, _, _ = pack_uniform_boards(dict(srcs=srcs, bank=bank, quantities=remaining), args,
                                            lambda *_: report('搜索剩余图片的新重复版式'))
        else:
            tail = pack_material_boards(srcs, bank, remaining, args,
                                        progress=lambda *_: report('搜索剩余图片的新板材'))
        for board in tail:
            commit(board, 1)
    validate(boards)
    actual = Counter(placement['i'] for board in boards for placement in board)
    if any(remaining) or any(actual[i] != quantity for i, quantity in enumerate(initial)):
        raise ValueError('跨方案重排未满足全部 QT 数量，结果未提交')
    report('目标与其他方案已完成真实空隙搜索，全部 QT、间距和边界校验通过')
    return boards
