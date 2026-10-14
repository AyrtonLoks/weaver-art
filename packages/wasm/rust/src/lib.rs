// Rust WASM kernel using standard wasm32-unknown-unknown library


static mut PEGS_X_PTR: *mut f64 = core::ptr::null_mut();
static mut PEGS_Y_PTR: *mut f64 = core::ptr::null_mut();
static mut CHORD_MASK_PTR: *mut u8 = core::ptr::null_mut();
static mut CHORD_USE_PTR: *mut u16 = core::ptr::null_mut();
static mut THREAD_COLORS_PTR: *mut f32 = core::ptr::null_mut();
static mut THREAD_WIDTH_PX_PTR: *mut f64 = core::ptr::null_mut();
static mut THREAD_OPACITY_PTR: *mut f64 = core::ptr::null_mut();
static mut SIDES_PTR: *mut i32 = core::ptr::null_mut();
static mut CANVAS_PTR: *mut f32 = core::ptr::null_mut();
static mut TARGET_PTR: *mut f32 = core::ptr::null_mut();
static mut WEIGHT_PTR: *mut f32 = core::ptr::null_mut();
static mut HALFTONE_PTR: *mut f32 = core::ptr::null_mut();
static mut RESULT_PTR: *mut f64 = core::ptr::null_mut();
static mut SAMPLES_IDX_PTR: *mut i32 = core::ptr::null_mut();
static mut SAMPLES_COV_PTR: *mut f32 = core::ptr::null_mut();

static mut GRID_SIZE: i32 = 0;
static mut CHANNELS: i32 = 1;
static mut PEG_COUNT: i32 = 0;
static mut THREAD_COUNT: i32 = 0;
static mut SIDES_COUNT: i32 = 2;
static mut MAX_CHORD_REPEATS: i32 = 1;
static mut HAS_HALFTONE: i32 = 0;
static mut PEG_RADIUS_MM: f64 = 0.0;
static mut SCALE: f64 = 1.0;
static mut EXTENT_MM: f64 = 1.0;
static mut LENGTH_PENALTY: f64 = 0.0;
static mut HEAP_BASE: usize = 0;

#[derive(Clone, Copy)]
pub struct Segment {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    pub dx: f64,
    pub dy: f64,
    pub length: f64,
}

#[inline(always)]
fn align8(offset: usize) -> usize {
    (offset + 7) & !7
}

#[no_mangle]
pub extern "C" fn wasm_init(
    size: i32,
    channels: i32,
    peg_count: i32,
    thread_count: i32,
    sides_count: i32,
    max_chord_repeats: i32,
    has_halftone: i32,
    peg_radius_mm: f64,
    scale: f64,
    extent_mm: f64,
    length_penalty: f64,
) -> i32 {
    unsafe {
        GRID_SIZE = size;
        CHANNELS = channels;
        PEG_COUNT = peg_count;
        THREAD_COUNT = thread_count;
        SIDES_COUNT = sides_count;
        MAX_CHORD_REPEATS = max_chord_repeats;
        HAS_HALFTONE = has_halftone;
        PEG_RADIUS_MM = peg_radius_mm;
        SCALE = scale;
        EXTENT_MM = extent_mm;
        LENGTH_PENALTY = length_penalty;

        let n = peg_count as usize;
        let t = thread_count as usize;
        let c = channels as usize;
        let s = size as usize;
        let sc = sides_count as usize;

        if HEAP_BASE == 0 {
            HEAP_BASE = align8(core::arch::wasm32::memory_size(0) * 65536);
        }
        let mut offset = HEAP_BASE;

        PEGS_X_PTR = offset as *mut f64;
        offset = align8(offset + n * 8);

        PEGS_Y_PTR = offset as *mut f64;
        offset = align8(offset + n * 8);

        CHORD_MASK_PTR = offset as *mut u8;
        offset = align8(offset + n * n);

        CHORD_USE_PTR = offset as *mut u16;
        offset = align8(offset + n * n * 2);

        THREAD_COLORS_PTR = offset as *mut f32;
        offset = align8(offset + t * c * 4);

        THREAD_WIDTH_PX_PTR = offset as *mut f64;
        offset = align8(offset + t * 8);

        THREAD_OPACITY_PTR = offset as *mut f64;
        offset = align8(offset + t * 8);

        SIDES_PTR = offset as *mut i32;
        offset = align8(offset + sc * 4);

        CANVAS_PTR = offset as *mut f32;
        offset = align8(offset + s * s * c * 4);

        TARGET_PTR = offset as *mut f32;
        offset = align8(offset + s * s * c * 4);

        WEIGHT_PTR = offset as *mut f32;
        offset = align8(offset + s * s * 4);

        if has_halftone != 0 {
            HALFTONE_PTR = offset as *mut f32;
            offset = align8(offset + s * s * c * 4);
        } else {
            HALFTONE_PTR = core::ptr::null_mut();
        }

        RESULT_PTR = offset as *mut f64;
        offset = align8(offset + 16 * 8);

        let max_samples = s * 16 + 64;
        SAMPLES_IDX_PTR = offset as *mut i32;
        offset = align8(offset + max_samples * 4);

        SAMPLES_COV_PTR = offset as *mut f32;
        offset = align8(offset + max_samples * 4);

        let current_bytes = core::arch::wasm32::memory_size(0) * 65536;
        if offset > current_bytes {
            let needed_pages = (offset - current_bytes + 65535) / 65536;
            let res = core::arch::wasm32::memory_grow(0, needed_pages);
            if res == usize::MAX {
                return -1;
            }
        }

        0
    }
}

#[no_mangle] pub extern "C" fn get_pegs_x_ptr() -> *mut f64 { unsafe { PEGS_X_PTR } }
#[no_mangle] pub extern "C" fn get_pegs_y_ptr() -> *mut f64 { unsafe { PEGS_Y_PTR } }
#[no_mangle] pub extern "C" fn get_chord_mask_ptr() -> *mut u8 { unsafe { CHORD_MASK_PTR } }
#[no_mangle] pub extern "C" fn get_chord_use_ptr() -> *mut u16 { unsafe { CHORD_USE_PTR } }
#[no_mangle] pub extern "C" fn get_thread_colors_ptr() -> *mut f32 { unsafe { THREAD_COLORS_PTR } }
#[no_mangle] pub extern "C" fn get_thread_width_px_ptr() -> *mut f64 { unsafe { THREAD_WIDTH_PX_PTR } }
#[no_mangle] pub extern "C" fn get_thread_opacity_ptr() -> *mut f64 { unsafe { THREAD_OPACITY_PTR } }
#[no_mangle] pub extern "C" fn get_sides_ptr() -> *mut i32 { unsafe { SIDES_PTR } }
#[no_mangle] pub extern "C" fn get_canvas_ptr() -> *mut f32 { unsafe { CANVAS_PTR } }
#[no_mangle] pub extern "C" fn get_target_ptr() -> *mut f32 { unsafe { TARGET_PTR } }
#[no_mangle] pub extern "C" fn get_weight_ptr() -> *mut f32 { unsafe { WEIGHT_PTR } }
#[no_mangle] pub extern "C" fn get_halftone_ptr() -> *mut f32 { unsafe { HALFTONE_PTR } }
#[no_mangle] pub extern "C" fn get_result_ptr() -> *mut f64 { unsafe { RESULT_PTR } }
#[no_mangle] pub extern "C" fn get_samples_idx_ptr() -> *mut i32 { unsafe { SAMPLES_IDX_PTR } }
#[no_mangle] pub extern "C" fn get_samples_cov_ptr() -> *mut f32 { unsafe { SAMPLES_COV_PTR } }
#[no_mangle] pub extern "C" fn set_halftone_active(active: i32) { unsafe { HAS_HALFTONE = active; } }

#[inline(always)]
pub fn tangent_segment(
    ax: f64, ay: f64, sa: f64,
    bx: f64, by: f64, sb: f64,
    r: f64,
) -> Segment {
    let vx = bx - ax;
    let vy = by - ay;
    let dist = (vx * vx + vy * vy).sqrt();
    if dist <= 1e-9 {
        return Segment {
            x0: ax,
            y0: ay,
            x1: bx,
            y1: by,
            dx: 0.0,
            dy: 0.0,
            length: 0.0,
        };
    }
    let ux = vx / dist;
    let uy = vy / dist;
    let mut dx = ux;
    let mut dy = uy;
    let mut length = dist;
    if r > 0.0 && sa != sb {
        let diff = dist * dist - 4.0 * r * r;
        length = if diff > 0.0 { diff.sqrt() } else { 0.0 };
        let cos_val = length / dist;
        let sin_val = (2.0 * sb * r) / dist;
        dx = ux * cos_val - uy * sin_val;
        dy = ux * sin_val + uy * cos_val;
    }
    let nx = -dy;
    let ny = dx;
    Segment {
        x0: ax + sa * r * nx,
        y0: ay + sa * r * ny,
        x1: bx + sb * r * nx,
        y1: by + sb * r * ny,
        dx,
        dy,
        length,
    }
}

#[inline(always)]
pub fn canonical_segment(
    from: usize, from_side: f64,
    to: usize, to_side: f64,
    peg_x: &[f64], peg_y: &[f64],
    r: f64,
) -> Segment {
    if from <= to {
        tangent_segment(peg_x[from], peg_y[from], from_side, peg_x[to], peg_y[to], to_side, r)
    } else {
        tangent_segment(peg_x[to], peg_y[to], -to_side, peg_x[from], peg_y[from], -from_side, r)
    }
}

#[inline(always)]
fn score_segment(seg: &Segment, thread: usize) -> f64 {
    unsafe {
        let size = GRID_SIZE;
        let channels = CHANNELS;
        let scale = SCALE;
        let width_px = *THREAD_WIDTH_PX_PTR.add(thread);
        let op = *THREAD_OPACITY_PTR.add(thread);
        let weight = core::slice::from_raw_parts(WEIGHT_PTR, (size * size) as usize);
        let canvas = core::slice::from_raw_parts(CANVAS_PTR, (size * size * channels) as usize);
        let target = core::slice::from_raw_parts(TARGET_PTR, (size * size * channels) as usize);
        let halftone = if HAS_HALFTONE != 0 && !HALFTONE_PTR.is_null() {
            Some(core::slice::from_raw_parts(HALFTONE_PTR, (size * size * channels) as usize))
        } else {
            None
        };

        let mut x0 = seg.x0 * scale;
        let mut y0 = seg.y0 * scale;
        let mut x1 = seg.x1 * scale;
        let mut y1 = seg.y1 * scale;

        let dx = x1 - x0;
        let dy = y1 - y0;
        let abs_dx = if dx < 0.0 { -dx } else { dx };
        let abs_dy = if dy < 0.0 { -dy } else { dy };

        let mut gain = 0.0f64;

        if abs_dx >= abs_dy {
            if dx == 0.0 {
                return 0.0;
            }
            if x0 > x1 {
                let tx = x0; x0 = x1; x1 = tx;
                let ty = y0; y0 = y1; y1 = ty;
            }
            let m = (y1 - y0) / (x1 - x0);
            let half = (width_px * (1.0 + m * m).sqrt()) / 2.0;
            let mut i_start = (x0 - 0.5).ceil() as i32;
            if i_start < 0 { i_start = 0; }
            let mut i_end = (x1 - 0.5).floor() as i32;
            if i_end > size - 1 { i_end = size - 1; }

            if channels == 1 {
                let k = *THREAD_COLORS_PTR.add(thread) as f64;
                for i in i_start..=i_end {
                    let yc = y0 + ((i as f64) + 0.5 - x0) * m;
                    let top = yc - half;
                    let bot = yc + half;
                    let mut k_start = top.floor() as i32;
                    if k_start < 0 { k_start = 0; }
                    let mut k_end = bot.floor() as i32;
                    if k_end > size - 1 { k_end = size - 1; }

                    for k_idx in k_start..=k_end {
                        let c = bot.min((k_idx + 1) as f64) - top.max(k_idx as f64);
                        let c_f32 = c as f32;
                        if c_f32 > 1e-6 {
                            let p = (k_idx * size + i) as usize;
                            let w = weight[p] as f64;
                            if w == 0.0 { continue; }
                            let r = canvas[p] as f64;
                            let d = (c_f32 as f64) * op * (k - r);
                            let err = if let Some(ht) = halftone {
                                ht[p] as f64
                            } else {
                                (target[p] as f64) - r
                            };
                            gain += w * d * (2.0 * err - d);
                        }
                    }
                }
            } else {
                let o = thread * 3;
                let k0 = *THREAD_COLORS_PTR.add(o) as f64;
                let k1 = *THREAD_COLORS_PTR.add(o + 1) as f64;
                let k2 = *THREAD_COLORS_PTR.add(o + 2) as f64;

                for i in i_start..=i_end {
                    let yc = y0 + ((i as f64) + 0.5 - x0) * m;
                    let top = yc - half;
                    let bot = yc + half;
                    let mut k_start = top.floor() as i32;
                    if k_start < 0 { k_start = 0; }
                    let mut k_end = bot.floor() as i32;
                    if k_end > size - 1 { k_end = size - 1; }

                    for k_idx in k_start..=k_end {
                        let c = bot.min((k_idx + 1) as f64) - top.max(k_idx as f64);
                        let c_f32 = c as f32;
                        if c_f32 > 1e-6 {
                            let p = (k_idx * size + i) as usize;
                            let w = weight[p] as f64;
                            if w == 0.0 { continue; }
                            let c_val = (c_f32 as f64) * op;
                            let q = p * 3;
                            let r0 = canvas[q] as f64;
                            let r1 = canvas[q + 1] as f64;
                            let r2 = canvas[q + 2] as f64;
                            let d0 = c_val * (k0 - r0);
                            let d1 = c_val * (k1 - r1);
                            let d2 = c_val * (k2 - r2);
                            let (err0, err1, err2) = if let Some(ht) = halftone {
                                (ht[q] as f64, ht[q + 1] as f64, ht[q + 2] as f64)
                            } else {
                                ((target[q] as f64) - r0, (target[q + 1] as f64) - r1, (target[q + 2] as f64) - r2)
                            };
                            gain += w * (d0 * (2.0 * err0 - d0) + d1 * (2.0 * err1 - d1) + d2 * (2.0 * err2 - d2));
                        }
                    }
                }
            }
        } else {
            if dy == 0.0 {
                return 0.0;
            }
            if y0 > y1 {
                let tx = x0; x0 = x1; x1 = tx;
                let ty = y0; y0 = y1; y1 = ty;
            }
            let m = (x1 - x0) / (y1 - y0);
            let half = (width_px * (1.0 + m * m).sqrt()) / 2.0;
            let mut j_start = (y0 - 0.5).ceil() as i32;
            if j_start < 0 { j_start = 0; }
            let mut j_end = (y1 - 0.5).floor() as i32;
            if j_end > size - 1 { j_end = size - 1; }

            if channels == 1 {
                let k = *THREAD_COLORS_PTR.add(thread) as f64;
                for j in j_start..=j_end {
                    let xc = x0 + ((j as f64) + 0.5 - y0) * m;
                    let left = xc - half;
                    let right = xc + half;
                    let mut k_start = left.floor() as i32;
                    if k_start < 0 { k_start = 0; }
                    let mut k_end = right.floor() as i32;
                    if k_end > size - 1 { k_end = size - 1; }
                    let row = j * size;

                    for k_idx in k_start..=k_end {
                        let c = right.min((k_idx + 1) as f64) - left.max(k_idx as f64);
                        let c_f32 = c as f32;
                        if c_f32 > 1e-6 {
                            let p = (row + k_idx) as usize;
                            let w = weight[p] as f64;
                            if w == 0.0 { continue; }
                            let r = canvas[p] as f64;
                            let d = (c_f32 as f64) * op * (k - r);
                            let err = if let Some(ht) = halftone {
                                ht[p] as f64
                            } else {
                                (target[p] as f64) - r
                            };
                            gain += w * d * (2.0 * err - d);
                        }
                    }
                }
            } else {
                let o = thread * 3;
                let k0 = *THREAD_COLORS_PTR.add(o) as f64;
                let k1 = *THREAD_COLORS_PTR.add(o + 1) as f64;
                let k2 = *THREAD_COLORS_PTR.add(o + 2) as f64;

                for j in j_start..=j_end {
                    let xc = x0 + ((j as f64) + 0.5 - y0) * m;
                    let left = xc - half;
                    let right = xc + half;
                    let mut k_start = left.floor() as i32;
                    if k_start < 0 { k_start = 0; }
                    let mut k_end = right.floor() as i32;
                    if k_end > size - 1 { k_end = size - 1; }
                    let row = j * size;

                    for k_idx in k_start..=k_end {
                        let c = right.min((k_idx + 1) as f64) - left.max(k_idx as f64);
                        let c_f32 = c as f32;
                        if c_f32 > 1e-6 {
                            let p = (row + k_idx) as usize;
                            let w = weight[p] as f64;
                            if w == 0.0 { continue; }
                            let c_val = (c_f32 as f64) * op;
                            let q = p * 3;
                            let r0 = canvas[q] as f64;
                            let r1 = canvas[q + 1] as f64;
                            let r2 = canvas[q + 2] as f64;
                            let d0 = c_val * (k0 - r0);
                            let d1 = c_val * (k1 - r1);
                            let d2 = c_val * (k2 - r2);
                            let (err0, err1, err2) = if let Some(ht) = halftone {
                                (ht[q] as f64, ht[q + 1] as f64, ht[q + 2] as f64)
                            } else {
                                ((target[q] as f64) - r0, (target[q + 1] as f64) - r1, (target[q + 2] as f64) - r2)
                            };
                            gain += w * (d0 * (2.0 * err0 - d0) + d1 * (2.0 * err1 - d1) + d2 * (2.0 * err2 - d2));
                        }
                    }
                }
            }
        }

        if LENGTH_PENALTY > 0.0 && gain > 0.0 {
            let norm_len = seg.length / EXTENT_MM;
            let factor = 1.0 - LENGTH_PENALTY * norm_len;
            gain *= if factor > 0.0 { factor } else { 0.0 };
        }

        gain
    }
}

#[inline(always)]
fn rasterize_to_samples(seg: &Segment, width_px: f64) -> i32 {
    unsafe {
        let size = GRID_SIZE;
        let scale = SCALE;
        let idx_ptr = SAMPLES_IDX_PTR;
        let cov_ptr = SAMPLES_COV_PTR;

        let mut x0 = seg.x0 * scale;
        let mut y0 = seg.y0 * scale;
        let mut x1 = seg.x1 * scale;
        let mut y1 = seg.y1 * scale;

        let dx = x1 - x0;
        let dy = y1 - y0;
        let abs_dx = if dx < 0.0 { -dx } else { dx };
        let abs_dy = if dy < 0.0 { -dy } else { dy };

        let mut n = 0i32;

        if abs_dx >= abs_dy {
            if dx == 0.0 {
                return 0;
            }
            if x0 > x1 {
                let tx = x0; x0 = x1; x1 = tx;
                let ty = y0; y0 = y1; y1 = ty;
            }
            let m = (y1 - y0) / (x1 - x0);
            let half = (width_px * (1.0 + m * m).sqrt()) / 2.0;
            let mut i_start = (x0 - 0.5).ceil() as i32;
            if i_start < 0 { i_start = 0; }
            let mut i_end = (x1 - 0.5).floor() as i32;
            if i_end > size - 1 { i_end = size - 1; }

            for i in i_start..=i_end {
                let yc = y0 + ((i as f64) + 0.5 - x0) * m;
                let top = yc - half;
                let bot = yc + half;
                let mut k_start = top.floor() as i32;
                if k_start < 0 { k_start = 0; }
                let mut k_end = bot.floor() as i32;
                if k_end > size - 1 { k_end = size - 1; }

                for k_idx in k_start..=k_end {
                    let c = bot.min((k_idx + 1) as f64) - top.max(k_idx as f64);
                    let c_f32 = c as f32;
                    if c_f32 > 1e-6 {
                        *idx_ptr.add(n as usize) = k_idx * size + i;
                        *cov_ptr.add(n as usize) = c_f32;
                        n += 1;
                    }
                }
            }
        } else {
            if dy == 0.0 {
                return 0;
            }
            if y0 > y1 {
                let tx = x0; x0 = x1; x1 = tx;
                let ty = y0; y0 = y1; y1 = ty;
            }
            let m = (x1 - x0) / (y1 - y0);
            let half = (width_px * (1.0 + m * m).sqrt()) / 2.0;
            let mut j_start = (y0 - 0.5).ceil() as i32;
            if j_start < 0 { j_start = 0; }
            let mut j_end = (y1 - 0.5).floor() as i32;
            if j_end > size - 1 { j_end = size - 1; }

            for j in j_start..=j_end {
                let xc = x0 + ((j as f64) + 0.5 - y0) * m;
                let left = xc - half;
                let right = xc + half;
                let mut k_start = left.floor() as i32;
                if k_start < 0 { k_start = 0; }
                let mut k_end = right.floor() as i32;
                if k_end > size - 1 { k_end = size - 1; }
                let row = j * size;

                for k_idx in k_start..=k_end {
                    let c = right.min((k_idx + 1) as f64) - left.max(k_idx as f64);
                    let c_f32 = c as f32;
                    if c_f32 > 1e-6 {
                        *idx_ptr.add(n as usize) = row + k_idx;
                        *cov_ptr.add(n as usize) = c_f32;
                        n += 1;
                    }
                }
            }
        }

        n
    }
}

#[no_mangle]
pub extern "C" fn best_for_thread(thread: i32, from_peg: i32, from_side_val: i32) -> i32 {
    unsafe {
        let t = thread as usize;
        let from = from_peg as usize;
        let n = PEG_COUNT as usize;
        let peg_x = core::slice::from_raw_parts(PEGS_X_PTR, n);
        let peg_y = core::slice::from_raw_parts(PEGS_Y_PTR, n);
        let chord_mask = core::slice::from_raw_parts(CHORD_MASK_PTR, n * n);
        let chord_use = core::slice::from_raw_parts(CHORD_USE_PTR, n * n);
        let sides = core::slice::from_raw_parts(SIDES_PTR, SIDES_COUNT as usize);

        let from_sides_storage: [i32; 2] = if from_side_val == 0 {
            if SIDES_COUNT == 1 { [sides[0], 0] } else { [sides[0], sides[1]] }
        } else {
            [from_side_val, 0]
        };
        let from_sides_len = if from_side_val == 0 { SIDES_COUNT as usize } else { 1 };
        let from_sides = &from_sides_storage[0..from_sides_len];

        let mut best_gain = -1.0e30;
        let mut best_to = -1i32;
        let mut best_from_side = 0i32;
        let mut best_to_side = 0i32;
        let mut best_seg = Segment { x0: 0.0, y0: 0.0, x1: 0.0, y1: 0.0, dx: 0.0, dy: 0.0, length: 0.0 };
        let mut has_best = false;

        for to in 0..n {
            if chord_mask[from * n + to] == 0 { continue; }
            if chord_use[from * n + to] >= MAX_CHORD_REPEATS as u16 { continue; }

            for &f_side in from_sides {
                for &t_side in sides {
                    let canonical = canonical_segment(from, f_side as f64, to, t_side as f64, peg_x, peg_y, PEG_RADIUS_MM);
                    let gain = score_segment(&canonical, t);

                    // Strict tie-break: strictly greater gain
                    if !has_best || gain > best_gain {
                        has_best = true;
                        best_gain = gain;
                        best_to = to as i32;
                        best_from_side = f_side;
                        best_to_side = t_side;
                        best_seg = tangent_segment(peg_x[from], peg_y[from], f_side as f64, peg_x[to], peg_y[to], t_side as f64, PEG_RADIUS_MM);
                    }
                }
            }
        }

        if has_best {
            let res = core::slice::from_raw_parts_mut(RESULT_PTR, 16);
            res[0] = 1.0;
            res[1] = best_to as f64;
            res[2] = best_from_side as f64;
            res[3] = best_to_side as f64;
            res[4] = best_gain;
            res[5] = best_seg.x0;
            res[6] = best_seg.y0;
            res[7] = best_seg.x1;
            res[8] = best_seg.y1;
            res[9] = best_seg.dx;
            res[10] = best_seg.dy;
            res[11] = best_seg.length;
            1
        } else {
            0
        }
    }
}

#[no_mangle]
pub extern "C" fn score_chord(thread: i32, from_peg: i32, from_side: i32, to: i32, to_side: i32) -> f64 {
    unsafe {
        let n = PEG_COUNT as usize;
        let peg_x = core::slice::from_raw_parts(PEGS_X_PTR, n);
        let peg_y = core::slice::from_raw_parts(PEGS_Y_PTR, n);
        let canonical = canonical_segment(from_peg as usize, from_side as f64, to as usize, to_side as f64, peg_x, peg_y, PEG_RADIUS_MM);
        score_segment(&canonical, thread as usize)
    }
}

#[no_mangle]
pub extern "C" fn samples_canonical(from_peg: i32, from_side: i32, to: i32, to_side: i32, width_px: f64) -> i32 {
    unsafe {
        let n = PEG_COUNT as usize;
        let peg_x = core::slice::from_raw_parts(PEGS_X_PTR, n);
        let peg_y = core::slice::from_raw_parts(PEGS_Y_PTR, n);
        let canonical = canonical_segment(from_peg as usize, from_side as f64, to as usize, to_side as f64, peg_x, peg_y, PEG_RADIUS_MM);
        rasterize_to_samples(&canonical, width_px)
    }
}
