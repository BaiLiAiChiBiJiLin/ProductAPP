# 拼版 PDF 并行导出

更新：2026-10-22。适用于拼版模块的板材 PDF；不改变示意图 A4 导出管线。

## 执行方式

- 导出窗口的“导出 PDF”“导出 DXF”“导出 CMYK PDF”默认勾选，可独立取消或单独导出。文件清单和数量只包含实际选中的输出；全部取消时无法开始导出。关闭普通 PDF 后不生成普通 PDF 页面，DXF 只暂存轮廓页，CMYK 只处理所需原图。没有所选类型内容的版式会跳过；同名检查与完成提示按实际文件类型执行。
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

## 伴随轮廓 DXF

选择导出 PDF 时，包含“轮廓 / 路径”页面的每种版式，额外生成一个同名 `.dxf`；没有轮廓页时仅输出 PDF。相同版式仍只导出一份，沿用原来的日期、B 版式数和 F 生产板材数命名。弹窗显示待导出的 PDF / DXF 数量和 DXF 转换进度。

- DXF 直接复用该轮廓页已暂存的 SVG，不重新生成整版，不解码图片，不增加 Python 或 CAD 运行依赖。
- 使用现有 usvg 处理嵌套 SVG、viewBox、defs/use、平移和旋转，按毫米 1:1 输出 DXF R2000。SVG 顶部原点转换为 DXF 底部原点，板材上的相对位置不变。
- `CUT` 图层统一输出 LWPOLYLINE，保留闭合状态、内部孔和分离子路径。曲线在完成位置、旋转和缩放变换后，以 0.005 mm 最大偏差做自适应细分；二阶贝塞尔先精确转换为三阶，SVG 圆弧沿用 usvg 的贝塞尔近似。`HOLES` 图层单独输出版面孔的真实 CIRCLE，圆心和半径来自毫米元数据。
- 文件格式由独立的 `imposition_dxf_format.rs` 生成。补齐九种标准表、模型/图纸空间 BLOCK_RECORD 与 BLOCKS、实体的模型空间 owner、根对象字典和默认视口，使用 CRLF 行尾。输出仍为 R2000 毫米格式。
- 不包含 PDF 后加的 0.2 mm 印刷边框、画布利用率和选中框。筛选 SVG 图层后留下的空裁剪分组不会阻止导出。
- 当前支持完整路径及未截断路径的矩形视口裁剪。有效切割图层包含图片、复杂裁剪、遮罩、滤镜或实际被裁剪截断的路径时，DXF 明确报错，避免错误切割线；先成功生成的 PDF 保留，界面指出失败的 DXF 文件。
- PDF 和 DXF 一起检查同名冲突，最终写盘共用串行锁与原子提交，不覆盖已有文件。轮廓转换使用单独互斥锁，避免多个版式同时解析轮廓造成内存峰值。

验证使用独立 ezdxf 读取器（仅测试环境），检查毫米单位、几何、闭合曲线、孔径、孔位和 DXF 结构。真实 `Backup_of_Raine Gaming` 两个版式分别含 28 / 22 个放置项，导出 54 / 42 条切割子路径和各 5 个真实圆孔，读取审计均为 0 错误、0 修复；渲染后与已有轮廓 PDF 的布局核对一致。另以嵌套视口与旋转用例核对坐标，偏差小于 0.0001 mm。

原生 DXF 用例：`cargo test --lib imposition_dxf::tests`。手动独立读取验证可设置 `PRINTFLOW_DXF_INPUT` 为 300 × 464 mm 的轮廓 SVG、`PRINTFLOW_DXF_OUTPUT` 为不存在的 `.dxf` 绝对路径，再运行 `cargo test --lib imposition_dxf::tests::export_validation_fixture -- --ignored --nocapture`；不设输入则使用内置旋转/曲线/圆孔用例。该入口同时检查不会覆盖已生成的文件。

### CorelDRAW / LibreOffice 兼容性复测

仅通过 ezdxf 审计不足以确认绘图软件能正常导入。用户提供的 `1.dxf` 为 CorelDRAW 2020 输出：AC1021（2007）、毫米、71 条 SPLINE，包含 HEADER / CLASSES / TABLES / BLOCKS / ENTITIES / OBJECTS 以及九种标准表。旧导出为 AC1015（2000），只有 HEADER / TABLES / ENTITIES，缺少模型空间及实体 owner。版本、闭合/周期样条标志和节点数量均存在差别，不能仅凭这些差别认定曲线无效。

实测区分出两个问题：

1. **CorelDRAW 文件结构兼容性**：旧文件不能用 CorelDRAW 2020 `OpenDocument` 打开；仅更换行尾或版本号仍失败。保留原 SPLINE 几何、补齐标准结构与模型空间归属后，59 个对象全部导入成功，因此不能归因于 CorelDRAW 不支持 SPLINE。
2. **LibreOffice 曲线支持**：旧真实文件和用户提供的 CorelDRAW SPLINE 文件均未导入样条轮廓。保留原头部、只把 SPLINE 换成 LWPOLYLINE 后，54 条轮廓全部显示。这是不能仅靠文件结构修复的问题。

最终默认输出同时采用完整标准结构和兼容多段线。两块真实版式在 CorelDRAW 2020 中分别导入 59 / 47 个对象；LibreOffice 转换结果分别包含 54 / 42 条轮廓路径和各 5 个圆孔。ezdxf 审计均为 0 错误、0 修复。与原样条逐条抽样对照的最大偏差分别约 0.003690 / 0.003629 mm；文件毫米坐标、旋转、轮廓闭合和孔径保留。

自动测试覆盖自适应细分误差（包含回折、闭环与大尺寸曲线）、文件结构、变换和圆孔。安装目标软件后，可从 `src-tauri` 串行运行以下实际导入回归：

```powershell
$env:PRINTFLOW_DXF_LIBREOFFICE = 'C:/Program Files/LibreOffice/program/soffice.com'
cargo test --lib libreoffice_import_keeps_curved_contours -- --ignored --nocapture
cargo test --lib coreldraw_import_keeps_contours_and_millimetre_scale -- --ignored --nocapture
```

LibreOffice 使用独立临时配置，检查导入后仍有两个曲线对象；此用例在修复前为 0 个、修复后为 2 个。CorelDRAW 使用已安装的 COM 接口，只打开、关闭生成的测试文档，不保存或关闭用户文档，并恢复原活动文档；检查对象数量和 60 mm 的实际宽度。

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

### 2026-10-22：超大交错 PNG 导出异常

再次复现了截图中的 `0xc0000409`。`Backup_of_Raine Gaming` 的 `1d408003-653b-4c96-a6ed-3edb0ce950f6-1.svg` 含 9774 × 13386（130,834,764 像素）RGBA PNG；`...-2.svg` 含 8300 × 13386（111,103,800 像素）PNG。在 1536 MiB 的 Windows 子进程内存上限下，两者原实现都在 PDF 转换阶段因内存分配失败退出。将前者减为一张图片、一个副本、一个页面，仍稳定复现，stderr 为 `memory allocation of 130834764 bytes failed`。这与轮廓计算无关。

修复使用本地 `src-tauri/vendor/svg2pdf` 补丁：非交错 PNG 按行解码并压缩；Adam7 PNG 以匿名临时文件保存扫描 pass，再按行重建，避免整个 RGBA、RGB 和 alpha 平面同时常驻内存。QT 副本共用 PDF 图片和透明度资源。原始像素、透明度和 16 位精度保留，不通过降低分辨率规避问题。

本轮验证：

- 原先单副本在 1536 MiB 上限下崩溃的 SVG，修复后在 **384 MiB** 子进程上限下成功导出。
- 用截图对应任务的 18 个原始 SVG，每张放置 23 个含旋转的副本，分别经过当前前端 SVG 导出器与真正的后台进程；共 36 页全部成功。此压力布局用于验证资源，不代表用户截图中六种手动版式的精确重放。
- 独立生成 20 组 PNG：灰度、灰度透明、RGB、RGBA、索引色/tRNS，覆盖低位、8/16 位与普通/Adam7；pypdf 解压出的颜色和 alpha 样本逐字节一致。
- Rust 回归将三份 PNG 副本从原实现的 6 个图片对象降为 2 个（1 个颜色流、1 个透明度流）；另保留 Adam7 / 索引色 / 16 位的实际 PDF 流校验。
- `cargo test --lib`：155 项通过，25 项需本地外部环境的测试默认忽略。
- 既有两种真实混排板材、4 页基准再次通过：单线程 30.798 秒、自动预算 6 线程 32.256 秒、双版式受限并发 30.551 秒。相同 4 页 PDF 从 159,404,679 字节减少到 61,637,548 字节，主要减少重复栅格资源；这组同机结果不能代表所有机器。
- pypdf 验证 300 × 464 mm 页尺寸与页数；Poppler 45 DPI 渲染的 4 页与修复前对应渲染逐像素相同。坏页不会发布半成品，后续工作进程仍可正常使用。

大幅面交错 PNG 会使用临时磁盘空间保存解码扫描数据；处理完当前原图后立即回收。进程隔离、Windows Job 内存保护、动态并行和串行原子提交继续生效。

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
