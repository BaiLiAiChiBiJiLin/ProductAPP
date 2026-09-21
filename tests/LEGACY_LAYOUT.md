# 旧版排列测试归档

2026-09-19 用户明确要求重写排列算法，不兼容旧规则。

以下 `.legacy.mjs` 文件保留旧断言，不作为新布局验收：
- automatic-columns：动态列数、自动放大、旧版表头恢复。
- compact-product-layout：半宽产品组与旧版跨页回填。
- product-group-arrangement：旧版自由产品组与多详情面板。
- page-layout：旧版手动排版/竖向组合与相关视觉断言。

新的入口与特殊产品规则由 `three-column-layout.test.mjs` 验证；上传、产品属性、分组、原始尺寸、导出基础测试继续运行。归档文件没有删除，可以手动执行，但与当前规则不兼容。
