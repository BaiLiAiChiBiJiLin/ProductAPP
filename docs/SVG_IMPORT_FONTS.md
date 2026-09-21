# SVG 导入字体按需加载

更新日期：2026-09-18。适用于当前 Windows 桌面端。

## 行为

- 导入选项的字体库初始为空。只有路径、图片或已转曲文字的 SVG 不加载字体；未使用的字体声明、`display="none"` 的文字也不会触发加载。
- usvg 实际排版文字时才请求字体。CSS、父级继承、`tspan` 和 `use` 的最终字体属性由 usvg 解析，避免靠搜索 `<text` 字符串遗漏文字。
- 根据字体名称、字重、斜体和宽度匹配本机已安装字体。按 `font-family` 顺序尝试，第一个可用字体匹配成功后不加载其余候选。
- 缺少指定字体时尝试 Times New Roman、Arial、Segoe UI；缺字时先复用本次文档已加载的字体，再按字符尝试必要替代字体。中文优先微软雅黑、宋体等，确认包含目标字符后才打开字体文件。
- 缺失原字体时使用替代字体可能改变字形，日志会提示。需要保持设计字形时，应安装原字体或在设计软件中转曲。不会下载外链字体。
- 嵌套 SVG 图片沿用同一按需解析策略；外层没有文字时字体库仍为空。导入后的文字继续按照原流程转为路径。

## 实现边界

`src-tauri/src/assets.rs` 的 `options()` 接入独立的 `fonts/artwork.rs`；`fonts/windows_artwork.rs` 通过 Windows DirectWrite 字体索引定位文件。应用不再调用 `load_system_fonts()`，也不遍历字体目录或把全部字体放入 fontdb。Windows 可以使用自身的系统字体索引，这与应用逐个扫描和解析所有字体文件不同。

字体匹配及字体文件元数据各使用最多 128 项的进程缓存。缓存只保留匹配对象、文件位置和字形集合元数据，不永久缓存全部字体文件内容。一个字体集合文件可能包含多个字形集合，仅把匹配到的集合加入当前文档字体库。

页面导出使用 `fonts.rs` 原有的 Arial / 微软雅黑固定字体策略，和原始 SVG 导入分开。

每个导入资源还保存 `sourceGroupWidthMm`、`sourceGroupHeightMm` 和 `sourceGroupBounds`（源 SVG 用户坐标中的 `[x, y, width, height]`）。它们在规范化 SVG、预览 PNG 和缩略图之外保留原始物理尺寸，排列页优先使用毫米值换算 A4 画布单位。

## 验证

新增测试覆盖：

1. 路径、无效字体声明和隐藏文字不触发字体加载。
2. 指定字体可用时不加载声明中其他备用字体。
3. 缺失字体与中文缺字使用少量替代字体，之后导入无文字 SVG 仍为空字体库。
4. CSS 继承、粗体斜体、`tspan`、`use` 与显式加载 Arial 的基准渲染逐像素相同。
5. 内嵌 SVG 按需加载自己的文字字体，和独立 SVG 文字渲染逐像素相同。

Windows 本机 Rust 单元测试：27 项通过，2 项需要本地导出数据的测试默认忽略。

```powershell
cd src-tauri
cargo check --no-default-features -j 1
cargo test --lib --no-run -j 1
cd ..
python .test-output/run-artwork-font-tests.py --test-threads=1
```

本机库测试程序缺少 Windows Common-Controls v6 清单，直接启动会在进入测试前报 `0xc0000139`。上述测试脚本仅给 Cargo 生成的测试可执行文件补入与 Tauri 应用相同的清单后运行，不修改应用代码或系统设置。运行结果位于 `.test-output/artwork-font-tests.log`。
