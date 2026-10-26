"""Repeated-subtemplate quantities, pruning, failure isolation and real geometry."""
import contextlib
from collections import Counter
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'src-tauri/src/imposition/local_nesting'))
import nest_repeat_patterns as patterns
import nest_repeat_lots as lots
from shapely.geometry import box


def source(index=0):
    geometry = box(0, 0, 10, 10)
    return dict(i=index, area=100, width=10, height=10, poly=geometry, frame=geometry)


def placement(x=0, index=0):
    return dict(i=index, angle=0, tx=x, ty=0)


def arguments():
    return SimpleNamespace(board_width=100, board_height=50, gap=3, margin=0,
                           resolution=.5, runs=6, lookahead=4, seed=0)


class PatternSearchTests(unittest.TestCase):
    def test_repeated_head_preserves_exact_unequal_quantities_and_caches_tail(self):
        bank = object()
        job = dict(srcs=[source(0), source(1)], bank=bank)
        quota = [5, 7]
        # Identical demand residuals from different orientations must not trigger
        # another full remainder search. Distinct artwork still counts separately.
        head = [placement(0), placement(13, 1)]
        tail = [[placement(i * 13, 0 if i < 3 else 1) for i in range(7)],
                [placement(0, 1)]]
        diagnostics = {}
        with patch.object(patterns, 'FACTORS', (2,)), \
                patch.object(patterns, 'pack_one', return_value=head) as one, \
                patch.object(patterns, 'optimize_near_full_board', return_value=None), \
                patch.object(patterns, 'pack_material_boards', return_value=tail) as material:
            candidates = list(patterns.repeated_pattern_lots(job, arguments(), quota, lambda: 4, diagnostics))
        self.assertEqual(len(candidates), len(patterns.VARIANTS) * 2)
        self.assertEqual(material.call_count, 1)
        self.assertEqual(diagnostics['cacheHits'], len(patterns.VARIANTS) * 2 - 1)
        self.assertEqual(quota, [5, 7])
        for lot, _ in candidates:
            self.assertIs(lot[0], lot[1])
            self.assertEqual(Counter(p['i'] for board in lot for p in board), {0: 5, 1: 7})
        self.assertTrue(all(call.args[1] is bank for call in one.call_args_list))

    def test_area_bound_and_live_sheet_limit_avoid_impossible_branches(self):
        job = dict(srcs=[source()], bank=object())
        args = arguments()
        diagnostics = {}
        with patch.object(patterns, 'pack_one') as one:
            self.assertEqual(list(patterns.repeated_pattern_lots(job, args, [500], lambda: 4, diagnostics)), [])
        one.assert_not_called()
        self.assertEqual(diagnostics['areaPruned'], 1)
        limit = [4]
        with patch.object(patterns, 'pack_one', return_value=[placement()]) as one, \
                patch.object(patterns, 'pack_material_boards', return_value=[[placement()]]) as material:
            candidates = patterns.repeated_pattern_lots(job, args, [3], lambda: limit[0], {})
            self.assertEqual(len(next(candidates)[0]), 3)
            limit[0] = 1
            self.assertEqual(list(candidates), [])
        self.assertEqual(one.call_count, 1)
        self.assertEqual(material.call_count, 1)

    def test_unavoidable_quantity_remainder_prunes_before_single_board_search(self):
        job = dict(srcs=[source()], bank=object())
        diagnostics = {}
        # Five copies cannot be covered by two identical boards: at least one
        # copy must remain even when both first boards hold their full quota.
        # The overall area fits, so only the new remainder bound rejects this.
        with patch.object(patterns, 'pack_one') as one, \
                patch.object(patterns, 'pack_material_boards') as material:
            candidates = list(patterns.repeated_pattern_lots(job, arguments(), [5], lambda: 2, diagnostics))
        self.assertEqual(candidates, [])
        one.assert_not_called()
        material.assert_not_called()
        self.assertEqual(diagnostics['trials'], 0)
        self.assertEqual(diagnostics['areaPruned'], 1)

    def test_optional_memory_pressure_preserves_complete_valid_baseline(self):
        args = arguments()
        baseline = [[placement(index)] for index in range(8)]
        ordinary_lot = [[placement(index)] for index in range(4)]
        for failure, reason in [(MemoryError(), 'memory-pressure-preserved-complete-plan'),
                                (SystemExit('No remaining item fits; try a smaller gap or finer resolution'),
                                 'tail-does-not-fit-preserved-complete-plan')]:
            with self.subTest(failure=type(failure).__name__):
                job = dict(srcs=[source()], bank=object(), quantities=[8])
                with patch.object(lots, '_candidates', return_value=[(2, [4])]), \
                        patch.object(lots, 'pack_material_boards', return_value=ordinary_lot), \
                        patch.object(lots, 'repeated_pattern_lots', side_effect=failure):
                    result = lots.improve_repeated_lots(job, args, baseline)
                self.assertEqual(len(result), 8)
                self.assertTrue(lots._valid(job, args, result))
                self.assertEqual(job['repeatDiagnostics']['candidates'][0]['subpatterns']['stopped'], reason)
        with patch.object(lots, '_candidates', return_value=[(2, [4])]), \
                patch.object(lots, 'pack_material_boards', return_value=ordinary_lot), \
                patch.object(lots, 'repeated_pattern_lots', side_effect=ValueError('invalid quantity')):
            with self.assertRaisesRegex(ValueError, 'invalid quantity'):
                lots.improve_repeated_lots(job, args, baseline)

    def test_invalid_subtemplate_is_rejected_and_quantity_errors_are_not_hidden(self):
        job = dict(srcs=[source()], bank=object(), quantities=[8])
        args = arguments()
        baseline = [[placement(index)] for index in range(8)]
        ordinary_lot = [[placement(index)] for index in range(4)]
        invalid = [[placement(), placement(1)]] * 2  # Exact QT, but overlapping contours.
        with patch.object(lots, '_candidates', return_value=[(2, [4])]), \
                patch.object(lots, 'pack_material_boards', return_value=ordinary_lot), \
                patch.object(lots, 'repeated_pattern_lots', return_value=iter([(invalid, {})])):
            result = lots.improve_repeated_lots(job, args, baseline)
        self.assertEqual(len(result), 8)
        self.assertTrue(lots._valid(job, args, result))
        with patch.object(patterns, 'pack_one', return_value=[placement()] * 3):
            with self.assertRaisesRegex(ValueError, 'exceeds the lot quantity'):
                list(patterns.repeated_pattern_lots(job, args, [4], lambda: 4, {}))


class PatternGeometryTests(unittest.TestCase):
    def test_anonymous_mixed_outlines_find_repeated_subpatterns_at_exact_gap(self):
        import local_tools_engine as engine
        from test_combined_nesting import CombinedNestingTests
        req = json.loads((Path(__file__).parent / 'fixtures/repeated-subpatterns.json').read_text(encoding='utf-8'))
        with tempfile.TemporaryDirectory() as cache, contextlib.redirect_stderr(io.StringIO()), \
                patch.dict(os.environ, PRINTFLOW_NESTING_THREADS='1'):
            result = engine.solve(req, cache_dir=cache)
        self.assertLessEqual(result['sheetsUsed'], 8)
        self.assertEqual(len(result['placements']), 190)
        pages = {}
        for p in result['placements']:
            pages.setdefault(p['sheetIndex'], []).append(
                (p['id'].split('#qt-')[0], p['xMm'], p['yMm'], p['rotationDeg']))
        self.assertLessEqual(len({tuple(sorted(page)) for page in pages.values()}), 3)
        self.assertFalse(result['unplaced'])
        self.assertFalse(result['excludedItems'])
        CombinedNestingTests().verify(req, result)

    def test_equal_quantities_find_two_complementary_programs_without_saved_quotas(self):
        import local_tools_engine as engine
        from test_combined_nesting import CombinedNestingTests
        req = json.loads((Path(__file__).parent / 'fixtures/repeated-subpatterns.json').read_text(encoding='utf-8'))
        # Scale all demands equally: the planner must derive complementary
        # quotas from these anonymous shapes, rather than import a saved plan.
        for item in req['items']:
            item['quantity'] = 8
        with tempfile.TemporaryDirectory() as cache, contextlib.redirect_stderr(io.StringIO()), \
                patch.dict(os.environ, PRINTFLOW_NESTING_THREADS='1'):
            result = engine.solve(req, cache_dir=cache)
        self.assertLessEqual(result['sheetsUsed'], 6)
        self.assertEqual(len(result['placements']), 144)
        pages = {}
        for p in result['placements']:
            pages.setdefault(p['sheetIndex'], []).append(
                (p['id'].split('#qt-')[0], p['xMm'], p['yMm'], p['rotationDeg']))
        self.assertLessEqual(len({tuple(sorted(page)) for page in pages.values()}), 2)
        self.assertFalse(result['unplaced'])
        self.assertFalse(result['excludedItems'])
        CombinedNestingTests().verify(req, result)


if __name__ == '__main__':
    unittest.main()
