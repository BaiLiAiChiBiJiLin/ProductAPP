# Native single-board nesting core

This independent, dependency-free Rust library replaces only the raster search
and single-board placement loop in `../nesting_common.py`. Python still owns
geometry, rasterization, the 24 rotations, 0.5 mm sampling, 3 mm spacing, random
number generation, source ordering, board strategies and output generation.

Build separately from Tauri, with one compiler job:

```powershell
cargo build --release -j 1 --manifest-path src-tauri/src/imposition/local_nesting/rust_core/Cargo.toml --target-dir .tools/nesting/rust-core-target
```

The Windows result is `release/printflow_nesting_core.dll`. Test it through an
explicit candidate-library path before deploying it to the production bridge.

## C ABI version 1

All structures use normal C layout, fixed-width integer fields, native `size_t`
lengths, and native pointers. All functions use the C calling convention.

```c
typedef struct NcContext NcContext;
typedef struct { uint32_t first_mask, mask_count; } NcSource;
typedef struct { int32_t max_x, max_y; } NcLimit;
typedef struct {
    uint32_t cols, rows, lookahead, reserved;
    double weight, height_weight;
} NcPackConfig;
typedef struct { uint32_t source_index, mask_index, x, y; } NcPlacement;
typedef void (*NcProgress)(uint64_t placed, uint64_t remaining, void *user);

uint32_t nc_abi_version(void);
int32_t nc_create(uint32_t workers, uint64_t max_bytes, NcContext **out);
int32_t nc_add_mask(NcContext *, const uint8_t *data, size_t data_len,
                    uint32_t width, uint32_t height, uint32_t *out_index);
int32_t nc_pack(NcContext *, const NcPackConfig *,
                const NcSource *, size_t source_count,
                const uint32_t *mask_indexes, size_t mask_index_count,
                const NcLimit *, size_t limit_count,
                const uint32_t *order, size_t order_count,
                uint64_t *quantities, size_t quantity_count,
                NcProgress progress, void *user);
int32_t nc_pack_seeded(NcContext *, const NcPackConfig *,
                const NcSource *, size_t source_count,
                const uint32_t *mask_indexes, size_t mask_index_count,
                const NcLimit *, size_t limit_count,
                const uint32_t *order, size_t order_count,
                uint64_t *quantities, size_t quantity_count,
                const uint8_t *initial_occupancy, size_t occupancy_len,
                NcProgress progress, void *user);
size_t nc_placement_count(const NcContext *);
int32_t nc_copy_placements(NcContext *, NcPlacement *out, size_t capacity);
uint64_t nc_memory_used(const NcContext *);
uint32_t nc_worker_count(const NcContext *);
size_t nc_last_error(const NcContext *, uint8_t *out, size_t capacity);
void nc_destroy(NcContext *);
```

`nc_create` accepts workers 0 (default 2), 1, 2 or 4. `max_bytes=0` selects a
128 MiB budget. A context uploads each unique Python **item object** once,
in row-major contiguous uint8 format with values 0 or 1. Repeated source
references reuse that mask index. Masks are bit-packed immediately; the input
buffer may be released after `nc_add_mask` returns. Source index means position
in the source array, not the original Python source ID.

`NcSource` describes a span in `mask_indexes`, preserving its original angle
order. `order` must be a permutation of the source indexes. Quantities have one
entry per source. `limits` has one entry per uploaded mask, with inclusive
origin maxima already computed by Python from the exact frame. A negative
limit means that orientation cannot fit. Rust additionally clips these maxima
to the physical raster. `reserved` must be zero; `lookahead` is positive.
Python passes its already-generated `weight` and the score height coefficient
1.0 (`top`), 0.65 (`bl`) or 0.35 (other). No random numbers are generated here.

`nc_pack_seeded` is an optional ABI 1 extension; the original `nc_pack` symbol
and structures are unchanged. The seed is a row-major, binary uint8 array with
exactly `cols * rows` entries. It stays borrowed and unmodified until the call
returns. Its bytes count toward the context memory budget; native search stores
one bit-packed board and returns only newly placed pieces. Fixed pieces must
already be represented by the seed and excluded from the remaining quantities.
A null seed with length zero starts an empty board. Invalid lengths, nonbinary
values and memory-budget failures leave quantities unchanged. The Python bridge
accepts `pack_one(..., initial_occupancy=grid)`, copies the grid for its Python
fallback, and preserves fixed occupancy if an older DLL lacks the new symbol.
`nesting_rust.collision_grid` exposes the shared origin, columns and rows used
by both implementations so arbitrary fixed positions can be rasterized once.

The returned placement indexes allow Python to recover angle, bx/by and source
ID without duplicating geometry metadata in Rust. Placement coordinates are
grid origins; Python applies its original translation formula. Quantities are
updated only on a successful call. On any error, results are cleared, caller
quantities are unchanged, and the context remains reusable. The optional
progress callback runs synchronously on the calling thread after each piece;
it must not reenter or destroy this context. Python must catch exceptions in
its callback. Call `nc_placement_count`, allocate only that many output entries,
and call `nc_copy_placements` after success.

Return codes: 0 success, 1 invalid input, 2 memory budget exceeded, 3 allocation
failure, 4 caught Rust panic, 5 insufficient output capacity. `nc_last_error`
returns the required bytes including the NUL terminator; it writes a truncated,
NUL-terminated message when capacity is nonzero. A null context reads the
current thread's create/invalid-handle error. Null array pointers are accepted
only for zero length. Live handles and their arrays must refer to valid,
properly aligned memory, and calls using the same context must be serialized.
As with ordinary C APIs, lengths and null pointers can be checked, but a forged
pointer or a handle used after destruction cannot be made safe by this ABI.

## Exact search and bounded memory

Search returns the first legal origin in row-major order, resuming at the
previous legal origin. Cached exhaustion is per uploaded item; failed sources
are per board. Occupancy only grows. Equal scores keep the earlier angle and
earlier source. Lookahead counts sources with a legal choice, not orientations.
Workers only search orientations; merging and quantity updates remain ordered.

A mask stores `ceil(width/64)*height*8 + height*4` bytes of vector capacity plus
small fixed metadata. The second term indexes nonempty rows, permitting early
collision rejection. Occupancy uses `ceil(cols/64)*rows*8` bytes. There are no
correlation matrices, copies per requested quantity, or precomputed copies for
every horizontal bit offset. Results grow only with pieces actually placed.
`nc_memory_used` reports retained allocations; temporary board allocations and
result growth are checked against the same context budget. Fallible vector
reservation reports memory errors instead of invoking Rust's allocation-failure
handler. Thread startup failures reduce parallelism. On Windows, low available
physical memory or commit headroom forces one worker. `nc_worker_count` reports
the effective worker count from the most recent packing call.
