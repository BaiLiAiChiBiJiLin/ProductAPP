import unittest
from unittest.mock import patch

from test_repeat_patterns import arguments, source, placement
import nest_order_search as search
from nesting_rust import MaskBank


class OrderSearchTests(unittest.TestCase):
    def test_far_or_over_area_quotas_do_not_consume_search_budget(self):
        job = dict(srcs=[source()], bank=MaskBank())
        with patch.object(search, 'pack_one') as pack:
            self.assertIsNone(search.optimize_near_full_board(job, arguments(), [4], [placement()], {}))
            args = arguments()
            args.board_width = args.board_height = 10
            self.assertIsNone(search.optimize_near_full_board(job, args, [2], [placement()], {}))
        pack.assert_not_called()
        self.assertFalse(hasattr(job['bank'], '_repeat_order_search'))

    def test_success_uses_original_geometry_input_order_and_cached_quota(self):
        sources = [source(0), source(1)]
        job = dict(srcs=sources, bank=MaskBank())
        answer = [placement(), placement(13, 1)]
        def pack(srcs, bank, remaining, *args):
            self.assertTrue(all(s is sources[s['i']] for s in srcs))
            self.assertEqual([s['area'] for s in srcs], [100, 100])
            self.assertIs(bank, job['bank'])
            self.assertEqual(args[-2], 'input')
            remaining[:] = [0, 0]
            return answer
        with patch.object(search, 'pack_one', side_effect=pack) as run:
            first = search.optimize_near_full_board(job, arguments(), [1, 1], answer[:1], {})
            second = search.optimize_near_full_board(job, arguments(), [1, 1], answer[:1], {})
        self.assertIs(first, answer)
        self.assertIs(second, first)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(job['bank']._repeat_order_search['remaining'], search.MAX_JOB_TRIALS - 1)

    def test_shared_bank_caps_budget_across_groups_and_new_solve_starts_fresh(self):
        bank = MaskBank()
        first = dict(srcs=[source()], bank=bank)
        second = dict(srcs=[source()], bank=bank)
        with patch.object(search, 'MAX_JOB_TRIALS', 5), patch.object(search, 'MAX_QUOTA_TRIALS', 3), \
                patch.object(search, 'pack_one', return_value=[]) as run:
            self.assertIsNone(search.optimize_near_full_board(first, arguments(), [2], [placement()], {}))
            self.assertIsNone(search.optimize_near_full_board(second, arguments(), [2], [placement()], {}))
            self.assertEqual(run.call_count, 3)  # Exhausted quota is cached across groups.
            self.assertIsNone(search.optimize_near_full_board(second, arguments(), [3], [placement()], {}))
            self.assertEqual(run.call_count, 5)
            self.assertEqual(bank._repeat_order_search['remaining'], 0)
            fresh = dict(srcs=[source()], bank=MaskBank())
            search.optimize_near_full_board(fresh, arguments(), [2], [placement()], {})
            self.assertEqual(run.call_count, 8)

    def test_invalid_full_geometry_is_rejected_and_progress_is_reported(self):
        job = dict(srcs=[source()], bank=MaskBank())
        events = []
        def overlap(srcs, bank, remaining, *args):
            remaining[:] = [0]
            return [placement(), placement(1)]
        with patch.object(search, 'MAX_QUOTA_TRIALS', 12), patch.object(search, 'pack_one', side_effect=overlap):
            result = search.optimize_near_full_board(job, arguments(), [2], [placement()], {},
                                                    lambda *event: events.append(event))
        self.assertIsNone(result)
        self.assertGreaterEqual(len(events), 2)
        self.assertEqual(events[0][1], 1)
        self.assertEqual(events[-1][1], 9)

    def test_invalid_quantity_is_not_silently_treated_as_search_failure(self):
        with self.assertRaisesRegex(ValueError, 'exceeds'):
            search.optimize_near_full_board(dict(srcs=[source()], bank=MaskBank()), arguments(),
                                            [1], [placement(), placement(13)], {})


if __name__ == '__main__':
    unittest.main()
