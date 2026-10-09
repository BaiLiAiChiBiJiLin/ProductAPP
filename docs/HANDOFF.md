# PrintFlow 项目交接说明

## 顶部业务模块

- **订单**：订单模块入口，目前保留模块结构和订单类型，页面功能仍在建设。
- **订单图片编辑**：图片编辑模块入口，目前保留编辑图片数据类型，页面功能仍在建设。
- **示意图排列**：当前主要业务模块，负责 SVG 上传、图片属性、图片池、产品分组、自动排版和导出。
- **示意图审核**：位于生成示意图和生产拼版之间，独立目录为 `src/modules/schematic-review`；成功导出后将完整排列与显示调整保存为本地审核记录，列表支持搜索及编辑恢复；每次导出新增版本。前端记录契约为 `reviewRecords.ts`，原生持久化为 `src-tauri/src/schematic_review.rs`（SQLite `schematic_reviews` 清单及 `schematic_review_resources` 大资源表，同事务独立保存 SVG 内容，分块上传、逐项二进制恢复）。`ArrangePage` 的视觉缩放、配件位置、小数位数和画布缩放由 `SchematicPage` 统一持有；恢复直接使用保存的页面，不调用自动排列。页面、样式和后续审核功能在该目录内维护。
- **生产拼版**：`src/modules/imposition` 提供待拼版分页表、客户/文件名搜索及按需读取的图片明细；`src-tauri/src/production_imposition.rs` 负责阶段流转和独立 SQLite 存储。尚未实现生产拼版算法。
- **生产进度**：生产进度模块入口，目前保留进度数据类型，页面功能仍在建设。

模块由 `src/App.tsx` 统一挂载。切换模块只改变显示状态，已访问模块保持挂载，因此切换后不会丢失页面状态，并带有左右滑动过渡。

常规业务模块统一使用 `src/components/ModulePage.tsx` 和 `module-page.css`，外边距 12px、内边距 16px、标题 20px、说明 13px，与生成示意图上传页一致。审核和待拼版已接入，预留模块也使用相同框架；上传页对应尺寸使用相同 CSS 变量。新模块接入方式与完整间距标准见 [UI_GUIDELINES.md](./UI_GUIDELINES.md)。

### 审核记录列表维护

`list_schematic_reviews` 接收分页、关键字及 UTC 日期边界，返回 `records/total/page/pageSize`；默认 20 条，单页上限 100 条，SQLite 中筛选和分页，不加载排列快照及大图。前端保存时间使用单个 Ant Design DatePicker，将本地日期转换为当天零点至次日零点的半开区间，选择后立即查询。末页清空后由后端回退至有效页。`delete_schematic_review` 在同一事务中删除记录和 `schematic_review_resources`；前端必须经过 Ant Design 二次确认，原始批次及导出文件保留。

`paymentStatus` 使用 `unpaid/paid`，新旧记录默认 `unpaid`。“状态”列在操作栏前，“拼版”菜单位于编辑之后。选择已付款/未付款拼版调用 `submit_schematic_review_to_imposition`，同一 immediate 事务写入 `production_imposition_jobs` 和 `schematic_review_payment_states`。前者 `source_review_id UNIQUE` 防止重复转入，审核摘要通过 LEFT JOIN 返回 `impositionJobId`，用它判断阶段，区分未转入的淡红色和未付款已转入的淡橙色；付款已转入用淡绿色。整行含固定操作列使用 Ant Design 的 `colorSuccessBg/colorErrorBg/orange1` 和对应悬停 token。转入后前端隐藏编辑、删除及拼版菜单，提供查看拼版入口；后端也拒绝恢复编辑、删除及旧付款修改命令。

生产表仅保存客户、导出文件引用、阶段关联及 `images` 精简清单。清单列出实际出现在页面中的原图 ID、已保存批次文件路径、真实宽高 mm、产品属性和逻辑产品组关系，不保留页面/组坐标、标尺、文字调整及视觉比例。尺寸与 `physicalSourceSize` 相同，直接来自源数据，显示小数位数或取整不影响生产尺寸。新审核快照保留 `storagePath`，旧快照从 `assets.payload.storagePath` 查回；不读取主 SVG，也不复制 `printflow-data/assets` 下的文件。失效路径或属性文件写入/数据库写入失败会回滚阶段和任务；只清理本次生成的附件目录。`delete_batch/delete_asset` 检查生产引用，保留被生产任务使用的资产行及文件。

`list_pending_impositions` 默认每页 20 条、最多 100 条，SQL 筛选和分页仅返回摘要；`load_imposition_job` 在用户打开明细时返回当前任务的精简图片清单，不读取 SVG。内嵌产品属性/备注图片保存为应用数据目录 `production-imposition/任务 ID/` 下的独立附件，远程图片仍保留引用。原审核快照保留在审核表，但不会被复制到生产表。

## 示意图排列模块

### 图片上传与图片池

- 通过 Tauri 文件选择器、拖拽或本地 HTTP API 接收 SVG。
- Rust 负责解析 SVG、拆分图片、保存临时资源和发送解析进度。
- 图片池支持全部、未使用、已排版等状态，并与画布中的资源保持对应。
- 图片卡片支持选择、预览放大、删除、属性编辑和标记是否进入示意图。
- 外部程序可调用本地接口触发上传，接口说明见 [LOCAL_SVG_API.md](./LOCAL_SVG_API.md)。

### 图片属性

- 支持已有产品和自定义产品。
- 支持产品、尺寸、印刷选项、样式、配件颜色、QT、备注和属性图片。
- 产品配置从远程接口缓存到本地 `printflow-data/cache/product-configs.json`。
- 远程配置成功后自动提取含 `preview3D` 的对象，更新 `finish.json`。
- 多选图片时，属性修改会写回选中的图片。
- 图片可进入产品组合引导，组合信息会保存到资产数据中。

### 批次和历史记录

- 当前批次先使用临时资源，不会自动写入历史记录。
- 保存批次后由 Rust 写入 SQLite 和项目数据目录。
- 历史记录列表只加载元数据，打开记录时再加载完整图片资源。
- 支持保存、打开、删除和放弃当前批次。

### 生成示意图与排列页

- 点击生成示意图后先按产品、印刷选项和数量分类，再进入排列页。
- 自动排列使用 A4 画布和物理尺寸数据，按产品类型使用不同布局：普通产品、串串、立牌、照片夹等。
- 支持多页、分页缩略图、拖拽图片、移动图片组、组合和删除画布元素。
- 排列后会尝试填充空闲区域，并保持组内图片、属性、标尺和表头关系。
- 画布使用 SVG 资源，支持标尺、属性面板、备注、配件图片和背面预览。
- 可导出 SVG、PDF，并支持分阶段进度显示。

## Rust 后端职责

Rust 代码位于 `src-tauri/src`，主要负责：

- SVG 多模式识别、场景树解析、图层拆分和资源写入；
- 变换矩阵、包围盒、裁剪、蒙版和 SVG 渲染校验；
- 批次、资产和工作区的 SQLite 持久化；
- 产品配置、工艺缓存和本地临时资源；
- Tauri 更新检查、日志和本地 HTTP API；
- 远程配件图片下载及 data URL 转换。

## 关键关联关系

```text
外部程序 / 文件选择器 / 拖拽
            ↓
      SchematicPage
            ↓ invoke
        Rust import_assets
            ↓ events
      图片池与当前批次
            ↓ 属性确认 / 产品分组
      生成示意图与分类
            ↓
        ArrangePage
            ↓
       A4 SVG 画布 / 导出
```

- `SchematicPage` 管理上传页、批次状态、图片选择和页面切换。
- `ArrangePage` 管理排列页交互，排版算法集中在 `arrangement` 目录。
- `grouping` 目录负责产品组合引导和组合恢复。
- `services` 目录提供属性、尺寸、分页、导出、产品配置和资源处理服务。
- 前端只负责交互和显示，文件解析、持久化和大数据处理由 Rust 完成。

## 重要数据位置

- `printflow-data/cache/product-configs.json`：产品配置缓存。
- `printflow-data/cache/finish.json`：从产品配置提取的工艺目录。
- `printflow-data/cache/local-api.json`：本地 HTTP API 实际端口。
- `printflow-data/temp-assets/`：上传过程中的临时 SVG 资源。
- 应用数据目录中的 `printflow.sqlite`：批次、资产和工作区数据。
