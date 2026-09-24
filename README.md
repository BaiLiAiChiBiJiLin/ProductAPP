# PrintFlow

PrintFlow 是面向定制产品生产的 Windows 桌面应用。它把上传素材、产品属性、尺寸和工艺整理成 A4 生产示意图，减少人工排版和生产交接时漏图、漏信息的问题。

技术栈为 React、TypeScript、Vite、Ant Design、Konva、Tauri 2 和 Rust。前端负责交互与画布，Rust 负责本地文件、SVG 解析、资源处理及 PDF 导出。

## 功能范围与价值

当前主要可用模块是**生成示意图**。订单、订单图片编辑、生产拼版、生产进度目前是占位入口，尚未实现完整业务流程。

| 功能 | 使用方式 | 用途 |
| --- | --- | --- |
| 批次与历史 | 打开最近批次，或上传创建新批次；打开批次后上传会追加素材 | 保存工作内容，避免启动时加载全部历史图片 |
| 图片上传 | 点击上传或拖入 SVG、PNG、JPG；SVG 支持自动判断、整图与分组拆分 | 将设计大图变成可独立分类的生产素材 |
| 图片属性 | 选择图片，填写产品、印刷选项、Size、QT、工艺、配件和备注，确认保存 | 让生产要求与图片对应 |
| 产品分组 | 按产品进行引导分组，或自由组合 | 保留主图、正反面、底座等关系 |
| 生成前确认 | 点击生成示意图，在弹窗中确认参与生产的图片 | 防止无关图片进入输出 |
| 自动排列 | 按产品和印刷选项分页，可切换产品排序或上传排序 | 减少人工排版，并利用空余位置填入后续产品组 |
| 尺寸标尺 | 选择图片后切换 mm、cm、in，选择默认值、四舍五入或舍弃小数，并开关宽高标尺 | 展示真实尺寸，格式调整只影响画布显示，不修改原始尺寸 |
| 画布操作 | 选择模式框选，手形模式或按住空格平移，Ctrl + 滚轮缩放 | 便于检查细节、批量调整标尺 |
| 图片池与组合 | 未使用图片可双击或拖入画布；选组按 Delete 移回图片池；Ctrl 可跨页选择组进行组合 | 调整生产内容并复用素材 |
| 页面配置 | 编辑页眉信息、排列区域和表头 | 统一每页交接信息与版式 |
| 导出 | 当前页导出 JPG、PNG、SVG；PDF 输出单页文件和合并文件 | 用于预览、打印及后续设计软件处理 |

### 特殊产品排列

- 普通产品以三列为基础，图片区与右侧属性区分开。
- 双面不同图按产品规则展示正反面；背面来源与源 SVG 图片层顺序有关，并整体水平翻转，需在预览中核对。
- 立牌多图组默认最后一张为底座，放在属性区，显示红色小写 `base`。双面不同图立牌组占基础网格两列。
- 摇摇乐、照片夹按半页预算排列，包含表头和间隔。前四张均为竖图时，扣除属性栏后四等分横排；否则使用 Example 上方、Front / Inside / Back 下方的布局。
- 串串成员纵向排列，双面不同图在同一行左右展示正反面，并保留组内尺寸信息。
- 配件读取 `attributeImages['Accessories Color']`，按可见内容裁剪白边；工艺和备注随图片或产品组展示。

完整约束见 [排列规则](src/modules/schematic/ARRANGEMENT_RULES.md)。

## 使用方法

1. 启动桌面程序，进入“生成示意图”。
2. 打开历史批次，或上传文件创建批次；填写客户、绘图日期、预计发货日期和设计来源。
3. 选择图片并确认产品属性，需要时完成产品分组。
4. 保存批次，点击“生成示意图”，确认需要生产的图片。
5. 在排列页检查表头、尺寸、底座、配件、备注及工艺；按需调整排序、图片池、页眉和标尺。
6. 选择格式导出。PDF 选择目标文件夹后，先逐页输出，再生成保留原上传 SVG 文件名的合并 PDF。

例如上传 `订单示意.svg`，三页 PDF 的输出为：

```text
所选导出文件夹/
  1.pdf
  2.pdf
  3.pdf
  订单示意.pdf
```

合并文件包含全部页面。每个批次建议使用独立目录，当前导出会写入同名文件。导出期间显示遮罩和进度，所有文件写完才表示导出完成。

## 开发环境与启动

Windows 环境准备 Node.js 24、npm、Rust stable（MSVC 工具链）、Visual Studio C++ 构建工具及 WebView2 Runtime。依赖版本以 `package-lock.json` 和 `src-tauri/Cargo.lock` 为准。

```powershell
npm ci
npm run tauri -- dev
```

仅预览前端：

```powershell
npm run dev
```

开发地址为 `http://127.0.0.1:5173`。原生导入、历史存储和文件导出需在 Tauri 桌面窗口中使用，浏览器预览不能替代完整桌面验证。

## 构建与检查

```powershell
# 前端构建，包含关键源码快照
npm run build

# 桌面打包，自动准备自定义产品资源并构建前端
npm run tauri -- build

# 业务逻辑测试
npm test

# UI、上传及 PDF 暂存流程测试
npx vitest run

# 类型与 Rust 检查
npx tsc -b --pretty false
cargo check --manifest-path src-tauri/Cargo.toml
```

在 `src-tauri` 目录执行 Cargo 时，项目配置将构建产物放到 `.cargo-target`。发布与更新流程见 [发布说明](docs/GITHUB_RELEASE_UPDATES.md)。

## 项目结构

| 路径 | 职责 |
| --- | --- |
| `src/App.tsx` | 全局布局和模块入口 |
| `src/model.ts` | 素材、页面模型及公共渲染接口 |
| `src/modules/schematic/components/` | 上传、属性、图片池等组件 |
| `src/modules/schematic/grouping/` | 产品分组及组合引导 |
| `src/modules/schematic/arrangement/` | 自动排列、分页、空位填充 |
| `src/modules/schematic/services/` | 导入、尺寸、工艺、导出等服务 |
| `src/modules/schematic/ArtworkCanvas.tsx` | Konva 画布 |
| `src/modules/order/`、`image-edit/`、`imposition/`、`progress/` | 预留业务模块 |
| `src/modules/update/` | 桌面更新 |
| `src-tauri/` | Rust 后端、资源及打包配置 |
| `scripts/` | 构建、发布、源码快照及诊断工具 |
| `tests/` | 有效业务与 UI 回归测试 |
| `docs/` | 专项说明 |
| `printflow-data/` | 本地资源与缓存，实际数据位置由后端决定 |

新增功能先归属模块。上传解析、画布、图片池、分页和导出独立维护；跨模块通过类型与服务接口传递数据，避免继续向根 `App.tsx` 堆业务代码。见 [模块化架构约定](docs/模块化架构约定.md)。

## 数据、备份与清理

- 批次、图片属性及分组信息由 Rust 持久化。历史批次和素材属于业务数据，不应当作临时文件清空。
- `npm run protect-source` 在 `.source-backups` 保存脚本列出的关键源码；它不是全项目备份，完整源码历史仍应使用 Git 管理。
- `npm run restore-source` 会用最新快照覆盖对应文件，仅在确需恢复并检查快照后使用。
- `node_modules`、`dist`、`.cargo-target` 是依赖或构建产物，`.test-output` 是诊断输出。
- `artifacts` 可能含分发程序及运行数据，`measurement-output` 可能含测量素材，清理前应逐项确认。
- 本次删除了四份与当前规则不兼容的 `.legacy.mjs` 排列测试、对应归档说明和一次性 `patch.py`。有效回归测试与历史数据兼容测试继续保留；旧文件可从 Git 历史追溯。

## 进一步阅读

- [排列规则](src/modules/schematic/ARRANGEMENT_RULES.md)：当前排版与展示约束。
- [产品分组](src/modules/schematic/grouping/README.md)：引导、自由组合和保存逻辑。
- [PDF 导出诊断](docs/PDF_EXPORT_PERFORMANCE.md)：性能日志、样本生成及验证方法。
- [SVG 原始尺寸测量](docs/SVG原图分组尺寸测量.md)：尺寸来源和测量算法。
- [本地 SVG API](docs/LOCAL_SVG_API.md)：本地集成接口。

专项文档保留部分历史实现背景；日常操作以当前界面和本 README 为准，具体排版约束以排列规则为准。
