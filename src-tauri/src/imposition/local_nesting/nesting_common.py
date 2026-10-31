"""Shared contour masks and single-board search for local nesting.

The production adapter supplies millimetre polygons. SVG parsing and legacy
standalone GUI/CLI export are deliberately outside the runtime search core.
"""
from pathlib import Path
import hashlib
import math
import os
import pickle
import random

# Apply before importing NumPy. Native pools would add per-thread buffers
# while Rust already limits its own parallel angle searches.
for _thread_env in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_thread_env] = '1'

import cv2
import numpy as np
import shapely
from shapely import affinity
from nesting_rust import MaskBank, dispatch, collision_grid, validated_occupancy

# Keep the Python reference/fallback single-threaded.
cv2.setNumThreads(1)
cv2.ocl.setUseOpenCL(False)


def make_masks(srcs, out, res, angles, gap, progress=None):
    digest = hashlib.sha1('|'.join(f"{s['name']}:{Path(s['file']).stat().st_size}" for s in srcs).encode()).hexdigest()[:12]
    # Version the format: old caches store float32 arrays (four times larger).
    frame_version = 'frame_v2_' if any(s.get('frame') is not None for s in srcs) else ''
    cache = out / f'masks_u8_{frame_version}{res}_{len(angles)}_g{gap}_{digest}.pkl'
    if cache.exists():
        # Load through a file handle so Python does not keep both the raw
        # pickle bytes and the unpickled object in memory at the same time.
        try:
            with cache.open('rb') as f:
                return MaskBank(pickle.load(f))
        except (MemoryError, EOFError, pickle.UnpicklingError, ValueError, OSError) as exc:
            print(f'WARNING: mask cache {cache.name} cannot be loaded ({type(exc).__name__}); rebuilding.', flush=True)
            try:
                cache.unlink()
            except OSError:
                pass
            # Let the adapter select a coarser grid when this cache is too
            # large for the current Python process.
            if isinstance(exc, MemoryError):
                raise
    all_masks = {}
    for s in srcs:
        items = []
        for angle_index, a in enumerate(angles):
            rp = affinity.rotate(s['poly'], a, origin=(0, 0))
            cp = rp.buffer(gap / 2 + .12, quad_segs=12)
            bx, by, bx1, by1 = cp.bounds
            frame_size = {}
            # The app carries the full SVG/image frame separately from its
            # cutting contour. Reserve that frame at sheet edges without
            # turning its transparent corners into collision obstacles.
            if s.get('frame') is not None:
                frame = affinity.rotate(s['frame'], a, origin=(0, 0))
                fx, fy, fx1, fy1 = frame.bounds
                padding = gap / 2 + .12
                bx, by, bx1, by1 = fx - padding, fy - padding, fx1 + padding, fy1 + padding
                frame_size = dict(frame_width=fx1 - fx, frame_height=fy1 - fy)
            width, height = math.ceil((bx1 - bx) / res), math.ceil((by1 - by) / res)
            local = affinity.translate(cp, -bx, -by)
            guard = local.buffer(res * math.sqrt(2) / 2 + 1e-7)
            xx = (np.arange(width)[None, :] + .5) * res
            yy = (np.arange(height)[:, None] + .5) * res
            mask = shapely.contains_xy(guard, xx, yy).astype(np.uint8)
            items.append(dict(angle=a, bx=bx, by=by, w=width, h=height, mask=mask, **frame_size))
            if progress:
                progress(s['i'], angle_index + 1, len(angles))
        all_masks[s['i']] = items
    with cache.open('wb') as f:
        pickle.dump(all_masks, f, protocol=pickle.HIGHEST_PROTOCOL)
    return MaskBank(all_masks)


def _first_legal_position(occ, mask, start_origin=None):
    """Search top-to-bottom, retrying smaller strips on OpenCV allocation failure."""
    h, w = mask.shape
    result_rows = occ.shape[0] - h + 1
    result_cols = occ.shape[1] - w + 1
    first_x, first_y = start_origin or (0, 0)
    if first_x >= result_cols or first_y >= result_rows:
        return None
    if start_origin is not None and not np.any(np.logical_and(
            occ[first_y:first_y + h, first_x:first_x + w], mask)):
        return first_x, first_y
    # Bound each correlation result to about 256 KiB. Adjacent strips overlap
    # by h-1 input rows so every legal origin is tested exactly once.
    strip_rows = min(result_rows, max(1, 65536 // result_cols))
    start = first_y
    while start < result_rows:
        count = min(strip_rows, result_rows - start)
        try:
            corr = cv2.matchTemplate(occ[start:start + count + h - 1], mask, cv2.TM_CCORR)
        except cv2.error as exc:
            if exc.code != -4:
                raise
            if strip_rows == 1:
                # Last resort requires only one product-sized boolean array,
                # and tests precisely the same raster collision condition.
                for y in range(start, result_rows):
                    for x in range(first_x if y == first_y else 0, result_cols):
                        if not np.any(np.logical_and(occ[y:y + h, x:x + w], mask)):
                            return x, y
                return None
            strip_rows = max(1, strip_rows // 2)
            continue
        for row in range(count):
            row_x = first_x if start + row == first_y else 0
            xs = np.flatnonzero(corr[row, row_x:] < .5)
            if len(xs):
                return row_x + int(xs[0]), start + row
        del corr
        start += count
    return None


def first_spot(occ, item, res, weight, mode, max_origin=None, min_origin=None):
    h, w = item['h'], item['w']
    if max_origin is not None:
        max_x, max_y = max_origin
        if max_x < 0 or max_y < 0:
            return None
        # Padding exists outside the physical sheet solely for collision
        # masks. Restrict the origins using the exact rotated image frame.
        occ = occ[:max_y + h, :max_x + w]
    if h > occ.shape[0] or w > occ.shape[1]:
        return None
    position = _first_legal_position(occ, item['mask'], min_origin)
    if position is None:
        return None
    x, y = position
    if mode == 'bl':
        score = y + .65 * h + weight * x
    elif mode == 'top':
        score = y + h + weight * x
    else:
        score = y + .35 * h + weight * x
    return score, x, y


def _pack_one_python(srcs, bank, remaining, board_w, board_h, gap, margin, res, seed, mode='top', order_mode='small', lookahead=1, progress=None, initial_occupancy=None):
    rng = random.Random(seed)
    grid_origin, cols, rows = collision_grid(srcs, board_w, board_h, gap, margin, res)
    seed_occupancy = validated_occupancy(initial_occupancy, rows, cols)
    occ = np.zeros((rows, cols), dtype=np.uint8) if seed_occupancy is None else np.array(seed_occupancy, dtype=np.uint8, order='C', copy=True)
    if order_mode == 'small':
        order = sorted(srcs, key=lambda s: s['area'])
    elif order_mode == 'large':
        order = sorted(srcs, key=lambda s: -s['area'])
    elif order_mode == 'random':
        order = list(srcs)
        rng.shuffle(order)
    elif order_mode == 'balanced':
        order = sorted(srcs, key=lambda s: -remaining[s['i']])
    elif order_mode == 'input':
        order = list(srcs)
    else:
        order = sorted(srcs, key=lambda s: s['area'] * (.7 + .6 * rng.random()))
    placed, failed = [], set()
    # Occupancy only grows on one sheet. Every origin preceding the last
    # legal one stays blocked; an orientation with no position stays blocked
    # too. Reset per sheet/trial and share only identical mask objects.
    first_origins = {}
    weight = .002 + rng.random() * .014
    while True:
        choices = []
        for s in order:
            i = s['i']
            if remaining[i] <= 0 or i in failed:
                continue
            options = []
            for it in bank[i]:
                mask_key = id(it)
                if mask_key in first_origins and first_origins[mask_key] is None:
                    continue
                max_origin = None
                if 'frame_width' in it:
                    max_origin = (math.floor((board_w - 2 * margin - it['frame_width'] + 1e-7) / res),
                                  math.floor((board_h - 2 * margin - it['frame_height'] + 1e-7) / res))
                loc = first_spot(occ, it, res, weight, mode, max_origin,
                                 first_origins.get(mask_key, (0, 0)))
                first_origins[mask_key] = (loc[1], loc[2]) if loc is not None else None
                if loc is not None:
                    options.append((loc, it))
            if options:
                loc, it = min(options, key=lambda p: p[0][0])
                choices.append((loc[0], s, loc, it))
                if len(choices) >= lookahead:
                    break
            else:
                failed.add(i)
        if not choices:
            break
        _, s, loc, it = min(choices, key=lambda p: p[0])
        _, x, y = loc
        occ[y:y + it['h'], x:x + it['w']] |= it['mask']
        tx = grid_origin + x * res - it['bx']
        ty = grid_origin + y * res - it['by']
        placed.append(dict(i=s['i'], angle=it['angle'], tx=tx, ty=ty))
        remaining[s['i']] -= 1
        if progress:
            progress(len(placed), sum(remaining))
    return placed


def pack_one(srcs, bank, remaining, board_w, board_h, gap, margin, res, seed, mode='top', order_mode='small', lookahead=1, progress=None, initial_occupancy=None):
    """Both strategies share this seam; Python remains the reference solver."""
    return dispatch(_pack_one_python, srcs, bank, remaining, board_w, board_h,
                    gap, margin, res, seed, mode, order_mode, lookahead, progress, initial_occupancy)


def pack_material_boards(srcs, bank, quantities, args, seed_offset=0, progress=None, *, max_sheets=None):
    """Pack a quantity vector using the board-saving heuristic.

    This is a reusable low-level packing utility. The material strategy uses
    it directly; the uniform strategy uses it only for quantities left over
    after its repeated common template has been generated. ``max_sheets`` is
    an optional bound on this particular greedy candidate, not on the order:
    return None when its fixed prefix fills the bound with demand still left.
    Appending more boards cannot make that prefix shorter. The input quantity
    vector stays untouched and unbounded callers retain the complete search.
    """
    remaining = list(quantities)
    if max_sheets is not None:
        if not isinstance(max_sheets, int) or max_sheets < 0:
            raise ValueError('max_sheets must be a nonnegative integer or None')
        if not any(remaining):
            return []
        if max_sheets == 0:
            return None
    best = None
    for run in range(args.runs):
        rem = remaining.copy()
        mode = ['top', 'bl', 'low'][run % 3]
        order = ['small', 'large', 'random', 'mixed'][run // 3 % 4]
        placed = pack_one(srcs, bank, rem, args.board_width, args.board_height, args.gap, args.margin,
                          args.resolution, args.seed + seed_offset + run, mode, order, args.lookahead,
                          (lambda count, left: progress(0, run + 1, count, left)) if progress else None)
        if best is None or len(placed) > len(best[0]):
            best = (placed, rem)
    result = [best[0]]
    remaining = list(best[1])
    while sum(remaining):
        if max_sheets is not None and len(result) >= max_sheets:
            return None
        trials = []
        for j, (mode, order) in enumerate([('low', 'small'), ('bl', 'small'), ('low', 'mixed')]):
            rem = remaining.copy()
            placed = pack_one(srcs, bank, rem, args.board_width, args.board_height, args.gap, args.margin,
                              args.resolution, args.seed + seed_offset + 100 + len(result) * 7 + j,
                              mode, order, args.lookahead,
                              (lambda count, left: progress(len(result), j + 1, count, left)) if progress else None)
            trials.append((placed, rem))
        placed, remaining = max(trials, key=lambda t: (len(t[0]), sum(srcs[p['i']]['area'] for p in t[0])))
        if not placed:
            raise SystemExit('No remaining item fits; try a smaller gap or finer resolution')
        result.append(placed)
    return result
