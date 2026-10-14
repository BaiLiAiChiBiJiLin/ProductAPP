use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
    thread,
    time::Duration,
};
use tauri::Emitter;
use tiny_skia::{PathSegment, Point};
use usvg::Node;

// Cap malformed-input diagnostics without expanding corrupt QT values. Valid
// quantities remain compact metadata for the local Python/Rust search core.
const MAX_DIAGNOSTIC_QT_IDS: usize = 4_000;
const MAX_IRREGULAR_VERTICES_PER_ITEM: usize = 4_096;
const MAX_OUTLINE_SVG_BYTES: u64 = 32 * 1024 * 1024;
static IRREGULAR_SOLVER_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static OUTLINE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// Progress is sent on a separate Tauri event so the nesting overlay can tell
/// the user which expensive stage is running while the solver continues.  A
/// worker writes the same payload as a prefixed stderr line; the desktop
/// process forwards it without mixing diagnostics into the JSON result on
/// stdout.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IrregularProgressEvent {
    pub phase: String,
    pub status: String,
    pub detail: String,
    pub completed: usize,
    pub total: usize,
    pub percent: f64,
    pub algorithm: String,
}

const IRREGULAR_PROGRESS_EVENT: &str = "imposition-progress";
const WORKER_PROGRESS_PREFIX: &str = "PRINTFLOW_PROGRESS ";

fn progress_event(
    phase: &str,
    status: &str,
    detail: impl Into<String>,
    completed: usize,
    total: usize,
    algorithm: &str,
) -> IrregularProgressEvent {
    let percent = if total > 0 {
        ((completed as f64 / total as f64) * 100.0).clamp(0.0, 100.0)
    } else if status == "completed" {
        100.0
    } else {
        0.0
    };
    IrregularProgressEvent {
        phase: phase.to_owned(),
        status: status.to_owned(),
        detail: detail.into(),
        completed,
        total,
        percent,
        algorithm: algorithm.to_owned(),
    }
}

fn emit_progress(app: Option<&tauri::AppHandle>, event: IrregularProgressEvent) {
    if let Some(app) = app {
        let _ = app.emit(IRREGULAR_PROGRESS_EVENT, event);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NestItem {
    pub id: String,
    pub width_mm: f64,
    pub height_mm: f64,
    /// Requested copies for this base asset. Keep this on the protocol item so
    /// contour extraction and nesting only have to inspect one polygon per
    /// asset; engines expand placements after solving.
    #[serde(default = "default_quantity")]
    pub quantity: u32,
    #[serde(default)]
    pub polygon: Option<Vec<[f64; 2]>>,
}

fn default_quantity() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NestRequest {
    pub plate_width_mm: f64,
    pub plate_height_mm: f64,
    pub effective_width_mm: f64,
    pub effective_height_mm: f64,
    pub effective_right_mm: f64,
    pub spacing_mm: f64,
    pub objective: String,
    #[serde(default = "default_irregular_algorithm")]
    pub irregular_algorithm: String,
    pub items: Vec<NestItem>,
}

fn default_irregular_algorithm() -> String {
    "local-tools".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NestPlacement {
    pub id: String,
    pub sheet_index: usize,
    pub x_mm: f64,
    pub y_mm: f64,
    pub width_mm: f64,
    pub height_mm: f64,
    pub rotation_deg: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NestExcludedItem {
    /// Base asset id (without a `#qt-N` suffix).  The frontend uses this id
    /// to mark the source row red while keeping all other assets in the job.
    pub id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NestResult {
    pub placements: Vec<NestPlacement>,
    pub unplaced: Vec<String>,
    pub sheets_used: usize,
    pub utilization: f64,
    pub algorithm: String,
    /// Assets that were intentionally removed from this irregular run because
    /// their contour cannot be handled safely.  Keep this additive and
    /// defaulted so saved results remain protocol compatible.
    #[serde(default)]
    pub excluded_items: Vec<NestExcludedItem>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

fn irregular_polygon_points(item: &NestItem) -> Vec<[f64; 2]> {
    // Missing outlines are invalid assets; never invent a rectangular contour.
    clean_polygon(item.polygon.clone().unwrap_or_default())
}

fn clean_polygon(mut polygon: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    polygon.dedup_by(|left, right| (left[0] - right[0]).hypot(left[1] - right[1]) <= 1e-7);
    if polygon.len() > 1
        && (polygon[0][0] - polygon[polygon.len() - 1][0])
            .hypot(polygon[0][1] - polygon[polygon.len() - 1][1])
            <= 1e-7
    {
        polygon.pop();
    }
    // Curves sampled into very short straight runs create unnecessary NFP
    // vertices. Remove collinear middle points while retaining corners.
    let mut changed = true;
    while changed && polygon.len() > 3 {
        changed = false;
        for index in 0..polygon.len() {
            let previous = polygon[(index + polygon.len() - 1) % polygon.len()];
            let current = polygon[index];
            let next = polygon[(index + 1) % polygon.len()];
            let cross = (current[0] - previous[0]) * (next[1] - current[1])
                - (current[1] - previous[1]) * (next[0] - current[0]);
            if cross.abs() <= 1e-8 {
                polygon.remove(index);
                changed = true;
                break;
            }
        }
    }
    polygon
}

fn squared_distance(left: [f64; 2], right: [f64; 2]) -> f64 {
    let dx = left[0] - right[0];
    let dy = left[1] - right[1];
    dx.mul_add(dx, dy * dy)
}

fn cross(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
    (b[0] - a[0]).mul_add(c[1] - a[1], -(b[1] - a[1]) * (c[0] - a[0]))
}

fn on_segment(a: [f64; 2], b: [f64; 2], point: [f64; 2]) -> bool {
    const EPSILON: f64 = 1e-8;
    cross(a, b, point).abs() <= EPSILON
        && point[0] >= a[0].min(b[0]) - EPSILON
        && point[0] <= a[0].max(b[0]) + EPSILON
        && point[1] >= a[1].min(b[1]) - EPSILON
        && point[1] <= a[1].max(b[1]) + EPSILON
}

fn segments_intersect(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> bool {
    const EPSILON: f64 = 1e-8;
    let min_ax = a[0].min(b[0]) - EPSILON;
    let max_ax = a[0].max(b[0]) + EPSILON;
    let min_ay = a[1].min(b[1]) - EPSILON;
    let max_ay = a[1].max(b[1]) + EPSILON;
    let min_cx = c[0].min(d[0]) - EPSILON;
    let max_cx = c[0].max(d[0]) + EPSILON;
    let min_cy = c[1].min(d[1]) - EPSILON;
    let max_cy = c[1].max(d[1]) + EPSILON;
    if max_ax < min_cx || max_cx < min_ax || max_ay < min_cy || max_cy < min_ay {
        return false;
    }
    let ab_c = cross(a, b, c);
    let ab_d = cross(a, b, d);
    let cd_a = cross(c, d, a);
    let cd_b = cross(c, d, b);
    (ab_c.abs() <= EPSILON && on_segment(a, b, c))
        || (ab_d.abs() <= EPSILON && on_segment(a, b, d))
        || (cd_a.abs() <= EPSILON && on_segment(c, d, a))
        || (cd_b.abs() <= EPSILON && on_segment(c, d, b))
        || ((ab_c > EPSILON && ab_d < -EPSILON || ab_c < -EPSILON && ab_d > EPSILON)
            && (cd_a > EPSILON && cd_b < -EPSILON || cd_a < -EPSILON && cd_b > EPSILON))
}

fn has_self_intersection(polygon: &[[f64; 2]]) -> bool {
    // SVG outlines are normally a few hundred points.  For an unusually
    // dense path, the vertex limit remains the primary guard; checking the
    // first 2048 points still catches the common malformed/self-crossing case
    // without turning validation itself into a quadratic denial of service.
    let count = polygon.len().min(2_048);
    if count < 4 {
        return false;
    }
    for first in 0..count {
        let first_next = (first + 1) % count;
        for second in (first + 1)..count {
            let second_next = (second + 1) % count;
            if first == second || first_next == second || second_next == first {
                continue;
            }
            if first == 0 && second_next == count {
                continue;
            }
            if segments_intersect(
                polygon[first],
                polygon[first_next],
                polygon[second],
                polygon[second_next],
            ) {
                return true;
            }
        }
    }
    false
}

fn normalized_polygon(points: Vec<[f64; 2]>, id: &str) -> Result<Vec<[f64; 2]>, String> {
    if points.iter().any(|[x, y]| !x.is_finite() || !y.is_finite()) {
        return Err(format!("图片 {id} 的 SVG 轮廓包含无效坐标"));
    }
    let mut cleaned = Vec::with_capacity(points.len());
    for point in points {
        if cleaned
            .last()
            .map(|last| squared_distance(*last, point) <= 1e-12)
            .unwrap_or(false)
        {
            continue;
        }
        cleaned.push(point);
    }
    if cleaned.len() > 1 && squared_distance(cleaned[0], *cleaned.last().unwrap()) <= 1e-12 {
        cleaned.pop();
    }
    if cleaned.len() < 3 {
        return Err(format!("图片 {id} 的 SVG 轮廓退化，无法异形拼版"));
    }
    // Self-intersection validation is intentionally quadratic. Reject rings
    // beyond the checked window instead of allowing an unchecked tail into
    // the native Clipper/NFP code.
    if cleaned.len() > 2_048 {
        return Err(format!(
            "图片 {id} 的 SVG 轮廓点数超过安全校验上限，无法异形拼版"
        ));
    }
    if has_self_intersection(&cleaned) {
        return Err(format!("图片 {id} 的 SVG 轮廓存在自交，无法异形拼版"));
    }
    if polygon_area(&cleaned) <= 1e-8 {
        return Err(format!("图片 {id} 的 SVG 轮廓退化，无法异形拼版"));
    }
    // Native nesters receive a local contour whose lower-left bound is the
    // origin. SVG artwork is frequently authored around its visual centre
    // (negative coordinates are valid SVG), but passing that raw offset into a
    // fresh batch can make every candidate appear outside the sheet.
    let min_x = cleaned
        .iter()
        .map(|[x, _]| *x)
        .fold(f64::INFINITY, f64::min);
    let min_y = cleaned
        .iter()
        .map(|[_, y]| *y)
        .fold(f64::INFINITY, f64::min);
    Ok(cleaned
        .into_iter()
        .map(|[x, y]| [x - min_x, y - min_y])
        .collect())
}

fn qt_instance_id(base_id: &str, ordinal: usize) -> String {
    if ordinal == 0 {
        base_id.to_owned()
    } else {
        format!("{base_id}#qt-{}", ordinal + 1)
    }
}

#[cfg(test)]
pub fn pack_irregular(request: NestRequest) -> Result<NestResult, String> {
    pack_irregular_with_progress(request, None)
}

fn pack_irregular_with_progress(
    request: NestRequest,
    progress: Option<&dyn Fn(IrregularProgressEvent)>,
) -> Result<NestResult, String> {
    let _solver_guard = IRREGULAR_SOLVER_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "异形拼版计算锁已损坏".to_string())?;
    if request.irregular_algorithm != "local-tools" {
        return Err(format!(
            "不支持的拼版算法：{}；当前仅支持本地拼版",
            request.irregular_algorithm
        ));
    }
    let algorithm = request.irregular_algorithm.clone();
    if let Some(report) = progress {
        report(progress_event(
            "validating",
            "running",
            "正在校验图片尺寸和 SVG 轮廓",
            0,
            request.items.len(),
            &algorithm,
        ));
    }
    // An invalid SVG should remove only that asset from the irregular job.
    // Keeping malformed rings in the request used to make the whole job fall
    // back to rectangles, which both wasted memory and rendered the bad asset
    // on top of otherwise valid placements.
    let mut valid_request = request.clone();
    let mut invalid_ids = Vec::new();
    let mut invalid_excluded = Vec::<NestExcludedItem>::new();
    valid_request.items.retain(|item| {
        if item.quantity == 0 {
            return false;
        }
        let valid_dimensions = item.width_mm.is_finite()
            && item.height_mm.is_finite()
            && item.width_mm > 0.0
            && item.height_mm > 0.0;
        let outline_reason = match normalized_polygon(irregular_polygon_points(item), &item.id) {
            Ok(polygon)
                if polygon.len() <= MAX_IRREGULAR_VERTICES_PER_ITEM
                    && polygon_area(&polygon) >= 0.0001 =>
            {
                None
            }
            Ok(_) => Some(format!(
                "图片 {} 的 SVG 轮廓点数或面积不满足异形拼版要求",
                item.id
            )),
            Err(error) => Some(error),
        };
        if valid_dimensions && outline_reason.is_none() {
            true
        } else {
            // Keep malformed assets out of the native solver, but cap the
            // diagnostic expansion. A corrupt QT value must never allocate
            // millions of IDs just to paint one row red in the sidebar.
            let available = MAX_DIAGNOSTIC_QT_IDS.saturating_sub(invalid_ids.len());
            let count = (item.quantity as usize).min(available);
            invalid_ids.extend((0..count).map(|ordinal| qt_instance_id(&item.id, ordinal)));
            invalid_excluded.push(NestExcludedItem {
                id: item.id.clone(),
                reason: outline_reason
                    .unwrap_or_else(|| format!("图片 {} 的尺寸无效，已跳过该图片", item.id)),
            });
            false
        }
    });
    if let Some(report) = progress {
        report(progress_event(
            "nesting",
            "running",
            "正在使用真实轮廓计算异形排版",
            0,
            valid_request.items.len(),
            &algorithm,
        ));
    }
    let mut result = if valid_request.items.is_empty() {
        NestResult {
            placements: Vec::new(),
            unplaced: Vec::new(),
            sheets_used: 0,
            utilization: 0.0,
            algorithm: "tools/local".into(),
            excluded_items: Vec::new(),
            warnings: Vec::new(),
        }
    } else {
        pack_local_irregular(valid_request, progress)?
    };
    if let Some(report) = progress {
        report(progress_event(
            "finalizing",
            "running",
            "正在整理板材、放置位置和未放置图片",
            result.placements.len(),
            result.placements.len() + result.unplaced.len(),
            &algorithm,
        ));
    }
    if !invalid_ids.is_empty() {
        let invalid_count = invalid_ids.len();
        let invalid_assets = invalid_ids
            .iter()
            .map(|id| id.split("#qt-").next().unwrap_or(id.as_str()).to_owned())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let mut invalid_assets = invalid_assets;
        invalid_assets.sort();
        result.unplaced.extend(invalid_ids);
        result.algorithm = format!(
            "{}（已跳过 {} 张无效 SVG 轮廓：{}）",
            result.algorithm,
            invalid_count,
            invalid_assets.join(",")
        );
    }
    result.excluded_items.extend(invalid_excluded);
    result
        .excluded_items
        .sort_by(|left, right| left.id.cmp(&right.id));
    result
        .excluded_items
        .dedup_by(|left, right| left.id == right.id);
    if !result.excluded_items.is_empty() {
        result.warnings.push(format!(
            "{} 个图片因轮廓无法安全异形拼版而跳过，其余图片继续计算",
            result.excluded_items.len()
        ));
    }
    Ok(result)
}

const LOCAL_NESTING_ADAPTER: &str = "src-tauri/src/imposition/local_nesting/local_tools_engine.py";

fn local_tool_root() -> Option<std::path::PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(root) = std::env::var("PRINTFLOW_NESTING_ROOT") {
        candidates.push(std::path::PathBuf::from(root));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd);
        if let Some(parent) = candidates.last().and_then(|path| path.parent()) {
            candidates.push(parent.to_path_buf());
        }
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            candidates.push(parent.to_path_buf());
            candidates.push(parent.join("resources"));
            candidates.push(parent.join("..\resources"));
        }
    }
    candidates
        .into_iter()
        .find(|root| root.join(LOCAL_NESTING_ADAPTER).is_file())
}

fn local_python(root: &Path) -> Option<std::path::PathBuf> {
    if let Ok(value) = std::env::var("PRINTFLOW_NESTING_PYTHON") {
        let path = std::path::PathBuf::from(value);
        if path.is_file() {
            return Some(path);
        }
    }
    let candidates = [
        root.join(".tools/nesting/.venv/Scripts/python.exe"),
        root.join(".tools/nesting/.venv/bin/python"),
        root.join(".tools/nesting/python.exe"),
    ];
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .or_else(|| Some(std::path::PathBuf::from("python")))
}

fn parse_local_result(stdout: &[u8], algorithm: &str) -> Result<NestResult, String> {
    let value: serde_json::Value = serde_json::from_slice(stdout)
        .map_err(|error| format!("{algorithm} 适配器输出不是有效 JSON：{error}"))?;
    if value.get("ok").and_then(serde_json::Value::as_bool) == Some(false) {
        let message = value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("适配器返回失败")
            .to_owned();
        return Err(format!("{algorithm}：{message}"));
    }
    let result = value.get("result").cloned().unwrap_or(value);
    let parsed: NestResult = serde_json::from_value(result)
        .map_err(|error| format!("{algorithm} 结果字段不符合拼版协议：{error}"))?;
    if parsed.algorithm.contains("unavailable") {
        return Err(format!("{algorithm} 当前运行时不可用"));
    }
    if parsed.placements.iter().any(|placement| {
        !placement.x_mm.is_finite()
            || !placement.y_mm.is_finite()
            || !placement.width_mm.is_finite()
            || !placement.height_mm.is_finite()
            || placement.width_mm <= 0.0
            || placement.height_mm <= 0.0
    }) {
        return Err(format!("{algorithm} 返回了无效的图片位置或尺寸"));
    }
    Ok(parsed)
}

fn pack_local_irregular(
    request: NestRequest,
    progress: Option<&dyn Fn(IrregularProgressEvent)>,
) -> Result<NestResult, String> {
    let algorithm = request.irregular_algorithm.clone();
    let root = local_tool_root().ok_or_else(|| {
        format!(
            "{algorithm} 适配器未找到：请保留 src-tauri/src/imposition/local_nesting 源码与 .tools/nesting 运行时"
        )
    })?;
    let python =
        local_python(&root).ok_or_else(|| format!("{algorithm} 适配器未找到 Python 运行时"))?;
    let script = root.join(LOCAL_NESTING_ADAPTER);
    if !script.is_file() {
        return Err(format!(
            "{algorithm} 适配器脚本不存在：{}",
            script.display()
        ));
    }
    let payload = serde_json::to_vec(&serde_json::json!({
        "engine": "local-tools",
        "request": request,
    }))
    .map_err(|error| error.to_string())?;
    let mut command = Command::new(python);
    command
        .arg(script)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("{algorithm} 适配器启动失败：{error}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(&payload)
            .map_err(|error| format!("{algorithm} 适配器输入失败：{error}"))?;
    }
    // Adapters may legitimately take longer for large true-shape jobs. Do not
    // impose a wall-clock kill here; the UI receives stage events while this
    // process is running and keeps the calculation state visible.
    let output = collect_adapter_output(child, &algorithm, progress)?;
    if !output.status.success() && output.stdout.is_empty() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(format!("{algorithm} 适配器退出失败：{}", detail.trim()));
    }
    parse_local_result(&output.stdout, &algorithm)
}

fn collect_adapter_output(
    mut child: std::process::Child,
    algorithm: &str,
    progress: Option<&dyn Fn(IrregularProgressEvent)>,
) -> Result<std::process::Output, String> {
    // Drain both pipes before waiting: a large QT result can fill the Windows
    // pipe buffer and otherwise deadlock a successfully completed solver.
    let mut stdout = child.stdout.take().ok_or("适配器输出管道不可用")?;
    let stderr = child.stderr.take().ok_or("适配器错误管道不可用")?;
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).map(|_| bytes)
    });
    let (progress_tx, progress_rx) = std::sync::mpsc::channel();
    let stderr_reader = thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut bytes = Vec::new();
        let mut line = String::new();
        loop {
            line.clear();
            if reader.read_line(&mut line)? == 0 {
                break;
            }
            if let Some(payload) = line.trim().strip_prefix(WORKER_PROGRESS_PREFIX) {
                if let Ok(event) = serde_json::from_str::<IrregularProgressEvent>(payload) {
                    let _ = progress_tx.send(event);
                    continue;
                }
            }
            bytes.extend_from_slice(line.as_bytes());
        }
        Ok::<_, std::io::Error>(bytes)
    });
    let status = loop {
        for event in progress_rx.try_iter() {
            if let Some(report) = progress {
                report(event);
            }
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("{algorithm} 适配器状态读取失败：{error}"))?
        {
            break status;
        }
        thread::sleep(Duration::from_millis(25));
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| "适配器输出线程异常")?
        .map_err(|error| format!("读取适配器输出失败：{error}"))?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "适配器错误线程异常")?
        .map_err(|error| format!("读取适配器错误失败：{error}"))?;
    for event in progress_rx.try_iter() {
        if let Some(report) = progress {
            report(event);
        }
    }
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

fn map_point(transform: tiny_skia::Transform, point: Point) -> Point {
    let mut mapped = point;
    transform.map_point(&mut mapped);
    mapped
}

fn sampled_paths(path: &usvg::Path) -> Vec<Vec<[f64; 2]>> {
    let transform = path.abs_transform();
    let mut subpaths = Vec::new();
    let mut points = Vec::new();
    let mut current = Point::from_xy(0.0, 0.0);
    let mut start = current;
    for segment in path.data().segments() {
        if points.len() > MAX_IRREGULAR_VERTICES_PER_ITEM {
            break;
        }
        match segment {
            PathSegment::MoveTo(point) => {
                if points.len() >= 3 {
                    subpaths.push(std::mem::take(&mut points));
                }
                current = point;
                start = point;
                points.push(map_point(transform, point));
            }
            PathSegment::LineTo(point) => {
                current = point;
                points.push(map_point(transform, point));
            }
            PathSegment::QuadTo(control, point) => {
                let from = current;
                for step in 1..=8 {
                    if points.len() > MAX_IRREGULAR_VERTICES_PER_ITEM {
                        break;
                    }
                    let t = step as f32 / 8.0;
                    let inverse = 1.0 - t;
                    let sampled = Point::from_xy(
                        inverse * inverse * from.x
                            + 2.0 * inverse * t * control.x
                            + t * t * point.x,
                        inverse * inverse * from.y
                            + 2.0 * inverse * t * control.y
                            + t * t * point.y,
                    );
                    points.push(map_point(transform, sampled));
                }
                current = point;
            }
            PathSegment::CubicTo(control_a, control_b, point) => {
                let from = current;
                for step in 1..=12 {
                    if points.len() > MAX_IRREGULAR_VERTICES_PER_ITEM {
                        break;
                    }
                    let t = step as f32 / 12.0;
                    let inverse = 1.0 - t;
                    let sampled = Point::from_xy(
                        inverse.powi(3) * from.x
                            + 3.0 * inverse.powi(2) * t * control_a.x
                            + 3.0 * inverse * t.powi(2) * control_b.x
                            + t.powi(3) * point.x,
                        inverse.powi(3) * from.y
                            + 3.0 * inverse.powi(2) * t * control_a.y
                            + 3.0 * inverse * t.powi(2) * control_b.y
                            + t.powi(3) * point.y,
                    );
                    points.push(map_point(transform, sampled));
                }
                current = point;
            }
            PathSegment::Close => {
                current = start;
            }
        }
    }
    if points.len() >= 3 {
        subpaths.push(points);
    }
    subpaths
        .into_iter()
        .map(|points| {
            points
                .into_iter()
                .map(|point| [point.x as f64, point.y as f64])
                .collect()
        })
        .collect()
}

fn polygon_area(polygon: &[[f64; 2]]) -> f64 {
    polygon
        .iter()
        .enumerate()
        .map(|(index, point)| {
            let next = polygon[(index + 1) % polygon.len()];
            point[0] * next[1] - next[0] * point[1]
        })
        .sum::<f64>()
        .abs()
        / 2.0
}

fn extract_svg_polygon(
    path: &Path,
    width_mm: f64,
    height_mm: f64,
) -> Result<Vec<[f64; 2]>, String> {
    let byte_length = fs::metadata(path)
        .map_err(|error| format!("读取 SVG 轮廓失败：{error}"))?
        .len();
    if byte_length > MAX_OUTLINE_SVG_BYTES {
        return Err(format!(
            "SVG 轮廓文件过大（超过 {} MB）",
            MAX_OUTLINE_SVG_BYTES / 1024 / 1024
        ));
    }
    let bytes = fs::read(path).map_err(|error| format!("读取 SVG 轮廓失败：{error}"))?;
    let options = crate::assets::options();
    let tree = usvg::Tree::from_data(&bytes, &options)
        .map_err(|error| format!("解析 SVG 轮廓失败：{error}"))?;
    let mut paths = Vec::new();
    fn visit(node: &Node, paths: &mut Vec<Vec<[f64; 2]>>) {
        match node {
            Node::Group(group) => group
                .children()
                .iter()
                .for_each(|child| visit(child, paths)),
            Node::Path(path)
                if path.is_visible() && (path.fill().is_some() || path.stroke().is_some()) =>
            {
                for polygon in sampled_paths(path) {
                    let polygon = clean_polygon(polygon);
                    if polygon.len() >= 3 {
                        paths.push(polygon);
                    }
                }
            }
            _ => {}
        }
    }
    tree.root()
        .children()
        .iter()
        .for_each(|child| visit(child, &mut paths));
    let mut polygon = paths
        .into_iter()
        .max_by(|left, right| polygon_area(left).total_cmp(&polygon_area(right)))
        .ok_or("SVG 中没有可用于异形拼版的闭合路径".to_owned())?;
    let scale_x = width_mm / tree.size().width() as f64;
    let scale_y = height_mm / tree.size().height() as f64;
    // Keep the SVG viewport origin: the canvas displays the full source image,
    // including transparent margins. Moving the outline to (0, 0) here would
    // shift collision geometry away from that image, especially after rotation.
    // Solvers that need origin-normalized geometry do so in their own adapter.
    for point in &mut polygon {
        point[0] *= scale_x;
        point[1] *= scale_y;
    }
    Ok(polygon)
}

#[tauri::command]
pub async fn pack_imposition_irregular(
    request: NestRequest,
    app: tauri::AppHandle,
) -> Result<NestResult, String> {
    let algorithm = request.irregular_algorithm.clone();
    let request_item_count = request.items.len();
    emit_progress(
        Some(&app),
        progress_event(
            "starting",
            "running",
            "正在启动本地异形拼版",
            0,
            request_item_count,
            &algorithm,
        ),
    );
    // The Python adapter owns a separate process and the bounded Rust search
    // core. Do not terminate a valid calculation because of elapsed time.
    let calculation_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let reporter = |event| emit_progress(Some(&calculation_app), event);
        pack_irregular_with_progress(request, Some(&reporter))
    })
    .await
    .map_err(|error| error.to_string())?;
    match &result {
        Ok(value) => emit_progress(
            Some(&app),
            progress_event(
                "completed",
                "completed",
                "异形排版计算完成",
                value.placements.len(),
                value.placements.len() + value.unplaced.len(),
                &algorithm,
            ),
        ),
        Err(error) => emit_progress(
            Some(&app),
            progress_event("failed", "failed", error, 0, request_item_count, &algorithm),
        ),
    }
    result
}

#[tauri::command]
pub async fn load_imposition_polygon(
    path: String,
    width_mm: f64,
    height_mm: f64,
) -> Result<Vec<[f64; 2]>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _outline_guard = OUTLINE_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|_| "SVG 轮廓计算锁已损坏".to_string())?;
        extract_svg_polygon(Path::new(&path), width_mm, height_mm)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rotated_polygon_bounds(polygon: &[[f64; 2]], rotation_deg: f64) -> (f64, f64, f64, f64) {
        let angle = rotation_deg.to_radians();
        let (sin, cos) = angle.sin_cos();
        polygon.iter().fold(
            (
                f64::INFINITY,
                f64::INFINITY,
                f64::NEG_INFINITY,
                f64::NEG_INFINITY,
            ),
            |bounds, point| {
                let x = cos * point[0] - sin * point[1];
                let y = sin * point[0] + cos * point[1];
                (
                    bounds.0.min(x),
                    bounds.1.min(y),
                    bounds.2.max(x),
                    bounds.3.max(y),
                )
            },
        )
    }

    #[test]
    fn svg_outline_keeps_its_position_inside_the_image_viewport() {
        let path = std::env::temp_dir().join(format!(
            "printflow-outline-offset-{}.svg",
            std::process::id()
        ));
        fs::write(&path, r#"<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="10mm" viewBox="0 0 20 10"><path d="M2 3 L18 3 L18 9 L2 9 Z"/></svg>"#).unwrap();
        let polygon = extract_svg_polygon(&path, 20.0, 10.0).unwrap();
        let _ = fs::remove_file(path);
        let (min_x, min_y, max_x, max_y) = rotated_polygon_bounds(&polygon, 0.0);
        assert!((min_x - 2.0).abs() < 1e-5);
        assert!((min_y - 3.0).abs() < 1e-5);
        assert!((max_x - 18.0).abs() < 1e-5);
        assert!((max_y - 9.0).abs() < 1e-5);
    }

    #[test]
    #[ignore = "requires the local tools Python runtime"]
    fn local_tools_adapter_roundtrip_reports_progress_and_real_placements() {
        let events = std::cell::RefCell::new(Vec::new());
        let reporter = |event: IrregularProgressEvent| events.borrow_mut().push(event);
        let result = pack_irregular_with_progress(
            NestRequest {
                plate_width_mm: 100.0,
                plate_height_mm: 80.0,
                effective_width_mm: 85.0,
                effective_height_mm: 60.0,
                effective_right_mm: 5.0,
                spacing_mm: 3.0,
                objective: "least-material".into(),
                irregular_algorithm: "local-tools".into(),
                items: vec![NestItem {
                    id: "tools-probe".into(),
                    width_mm: 10.0,
                    height_mm: 8.0,
                    quantity: 5,
                    polygon: Some(vec![[1.0, 1.0], [9.0, 1.0], [5.0, 7.0]]),
                }],
            },
            Some(&reporter),
        )
        .unwrap();
        assert_eq!(result.placements.len(), 5);
        assert_eq!(result.sheets_used, 1);
        assert!(result.unplaced.is_empty());
        assert!(result.algorithm.starts_with("tools/material"));
        assert!(events
            .borrow()
            .iter()
            .any(|event| event.detail.contains("QT 共用")));
        assert!(events
            .borrow()
            .iter()
            .any(|event| event.detail.contains("验证真实轮廓")));
        assert!(result
            .placements
            .iter()
            .all(|p| p.x_mm >= 10.0 && p.y_mm >= 10.0));
    }

    #[test]
    #[ignore = "requires the local tools Python runtime"]
    fn skips_only_invalid_irregular_assets_and_keeps_valid_placements() {
        let result = pack_irregular(NestRequest {
            plate_width_mm: 100.0,
            plate_height_mm: 100.0,
            effective_width_mm: 100.0,
            effective_height_mm: 100.0,
            effective_right_mm: 0.0,
            spacing_mm: 3.0,
            objective: "combined".into(),
            irregular_algorithm: "local-tools".into(),
            items: vec![
                NestItem {
                    id: "valid".into(),
                    width_mm: 20.0,
                    height_mm: 20.0,
                    quantity: 1,
                    polygon: Some(vec![[0.0, 0.0], [20.0, 0.0], [20.0, 20.0], [0.0, 20.0]]),
                },
                NestItem {
                    id: "invalid".into(),
                    width_mm: 20.0,
                    height_mm: 20.0,
                    quantity: 2,
                    polygon: Some(vec![[0.0, 0.0], [20.0, 20.0], [20.0, 0.0], [0.0, 20.0]]),
                },
            ],
        })
        .unwrap();
        assert_eq!(result.placements.len(), 1);
        assert!(result
            .placements
            .iter()
            .all(|placement| placement.id == "valid"));
        assert!(result.unplaced.iter().any(|id| id == "invalid"));
        assert!(result.unplaced.iter().any(|id| id == "invalid#qt-2"));
        assert!(result.algorithm.contains("无效 SVG 轮廓"));
    }

    #[test]
    #[ignore = "requires the local tools Python runtime"]
    fn invalid_quantity_does_not_expand_without_bound() {
        let result = pack_irregular(NestRequest {
            plate_width_mm: 100.0,
            plate_height_mm: 100.0,
            effective_width_mm: 100.0,
            effective_height_mm: 100.0,
            effective_right_mm: 0.0,
            spacing_mm: 3.0,
            objective: "least-sheets".into(),
            irregular_algorithm: "local-tools".into(),
            items: vec![
                NestItem {
                    id: "valid-dimension".into(),
                    width_mm: 20.0,
                    height_mm: 20.0,
                    quantity: 1,
                    polygon: Some(vec![[0.0, 0.0], [20.0, 0.0], [20.0, 20.0], [0.0, 20.0]]),
                },
                NestItem {
                    id: "bad-dimension".into(),
                    width_mm: f64::NAN,
                    height_mm: 20.0,
                    quantity: u32::MAX,
                    polygon: Some(vec![[0.0, 0.0], [20.0, 0.0], [20.0, 20.0]]),
                },
            ],
        })
        .unwrap();
        assert_eq!(result.placements.len(), 1);
        assert!(result.unplaced.len() <= MAX_DIAGNOSTIC_QT_IDS);
        assert!(result.algorithm.contains("bad-dimension"));
    }

    #[test]
    fn removed_algorithm_is_rejected_without_running_local_solver() {
        let result = pack_irregular(NestRequest {
            plate_width_mm: 100.0,
            plate_height_mm: 100.0,
            effective_width_mm: 100.0,
            effective_height_mm: 100.0,
            effective_right_mm: 0.0,
            spacing_mm: 3.0,
            objective: "least-material".into(),
            irregular_algorithm: "not-a-real-engine".into(),
            items: vec![NestItem {
                id: "external-tool-probe".into(),
                width_mm: 20.0,
                height_mm: 20.0,
                quantity: 1,
                polygon: Some(vec![[0.0, 0.0], [20.0, 0.0], [20.0, 20.0], [0.0, 20.0]]),
            }],
        })
        .unwrap_err();
        assert!(result.contains("not-a-real-engine"));
    }

    #[test]
    fn accepts_disconnected_svg_subpaths_as_separate_candidates() {
        // The extraction routine keeps each MoveTo ring separate; this test
        // exercises the ring validator used before a native solver call.
        let first = normalized_polygon(
            vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]],
            "subpath-a",
        )
        .unwrap();
        let second = normalized_polygon(
            vec![[20.0, 20.0], [30.0, 20.0], [30.0, 30.0], [20.0, 30.0]],
            "subpath-b",
        )
        .unwrap();
        assert_eq!(first.len(), 4);
        assert_eq!(second.len(), 4);
    }
}

#[cfg(test)]
#[path = "real_nesting_job_test.rs"]
mod real_nesting_job_test;
