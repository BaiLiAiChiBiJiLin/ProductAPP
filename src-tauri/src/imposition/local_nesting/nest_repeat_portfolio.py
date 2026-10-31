"""Optional template inventories with different QT repetition periods.

Only the demand vector selects extra template seeds. No task, filename or saved
placement enters this search. The complete all-artwork mixed plan remains the
incumbent; every new inventory and its globally mixed tail must beat that plan.
"""
from collections import Counter
import math

from nest_repeat_lots import _insert_tails, _valid, template_key
from nesting_rust import MaskBank, core_status


MAX_PORTFOLIOS = 2
MAX_COMPONENT_SOLVES = 4
MAX_ORDER_TRIALS = 384
MAX_DEPTH = 1


def _supports(quantities, srcs):
    """Deduplicate complementary QT-divisibility supports, not customer groups."""
    active = tuple(i for i, quantity in enumerate(quantities) if quantity > 0)
    divisors = set()
    for quantity in set(quantities):
        for divisor in range(1, math.isqrt(quantity) + 1):
            if quantity % divisor == 0:
                divisors.update((divisor, quantity // divisor))
    candidates = {}
    for divisor in divisors:
        if divisor < 2:
            continue
        support = tuple(i for i in active if quantities[i] % divisor == 0)
        if not support or len(support) == len(active):
            continue
        selected = set(support)
        residual = tuple(i for i in active if i not in selected)
        key = tuple(sorted((support, residual)))
        candidates[key] = max(divisor, candidates.get(key, 0))
    def demand_area(indices):
        return sum(srcs[i]['area'] * quantities[i] for i in indices)
    def rank(entry):
        (first, second), _divisor = entry
        periods = sorted((math.gcd(*(quantities[i] for i in first)),
                          math.gcd(*(quantities[i] for i in second))))
        return -periods[0], -periods[1], -min(demand_area(first), demand_area(second)), first, second
    result = []
    for pair, divisor in sorted(candidates.items(), key=rank)[:MAX_PORTFOLIOS]:
        # The larger inventory seeds later free-space repair; all remaining
        # artwork is still allowed on its boards by the global repair solver.
        first, second = sorted(pair, key=lambda ids: (-demand_area(ids), ids))
        result.append((first, second, divisor))
    return result


def _solve_uniform(job, args, progress):
    # Lazy import: the ordinary uniform solver can call this optional stage.
    from nest_uniform import pack_uniform_boards
    return pack_uniform_boards(job, args, progress)


def improve_repeat_portfolio(job, args, baseline, progress=None):
    """Try a bounded inventory of reusable templates, retaining a complete plan."""
    if job.get('_repeatPortfolioDepth', 0) >= MAX_DEPTH:
        return baseline
    srcs, bank, quantities = job['srcs'], job['bank'], job['quantities']
    supports = _supports(quantities, srcs)
    if not supports:
        return baseline
    from nest_combined import CuttingScore
    from nest_order_search import MAX_JOB_TRIALS
    scorer = CuttingScore(srcs)
    def score(boards):
        measured = scorer.score(boards)
        return measured[2], measured[1], measured[3]
    def metrics(boards):
        measured = score(boards)
        return dict(sheets=measured[1], layouts=measured[0])
    diagnostics = job.setdefault('portfolioDiagnostics', {})
    diagnostics.update(before=metrics(baseline), candidates=[], componentSolves=0,
                       cacheHits=0, orderTrials=0, tailRepairs=0)
    best, best_score = baseline, score(baseline)
    if best_score[0] <= 1:
        diagnostics['after'] = metrics(best)
        return best
    cache = {}
    order_remaining = min(MAX_ORDER_TRIALS, MAX_JOB_TRIALS)

    def component(indices):
        nonlocal order_remaining
        # Include global artwork indexes: equal silhouettes/quotas may still be
        # different print inventories and must not reuse each other's pieces.
        key = tuple((i, quantities[i]) for i in indices)
        if key in cache:
            diagnostics['cacheHits'] += 1
            return cache[key]
        if diagnostics['componentSolves'] >= MAX_COMPONENT_SOLVES:
            return None
        if not 0 < len(indices) < sum(q > 0 for q in quantities):
            raise ValueError('Portfolio template seed must strictly reduce active artwork types')
        diagnostics['componentSolves'] += 1
        child_sources = [dict(srcs[global_i], i=local_i, quantity=quantities[global_i])
                         for local_i, global_i in enumerate(indices)]
        child_quantities = [quantities[i] for i in indices]
        # Lists and immutable NumPy masks are shared. Each child uploads once
        # into a short-lived native context, never once per QT or trial board.
        with MaskBank({local_i: bank[global_i] for local_i, global_i in enumerate(indices)}) as child_bank:
            child_job = dict(srcs=child_sources, bank=child_bank, quantities=child_quantities,
                             _repeatPortfolioDepth=job.get('_repeatPortfolioDepth', 0) + 1,
                             _globalSourceIndexes=indices)
            order_state = dict(remaining=order_remaining, cache={})
            child_bank._repeat_order_search = order_state
            if isinstance(bank, MaskBank):
                bank._active_child_bank = child_bank
            try:
                def report(template, repeat, count, remaining):
                    if progress:
                        progress(template, repeat, count,
                                 sum(quantities) - sum(child_quantities) + remaining)
                boards, _templates, _summaries = _solve_uniform(child_job, args, report)
                if not _valid(child_job, args, boards):
                    cache[key] = None
                    return None
                mapped = {}
                def restore(board):
                    ident = id(board)
                    if ident not in mapped:
                        mapped[ident] = [dict(p, i=indices[p['i']]) for p in board]
                    return mapped[ident]
                result = [restore(board) for board in boards]
                cache[key] = result
                return result
            finally:
                used = max(0, order_remaining - order_state['remaining'])
                order_remaining = max(0, order_remaining - used)
                diagnostics['orderTrials'] += used
                if isinstance(bank, MaskBank):
                    statuses = getattr(bank, '_child_core_status', [])
                    statuses.append(core_status(child_bank))
                    bank._child_core_status = statuses
                    del bank._active_child_bank

    seed_for_repair, best_repair_rank = None, None
    def consider(candidate, detail, *, validated=False):
        nonlocal best, best_score
        candidate_score = score(candidate)
        detail.update(sheets=len(candidate), layouts=candidate_score[0])
        if (len(candidate) <= len(best) and candidate_score < best_score
                and (validated or _valid(job, args, candidate))):
            best, best_score = candidate, candidate_score
            detail['accepted'] = True
            return True
        return False

    def repair_rank(seed, residual, candidate):
        board_area = (args.board_width - 2 * args.margin) * (args.board_height - 2 * args.margin)
        residual_area = sum(srcs[p['i']]['area'] for board in residual for p in board)
        # _insert_tails visits one physical copy of each distinct template.
        # True-area free space overestimates what can fit, giving a safe lower
        # bound for pruning without running another geometric placement trial.
        unique = {template_key(board): board for board in seed}
        free_area = sum(max(0., board_area - sum(srcs[p['i']]['area'] for p in board))
                        for board in unique.values())
        extra_sheets = math.ceil(max(0., residual_area - free_area) / board_area - 1e-9)
        measured = score(candidate)
        return len(seed) + extra_sheets, measured[0], measured[1], -free_area

    for support, residual, divisor in supports:
        detail = dict(divisor=divisor, seedTypes=len(support), residualTypes=len(residual))
        diagnostics['candidates'].append(detail)
        try:
            seed = component(support)
            if seed is None:
                detail['rejected'] = 'unavailable-template-seed'
                continue
            remainder = component(residual)
            if remainder is None:
                detail['rejected'] = 'unavailable-complete-remainder'
                continue
            candidate = seed + remainder
            if not _valid(job, args, candidate):
                detail['rejected'] = 'invalid-complete-inventory'
                continue
            consider(candidate, detail, validated=True)
            # Even a worse uncombined inventory can have an excellent partial
            # template. Keep one promising seed for a global fill before
            # requiring the complete repaired plan to beat the incumbent.
            rank = repair_rank(seed, remainder, candidate)
            if rank[0] <= len(best) and (best_repair_rank is None or rank < best_repair_rank):
                seed_for_repair = seed
                best_repair_rank = rank
            if best_score[0] <= 1:
                break
        except MemoryError:
            detail['stopped'] = 'memory-pressure-preserved-complete-plan'
            break
        except SystemExit as exc:
            if not str(exc).startswith('No remaining item fits;'):
                raise
            detail['rejected'] = 'optional-template-does-not-fit'
    if seed_for_repair is not None and best_score[0] > 1 and best_repair_rank[0] <= len(best):
        # Never force the partial-template boundaries into the output. Also try
        # placing every residual type into the seed's real free space globally.
        used = Counter(p['i'] for board in seed_for_repair for p in board)
        remaining = [q - used[i] for i, q in enumerate(quantities)]
        try:
            diagnostics['tailRepairs'] += 1
            repaired = _insert_tails(job, args, seed_for_repair, remaining, progress)
            consider(repaired, diagnostics.setdefault('globalTail', {}))
        except MemoryError:
            diagnostics['tailStopped'] = 'memory-pressure-preserved-complete-plan'
        except SystemExit as exc:
            if not str(exc).startswith('No remaining item fits;'):
                raise
            diagnostics['tailStopped'] = 'optional-tail-does-not-fit'
    diagnostics['after'] = metrics(best)
    return best
