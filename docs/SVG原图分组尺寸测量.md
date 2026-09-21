# SVG 原图分组尺寸测量

上传在拆分之前读取原始 SVG。对图层下的直接子 `g`（以及顶层独立分组）统一建立完整 usvg 场景树，测量后释放场景树，再执行原有拆分流程。

- 使用路径的绝对变换和 `compute_tight_bounds()`，不计算描边外扩。
- 仅测量可见、无填充且有描边的路径；跳过带裁剪、蒙版或滤镜的子树，以及图片矩形、填充区域。
- 绝对坐标已经包含根 viewBox 映射，以 96 DPI 的 CSS px 乘 `25.4 / 96`，仅换算一次毫米。
- 使用原有组 ID 关联结果；匿名组仅在内存副本添加防冲突 ID。输入文件不改写。
- 拆分后的资产优先使用原图测量值，保存到双精度 `sourceGroupWidthMm`、`sourceGroupHeightMm`，并保存原坐标边界 `sourceGroupBounds`。保存批次时随资产写入数据库。
- 原始大 SVG 文件不改写。生成的单图 SVG 根 width/height 使用该组测量值并带 mm 单位，viewBox 对应该组原坐标边界；内部图层坐标和 transform 保留。页面视觉缩放不能回写物理测量值。

没有可测轮廓的图片仍使用原有边界回退；非独立组的散图场景仍使用原有场景拆分算法。这些回退不宣称具有轮廓测量的精度。历史记录不会被自动重新测量，需要重新导入源文件。

验证入口：`cargo test --manifest-path src-tauri/Cargo.toml --example verify_upload_measurement`。测试包含父级平移、缩放、匿名组、描边外扩、填充和裁剪污染，毫米误差断言小于 0.001。真实文件的精度仍需结合其路径内容与 CorelDRAW 显示值验证。
