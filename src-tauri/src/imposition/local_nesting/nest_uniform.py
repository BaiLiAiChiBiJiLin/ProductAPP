#!/usr/bin/env python
"""Dense repeated cutting templates with exact quantities and shared geometry.

The same single-board true-shape search underlies both strategies. This strategy
tries per-board quantity quotas, repeats dense templates, then nests remainders.
It never creates one-copy-per-product quantity layers.
"""
from collections import Counter

from nesting_common import pack_one


def _counts(placement):
    return Counter(p['i'] for p in placement)


def _repeat_count(placement, remaining):
    counts = _counts(placement)
    return min((remaining[i] // count for i, count in counts.items()), default=0)


def _area(placement, srcs):
    return sum(srcs[p['i']]['area'] for p in placement)


def _repeat_candidates(remaining, srcs, baseline):
    """Bound search variants, not QT: use quantity quotient breakpoints.

    A candidate needs enough available contour area or pieces to compete with
    the unrestricted dense board. Large QT increases repetitions rather than
    the number of masks or searches.
    """
    base_count, base_area = len(baseline), _area(baseline, srcs)
    choices = {2}
    for quantity in remaining:
        for per_board in range(1, min(quantity, base_count) + 1):
            choices.add(quantity // per_board)
    eligible = []
    for repeat in sorted(choices):
        if repeat < 2:
            continue
        quota = [quantity // repeat for quantity in remaining]
        count = sum(quota)
        area = sum(srcs[i]['area'] * quantity for i, quantity in enumerate(quota))
        if count >= base_count or area >= base_area - 1e-7:
            eligible.append(repeat)
    if len(eligible) <= 3:
        return eligible
    return sorted({eligible[0], eligible[len(eligible) // 2], eligible[-1]})


def _dense_frontier(candidates, srcs):
    """Discard sparse layouts even when they could be repeated many times."""
    measured = [(placed, len(placed), _area(placed, srcs)) for placed in candidates if placed]
    return [placed for placed, count, area in measured if not any(
        other_count >= count and other_area >= area - 1e-7
        and (other_count > count or other_area > area + 1e-7)
        for _, other_count, other_area in measured)]


def pack_uniform_boards(job, args, progress=None):
    """Fill boards, reuse dense layouts, then continue with exact remainders.

    Every physical board remains in the result. Repetitions share the same
    lightweight placement list; only the UI folds them into templates.
    """
    srcs, bank = job['srcs'], job['bank']
    remaining = list(job['quantities'])
    if not any(remaining):
        raise SystemExit('Uniform mode has no positive quantities to place')
    boards, summaries = [], []
    templates_by_key = {}
    template_no = 0
    while any(remaining):
        left = sum(remaining)
        cache = {}

        def search(quota, repeat, mode='top', order='small'):
            key = (tuple(quota), mode, order)
            if key not in cache:
                rem = list(quota)
                cache[key] = pack_one(
                    srcs, bank, rem, args.board_width, args.board_height,
                    args.gap, args.margin, args.resolution, args.seed + template_no * 101,
                    mode, order, max(1, args.lookahead),
                    (lambda count, unused: progress(template_no, repeat, count, left)) if progress else None)
            return cache[key]

        # If everything fits, one full tail always beats quantity-layer boards.
        baseline = search(remaining, 1)
        if not baseline:
            raise SystemExit('No remaining item fits; check its contour, size and gap')
        candidates = [baseline]
        if len(baseline) != left:
            for repeat in _repeat_candidates(remaining, srcs, baseline):
                quota = [quantity // repeat for quantity in remaining]
                candidates.append(search(quota, repeat))
            # Try a second direction/order with the same cached geometry.
            promising = max(_dense_frontier(candidates, srcs),
                            key=lambda p: (_repeat_count(p, remaining), len(p), _area(p, srcs)))
            repeat = _repeat_count(promising, remaining)
            candidates.append(search([q // repeat for q in remaining], repeat, 'low', 'mixed'))
        frontier = _dense_frontier(candidates, srcs)
        chosen = max(frontier, key=lambda p: (_repeat_count(p, remaining), len(p), _area(p, srcs)))
        repeat = _repeat_count(chosen, remaining)
        if repeat < 1:
            raise RuntimeError('Template quantities exceed the remaining demand')
        for i, count in _counts(chosen).items():
            remaining[i] -= count * repeat
        boards.extend([chosen] * repeat)
        key = tuple(sorted((p['i'], p['angle'], round(p['tx'], 7), round(p['ty'], 7)) for p in chosen))
        if key in templates_by_key:
            templates_by_key[key][1] += repeat
        else:
            templates_by_key[key] = [chosen, repeat]
        summaries.append(dict(template=template_no + 1, repeat=repeat,
                              pieces_per_board=len(chosen), remaining=sum(remaining)))
        if progress:
            progress(template_no, repeat, len(chosen), sum(remaining))
        template_no += 1
    return boards, [(placement, repeat) for placement, repeat in templates_by_key.values()], summaries
