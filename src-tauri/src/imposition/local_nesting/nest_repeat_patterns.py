"""Search a short demand lot as repeated subtemplates plus its exact remainder.

This is an optional improvement over a complete plan, not another full-order
solver. Quantity vectors and placements are small; every trial shares the
caller's immutable contour/mask bank. No customer names or saved layouts enter
the search.
"""
from collections import Counter
import math

from nesting_common import pack_material_boards, pack_one
from nest_order_search import optimize_near_full_board


# Bound additional heuristic work, not the input quantity. Longer lots still
# have the complete material/uniform baseline and the ordinary repeated-lot
# search. Two/three identical boards plus a short tail are the neighborhood.
MAX_PATTERN_SHEETS = 4
MAX_ORDER_QUOTAS = 2
FACTORS = (2, 3)
VARIANTS = tuple((mode, order) for order in ('large', 'small', 'mixed', 'random')
                 for mode in ('top', 'low', 'bl'))


def repeated_pattern_lots(job, args, quota, sheet_limit, diagnostics, progress=None):
    """Yield exact lot candidates; the caller validates the complete order.

    ``sheet_limit`` is live: accepting a better whole plan can prune later
    trials immediately. Remainder packs are cached by quantities, independent
    of the geometry/ordering that produced the repeated first board.
    """
    srcs, bank = job['srcs'], job['bank']
    area = (args.board_width - 2 * args.margin) * (args.board_height - 2 * args.margin)
    def lower_bound(quantities):
        return math.ceil(sum(source['area'] * quantities[source['i']] for source in srcs) / area - 1e-9)
    def limit():
        return min(MAX_PATTERN_SHEETS, sheet_limit())
    diagnostics.update(trials=0, tailSearches=0, cacheHits=0, areaPruned=0)
    if lower_bound(quota) > limit():
        diagnostics['areaPruned'] += 1
        return
    tail_cache, near_full = {}, {}
    variants = [(mode, order, args.lookahead) for mode, order in VARIANTS]
    if args.lookahead != 1:
        variants += [(mode, order, 1) for mode, order in VARIANTS]
    for factor in FACTORS:
        first = [quantity // factor for quantity in quota]
        if not any(first) or factor > limit():
            continue
        # Even a first board containing its entire allowance cannot consume
        # these remainders. Their contour area is a lower bound independent of
        # placement, so skip every ordering when that bound already exceeds the
        # live sheet limit. This changes no feasible candidate's search order.
        unavoidable = [quantity - factor * allowance for quantity, allowance in zip(quota, first)]
        minimum_sheets = factor + lower_bound(unavoidable)
        for variant, (mode, order, lookahead) in enumerate(variants):
            if minimum_sheets > limit():
                diagnostics['areaPruned'] += 1
                break
            diagnostics['trials'] += 1
            board = pack_one(srcs, bank, first.copy(), args.board_width, args.board_height,
                             args.gap, args.margin, args.resolution, args.seed + variant,
                             mode, order, lookahead)
            if not board:
                continue
            counts = Counter(p['i'] for p in board)
            remaining = tuple(quantity - factor * counts[i] for i, quantity in enumerate(quota))
            if any(quantity < 0 for quantity in remaining):
                raise ValueError('Repeated subtemplate exceeds the lot quantity')
            if factor + lower_bound(remaining) > limit():
                diagnostics['areaPruned'] += 1
                continue
            if progress:
                progress(factor, variant + 1, len(board), sum(remaining))
            if remaining in tail_cache:
                diagnostics['cacheHits'] += 1
                tail = tail_cache[remaining]
            else:
                diagnostics['tailSearches'] += 1
                tail = pack_material_boards(srcs, bank, remaining, args) if any(remaining) else []
                tail_cache[remaining] = tail
            detail = dict(factor=factor, variant=variant, mode=mode, order=order, lookahead=lookahead)
            if tail and factor + 1 <= limit() and lower_bound(remaining) <= 1:
                placed = Counter(p['i'] for p in tail[0])
                missing = [q - placed[i] for i, q in enumerate(remaining)]
                if 1 <= sum(missing) <= 2:
                    rank = (sum(missing), sum(srcs[i]['area'] * q for i, q in enumerate(missing)),
                            -len(tail[0]) / sum(remaining), factor)
                    previous = near_full.get(remaining)
                    if previous is None or rank < previous[0]:
                        near_full[remaining] = (rank, board, tail[0], detail)
            if factor + len(tail) > limit():
                continue
            lot = [board] * factor + tail
            actual = Counter(p['i'] for page in lot for p in page)
            if any(actual[i] != quantity for i, quantity in enumerate(quota)):
                raise ValueError('Repeated subtemplate remainder does not preserve the lot quantity')
            yield lot, detail
    # Spend the separate whole-job order budget on the closest distinct
    # residual quotas only; do not launch a genetic search for every head.
    diagnostics['orderSearches'] = []
    candidates = sorted(near_full.items(), key=lambda entry: entry[1][0])
    attempted = 0
    for remaining, (_, board, baseline, detail) in candidates:
        factor = detail['factor']
        if factor + 1 > limit():
            continue
        if attempted >= MAX_ORDER_QUOTAS:
            break
        attempted += 1
        search = dict(factor=factor, variant=detail['variant'])
        diagnostics['orderSearches'].append(search)
        tail_board = optimize_near_full_board(job, args, remaining, baseline, search, progress)
        if tail_board is not None:
            yield [board] * factor + [tail_board], dict(detail, orderOptimized=True)
