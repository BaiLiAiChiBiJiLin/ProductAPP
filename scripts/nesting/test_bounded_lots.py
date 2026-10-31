"""Prune only a losing greedy lot prefix, retaining every other candidate."""
from collections import Counter
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'src-tauri/src/imposition/local_nesting'))
import nesting_common as common
import nest_repeat_lots as lots
from shapely.geometry import box


def source(index):
    shape = box(0, 0, 10, 10)
    return dict(i=index, width=10, height=10, area=100, poly=shape, frame=shape)


def piece(index, x=0):
    return dict(i=index, angle=0, tx=x, ty=0)


def arguments():
    return SimpleNamespace(board_width=100, board_height=50, gap=3, margin=0,
                           resolution=.5, runs=2, lookahead=1, seed=0)


def fixed_capacity(capacity):
    def pack(_sources, _bank, remaining, *_args, **_kwargs):
        placed = []
        for index in range(len(remaining)):
            while remaining[index] and len(placed) < capacity:
                placed.append(piece(index, 13 * len(placed)))
                remaining[index] -= 1
        return placed
    return pack


class BoundedLotTests(unittest.TestCase):
    def test_unbounded_default_keeps_all_boards_and_input_quantities(self):
        quantities = [3, 2]
        sources, args = [source(0), source(1)], arguments()
        with patch.object(common, 'pack_one', side_effect=fixed_capacity(2)) as search:
            result = common.pack_material_boards(sources, {}, quantities, args)
        self.assertEqual(len(result), 3)
        self.assertEqual(search.call_count, args.runs + 6)
        self.assertEqual(Counter(p['i'] for board in result for p in board), {0: 3, 1: 2})
        self.assertEqual(quantities, [3, 2])
        self.assertTrue(lots._valid(dict(srcs=sources, quantities=quantities), args, result))

    def test_full_quantity_at_exact_cap_matches_unbounded_candidate(self):
        sources, quantities, args = [source(0), source(1)], [3, 2], arguments()
        with patch.object(common, 'pack_one', side_effect=fixed_capacity(2)):
            expected = common.pack_material_boards(sources, {}, quantities, args)
        with patch.object(common, 'pack_one', side_effect=fixed_capacity(2)) as search:
            actual = common.pack_material_boards(sources, {}, quantities, args, max_sheets=3)
        self.assertEqual(actual, expected)
        self.assertEqual(search.call_count, args.runs + 6)
        self.assertEqual(quantities, [3, 2])

    def test_cap_with_remaining_demand_stops_before_any_next_board_search(self):
        sources, quantities, args = [source(0), source(1)], [3, 2], arguments()
        with patch.object(common, 'pack_one', side_effect=fixed_capacity(2)) as search:
            result = common.pack_material_boards(sources, {}, quantities, args, max_sheets=2)
        self.assertIsNone(result)  # An incomplete prefix must never look complete.
        self.assertEqual(search.call_count, args.runs + 3)
        self.assertEqual(quantities, [3, 2])

    def test_zero_cap_skips_search_but_accepts_empty_demand(self):
        args = arguments()
        with patch.object(common, 'pack_one') as search:
            self.assertIsNone(common.pack_material_boards([source(0)], {}, [1], args, max_sheets=0))
            self.assertEqual(common.pack_material_boards([source(0)], {}, [0], args, max_sheets=0), [])
        search.assert_not_called()

    def test_cap_rejects_non_integer_or_negative_limits(self):
        for cap in (-1, 1.5):
            with self.subTest(cap=cap), patch.object(common, 'pack_one') as search:
                with self.assertRaisesRegex(ValueError, 'max_sheets'):
                    common.pack_material_boards([source(0)], {}, [1], arguments(), max_sheets=cap)
                search.assert_not_called()

    def test_pruned_ordinary_lot_still_accepts_a_complete_repeated_subpattern(self):
        sources, args = [source(0)], arguments()
        quantities = [8]
        job = dict(srcs=sources, bank={}, quantities=quantities)
        baseline = [[piece(0, shift), piece(0, shift + 13)] for shift in (0, 1)]
        baseline += [[piece(0, shift)] for shift in (2, 3, 4, 5)]
        self.assertTrue(lots._valid(job, args, baseline))
        repeated_board = [piece(0), piece(0, 13)]
        subpattern = [repeated_board, repeated_board]
        with patch.object(lots, '_candidates', return_value=[(2, [4])]), \
                patch.object(common, 'pack_one', side_effect=fixed_capacity(1)) as search, \
                patch.object(lots, 'repeated_pattern_lots', return_value=iter([(subpattern, {})])) as patterns:
            result = lots.improve_repeated_lots(job, args, baseline)
        self.assertEqual(search.call_count, 6 + 3 * 2)  # No fourth greedy board.
        patterns.assert_called_once()
        self.assertEqual(patterns.call_args.args[2], [4])
        self.assertEqual(len(result), 4)
        self.assertEqual(Counter(p['i'] for board in result for p in board), {0: 8})
        self.assertEqual(quantities, [8])
        self.assertTrue(lots._valid(job, args, result))
        diagnostics = job['repeatDiagnostics']
        self.assertTrue(diagnostics['candidates'][0]['materialPruned'])
        self.assertEqual(diagnostics['candidates'][0]['lotSheetsAtLeast'], 4)
        self.assertEqual(diagnostics['after'], dict(sheets=4, layouts=1))


if __name__ == '__main__':
    unittest.main()
