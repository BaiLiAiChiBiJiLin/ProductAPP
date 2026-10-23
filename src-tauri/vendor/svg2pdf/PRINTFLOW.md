# PrintFlow 的 svg2pdf 补丁

来源：crates.io `svg2pdf 0.13.0`，上游 https://github.com/typst/svg2pdf 。保留原 MIT / Apache-2.0 许可、源文件与 ICC 数据。这里只修改图片编码和资源复用；没有引入新的拼版或 PDF 转换引擎。

## 修改原因

印刷 SVG 内可能包含 9774 × 13386 的交错 RGBA PNG。上游图片转换同时保留解码 RGBA、RGB、再次复制的 RGBA 和 alpha 平面，在 Windows 工作进程内触发 OOM abort（`0xc0000409`）。同一个 PNG 的 QT 副本还会重复解码和编码。

## 补丁范围

- `render/image/png.rs`：普通 PNG 按行解码、分离颜色与 alpha、ZIP 无损压缩；Adam7 交错 PNG 将七个扫描 pass 写入匿名临时文件，再逐行重建和压缩，不申请整个解码图像缓冲区。支持索引色、低位灰度、tRNS、8/16 位颜色及透明度。
- `render/image.rs`、`util/context.rs`：同一转换上下文内的栅格副本共用 Image XObject / SMask。缓存保留源 `Arc`，防止指针缓存键被分配器复用；每个资源容器仍独立登记引用。JPEG 读取头部尺寸和颜色信息，保留原压缩数据。
- `Cargo.toml`：图片功能新增 png 0.17、flate2、tempfile；均使用项目已有依赖版本。临时文件在正常返回、错误或进程退出时由系统回收。
- `util/helper.rs`：显式补齐 `Name<'_>` 生命周期，消除本地依赖编译警告。

图片不降采样，颜色与 alpha 样本不改写。SVG 变换、裁剪、遮罩、图层顺序和矢量内容继续走上游逻辑。GIF/WebP 保留上游解码方式并复用编码后的资源。

## 升级检查

升级上游时需对照上述四个源文件，避免丢失内存修复。不要直接把主依赖改回 registry 版本。

在 `src-tauri` 下运行 `cargo test --lib`。其中 `repeated_png_copies_share_one_lossless_image_and_alpha_resource` 检查资源复用；`interlaced_png_preserves_palette_alpha_and_sixteen_bit_samples` 通过实际 PDF 转换，解压颜色/透明度流并核对独立样本的 SHA-256。真实大图与 Windows 受限内存验证见 `docs/拼版PDF并行导出.md`。
