"""Bounded source-order search for a nearly complete single-board quota.

Only the source priority changes. Original areas, contours, frames, allowed
angles, spacing and the shared native mask bank remain unchanged.
"""
from collections import Counter
import random

from shapely import affinity
from shapely.geometry import box
from shapely.strtree import STRtree

from nesting_common import pack_one
from nesting_rust import MaskBank


MAX_JOB_TRIALS = 384
MAX_QUOTA_TRIALS = 192
ELITE_SIZE = 20


def valid_single_board(srcs, quota, board, args):
    """Check exact artwork quantities and the real geometry before acceptance."""
    if not board or Counter(p['i'] for p in board) != Counter({i: q for i, q in enumerate(quota) if q}):
        return False
    region = box(args.margin, args.margin, args.board_width - args.margin,
                 args.board_height - args.margin).buffer(1e-7)
    polygons = []
    for p in board:
        source = srcs[p['i']]
        def transform(geometry):
            return affinity.translate(affinity.rotate(geometry, p['angle'], origin=(0, 0)), p['tx'], p['ty'])
        polygon = transform(source['poly'])
        if not region.covers(polygon) or not region.covers(transform(source['frame'])):
            return False
        polygons.append(polygon)
    tree = STRtree(polygons)
    for i, polygon in enumerate(polygons):
        for j in tree.query(polygon.buffer(args.gap + 1e-7)):
            if j > i and (polygon.intersection(polygons[j]).area > 1e-7
                          or polygon.distance(polygons[j]) < args.gap - 1e-6):
                return False
    return True


def optimize_near_full_board(job, args, quota, baseline, diagnostics, progress=None):
    """Return a validated complete board, or None while preserving the baseline.

    Gate on one/two missing pieces and area before consuming the shared job
    budget. Both successful and exhausted quantity vectors are cached.
    """
    srcs, bank = job['srcs'], job['bank']
    counts = Counter(p['i'] for p in baseline)
    remaining = [q - counts[i] for i, q in enumerate(quota)]
    if any(q < 0 for q in remaining):
        raise ValueError('Single-board baseline exceeds the requested quantity')
    missing = sum(remaining)
    area = sum(source['area'] * quota[source['i']] for source in srcs)
    board_area = (args.board_width - 2 * args.margin) * (args.board_height - 2 * args.margin)
    diagnostics.update(trials=0, missing=missing)
    if not 1 <= missing <= 2 or area > board_area + 1e-7:
        diagnostics['skipped'] = 'not-near-full'
        return None
    # One MaskBank belongs to one solve, including its line-only/mixed groups.
    # Keep this budget scoped there, never in module globals or across jobs.
    state = getattr(bank, '_repeat_order_search', None)
    if state is None:
        state = job.setdefault('_repeatOrderSearch', dict(remaining=MAX_JOB_TRIALS, cache={}))
        if isinstance(bank, MaskBank):
            bank._repeat_order_search = state
    key = tuple(quota)
    if key in state['cache']:
        diagnostics['cached'] = True
        return state['cache'][key]
    limit = min(MAX_QUOTA_TRIALS, state['remaining'])
    if limit <= 0:
        diagnostics['skipped'] = 'job-search-budget'
        return None
    active = [i for i, q in enumerate(quota) if q]
    orders = [sorted(active, key=lambda i: srcs[i][attr], reverse=reverse)
              for attr in ('area', 'width', 'height') for reverse in (False, True)]
    orders += [sorted(active, key=lambda i: srcs[i]['width'] * srcs[i]['height'], reverse=reverse)
               for reverse in (False, True)]
    rng = random.Random(args.seed)
    elite, seen, top_cache, best_score = [], set(), {}, None
    for trial in range(limit):
        if trial < len(orders):
            order = orders[trial].copy()
        elif trial < 50 or trial % 7 == 0 or not elite:
            order = active.copy()
            rng.shuffle(order)
        else:
            order = rng.choice(elite[:12])[1].copy()
            if len(order) > 1:
                for _ in range(1 if trial % 3 else 3):
                    a, b = rng.sample(range(len(order)), 2)
                    if trial % 2:
                        order[a], order[b] = order[b], order[a]
                    else:
                        order.insert(b, order.pop(a))
        mode = ('top', 'bl', 'low')[trial % 3]
        seed = rng.randrange(100000)
        lookahead = 1 if trial % 5 else 2
        remaining = list(quota)
        state['remaining'] -= 1
        diagnostics['trials'] += 1
        board = pack_one([srcs[i] for i in order], bank, remaining,
                         args.board_width, args.board_height, args.gap, args.margin,
                         args.resolution, seed, mode, 'input', lookahead)
        if not any(remaining) and valid_single_board(srcs, quota, board, args):
            state['cache'][key] = board
            diagnostics.update(completed=True, mode=mode, lookahead=lookahead)
            return board
        placed_area, extent = 0., 0.
        for p in board:
            placed_area += srcs[p['i']]['area']
            shape = p['i'], p['angle']
            if shape not in top_cache:
                top_cache[shape] = affinity.rotate(srcs[p['i']]['poly'], p['angle'], origin=(0, 0)).bounds[3]
            extent = max(extent, top_cache[shape] + p['ty'])
        score = len(board), placed_area, -extent
        board_key = tuple((p['i'], p['angle'], round(p['tx'], 4), round(p['ty'], 4)) for p in board)
        if board_key not in seen:
            seen.add(board_key)
            elite.append((score, order))
            elite.sort(key=lambda entry: entry[0], reverse=True)
            del elite[ELITE_SIZE:]
        if progress and (trial % 8 == 0 or best_score is None or score > best_score):
            progress(0, trial + 1, len(board), sum(remaining))
        best_score = score if best_score is None else max(best_score, score)
    state['cache'][key] = None
    diagnostics['completed'] = False
    return None
