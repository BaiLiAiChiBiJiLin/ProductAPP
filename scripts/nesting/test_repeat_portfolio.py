"""Anonymous QT-period template candidates, global inventory and context lifetime."""
from collections import Counter
import contextlib
import io
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'src-tauri/src/imposition/local_nesting'))
import nest_repeat_portfolio as portfolio
from nesting_rust import MaskBank
from shapely.geometry import box


def source(index, width=10):
    poly = box(0, 0, width, 10)
    return dict(i=index, id=f'anonymous-{index}', quantity=999, area=poly.area,
                width=width, height=10, frame=poly, poly=poly)


def piece(index, x=0, y=0):
    return dict(i=index, angle=0, tx=x, ty=y)


def arguments():
    return SimpleNamespace(board_width=80, board_height=50, gap=3, margin=0,
                           resolution=.5, runs=3, lookahead=1, seed=0)


class PortfolioTests(unittest.TestCase):
    def test_distinct_qt_periods_can_reuse_anonymous_templates_without_replacing_full_mix(self):
        srcs = [source(0), source(1, 12), source(2, 20)]
        quantities = [4, 4, 6]
        # Complete valid mixed-search incumbent, but seven different cutting layouts.
        baseline = [[piece(0, shift), piece(1, 13 + shift)] for shift in range(4)]
        baseline += [[piece(2, shift), piece(2, 23 + shift)] for shift in range(3)]
        bank = MaskBank({i: [object()] for i in range(3)})
        self.addCleanup(bank.close)
        job = dict(srcs=srcs, bank=bank, quantities=quantities)
        children = []
        def solve(child, _args, progress):
            children.append(child)
            self.assertEqual([s['i'] for s in child['srcs']], list(range(len(child['srcs']))))
            self.assertEqual([s['quantity'] for s in child['srcs']], child['quantities'])
            if child['quantities'] == [4, 4]:
                boards = [[piece(0), piece(1, 13)]] * 4
            else:
                self.assertEqual(child['quantities'], [6])
                boards = [[piece(0), piece(0, 23)]] * 3
            return boards, [], []
        with patch.object(portfolio, '_solve_uniform', side_effect=solve), \
                patch.object(portfolio, '_insert_tails', return_value=baseline) as insert:
            result = portfolio.improve_repeat_portfolio(job, arguments(), baseline)
        self.assertEqual(Counter(p['i'] for board in result for p in board), {0: 4, 1: 4, 2: 6})
        self.assertEqual(len(result), 7)
        self.assertEqual(job['portfolioDiagnostics']['after']['layouts'], 2)
        self.assertEqual(len(children), 2)  # Complementary divisor masks are one candidate.
        self.assertTrue(all(child['_repeatPortfolioDepth'] == 1 for child in children))
        self.assertTrue(all(child['bank'][i] is bank[original]
                            for child in children for i, original in enumerate(child['_globalSourceIndexes'])))
        self.assertFalse(hasattr(bank, '_active_child_bank'))
        self.assertEqual(len(bank._child_core_status), 2)
        self.assertEqual(quantities, [4, 4, 6])
        self.assertIs(insert.call_args.args[0], job)
        self.assertEqual(len(insert.call_args.args[3]), len(srcs))

    def test_same_cutting_shape_keeps_distinct_artwork_quantities_and_sparse_global_indexes(self):
        srcs = [source(i) for i in range(4)]
        bank = MaskBank({i: [object()] for i in range(4)})
        self.addCleanup(bank.close)
        job = dict(srcs=srcs, bank=bank, quantities=[0, 4, 0, 6])
        baseline = [[piece(i, n), piece(i, n + 13)] for i, qty in ((1, 4), (3, 6))
                    for n in range(qty // 2)]
        def solve(child, *_args):
            self.assertEqual(len(child['srcs']), 1)
            return [[piece(0), piece(0, 13)]] * (child['quantities'][0] // 2), [], []
        with patch.object(portfolio, '_solve_uniform', side_effect=solve), \
                patch.object(portfolio, '_insert_tails', return_value=baseline):
            result = portfolio.improve_repeat_portfolio(job, arguments(), baseline)
        self.assertEqual(Counter(p['i'] for board in result for p in board), {1: 4, 3: 6})
        self.assertEqual(job['portfolioDiagnostics']['after']['layouts'], 1)

    def test_child_context_is_closed_on_failure_and_complete_baseline_is_preserved(self):
        bank = MaskBank({0: [object()], 1: [object()]})
        self.addCleanup(bank.close)
        job = dict(srcs=[source(0), source(1, 12)], bank=bank, quantities=[2, 3])
        baseline = [[piece(0)]] * 2 + [[piece(1)]] * 3
        class Context:
            closed = False
            def close(self):
                self.closed = True
        context = Context()
        def fail(child, *_args):
            child['bank']._native_context = context
            raise MemoryError('injected pressure')
        with patch.object(portfolio, '_solve_uniform', side_effect=fail), \
                patch.object(portfolio, '_insert_tails') as insert:
            result = portfolio.improve_repeat_portfolio(job, arguments(), baseline)
        self.assertIs(result, baseline)
        self.assertTrue(context.closed)
        self.assertFalse(hasattr(bank, '_active_child_bank'))
        insert.assert_not_called()

    def test_one_period_and_recursive_calls_do_not_launch_optional_search(self):
        job = dict(srcs=[source(0), source(1)], bank=MaskBank(), quantities=[6, 6])
        baseline = [[piece(0), piece(1, 13)]] * 6
        with patch.object(portfolio, '_solve_uniform') as solve:
            self.assertIs(portfolio.improve_repeat_portfolio(job, arguments(), baseline), baseline)
            job.update(quantities=[4, 6], _repeatPortfolioDepth=1)
            self.assertIs(portfolio.improve_repeat_portfolio(job, arguments(), baseline), baseline)
        solve.assert_not_called()

    def test_optional_candidate_count_and_order_budget_are_shared_between_compact_searches(self):
        srcs = [source(i, 10 + i) for i in range(4)]
        quantities = [4, 6, 8, 10]
        job = dict(srcs=srcs, bank=MaskBank({i: [object()] for i in range(4)}), quantities=quantities)
        baseline = [[piece(i, n)] for i, quantity in enumerate(quantities) for n in range(quantity)]
        budgets = []
        def solve(child, *_args):
            state = child['bank']._repeat_order_search
            budgets.append(state['remaining'])
            state['remaining'] -= 7
            return [[piece(i)] for i, quantity in enumerate(child['quantities'])
                    for _ in range(quantity)], [], []
        supports = [((0, 1), (2, 3), 2), ((0, 2), (1, 3), 3)]
        with patch.object(portfolio, '_supports', return_value=supports), \
                patch.object(portfolio, '_solve_uniform', side_effect=solve), \
                patch.object(portfolio, '_insert_tails', return_value=baseline):
            result = portfolio.improve_repeat_portfolio(job, arguments(), baseline)
        self.assertTrue(portfolio._valid(job, arguments(), result))
        self.assertEqual(budgets, [portfolio.MAX_ORDER_TRIALS - 7 * index for index in range(4)])
        self.assertEqual(job['portfolioDiagnostics']['componentSolves'], 4)
        self.assertEqual(job['portfolioDiagnostics']['orderTrials'], 28)

    def test_incomplete_child_inventory_cannot_replace_complete_mixed_plan(self):
        job = dict(srcs=[source(0), source(1, 12)], bank=MaskBank({0: [], 1: []}), quantities=[4, 6])
        baseline = [[piece(0)]] * 4 + [[piece(1)]] * 6
        with patch.object(portfolio, '_solve_uniform', return_value=([[piece(0)]], [], [])), \
                patch.object(portfolio, '_insert_tails') as repair:
            self.assertIs(portfolio.improve_repeat_portfolio(job, arguments(), baseline), baseline)
        repair.assert_not_called()

    def test_global_tail_can_win_even_when_the_unmixed_inventory_is_worse_than_baseline(self):
        srcs, quantities = [source(0), source(1, 40)], [6, 2]
        args = arguments()
        args.board_width, args.board_height = 100, 60
        job = dict(srcs=srcs, bank=MaskBank({0: [object()], 1: [object()]}), quantities=quantities)
        baseline = [[piece(1, shift), *[piece(0, shift + 13 * index, 13) for index in range(3)]]
                    for shift in (0, 1)]
        winner = [[piece(1), piece(1, 43),
                   *[piece(0, 13 * column, 13 + 13 * row) for row in range(2) for column in range(3)]]]
        def solve(child, *_args):
            if child['_globalSourceIndexes'] == (1,):
                return [[piece(0), piece(0, 43)]], [], []
            return [[piece(0), piece(0, 13)]] * 3, [], []
        self.assertTrue(portfolio._valid(job, args, baseline))
        self.assertTrue(portfolio._valid(job, args, winner))
        with patch.object(portfolio, '_solve_uniform', side_effect=solve), \
                patch.object(portfolio, '_insert_tails', return_value=winner) as repair:
            result = portfolio.improve_repeat_portfolio(job, args, baseline)
        self.assertIs(result, winner)
        self.assertEqual(job['portfolioDiagnostics']['candidates'][0]['sheets'], 4)
        self.assertFalse(job['portfolioDiagnostics']['candidates'][0].get('accepted', False))
        self.assertEqual(job['portfolioDiagnostics']['after'], dict(sheets=1, layouts=1))
        self.assertEqual(repair.call_count, 1)
        self.assertEqual(len(repair.call_args.args[2]), 1)
        self.assertEqual(repair.call_args.args[3], [6, 0])

    def test_real_anonymous_shapes_can_mix_across_qt_periods_after_inventory_search(self):
        from nesting_common import make_masks
        from nesting_rust import core_status
        srcs = [source(0), source(1, 12), source(2, 20)]
        quantities = [4, 4, 6]
        args = arguments()
        args.board_width, args.board_height = 120, 60
        baseline = [[piece(0, shift), piece(1, 13 + shift)] for shift in range(4)]
        baseline += [[piece(2, shift), piece(2, 23 + shift)] for shift in range(3)]
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(os.environ, PRINTFLOW_NESTING_THREADS='1'), \
                contextlib.redirect_stderr(io.StringIO()):
            folder = Path(directory)
            for item in srcs:
                filename = folder / (item['id'] + '.svg')
                filename.write_text(item['poly'].wkt, encoding='utf-8')
                item.update(file=filename, name=item['id'])
            with make_masks(srcs, folder, args.resolution, [0, 90, 180, 270], args.gap) as bank:
                job = dict(srcs=srcs, bank=bank, quantities=quantities)
                result = portfolio.improve_repeat_portfolio(job, args, baseline)
                self.assertTrue(portfolio._valid(job, args, result))
                self.assertEqual(Counter(p['i'] for board in result for p in board), {0: 4, 1: 4, 2: 6})
                self.assertLessEqual(len(result), 2)
                self.assertEqual(job['portfolioDiagnostics']['tailRepairs'], 1)
                self.assertTrue(any(len({p['i'] for p in board}) == 3 for board in result))
                self.assertFalse(hasattr(bank, '_active_child_bank'))
                self.assertGreater(core_status(bank).get('rust_calls', 0) + core_status(bank).get('python_calls', 0), 0)

    def test_real_uniform_baseline_improves_with_different_qt_periods(self):
        from nesting_common import make_masks
        from nest_uniform import pack_uniform_boards
        from nest_combined import CuttingScore
        quantities = [8, 8, 12, 12]
        dimensions = [(15, 14), (12, 11), (15, 8), (14, 8)]
        args = arguments()
        args.board_width, args.board_height, args.resolution = 55, 45, 1
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(os.environ, PRINTFLOW_NESTING_THREADS='1'), \
                contextlib.redirect_stderr(io.StringIO()):
            folder, srcs = Path(directory), []
            for index, (width, height) in enumerate(dimensions):
                poly = box(0, 0, width, height)
                name = f'anonymous-piece-{index}'
                filename = folder / (name + '.txt')
                filename.write_text(poly.wkt, encoding='utf-8')
                srcs.append(dict(i=index, id=name, name=name, file=filename, width=width,
                                 height=height, frame=poly, poly=poly, area=poly.area,
                                 quantity=quantities[index]))
            with make_masks(srcs, folder, args.resolution, [0, 90, 180, 270], args.gap) as bank:
                job = dict(srcs=srcs, bank=bank, quantities=quantities, _repeatPortfolioDepth=1)
                # Disable only this optional stage to run the real previous
                # uniform + repeated-lot algorithm, without mocked placements.
                baseline = pack_uniform_boards(job, args)[0]
                scorer = CuttingScore(srcs)
                self.assertEqual(scorer.score(baseline)[1:3], (5, 4))
                job.pop('_repeatPortfolioDepth')
                result = portfolio.improve_repeat_portfolio(job, args, baseline)
                self.assertEqual(scorer.score(result)[1:3], (4, 2))
                self.assertTrue(portfolio._valid(job, args, result))
                self.assertEqual(Counter(p['i'] for board in result for p in board),
                                 {i: quantity for i, quantity in enumerate(quantities)})


if __name__ == '__main__':
    unittest.main()
