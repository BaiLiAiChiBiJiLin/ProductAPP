# 示意图排列

当前使用 `threeColumnLayout.ts` 固定三列及特殊产品布局。完整规格见 [ARRANGEMENT_RULES.md](../ARRANGEMENT_RULES.md)。

生成、自动排列及变更通过 `services/paginationService.ts` 进入此实现。旧版动态列数及紧凑回填文件仅保留追溯，不作为新页面入口。

验证：`node --test tests/three-column-layout.test.mjs`；通用回归：`npm test`。

串串布局会让每个正反面共享同一尺寸，并以组内中位原始尺寸做轻微归一，避免大图拉开布局；缩放不会超过原图。
