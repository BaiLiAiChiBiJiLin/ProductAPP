"""60:40 sheet/cutting-program optimization with true-shape tail repair.

Both full baselines share one contour/mask bank. A bounded local improvement
then removes low-density sheets and really searches the occupied space on other
sheets. Candidate limits control additional work; no wall-clock limit cancels a
job or throws away its last validated complete result.
"""
from collections import Counter
import math

from shapely import affinity

from nesting_common import pack_material_boards, pack_one
from nest_uniform import pack_uniform_boards
from nest_replan import occupied_grid

MAX_REPAIR_SEARCHES = 32
MAX_DONORS = 6
MAX_RECEIVERS = 8
MAX_REPAIR_ROUNDS = 2
MAX_TEMPLATE_SEARCHES = 96
MAX_TEMPLATE_NEIGHBORHOODS = 12
# Integer costs are equivalent to 60% sheets / 40% cutting programs. Do not
# normalize each cost against its baseline: that changes the user's tradeoff.
SHEET_WEIGHT = 3
CUTTING_LAYOUT_WEIGHT = 2


def _round(value):
    """Match Math.round(value * 100) / 100, including negative coordinates."""
    return math.floor(float(value) * 100 + .5) / 100


class CuttingScore:
    """The UI's cutting identity, separate from printed-artwork template identity."""
    def __init__(self, srcs, origin=(0., 0.)):
        self.srcs = srcs
        self.origin = origin
        self.shape_ids = {}
        shapes = {}
        for source in srcs:
            # Keep the original point order. Shapely adds a closing vertex to
            # exterior.coords, so that representation is not the protocol key.
            points = source.get('polygon')
            if points is None:
                points = list(source['poly'].exterior.coords)[:-1]
            shape = (tuple((_round(x), _round(y)) for x, y in points),
                     _round(source['width']), _round(source['height']))
            if shape not in shapes:
                shapes[shape] = len(shapes)
            self.shape_ids[source['i']] = shapes[shape]
        self.frame_cache = {}
        self.board_cache = {}

    def board(self, board):
        ident = id(board)
        cached = self.board_cache.get(ident)
        if cached is not None and cached[0] is board:
            return cached[1:]
        entries = []
        left, top, right, bottom = math.inf, math.inf, -math.inf, -math.inf
        for placement in board:
            i, angle = placement['i'], placement['angle']
            source = self.srcs[i]
            frame_key = (i, angle)
            if frame_key not in self.frame_cache:
                self.frame_cache[frame_key] = affinity.rotate(source['frame'], angle, origin=(0, 0)).bounds
            min_x, min_y, max_x, max_y = self.frame_cache[frame_key]
            x, y = placement['tx'] + min_x, placement['ty'] + min_y
            entries.append((self.shape_ids[i], _round(x + self.origin[0]),
                            _round(y + self.origin[1]), _round(angle % 360)))
            left, top = min(left, x), min(top, y)
            right, bottom = max(right, placement['tx'] + max_x), max(bottom, placement['ty'] + max_y)
        key = tuple(sorted(entries))
        # Once sheet and cutting counts tie, a smaller occupied bounding area
        # leaves a larger contiguous edge remnant. It is only a tie-break proxy.
        footprint = max(0., right - left) * max(0., bottom - top) if board else 0.
        self.board_cache[ident] = (board, key, footprint)
        return key, footprint

    def score(self, boards):
        programs, footprint = set(), 0.
        for board in boards:
            key, area = self.board(board)
            programs.add(key)
            footprint += area
        sheets, layouts = len(boards), len(programs)
        return SHEET_WEIGHT * sheets + CUTTING_LAYOUT_WEIGHT * layouts, sheets, layouts, round(footprint, 7)

    def metrics(self, boards):
        score = self.score(boards)
        return dict(score=score[0], sheets=score[1], cuttingLayouts=score[2], occupiedEnvelope=score[3])


def _validate_complete(srcs, quantities, boards, validate):
    if not boards or any(not board for board in boards):
        raise ValueError('综合最少候选包含空板或未生成版面')
    actual = Counter()
    for board in boards:
        for placement in board:
            i = placement.get('i')
            if isinstance(i, bool) or not isinstance(i, int) or not 0 <= i < len(srcs):
                raise ValueError('综合最少候选引用无效的图片轮廓')
            if any(not math.isfinite(float(placement[key])) for key in ('angle', 'tx', 'ty')):
                raise ValueError('综合最少候选包含无效位置')
            actual[i] += 1
    if any(actual[i] != quantity for i, quantity in enumerate(quantities)):
        raise ValueError('综合最少候选未满足每款图片的完整 QT')
    validate(boards)


def _art_key(board):
    # Never let identical silhouettes mix the source inventories while choosing
    # repair trials; cutting equivalence is used only for the objective score.
    return tuple(sorted((p['i'], p['angle'], p['tx'], p['ty']) for p in board))


def _area(board, srcs):
    return sum(srcs[p['i']]['area'] for p in board)


def _template_groups(boards, indices=None):
    groups = {}
    for index in range(len(boards)) if indices is None else indices:
        groups.setdefault(_art_key(boards[index]), []).append(index)
    return list(groups.values())


def _donor_sets(boards, srcs):
    selected, seen = [], set()
    order = sorted(range(len(boards)), key=lambda index: (_area(boards[index], srcs), len(boards[index]), -index))
    for index in order:
        key = _art_key(boards[index])
        if key in seen:
            continue
        seen.add(key)
        selected.append(index)
        if len(selected) == MAX_DONORS:
            break
    # A two-sheet donor can remove a second cutting layout and make a move
    # worthwhile even when a single tail would split a repeated program.
    trials = [(index,) for index in selected[:3]]
    if len(order) >= 2:
        trials.append(tuple(order[:2]))
    trials.extend((index,) for index in selected[3:])
    return trials


def improve_occupied_boards(job, args, baseline, *, validate, origin=(0., 0.), progress=None,
                            max_searches=MAX_REPAIR_SEARCHES, diagnostics=None):
    """Try bounded true-shape tail transfers, retaining a validated full baseline."""
    srcs, bank, quantities = job['srcs'], job['bank'], job['quantities']
    _validate_complete(srcs, quantities, baseline, validate)
    scorer = CuttingScore(srcs, origin)
    best = baseline
    best_score = scorer.score(best)
    searches, accepted = 0, 0
    failures = []
    for round_index in range(MAX_REPAIR_ROUNDS):
        improved = False
        if len(best) < 2:
            break
        for donors in _donor_sets(best, srcs):
            if searches >= max_searches:
                break
            donor_set = set(donors)
            receiver_order = sorted(_template_groups(best, (index for index in range(len(best)) if index not in donor_set)),
                                    key=lambda indices: (_area(best[indices[0]], srcs), len(best[indices[0]]), indices[0]))[:MAX_RECEIVERS]
            if not receiver_order:
                continue
            for mode, order_mode in [('top', 'small'), ('low', 'large')]:
                if searches >= max_searches:
                    break
                remaining = [0] * len(srcs)
                for index in donors:
                    for placement in best[index]:
                        remaining[placement['i']] += 1
                candidate = list(best)
                failed = False
                for indices in receiver_order:
                    if not any(remaining) or searches >= max_searches:
                        break
                    index = indices[0]
                    fixed = candidate[index]
                    before = list(remaining)
                    searches += 1
                    if progress:
                        progress(f'综合优化第 {round_index + 1} 轮：将 {len(donors)} 块尾板的余量补入已有版式空隙（搜索 {searches}/{max_searches}）',
                                 searches, max_searches)
                    try:
                        occupancy = occupied_grid(srcs, fixed, args)
                        additions = pack_one(srcs, bank, remaining, args.board_width, args.board_height,
                                             args.gap, args.margin, args.resolution, args.seed + searches,
                                             mode, order_mode, max(1, args.lookahead),
                                             initial_occupancy=occupancy)
                        if additions:
                            touched = fixed + additions
                            validate([touched])
                            counts = Counter(p['i'] for p in additions)
                            repeat = min(len(indices), min(before[i] // count for i, count in counts.items()))
                            for i, count in counts.items():
                                remaining[i] -= count * (repeat - 1)
                            for receiving_index in indices[:repeat]:
                                candidate[receiving_index] = touched
                    except (Exception, SystemExit) as exc:
                        failures.append(str(exc))
                        remaining[:] = before
                        failed = True
                        break
                if failed or any(remaining):
                    continue
                candidate = [board for index, board in enumerate(candidate) if index not in donor_set]
                try:
                    _validate_complete(srcs, quantities, candidate, validate)
                except (Exception, SystemExit) as exc:
                    failures.append(str(exc))
                    continue
                candidate_score = scorer.score(candidate)
                if candidate_score < best_score:
                    best, best_score = candidate, candidate_score
                    improved = True
                    accepted += 1
                    if progress:
                        progress(f'已改进：{best_score[1]} 块板材 + {best_score[2]} 套切割布局，综合评分 {best_score[0]}', searches, max_searches)
                    break
            if improved:
                break
        if not improved or searches >= max_searches:
            break
    if diagnostics is not None:
        diagnostics.update(seededSearches=searches, acceptedRepairs=accepted, rejectedCandidates=len(failures), final=scorer.metrics(best))
    return best


def _template_neighborhoods(boards, srcs, board_area):
    """Destroy small subsets, including copies drawn from repeated templates.

    A scarce/one-off tail is combined with one to three copies of a repeatable
    layout. The rest of every repeated template remains untouched. This lets a
    few new programs absorb remainder products without fragmenting all copies.
    """
    groups = _template_groups(boards)
    tails = sorted(groups, key=lambda group: (len(group) > 1, _area(boards[group[0]], srcs), len(group)))[:4]
    repeats = sorted((group for group in groups if len(group) > 1), key=lambda group: -len(group))[:3]
    candidates = set()
    for left in range(len(tails)):
        for right in range(left + 1, len(tails)):
            candidates.add(tuple(sorted((tails[left][0], tails[right][0]))))
    for tail in tails:
        for group in repeats:
            if tail is group:
                continue
            for count in (1, 2, 3):
                if count <= len(group):
                    candidates.add(tuple(sorted([tail[0], *group[:count]])))
    for left in range(min(3, len(tails))):
        for right in range(left + 1, min(3, len(tails))):
            for group in repeats:
                indices = set([tails[left][0], tails[right][0], *group[:2]])
                if len(indices) > 2:
                    candidates.add(tuple(sorted(indices)))
            if len(repeats) >= 2:
                candidates.add(tuple(sorted({tails[left][0], tails[right][0], repeats[0][0], repeats[1][0]})))
    if len(tails) >= 3:
        three_tails = {group[0] for group in tails[:3]}
        candidates.add(tuple(sorted(three_tails)))
        for group in repeats:
            for count in (1, 2, 3):
                candidates.add(tuple(sorted(three_tails | set(group[:count]))))
    def measures(indices):
        area = sum(_area(boards[i], srcs) for i in indices)
        removed_programs = sum(all(i in indices for i in group) for group in groups)
        density = area / max(1, len(indices) - 1) / board_area
        return density, removed_programs
    # Favor both plausible physical density and few new programs. Using only
    # program count previously spent every slot on 85-96% density neighborhoods
    # while excluding much easier 70-75% neighborhoods with more repeat copies.
    measured = {indices: measures(indices) for indices in candidates if len(indices) > 1}
    eligible = [indices for indices, (density, _) in measured.items() if density <= 1 + 1e-7]
    queues = [
        sorted(eligible, key=lambda p: (measured[p][0], len(p), p)),
        sorted(eligible, key=lambda p: (len(p) - measured[p][1], measured[p][0], p)),
        sorted(eligible, key=lambda p: (-measured[p][1], measured[p][0], p)),
    ]
    selected = []
    while any(queues) and len(selected) < MAX_TEMPLATE_NEIGHBORHOODS:
        for queue in queues:
            while queue and queue[0] in selected:
                queue.pop(0)
            if queue and len(selected) < MAX_TEMPLATE_NEIGHBORHOODS:
                selected.append(queue.pop(0))
    return selected


def improve_template_boards(job, args, baseline, *, validate, origin=(0., 0.), progress=None,
                            max_searches=MAX_TEMPLATE_SEARCHES, diagnostics=None):
    """Release positions in a template neighborhood, repack, and commit atomically."""
    srcs, bank, quantities = job['srcs'], job['bank'], job['quantities']
    _validate_complete(srcs, quantities, baseline, validate)
    scorer = CuttingScore(srcs, origin)
    best, best_score = baseline, scorer.score(baseline)
    searches = accepted = rejected = complete_rejected = 0
    complete_scores = []
    improvements = []
    variants = [('top', 'large', 1, 1), ('top', 'large', 1, 2), ('bl', 'mixed', 2, 1), ('low', 'large', 2, 2)]
    while searches < max_searches and len(best) > 1:
        neighborhoods = _template_neighborhoods(best, srcs, args.board_width * args.board_height)
        improved = False
        for variant, (mode, order, lookahead, first_repeat) in enumerate(variants):
            for indices in neighborhoods:
                if searches >= max_searches:
                    break
                remaining = [0] * len(srcs)
                for index in indices:
                    for placement in best[index]:
                        remaining[placement['i']] += 1
                active_sources = [source for source in srcs if remaining[source['i']]]
                replacement = []
                failed = False
                # A candidate must remove at least one sheet. Running out of
                # variant work discards this candidate, never the full baseline.
                while any(remaining) and len(replacement) < len(indices) - 1 and searches < max_searches:
                    searches += 1
                    if progress:
                        progress(f'模板重组：释放 {len(indices)} 块板材的位置，第 {variant + 1} 种排列；尚余 {sum(remaining)} QT（搜索 {searches}/{max_searches}）', searches, max_searches)
                    before = list(remaining)
                    try:
                        trial = [quantity // first_repeat for quantity in remaining] if not replacement and first_repeat > 1 else list(remaining)
                        if not any(trial):
                            trial = list(remaining)
                        placed = pack_one(active_sources, bank, trial, args.board_width, args.board_height,
                                          args.gap, args.margin, args.resolution, args.seed + 1009 * variant,
                                          mode, order, lookahead)
                        if not placed:
                            failed = True
                            break
                        validate([placed])
                        counts = Counter(p['i'] for p in placed)
                        repeat = min(len(indices) - 1 - len(replacement), min(before[i] // count for i, count in counts.items()))
                        for i, count in counts.items():
                            remaining[i] -= count * repeat
                        replacement.extend([placed] * repeat)
                    except (Exception, SystemExit):
                        rejected += 1
                        failed = True
                        break
                if failed or any(remaining):
                    continue
                removed = set(indices)
                candidate = [board for i, board in enumerate(best) if i not in removed] + replacement
                try:
                    _validate_complete(srcs, quantities, candidate, validate)
                except (Exception, SystemExit):
                    rejected += 1
                    continue
                candidate_score = scorer.score(candidate)
                summary = candidate_score[:3]
                if summary not in complete_scores:
                    complete_scores.append(summary)
                if candidate_score < best_score:
                    best, best_score = candidate, candidate_score
                    accepted += 1
                    improved = True
                    improvements.append(dict(search=searches, releasedSheets=len(indices), replacementSheets=len(replacement),
                                             sheets=best_score[1], cuttingLayouts=best_score[2], score=best_score[0]))
                    if progress:
                        progress(f'模板重组已改进：{best_score[1]} 块板材，{best_score[2]} 套切割布局，综合评分 {best_score[0]}', searches, max_searches)
                    break
                complete_rejected += 1
            if improved or searches >= max_searches:
                break
        if not improved:
            break
    if diagnostics is not None:
        diagnostics.update(templateSearches=searches, acceptedTemplateRepairs=accepted,
                           rejectedTemplateCandidates=rejected, completeRejectedByCost=complete_rejected,
                           completeTemplateScores=complete_scores, templateImprovements=improvements, final=scorer.metrics(best))
    return best


def pack_combined_boards(job, args, progress=None, *, validate, origin=(0., 0.)):
    """Generate both real baselines, then seek a better legal 60:40 plan."""
    srcs, bank, quantities = job['srcs'], job['bank'], job['quantities']
    if not any(quantities):
        return []
    scorer = CuttingScore(srcs, origin)
    diagnostics = job.setdefault('combinedDiagnostics', {})
    diagnostics['weights'] = dict(sheets=SHEET_WEIGHT, cuttingLayouts=CUTTING_LAYOUT_WEIGHT)
    diagnostics['baselines'] = {}
    failures = []
    memory_pressure = False
    best, best_score = None, None
    total = sum(quantities)
    progress_done = 0

    def emit(detail, done):
        nonlocal progress_done
        # Trial quotas and alternative orders can revisit larger remaining
        # counts. Report the high-water mark within fixed search phases, not
        # an ETA or a count of final accepted production pieces.
        progress_done = max(progress_done, min(1000, int(done)))
        if progress:
            progress('搜索进度 · ' + detail, progress_done, 1000)

    for phase, strategy in enumerate(('uniform', 'material')):
        phase_start, phase_end = phase * 400, (phase + 1) * 400
        name = '切割方案优先基线' if strategy == 'uniform' else '节省板材基线'
        emit(f'{name}：{total} QT 待排，复用同一份轮廓缓存', phase_start)

        def report(board_or_template, repeat_or_attempt, count, remaining):
            if progress:
                if strategy == 'uniform':
                    detail = (f'{name}：第 {board_or_template + 1} 套方案，尝试复用 {repeat_or_attempt} 块；'
                              f'单板放入 {count} 张，尚余 {remaining} QT')
                else:
                    detail = (f'{name}：第 {board_or_template + 1} 块板材，第 {repeat_or_attempt} 次试排；'
                              f'本板放入 {count} 张，本轮尚余 {remaining} QT')
                examined = total - remaining
                if strategy == 'uniform':
                    # Uniform's in-search callback reports committed remaining
                    # demand, not the trial's decreasing quota. Give a trial
                    # partial credit so a large repeated first template moves
                    # the search indicator before that template is committed.
                    examined += .5 * min(remaining, count * repeat_or_attempt)
                fraction = max(0., min(1., examined / total))
                # Leave the last tick for validation of this complete baseline.
                emit(detail, phase_start + 399 * fraction)
        try:
            if strategy == 'uniform':
                candidate, _, _ = pack_uniform_boards(job, args, report)
            else:
                candidate = pack_material_boards(srcs, bank, quantities, args, progress=report)
            _validate_complete(srcs, quantities, candidate, validate)
            candidate_score = scorer.score(candidate)
            diagnostics['baselines'][strategy] = scorer.metrics(candidate)
            if best_score is None or candidate_score < best_score:
                best, best_score = candidate, candidate_score
            emit(f'{name}已完成并校验：{candidate_score[1]} 块板材，{candidate_score[2]} 套切割布局，尚余 0 QT', phase_end)
        except (Exception, SystemExit) as exc:
            failures.append(strategy + ': ' + str(exc))
            # Remember only the error kind. Retaining an exception/traceback
            # here would also retain its large mask and search-buffer frames.
            memory_pressure = memory_pressure or isinstance(exc, MemoryError)
            next_step = '继续计算节省板材基线' if phase == 0 else ('继续使用已验证的可行基线' if best is not None else '未找到可用基线')
            emit(f'{name}未形成合法结果；{next_step}', phase_end)
    if best is None:
        if memory_pressure:
            # The adapter retries the entire demand with a 1 mm shared bank.
            # Do not turn recoverable memory pressure into a permanent error.
            raise MemoryError('综合最少基线搜索内存不足：' + '; '.join(failures))
        raise ValueError('综合最少未得到完整合法基线：' + '; '.join(failures))
    if failures:
        diagnostics['baselineFailures'] = failures
    emit(f'尾板补排：从 {best_score[1]} 块板材、{best_score[2]} 套切割布局开始，所有 {total} QT 已有合法位置', 800)

    def repair_report(detail, done, count):
        emit(detail, 800 + 79 * done / max(1, count))

    best = improve_occupied_boards(job, args, best, validate=validate, origin=origin,
                                   progress=repair_report if progress else None, diagnostics=diagnostics)
    emit('模板重组：释放少量尾板与重复模板的位置，再比较完整方案', 880)
    best = improve_template_boards(job, args, best, validate=validate, origin=origin,
                                  progress=(lambda detail, done, count: emit(detail, 880 + 119 * done / max(1, count))) if progress else None,
                                  diagnostics=diagnostics)
    _validate_complete(srcs, quantities, best, validate)
    final_score = scorer.score(best)
    emit(f'综合搜索完成：{final_score[1]} 块板材，{final_score[2]} 套切割布局，尚余 0 QT，已通过间距与数量校验', 1000)
    return best
