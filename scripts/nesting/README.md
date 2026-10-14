# 本地异形拼版

当前只提供本地拼版，不再提供外部算法切换。运行源码统一位于 `src-tauri/src/imposition/local_nesting/`，本目录仅保留安装、构建和测试脚本。两种策略共用轮廓和掩码缓存，以及 release Rust 位图搜索核心：

- 节省板材：单板尽量多放，优先利用已打开板材的空隙。
- 切割方案优先：搜索可重复使用的统一版式，同时尽量提高单板放入数量。

所有输入输出使用毫米 JSON；每种基础图片只提交一份轮廓和 QT 数量。无效轮廓按资产返回原因并继续处理其余图片，不生成矩形兜底结果。

## 源码与运行时

- `src-tauri/src/imposition/local_nesting/local_tools_engine.py`：毫米 JSON 入口、进度与最终几何校验。
- 同目录 `nesting_common.py`：共享轮廓掩码、单板搜索和节省板材策略。
- 同目录 `nest_uniform.py`：切割方案优先策略。
- 同目录 `nesting_rust.py`、`rust_core/`：Python 调用接口和 Rust 搜索核心。
- `.tools/nesting/.venv`、`.tools/nesting/native`：本机 Python 依赖和已编译 DLL，继续保留。

根目录旧 `tools/` 中的独立 GUI、CLI、配置和旧导出入口已移除。真实 SVG 基准采样辅助独立放在 `svg_benchmark_geometry.py`，生产搜索只接收已提取的轮廓，不导入该辅助模块。

## 安装与验证

安装：`powershell -File scripts/nesting/setup_local_tools.ps1`。

生产依赖见 `requirements-local-tools.txt`。运行真实 SVG 基准及完整测试前，再安装开发依赖：`& .tools/nesting/.venv/Scripts/python.exe -m pip install -r scripts/nesting/requirements-benchmark.txt`；其中的 `svgpathtools` 不参与生产计算入口。

本地两种策略共用 release Rust 位图搜索核心；Python 保留轮廓准备、策略调度、最终几何校验及可切换的参考搜索。安装脚本同时构建独立 DLL，不需要将整个 Tauri 应用切换到 release。仅安装 Python 可加 `-PythonOnly`；候选 DLL 单独构建使用 `build_rust_core.ps1 -SkipDeploy`。

默认 `PRINTFLOW_NESTING_CORE=auto`。可设为 `python` 或 `rust` 做同输入对照，`PRINTFLOW_NESTING_THREADS` 控制 1/2/4 个搜索线程（默认 2，低内存降为 1）。`PRINTFLOW_NESTING_CORE_LIBRARY` 可指定候选库。实际核心和回退原因写入结果 `searchCore` 及算法说明，原生失败不会被误报成 Rust 结果。完整实现与测量方法见 `docs/本地拼版Rust搜索核心与性能验收-2026-10-13.md`。

输入 stdin 为 `{ "engine": "local-tools", "request": { ... } }`，每种图片仅提交一个 `polygon` 和 `quantity`。`least-material` 调用节省板材策略，`least-cutting` 调用切割方案优先策略。stdout 只有毫米 `NestResult` JSON；stderr 的 `PRINTFLOW_PROGRESS` 行由 Tauri 实时转发。

```powershell
& .tools/nesting/.venv/Scripts/python.exe -B -m unittest discover -s scripts/nesting -p 'test_*.py'
& .tools/nesting/.venv/Scripts/python.exe -B scripts/nesting/benchmark_local_tools.py --objective material --quantity-mode synthetic --output-dir "$env:TEMP/printflow-nesting-check/material"
& .tools/nesting/.venv/Scripts/python.exe -B scripts/nesting/benchmark_local_tools.py --objective uniform --quantity-mode synthetic --output-dir "$env:TEMP/printflow-nesting-check/uniform"
```

基准默认探测 `printflow-data/assets/` 下第一个含 SVG 的目录，也可用 `--svg-dir` 指定；默认每种图片 QT 为 1，`--quantity-mode synthetic` 使用循环测试 QT，不修改生产订单。历史 84 种图片样本的循环 QT 合计为 1005 份，不代表其他目录的样本数量。输出包含原图 SVG 预览及独立的间距、越界、数量、重复版式检查。该工具独立解析 SVG，会记录修复过的输入轮廓；应用端通过 Rust 提取的轮廓须另用 Rust 适配回归验证，不能把两种采样结果混作完全相同的测试。

## 2026-10-13 目录迁移验收

- Python 回归 40 项全部通过，无跳过：覆盖适配器、真实 SVG 的 Python/Rust 对照、数量共享、间距及内存错误恢复。
- 移动后的 Rust crate 单元测试 5 项通过；`build_rust_core.ps1 -SkipDeploy` 成功构建 release DLL。
- Tauri 实际调用新 Python 入口的往返测试通过；拼版页面测试 13 项通过。
- 同一批 4 种真实 SVG、每种 QT 3，分别执行迁移前后两种策略：均放置 12 件、使用 1 块板和 1 个版式，放置坐标及顺序完全相同；独立真实轮廓校验无越界、重叠或小于 3 mm 的间距。
- 独立 benchmark CLI 使用真实 4 种 SVG、每种 QT 1 完成计算、几何检查及 SVG 预览输出。临时对照报告保存在系统临时目录，不再写入项目根目录。

此次只整理运行模块并移除独立工具闲置代码，不改变拼版搜索策略。旧源码快照与测试报告为临时验收数据，不属于运行依赖。
