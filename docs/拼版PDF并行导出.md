# 拼版 PDF 并行导出

更新：2026-10-22。适用于拼版模块的板材 PDF；不改变示意图 A4 导出管线。

## 执行方式

- 从操作系统读取可用逻辑处理器数，转换线程总预算为 `max(1, floor(N × 80%))`。这是线程预算，并非强制 CPU 占用率维持 80%。导出界面没有手动线程选项；拼版计算的既有线程设置保持独立。
- 前端一次只生成、传输一个 SVG，最多两个版式任务在途，避免同时生成多份包含大型 Base64 图片的字符串。原始图片不降采样。
- Rust 全局调度器同时限制后台进程数、总转换线程数和内存预留。大页面按 SVG 大小估算解码和 PDF 组装开销；两个版式不能重复占用同一份可用内存。内存不足时，版式会排队。
- 每个版式在当前程序的独立后台进程中转换，启动入口在初始化 Tauri 之前，因此不会产生第二个窗口或再次启动本地 API。
- 每批页面开始前检查物理可用内存、系统提交余量和工作进程的内存上限余量，再按页面大小控制该批并行数。内存压力下降时允许恢复并行，最高仍受原有 CPU/内存额度限制。大小估算是保守启发式，不能精确预测任意压缩图片的解码峰值。
- 页面可乱序完成，合并必须按输入页序执行。轮廓、图片 1、图片 2、彩窗、白墨的既有顺序不变，各页使用独立 PDF 资源编号。
- Windows 使用 Job Object 设置工作进程内存硬上限和关闭时回收；进程内也捕获可恢复的线程错误。普通 Rust 错误捕获不能拦截 OOM abort，因此必须有进程隔离。异常退出时最多降低为单页面线程重试一次；仍失败则返回错误，保留已经成功的文件。
- 工作进程仅写自己的暂存 PDF。目标目录的复制、同步和最终提交由主进程中的全局互斥锁串行执行。先写同目录临时文件再原子提交，不覆盖已经存在或在预检查后新出现的同名文件。主进程不一次性读取整个成品 PDF。
- 某个版式失败后不再启动后续版式；等待其他在途任务结束后再清理其 SVG，避免清理仍被转换进程引用的资源。

## 保持的导出规则

毫米板材尺寸、图片位置和旋转、SVG 裁剪/遮罩/渐变/透明度、版面孔、每页 0.2 mm 外边框均保持。相同版式只导出一份多页 PDF，生产数量仍由现有文件命名表达。

进度区分等待 CPU/内存额度、读取资源、解析 SVG、转换、按图层顺序合并和写盘；多任务进度按各自导出 ID 关联。

## 检查记录

使用 Vitest、Rust 原生测试、独立工作进程、Windows Job Object、Poppler、Pillow 和 pypdf 验证。PDF 转换继续使用 usvg、svg2pdf 和 pdf-writer，无新增转换引擎或外部安装要求。

真实订单为 `Backup_of_Raine Gaming`：18 张原 SVG、250 份 QT、2 种版式，各生产 5 块。通过实际 `impositionSvgExport.ts` 生成 4 张测试 SVG，总大小 122,396,527 字节（约 116.7 MiB）。

同机一次对照结果如下；开发环境存在其他程序负载，结果不能代表所有机器：

| 测试方式 | 耗时 | 说明 |
| --- | ---: | --- |
| 4 页单 PDF，单线程转换 | 62.399 秒 | 159,404,679 字节 |
| 4 页单 PDF，自动线程预算 6 | 60.618 秒 | 内存额度限制实际并行；159,404,679 字节 |
| 两个真实版式 PDF，受限并发 | 63.686 秒 | 内存压力可使版式排队；没有稳定提速结论 |

此批主要受大图解码/转换和内存余量限制，增加线程没有显著提速。不能将线程预算理解为速度提升倍数。

首轮压力测试暴露固定“每进程分一半内存”不适用于重图片页面，后台进程触及上限退出；随后改为按页面大小预留和批次加权调度，以上三种测试全部完成。坏页不会生成半成品 PDF。五页颜色标记用例验证轮廓、图片 1、图片 2、彩窗、白墨顺序；原生测试覆盖资源引用、尺寸、孔、边框、并发提交和失败清理。

Poppler 以 45 DPI 渲染三种导出结果后，Pillow 对比 4 张对应页面，逐像素一致；pypdf 检查页数、300 × 464 mm 媒体框和 0.2 mm 边框。另以仅限子进程的 1 MiB Windows Job 上限触发资源异常（复测分别为 `0xc0000142`、`0xc000012d`），宿主测试进程保持运行，子进程已回收且没有成品/半成品 PDF。该测试不耗尽整机内存。工作进程也以 Windows GUI 子系统入口复测，确认不弹第二个窗口且进度管道可用。

最终相关检查：前端 23 项、原生及隔离进程 15 项、真实大图基准 1 项通过，TypeScript 构建检查通过。

## 复测入口

关闭其他高负载测试，依次执行，避免编译和大图导出争用内存：

```powershell
npx vitest run tests/imposition-pdf-export-service.test.ts tests/imposition-pdf-export-modal.test.tsx --maxWorkers=1
npx tsc -b
Push-Location src-tauri
cargo test --lib imposition_pdf
cargo build --example imposition_pdf_worker
Pop-Location
```

`scripts/prepare-imposition-pdf-benchmark.cjs` 接受只读任务 JSON、拼版结果 JSON、新建输出目录，按当前导出管线生成 300 × 464 mm 测试页、版面孔及 `pages.json`、`plan.json`。此工具不会修改订单；输出目录必须不存在。

```powershell
node scripts/prepare-imposition-pdf-benchmark.cjs <job.json> <result.json> <新建目录>
$env:PRINTFLOW_PDF_WORKER_EXE = 'D:/project/productionAPP/.cargo-target/debug/examples/imposition_pdf_worker.exe'
$env:PRINTFLOW_PDF_BENCHMARK_DIR = '<测试目录>'
$env:PRINTFLOW_PDF_BENCHMARK_PAGES = Get-Content -Raw '<测试目录>/pages.json'
Push-Location src-tauri
cargo test --lib benchmark_actual_isolated_pages -- --ignored --nocapture
cargo test --lib windows_memory_abort_is_isolated_and_reaped -- --ignored --nocapture
Pop-Location
```

基准的双版式分组入口针对本次每版式两页的真实数据；其他图层数量应按 `plan.json` 分组比较。再次运行基准应使用新目录，避免覆盖前次成品。
