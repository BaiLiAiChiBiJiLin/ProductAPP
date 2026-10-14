"""Regression checks for bounded collision search and OpenCV OOM recovery."""
import unittest
from unittest.mock import patch
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'src-tauri/src/imposition/local_nesting'))

import cv2
import numpy as np

from nesting_common import _first_legal_position


class CollisionMemoryTests(unittest.TestCase):
    def test_matches_full_search(self):
        rng = np.random.default_rng(42)
        for _ in range(20):
            occ = (rng.random((37, 43)) < .05).astype(np.uint8)
            mask = (rng.random((7, 9)) < .5).astype(np.uint8)
            expected = np.argwhere(cv2.matchTemplate(occ, mask, cv2.TM_CCORR) < .5)
            expected = tuple(map(int, expected[0][::-1])) if len(expected) else None
            self.assertEqual(_first_legal_position(occ, mask), expected)

    def test_strips_include_boundary_positions(self):
        occ = np.ones((220, 900), dtype=np.uint8)
        mask = np.ones((5, 7), dtype=np.uint8)
        occ[73:78, 13:20] = 0
        self.assertEqual(_first_legal_position(occ, mask), (13, 73))

    def test_recovers_from_opencv_allocation_failure(self):
        occ = np.ones((12, 15), dtype=np.uint8)
        mask = np.ones((3, 4), dtype=np.uint8)
        occ[7:10, 8:12] = 0
        error = cv2.error(-4, 'matchTemplate', 'Insufficient memory', '', 0)
        error.code = -4
        with patch('nesting_common.cv2.matchTemplate', side_effect=error):
            self.assertEqual(_first_legal_position(occ, mask), (8, 7))

    def test_other_opencv_errors_are_not_hidden(self):
        error = cv2.error(-215, 'matchTemplate', 'Invalid input', '', 0)
        error.code = -215
        with patch('nesting_common.cv2.matchTemplate', side_effect=error):
            with self.assertRaises(cv2.error):
                _first_legal_position(np.zeros((10, 10), np.uint8), np.ones((3, 3), np.uint8))


if __name__ == '__main__':
    unittest.main()
