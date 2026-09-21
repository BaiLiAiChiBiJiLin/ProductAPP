# PDF 导出性能验证

## 问题与修复

2026-09-16 使用本机历史批次的只读快照复现了导出数分钟的问题。84 张资源生成 6 页 SVG，数据总量约 109 MB；虽然文件扩展名是 SVG，其中仍内嵌了 88 个 PNG，共 216,279,632 像素。因此“矢量 PDF”转换也需要解码 PNG、分离颜色及透明度、无损压缩并写入图片对象。

未优化的 Tauri 开发构建中，上述处理是主要瓶颈。原始完整批次导出 159.523 秒，其中 PDF 转换约 141 秒；第四页资源加载仅 45 ms，转换却需 41,770 ms。仅优化压缩库的单图实验改善很小，继续对 PDF、图片解码及 SVG 解析依赖开启编译优化后，完整批次耗时明显下降。

修复在 `src-tauri/Cargo.toml` 的 `[profile.dev.package.*]` 中，对相关依赖设置 `opt-level = 3`。主程序保留调试能力。这里没有缩小主图，也没有把整页转成位图；源 SVG 的矢量路径仍为矢量，内嵌 PNG 保留原像素和透明度。原有配件最长边 768 像素规则及 `attributeImages["Accessories Color"]` 唯一取图规则保持不变。

## 实测结果

| 完整真实批次 | Rust 导出耗时 | PDF 页数 | PDF 大小 |
| --- | ---: | ---: | ---: |
| 修复前 | 159.523 秒 | 6 | 51,625,312 字节 |
| 优化后第 1 次 | 27.180 秒 | 6 | 51,625,312 字节 |
| 优化后第 2 次 | 27.198 秒 | 6 | 51,625,312 字节 |
| 编译优化完成（含正式耗时日志） | 28.198 秒 | 6 | 51,625,312 字节 |
| 追加 Windows 页面字体定向加载 | 25.755 秒 | 6 | 51,628,079 字节 |

前端使用真实 `paginateAssets`、`arrangePage`、`pageRasterSvg` 生成页面，耗时约 1.13 秒，每页图片项数为 `[15, 15, 15, 15, 10, 14]`。后端测试直接调用应用的 `export_pdf` 命令，包含配件下载、字体初始化、SVG 解析、PDF 转换与文件写入；不包含保存对话框、WebView IPC，也不等同于人工点击到结束的全程计时。

旧版全量字体扫描曾测到约 7.5 秒，系统缓存热时约 1 秒。后续 Windows 导出改为下述定向加载，仍使用进程内 `OnceLock` 缓存。实际导出时间仍受机器负载和配件网络影响，不能把表中的时间当作所有批次的固定上限。

## 编译优化阶段的内容验证

- 已用 Poppler 打开、渲染并逐页查看完整 6 页，页眉、表头、主图、透明底座及配件均可见。
- 优化前后每一页在 96 DPI 下的渲染像素完全一致。
- PDF 中每页图片资源数量为 `[18, 15, 15, 16, 16, 11]`，共 91 个，其中 88 个来自原 SVG 的 PNG，另 3 个是配件。
- 使用 `pypdf` 递归读取 PDF 图片对象，逐一核对 88 个源 PNG 的宽高、RGB 像素与透明度哈希，全部一致；优化前后配件像素和透明度也一致。
- 源 PNG 验证用于本次含 PNG 的真实批次，不是所有 SVG 特性的通用证明；以后更换复杂 SVG 样本，仍需查看输出页面。

## Windows 页面字体定向加载（2026-09-16 追加）

用户本机安装了 5000 多个字体。通过真实导出使用的字体入口复现：独立进程初始化得到 6273 个字形集合，两次分别耗时 1195 ms、6627 ms；限制加载数量的回归测试失败。

新增 `src-tauri/src/fonts.rs`，`assets::export_options()` 与原始图稿导入的 `assets::options()` 分离。PDF、PNG、JPG 及嵌套 SVG 展开都使用导出专用入口：

- 从 `%SYSTEMROOT%/Fonts` 按文件名直接读取 `arial.ttf`、`arialbd.ttf`、`ariali.ttf`、`arialbi.ttf`、`msyh.ttc`、`msyhbd.ttc`。只读取这 6 个文件，本机共 8 个字形集合；不枚举目录，也不读取其他已安装字体。
- 英文字体不可用时，仅尝试指定的 Segoe UI 文件；中文字体不可用时，仅尝试 `simsun.ttc`。仍缺少中英文字体则返回明确错误，不回退到全目录扫描。
- 字体缓存首次构建后在进程内复用，日志目标为 `printflow::fonts`。本机新的独立进程初始化为 4 ms；这是字体阶段的时间，不是整批 PDF 的时间。
- 原始 SVG 图稿导入与页面字体分开；2026-09-18 后 Windows 图稿导入改为无文字不加载、有文字按需匹配系统字体，之后将文字规范化为路径，详见 [SVG 导入字体按需加载](SVG_IMPORT_FONTS.md)。非 Windows 页面的导出保留原有字体发现方式。

完整 84 张 / 6 页后端导出实测 25.755 秒。重新渲染全部 6 页，并核对源图像素、PDF 图片对象及文本：88 个内嵌主图 PNG 和 3 张配件均保持像素及透明度一致，所有页面文字内容完整。PDF 字体资源实际包含 `ArialMT`、`Arial-BoldMT`、`MicrosoftYaHei`。

旧导出把页眉中的部分中文文本行回退成了 `DengXian`（等线）；本次明确使用微软雅黑。因此不能继续声称整页像素完全相同：6 页的渲染差异都限定在页眉，正文像素全部一致。已查看新页眉，中文客户名、设计师、日期及页数显示正常。PDF 大小的轻微变化来自字体子集变化。

回归命令（在 `src-tauri` 目录）：

```powershell
cargo test --lib export_fonts_are_bounded_and_cached -- --nocapture
cargo test --lib fonts::tests -- --nocapture
```

这些测试覆盖导出字体数量、进程缓存、Arial 四种字重/样式、中文字符回退、缺失字体目录的错误处理。完整 Rust 测试为 19 项通过、2 项本地数据测试默认忽略；真实批次导出测试已显式执行通过。

本轮输出为 `.test-output/pdf-performance/preferred-fonts.pdf`，逐页图像/文本结果为 `preferred-fonts-verification.json`，正文像素及字体资源核对为 `preferred-fonts-layout-verification.json`。字体变更验证使用 `verify-pdf-export.py --baseline ...` 核对图片与文本，不使用要求整页像素相同的渲染参数。

## 复现方式

以下在项目根目录的 PowerShell 执行。Python 需要 `Pillow` 和 `pypdf`，PDF 渲染需要 `pdftoppm`。真实批次快照和测试输出只写入已忽略的 `.test-output`，不覆盖原批次或导入文件。

先只读提取当前最新保存批次（也可手工提供同格式 `{ "assets": [...], "metadata": {...} }` JSON）：

```powershell
@'
import json, os, sqlite3
from pathlib import Path
db = Path(os.environ['APPDATA']) / 'com.tauri.dev' / 'printflow.sqlite'
with sqlite3.connect(db.as_uri() + '?mode=ro', uri=True) as connection:
    row = connection.execute('SELECT payload, metadata FROM batches ORDER BY saved_at DESC LIMIT 1').fetchone()
    if row is None:
        raise SystemExit('No saved batch available')
    snapshot = {'assets': json.loads(row[0]), 'metadata': json.loads(row[1])}
output = Path('.test-output/pdf-performance/batch.json')
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(snapshot, ensure_ascii=False), encoding='utf-8')
'@ | python -

node scripts/prepare-pdf-benchmark.mjs
```

本机使用 Node 24，可直接运行这些包含 TypeScript 导入的脚本。

进入 Rust 目录执行真实导出。40 秒是本机本次完整批次的回归预算，编译时间不计入；慢机器或网络不佳时应结合分阶段日志判断，不能只提高预算来掩盖回归。

```powershell
Set-Location src-tauri
$env:PRINTFLOW_PDF_LIMIT_SECONDS = '40'
$env:PRINTFLOW_PDF_OUTPUT = '../.test-output/pdf-performance/verified.pdf'
cargo test --lib real_batch_pdf_performance -- --ignored --nocapture
Set-Location ..
```

可用 `PRINTFLOW_PDF_FIXTURE` 指定其他 `pages.json`，用 `PRINTFLOW_PDF_PAGES` 限定页数。性能测试默认忽略，避免常规测试依赖本机业务数据或网络。另一个本地视觉样本测试也已改为调用当前 PDF 导出命令；配件解析测试使用当前 `usvg` / `svg2pdf` 转换器，避免旧库测试通过但实际导出失败。

渲染和源像素校验：

```powershell
pdftoppm -png -r 96 .test-output/pdf-performance/verified.pdf .test-output/pdf-performance/verified
python scripts/verify-pdf-export.py .test-output/pdf-performance/pages.json .test-output/pdf-performance/verified.pdf
```

需要对比已保留的基准 PDF 和渲染时，增加 `--baseline`、`--render-prefix`、`--baseline-render-prefix` 参数。验证失败会返回非零退出码。不能仅凭 PDF 文件大小一致或测试返回成功就认定没有缺图，必须结合源像素核验及页面渲染检查。

## 运行时日志与后续检查

日志目标 `printflow::pdf` 按页记录 `resources_ms`、`flatten_ms`、`fonts_ms`、`parse_ms`、`convert_ms`，导出完成记录 `finish_write_ms`、`total_ms`、页数及字节数。日志不打印 SVG 内容。资源下载失败仍返回错误，不输出缺配件的 PDF。

排列页默认导出 PDF。`export_pdf` 每完成一页发送 `pdf-export-progress` 事件；前端导出服务监听并在页面显示半透明遮罩、动画和 `X / Y` 页进度，防止导出期间重复触发。保存对话框取消、导出成功或异常都会清理监听并关闭遮罩。

Cargo 配置变动需要重新编译 Rust 应用才能生效，仅刷新 React 页面不会更新旧的可执行文件。开发模式通常由 Tauri 自动重编译；如果仍运行旧程序，需要保存工作后重新启动。发布构建原本已开启优化，本次没有把开发版的对比结果冒称为发布版提速。
