# 本地拼版运行模块

本目录集中软件实际使用的本地异形拼版源码，两种策略共用同一个 Rust 单板搜索核心，输入和输出统一使用毫米。

```text
imposition_algorithms.rs
  → local_tools_engine.py       JSON、QT、轮廓准备、进度与最终校验
      → nesting_common.py      节省板材、掩码缓存与 Python 参考搜索
      → nest_uniform.py        重复统一版式
          → nesting_rust.py    共享上下文、内存保护与 Rust ABI
              → rust_core/    Rust 位图搜索和受控并行
```

每种基础轮廓只生成一份旋转掩码集，由 QT 副本共享。策略输出经真实轮廓校验，检查配置间距和有效区域；不能放置的资产保留原因供右侧列表展示。

Tauri 从项目根目录定位本模块，以 `.tools/nesting/.venv` 中的 Python 启动适配器；Rust 动态库继续部署在 `.tools/nesting/native`。源码与本机依赖分开存放。现有安装包资源配置尚未打包这一套运行时，目录整理不改变此限制。

安装、构建、真实 SVG 基准和回归测试入口见 [运行与开发说明](../../../../scripts/nesting/README.md)。旧 `tools/` 的独立 GUI、CLI 和旧 SVG 导出入口不再保留；软件 PDF 导出由 `imposition_pdf.rs` 负责。

为兼容已有请求、结果和掩码缓存，保留 `local-tools` 协议标识、`tools/material` / `tools/uniform` 算法标识，以及 Python 模块和类名。它们不再指向根目录 `tools/`。
