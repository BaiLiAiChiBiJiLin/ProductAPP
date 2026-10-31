# 本地异形拼版

当前只提供本地拼版，不再提供外部算法切换。运行源码统一位于 `src-tauri/src/imposition/local_nesting/`，本目录仅保留安装、构建和测试脚本。三种策略共用轮廓和掩码缓存，以及 release Rust 位图搜索核心：

- 节省板材：单板尽量多放，优先利用已打开板材的空隙。
- 切割方案优先：搜索可重复使用的统一版式，同时尽量提高单板放入数量。
- 综合最少（权重 60:40）：比较节省板材、统一版式、余隙补排和部分版式重组候选，按板材 60%、切割方案 40% 评分（`3 × 板材数 + 2 × 切割方案数`，两项不分别归一化）；先满足全部有效图片的 QT，再选择评分更好的结果。重组允许少量尾板和重复版式的部分副本重新排列，其余板材保留。

所有输入输出使用毫米 JSON；每种基础图片只提交一份轮廓和 QT 数量。无效轮廓按资产返回原因并继续处理其余图片，不生成矩形兜底结果。

## 纯线条底座分版与混排开关

点击重新计算时，`load_imposition_geometry` 使用同一次 usvg 解析返回毫米轮廓和 `lineOnly`。分类读取解析后的样式、继承和 `use` 引用：有可见描边、没有图片或可见填充的 SVG 属于纯线条；颜色、渐变、图案填充及图片归入其他图片。隐藏图层、零透明度内容及未使用的定义不参与分类；有滤镜的内容保守归入其他图片。

拼版设置中的“底座混排”默认关闭（开发和生产环境都可见）。关闭时，三种策略按两类分别求解，纯线条底座之间可以混排，同一板材不混入其他图片。开启时，`NestRequest.allowBaseMixing=true` 将两类的实际 QT 放入同一个搜索任务，允许同版旋转、补空隙和版式优化。分类仍保留原始 `lineOnly`，不修改图片或轮廓。QT 副本共享基础轮廓，跨类别相同几何也共享掩码缓存。最终始终校验完整 QT、有效区域和配置间距；仅在关闭时额外强制类别分版。更改开关清空旧方案，等待点击“智能拼版”，不自动计算。

关闭混排时，同类跨方案拖动只重算所属类别，保留另一类板材的位置、角度和生产份数；跨这两类版式拖动会被拒绝并保留原结果。开启混排时，跨类别和已混合版式均可参与特殊重排，落点、QT、间距和边界校验继续执行。画布折叠和 PDF 导出继续按图片身份区分版式，不会因为两类形状相同而合并。

回归入口：`test_line_only_nesting.py` 覆盖三种策略、1802 QT、缓存复用和跨方案重排；Rust 的 `svg_content::tests` 验证 SVG 分类，`line_only_svg_geometry_reaches_solver_as_separate_sheets` 验证原生读取到实际求解的完整链路（需本地运行时，使用 `--ignored`）。前端分类与选中范围回归位于 `tests/imposition.test.tsx`。

## SVG 占用轮廓与重叠校验

`src-tauri/src/imposition_svg_footprint.rs` 提取实际引用的图片裁剪路径和可见矢量路径，应用引用对象、裁剪路径和路径自身的变换，并裁剪到 SVG 画布边界。未使用的 `defs` 和隐藏内容不占用面积。不能仅因文件含有一个闭合挂孔，就把该挂孔作为整张图片的碰撞轮廓。

优先保留能包住所有有效部分的完整外轮廓及其凹形。缺少完整外轮廓、包含分离部件或自交时，使用覆盖全部已提取部分的保守凸包；这可能增加占用面积，但不会只保留局部小轮廓。未裁剪的位图仍依赖 SVG 中的显式产品轮廓，本次没有增加位图透明通道描边功能。`imposition_svg_outline.rs` 在毫米坐标中按 0.03 mm 曲线误差自适应采样；超过安全点数时返回资产错误，不再截断路径后继续拼版。

2026-10-21 使用 `Backup_of_Raine Gaming` 的 18 张真实 SVG、250 份实际 QT 回归。第 7、10 张图片原来仅提取了约 7.06 mm² 的挂孔，遗漏了图片引用的裁剪轮廓；修复后全部图片参与拼版。节省板材、切割方案优先、综合最少均放入 250/250 份、使用 10 块板材；后两种策略得到 2 个版式，各生产 5 块。按原始 SVG 独立渲染检查全部不同版式，三种策略均未检测到图案重叠或越出版材（3 px/mm，透明度阈值 32/255）。另用 Edge 的原始 SVG 图像渲染复核切割方案优先结果，两个版式均无重叠像素；这是求解结果渲染验证，不是桌面应用截图。

回归入口为 `imposition_algorithms::real_nesting_overlap_test::real_job_artwork_does_not_overlap`（`--ignored --nocapture`，需要本地运行时及真实 SVG）。`PRINTFLOW_OVERLAP_JOB` 指定只读任务快照，`PRINTFLOW_OVERLAP_OBJECTIVE` 可选 `least-material`、`least-cutting`、`combined`；报告和预览写入系统临时目录 `printflow-overlap-repro`。常规单元测试覆盖裁剪变换、分离部件、自交轮廓、画布边界和曲线采样；Konva 回归覆盖 24 个旋转角度及移动后的碰撞索引。

## 源码与运行时

- `src-tauri/src/imposition/local_nesting/local_tools_engine.py`：毫米 JSON 入口、进度与最终几何校验。
- 同目录 `nesting_common.py`：共享轮廓掩码、单板搜索和节省板材策略。
- 同目录 `nest_uniform.py`：切割方案优先策略。
- 同目录 `nest_combined.py`：综合最少策略、切割方案统计与候选评分。
- 同目录 `nest_replan.py`：跨方案拖动后的数量配额重算与已有空间补排。
- 同目录 `nesting_rust.py`、`rust_core/`：Python 调用接口和 Rust 搜索核心。
- `.tools/nesting/.venv`、`.tools/nesting/native`：本机 Python 依赖和已编译 DLL，继续保留。

根目录旧 `tools/` 中的独立 GUI、CLI、配置和旧导出入口已移除。真实 SVG 基准采样辅助独立放在 `svg_benchmark_geometry.py`，生产搜索只接收已提取的轮廓，不导入该辅助模块。

## 安装与验证

安装：`powershell -File scripts/nesting/setup_local_tools.ps1`。

生产依赖见 `requirements-local-tools.txt`。运行真实 SVG 基准及完整测试前，再安装开发依赖：`& .tools/nesting/.venv/Scripts/python.exe -m pip install -r scripts/nesting/requirements-benchmark.txt`；其中的 `svgpathtools` 不参与生产计算入口。

本地三种策略共用 release Rust 位图搜索核心；Python 保留轮廓准备、策略调度、最终几何校验及可切换的参考搜索。安装脚本同时构建独立 DLL，不需要将整个 Tauri 应用切换到 release。仅安装 Python 可加 `-PythonOnly`；候选 DLL 单独构建使用 `build_rust_core.ps1 -SkipDeploy`。

默认 `PRINTFLOW_NESTING_CORE=auto`。可设为 `python` 或 `rust` 做同输入对照。拼版设置中的“使用核心数”默认使用全部可用逻辑核心（至少 1），也可手动选择 1 至本机可用逻辑核心数；偏好在本机保存，切换到核心更少的电脑时会收敛到其上限。修改并行数在下一次计算或跨方案重排时生效，不会清空当前版式。

应用通过 `get_imposition_compute_info` 读取原生 CPU 信息，`NestRequest.threadCount` 缺省表示自动；Tauri 仅设置该次求解子进程的 `PRINTFLOW_NESTING_THREADS`，不改桌面进程全局环境。独立 Python CLI 可直接用此环境变量指定任意整数线程数，缺省同样自动使用全部可用逻辑核心。Python 和 Rust 会依据可用内存、共享轮廓缓存、线程栈预算及可并行角度数降低实际线程数，低内存时降为 1；QT 不会因此重复复制轮廓。并行仅用于同一放置步骤的角度搜索，最终按固定顺序选取结果，线程多不保证成比例提速。

`PRINTFLOW_NESTING_CORE_LIBRARY` 可指定候选库。实际核心、线程数和回退原因写入结果 `searchCore` 及算法说明，原生失败不会被误报成 Rust 结果。完整实现与原始测量方法见 `docs/本地拼版Rust搜索核心与性能验收-2026-10-13.md`。可用 `benchmark_thread_scaling.py --input <固定毫米请求.json>` 重复比较 1/2/4/8 线程；基准串行执行、共用预热缓存，并校验 QT、间距、板数、版式及坐标一致性，输出写入系统临时目录。

输入 stdin 为 `{ "engine": "local-tools", "request": { ... } }`，每种图片仅提交一个 `polygon` 和 `quantity`。`least-material` 调用节省板材策略，`least-cutting` 调用切割方案优先策略，`combined` 调用综合最少策略。跨方案重排保持手动指定的位置，在既有方案补排后，新增尾版继续使用所选策略。stdout 只有毫米 `NestResult` JSON；stderr 的 `PRINTFLOW_PROGRESS` 行由 Tauri 实时转发。

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


## Windows 安装包中的拼版运行时

正式打包前自动执行 `node scripts/bundle-nesting-runtime.mjs`。构建机需要 Windows x64、Python 3.13（可由 `PRINTFLOW_NESTING_BUILD_PYTHON` 指定）和 Rust MSVC 工具链；GitHub 发布流程已配置 Python。构建脚本固定安装生产依赖、编译 release 搜索 DLL，并把 `bundle_runtime.py` 的 `MODULES` 清单中的适配模块、独立解释器、标准库和依赖写入 `src-tauri/resources/imposition-runtime/`，通过 Tauri 资源映射随安装包发布。生成目录不提交 Git，不包含虚拟环境绝对路径、开发测试或订单数据。

每次打包都会从项目目录外验证三种策略使用内置 Rust 核心，并验证切割方案优先和综合最少的跨方案重排；运行时还会被复制到含空格和中文的临时安装目录验证搬迁。正式版优先使用 Tauri `resource_dir()/imposition-runtime`，不从当前工作目录查找源码，也不依赖目标电脑的系统 Python。Python 使用相对 `._pth` 隔离模块路径，缓存写入用户数据目录。

打包：`npm run tauri -- build --bundles nsis`。重新生成并安装新版安装包后生效；已经生成的旧安装包不会自动补齐资源。


### 三方案比较

默认策略为“全部”：一次提取基础图片轮廓，然后按节省板材、切割方案优先、综合最少的顺序串行运行求解器。一个策略失败不影响后续策略。比较阶段保留坐标与版面数、切割线数，不加载其他策略的画布图片；用户选定后仍保留其他策略坐标，支持再次切换，只有当前方案建立可编辑画布。返回待拼版或修改输入后释放比较结果。

开发和生产环境均展示版面预设选择与图片间距；间距位于版面配置展开区，独立保存，切换预设保持不变。预设新增、编辑、删除，以及单个策略和手动核心数选项仅在开发环境展示。生产默认比较全部策略，并自动使用全部可用逻辑核心。Python/Rust 的内存预算仍可降低实际并发。

导出窗口会逐版式检查尺寸、有效区域和真实轮廓间距，并标记未确认图层、SVG 读取失败、CMYK 配置错误及导出失败的对应版式。问题版式显示“需检查”和详情；取消勾选该版式可继续导出其他正常版式。

### 重复统一版式回归

`fixtures/repeated-mixed-contours.json` 是生产 SVG 经实际 Rust 导入/提取流程生成的匿名轮廓，不包含嵌入图片。8 款各 QT 30 的回归必须得到 5 张相同板材，每板各款 6 件，且通过独立边界和 3 mm 间距检查。切割策略先完成密排，再按整批 QT 公约数搜索不增加板材数的统一配额，避免只按单板件数淘汰更优整批方案。

运行：`python -B -m unittest discover -s scripts/nesting -p test_local_tools_engine.py -k test_uniform`。设置 `PRINTFLOW_NESTING_CORE=rust` 或 `python` 可分别验证原生和参考搜索。

本机原始 SVG 重放可用忽略测试 `real_production_svg_import`：`PRINTFLOW_IMPORT_TEST_SVG` 指定输入，`PRINTFLOW_IMPORT_TEST_COUNT` 指定拆分数量；可选 `PRINTFLOW_IMPORT_TEST_REQUEST` 指定系统临时目录内的 JSON 输出，`PRINTFLOW_IMPORT_TEST_QT` 指定测试 QT。该测试导出实际毫米轮廓请求及同目录下的拆分 SVG，原始文件不变。随后以此 JSON 调用 `local_tools_engine.py` 即可复现生产求解链路。

### 含少量尾数的重复批次

`nest_repeat_lots.py` 在已有完整方案之后，按 QT 除数搜索整批重复的多板组合，不再要求全部图片共享公约数。先排批量配额，再将无法整除的尾数补入已排模板的一块实际板材；该块独立成版，其他重复副本保持原样，无法补入的尾数继续单独求解。比较的是完整订单的板材和版式数，不以单板件数淘汰整批更好的候选。只接纳不增加板材且减少版式的完整合法结果；新候选仍经过真实轮廓、3 mm 间距、完整图框边界和每款 QT 校验。与原策略共享 MaskBank 和 Rust 搜索核心。

`fixtures/repeated-lots-with-tails.json` 为 20 种匿名轮廓、1902 QT 的真实任务几何快照，不包含图片、文件路径或客户名称。回归要求切割方案优先不超过 91 板、11 版式（旧结果 95 / 19），全部 QT 和间距不变。另有 8 款各 30 份加一张尾数的回归：旧 5 / 4，修复后 5 / 2。运行 `python -B -m unittest discover -s scripts/nesting -p test_local_tools_engine.py`。这属于有界启发式改进，不保证全局最优。

### 重复子版式与近满余量

`nest_repeat_patterns.py` 在约化批次内尝试重复子版式和精确剩余配额，共享原有轮廓掩码，用面积和当前完整方案板数剪枝。相同余量只计算一次，不按 QT 复制 SVG 或掩码。

`nest_order_search.py` 只优化距单板完整配额差 1–2 件、且面积下界允许一板的余量。它比较几何排序和精英顺序扰动，不改变面积、轮廓、图框、间距或旋转集合。每个配额最多 192 次、一次求解共用最多 384 次附加搜索；搜索预算不是订单数量限制。完整单板和整单分别校验后才采用结果，额外优化内存不足时保留已有合法方案。Python 与 Rust 的 `input` 顺序模式共用同一规则，不依赖文件名、客户名或预先保存的版式坐标。

### 临时内存压力后的原生核心恢复

`nesting_rust.py` 将资源不足与缺少原生库分开处理。资源预检或 Rust 分配失败先尝试降低线程；必要时临时进入 Python，但内存恢复后可以安全撤销当前试排并重新交给 Rust。旧数量向量、0.5 mm 栅格和旋转规则不变；短冷却避免反复重建。因内存被限制的线程可重新升回用户设置，明确选择 1 线程仍保持。进度使用 `current_backend` 显示当前核心，`backend` 仍记录整次任务是否混用过不同核心。

回归入口：`test_rust_nesting_core.py` 的资源恢复、冷却、线程恢复及数量事务测试；`test_local_tools_engine.py` 的实际入口恢复进度测试。故障恢复不能缓存为整批永久 Python 降级，也不能通过减少图片或超时终止规避。

### 全批不同重复次数的模板候选

勾选后的图片属于同一个需求池，不按任务来源、客户名或文件名限制组合。`nest_repeat_portfolio.py` 根据 QT 的整除关系生成额外的部分模板种子：不同模板可以有不同生产重复次数。原全混方案仍是候选；种子与完整余量组成的方案、向种子空隙全局补排的方案、原有全款重复批次搜索继续比较。只有完整需求满足、板数不增加且切割评分改善的结果才被采用，综合策略继续按 60:40 比较及重组。

额外搜索最多两个去重的 QT 支持集候选、四次子求解、共用 384 次近满顺序试排以及一次全局补空，禁止递归扩展。子求解只重编基础轮廓的索引，共享原 NumPy 掩码，每次结束释放原生上下文；不会按 QT 复制图像。传入数量为零的类型始终不可参与，保留底座混排关闭时的隔离。原生状态汇总父、子搜索，不能把子搜索的 Python 回退误报为全 Rust。

普通贪心 lot 已用完可胜出板数且仍有余量时，停止该失去竞争力的候选；完整订单、其它重复子模板和原有可行结果不受影响。该剪枝只根据板数下界，不以时间或订单数量中止拼版。

回归入口：`test_repeat_portfolio.py`、`test_bounded_lots.py`。匿名四轮廓 QT 8/8/12/12 的实际搜索由 5/4 改善为 4/2；另验证即使独立模板组合较差，仍可通过全批插空反超，而不是强制保持种子划分。所有结果仍通过逐款数量、完整图框、真实轮廓和间距检查。本方法是有界启发式，不保证全局最优。
