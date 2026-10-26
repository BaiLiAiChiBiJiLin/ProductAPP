"""Compare complete repeated lots, then insert indivisible demand into free space.

One-off products must not erase the repetition structure of the bulk order.
All searches share the original MaskBank; only quantity vectors are reduced.
"""
from collections import Counter
from types import SimpleNamespace
import math

from shapely import affinity
from shapely.geometry import box
from shapely.strtree import STRtree

from nesting_common import pack_material_boards, pack_one
from nest_repeat_patterns import repeated_pattern_lots


def template_key(board):
    return tuple(sorted((p['i'], p['angle'], round(p['tx'], 7), round(p['ty'], 7)) for p in board))


def _candidates(job, args, sheet_limit):
    quantities, srcs = job['quantities'], job['srcs']
    choices = set()
    for quantity in set(quantities):
        # Enumerate divisors, not physical QT copies or all possible repeats.
        for divisor in range(1, math.isqrt(quantity) + 1):
            if quantity % divisor == 0:
                choices.update((divisor, quantity // divisor))
    board_area = (args.board_width - 2 * args.margin) * (args.board_height - 2 * args.margin)
    candidates = []
    for repeat in choices:
        if not 2 <= repeat <= sheet_limit:
            continue
        quota = [quantity // repeat for quantity in quantities]
        covered = sum(quota) * repeat
        if covered < .75 * sum(quantities):
            continue
        area = sum(source['area'] * quota[source['i']] for source in srcs)
        if math.ceil(area / board_area - 1e-9) * repeat > sheet_limit:
            continue
        candidates.append((repeat, quota))
    # Large repeats offer fewer programs. Keep a bounded set of complete-lot
    # trials, independently of the number of QT instances in the order.
    return sorted(candidates, reverse=True)[:4]


def _valid(job, args, boards):
    counts = Counter()
    region = box(args.margin, args.margin, args.board_width - args.margin,
                 args.board_height - args.margin).buffer(1e-7)
    checked = set()
    for board in boards:
        if not board:
            return False
        counts.update(p['i'] for p in board)
        key = template_key(board)
        if key in checked:
            continue
        checked.add(key)
        polygons = []
        for placement in board:
            source = job['srcs'][placement['i']]
            def transform(geometry):
                return affinity.translate(affinity.rotate(geometry, placement['angle'], origin=(0, 0)),
                                          placement['tx'], placement['ty'])
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
    return all(counts[i] == quantity for i, quantity in enumerate(job['quantities']))


def _insert_tails(job, args, boards, remaining, progress):
    # Import lazily: nest_replan also uses the uniform strategy for its tails.
    from nest_replan import occupied_grid
    srcs, bank = job['srcs'], job['bank']
    result = list(boards)
    visited = set()
    # Inspect each unique template once. Splitting one physical board keeps
    # every other repetition identical and does not duplicate a product's QT.
    for index, board in enumerate(boards):
        if not any(remaining):
            break
        key = template_key(board)
        if key in visited:
            continue
        visited.add(key)
        occupancy = occupied_grid(srcs, board, args)
        trials = []
        for variant, (mode, order) in enumerate([('top', 'large'), ('low', 'small'), ('bl', 'mixed')]):
            rem = remaining.copy()
            extra = pack_one(srcs, bank, rem, args.board_width, args.board_height,
                             args.gap, args.margin, args.resolution, args.seed + 7001 + variant,
                             mode, order, max(1, args.lookahead), initial_occupancy=occupancy)
            trials.append((extra, rem))
        extra, rem = max(trials, key=lambda trial: (len(trial[0]), sum(srcs[p['i']]['area'] for p in trial[0])))
        if extra:
            result[index] = board + extra
            remaining = rem
            if progress:
                progress(len(visited), 1, len(extra), sum(remaining))
    if any(remaining):
        result.extend(pack_material_boards(srcs, bank, remaining, args))
    return result


def improve_repeated_lots(job, args, baseline, progress=None):
    """Adopt fewer programs only when the entire order uses no more sheets."""
    # Lazy import avoids the uniform/combined strategy import cycle. Artwork
    # identity must remain in template_key for QT accounting, but equal cutting
    # outlines can share a cutting program even when their printed art differs.
    from nest_combined import CuttingScore
    scorer = CuttingScore(job['srcs'])
    def plan_score(boards):
        cost = scorer.score(boards)
        return cost[2], cost[1]
    best, score = baseline, plan_score(baseline)
    diagnostics = job.setdefault('repeatDiagnostics', {})
    diagnostics.update(before=dict(sheets=len(baseline), layouts=score[0]), candidates=[])
    # A single existing program is already optimal for cutting reuse.
    if score[0] <= 1:
        return best
    for repeat, quota in _candidates(job, args, len(baseline)):
        search_args = SimpleNamespace(**vars(args))
        search_args.runs = max(6, args.runs)
        search_args.lookahead = max(4, args.lookahead)
        tail_total = sum(quantity - per_lot * repeat for quantity, per_lot in zip(job['quantities'], quota))
        def report(board, attempt, count, left):
            if progress:
                progress(board, repeat, count, left * repeat + tail_total)
        if progress:
            progress(0, repeat, 0, sum(job['quantities']))
        lot = pack_material_boards(job['srcs'], job['bank'], quota, search_args,
                                   seed_offset=0, progress=report)
        entry = dict(repeat=repeat, lotSheets=len(lot))
        diagnostics['candidates'].append(entry)
        def consider(lot, detail):
            nonlocal best, score
            if len(lot) * repeat > len(best):
                detail['rejected'] = 'sheet-count'
                return
            candidate = [board for board in lot for _ in range(repeat)]
            remaining = [quantity - per_lot * repeat for quantity, per_lot in zip(job['quantities'], quota)]
            if any(remaining):
                candidate = _insert_tails(job, args, candidate, remaining, progress)
            candidate_score = plan_score(candidate)
            detail.update(sheets=len(candidate), layouts=candidate_score[0])
            if len(candidate) <= len(best) and candidate_score < score and _valid(job, args, candidate):
                best, score = candidate, candidate_score
                detail['accepted'] = True
        consider(lot, entry)
        # A complete lot can contain a repeated subtemplate of its own. Trying
        # this before discarding an overlong lot can reduce both its sheet count
        # and its number of cutting programs (e.g. A, A, B, C instead of five
        # independently filled boards). Keep the complete plan on allocation
        # pressure or a known optional-tail packing failure.
        if score[0] <= 1:
            break
        patterns = entry['subpatterns'] = {}
        try:
            for candidate_lot, detail in repeated_pattern_lots(
                    job, search_args, quota, lambda: len(best) // repeat, patterns, report):
                consider(candidate_lot, detail)
                if detail.get('accepted'):
                    patterns.setdefault('accepted', []).append(detail)
                    if score[0] <= 1:
                        break
        except MemoryError:
            patterns['stopped'] = 'memory-pressure-preserved-complete-plan'
        except SystemExit as exc:
            if not str(exc).startswith('No remaining item fits;'):
                raise
            patterns['stopped'] = 'tail-does-not-fit-preserved-complete-plan'
    diagnostics['after'] = dict(sheets=len(best), layouts=score[0])
    return best
