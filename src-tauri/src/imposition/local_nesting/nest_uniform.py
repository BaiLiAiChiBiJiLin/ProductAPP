#!/usr/bin/env python
"""Dense repeated cutting templates with exact quantities and shared geometry.

The same single-board true-shape search underlies both strategies. This strategy
tries per-board quantity quotas, repeats dense templates, then nests remainders.
It never creates one-copy-per-product quantity layers.
"""
from collections import Counter
import math

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


def _complete_repeat_template(job, args, sheet_limit, progress):
    """Try exact whole-job quotas without increasing the validated sheet count.

    Single-board density cannot score this tradeoff: 48 pieces repeated five
    times can beat greedy 58-piece boards followed by three different tails.
    Only common divisors of the demand can complete a job with one template.
    Bound extra trials, share the mask bank, and keep the dense plan on failure.
    """
    quantities, srcs = job['quantities'], job['srcs']
    divisor = math.gcd(*quantities)
    area = sum(source['area'] * quantities[source['i']] for source in srcs)
    board_area = (args.board_width - 2 * args.margin) * (args.board_height - 2 * args.margin)
    lower = max(1, math.ceil(area / board_area - 1e-9))
    choices = set()
    for factor in range(1, min(sheet_limit, math.isqrt(divisor)) + 1):
        if divisor % factor == 0:
            choices.update(r for r in (factor, divisor // factor) if lower <= r <= sheet_limit)
    choices = sorted(choices)
    # Include both dense and high-reuse ends when there are many divisors.
    if len(choices) > 8:
        choices = [choices[j * (len(choices) - 1) // 7] for j in range(8)]
    for repeat in choices:
        quota = [quantity // repeat for quantity in quantities]
        for mode, order in [('top', 'small'), ('low', 'mixed'), ('top', 'large'), ('bl', 'balanced')]:
            remaining = quota.copy()
            placed = pack_one(
                srcs, job['bank'], remaining, args.board_width, args.board_height,
                args.gap, args.margin, args.resolution, args.seed, mode, order,
                max(1, args.lookahead),
                (lambda count, unused: progress(0, repeat, count, (sum(quota) - count) * repeat))
                if progress else None)
            if not any(remaining) and _counts(placed) == Counter({i: q for i, q in enumerate(quota) if q}):
                return placed, repeat
    return None


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
    if len(templates_by_key) > 1:
        complete = _complete_repeat_template(job, args, len(boards), progress)
        if complete is not None:
            placement, repeat = complete
            return ([placement] * repeat, [(placement, repeat)],
                    [dict(template=1, repeat=repeat, pieces_per_board=len(placement), remaining=0)])
    return boards, [(placement, repeat) for placement, repeat in templates_by_key.values()], summaries
