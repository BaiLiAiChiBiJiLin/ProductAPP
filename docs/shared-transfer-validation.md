# 图片批次转移验证

验证日期：2026-10-14（Asia/Shanghai）。本次检查的是实际业务模块 `src-tauri/src/shared_transfers/{files,store,transport}.rs`，不是此前的共享存储概念原型。

`tools/shared-transfer-tests` 用 `#[path]` 直接编译上述模块，避免启动 Tauri/WebView。数据库表结构按当前业务结构创建；原始图片、备注附件、导出附件和审核 SVG 都是测试生成的数据，不读取用户批次。

## 已执行

```powershell
cargo test --manifest-path tools/shared-transfer-tests/Cargo.toml --target-dir .cargo-test-target/shared-transfer -- --test-threads=1
cargo run --manifest-path tools/shared-transfer-tests/Cargo.toml --target-dir .cargo-test-target/shared-transfer
```

已验证 25 项 Rust 回归。最终完整运行 24 项通过，另 1 项的测试断言误把 `resource-*.svg` 中的 `source` 子串当作发送目录，改为检查真实父目录后定向复测通过。活跃工作句柄测试包含模块自身的 5 秒锁等待，没有用更短的测试超时绕过锁行为。

前端转移弹窗、历史刷新、审核、生产拼版与基础页面的 49 项不同测试通过；`npx tsc -b`、应用 `cargo check`、独立存储示例编译通过。弹窗测试覆盖重复点击防护和发送错误，历史刷新测试覆盖接收后的列表更新与网络失败时保留本地记录。示例编译有原有的未使用代码提示。

| 场景 | 检查内容 | 结果 |
| --- | --- | --- |
| 完整转移及重复刷新 | 批次、图片、两条审核、生产记录；组长/资源 ID 映射；重复接收和确认不重复入库 | 通过 |
| 包内容损坏 | 校验失败，不导入、不写 ACK、不删除发送方记录 | 通过 |
| 用户目录 | 拒绝路径穿越及 Windows 保留名，注册可重复调用 | 通过 |
| 重复发送 | 等待接收期间不能再发送同一批次 | 通过 |
| 发布中断与 ACK 丢失 | 恢复 `.pending` 发布；已接收后重新生成 ACK，不重复导入 | 通过 |
| 活跃准备任务 | 排他工作句柄仍被持有时，恢复操作不解除 `preparing` 冻结 | 通过 |
| 孤立准备任务 | 句柄释放后允许恢复为失败，重新发送能成功接收 | 通过 |
| 转移完成后的旧页面 | 原批次、资产、审核及生产 ID 继续被 `ensure_editable` 拒绝 | 通过 |
| 共享包缺少 SVG 文件 | 不导入、不写 ACK，发送方原记录和原图保留 | 通过 |
| 发送源文件缺失 | 不发布，转移进入失败状态，不永久锁死原批次 | 通过 |
| 审核 SVG BLOB 与画布 | `printflow-review:r0` 可解析为原 SVG 字节；画布位置、尺寸、旋转、缩放、组和显示覆盖保持一致 | 通过 |
| 审核悬空资源引用 | 不存在的 `printflow-review:missing` 不得被接收并写 ACK | 通过 |
| 校验和正确的无效审核包 | 删除包内 BLOB 映射并重算文件校验和，仍拒绝逻辑悬空引用，不写 ACK | 通过 |
| 两个磁盘数据库重开 | 关闭并重开 SQLite 后，接收及发送完成操作仍保持幂等 | 通过 |
| 开发/生产目录选择 | 开发模式选择 `dev/historyProduction`，生产模式选择 `production/historyProduction`；原生入口传入 Tauri 实际环境 | 通过 |
| 历史共用资产 | 同一资产 ID 仍属于其他批次时拒绝发送，不冻结任何批次 | 通过 |
| 老审核文件路径 | 快照缺少 storagePath 时从本地资产表恢复，接收后使用本地目标文件 | 通过 |
| 连续转移 | B 收到 A 的批次后再转移给 C，关联记录可读且新 ID 长度保持有界 | 通过 |

另有 7 项 `cleanup.rs` 实际模块清理回归通过：剩余批次共享引用保留、路径不同写法按 canonical 比较、非托管 Desktop 导出保留、无引用托管 SVG/生产备注 PNG 删除、缺失路径无害、审核/配件/备注/生产路径引用保护、损坏旧 JSON 时先报错而不删除。测试 Desktop 为临时测试根内合成目录，不是用户桌面。

清理只使用注册的批次目录和原生代码传入的生产/旧版资产目录作为范围；只删除完成转移所返回的原文件候选。`package.sqlite`、`.bin` 等未被列为原文件候选的文件保持不动。只尝试移除空的子目录，管理根本身保留，没有递归清理。

首次新增回归发现：审核引用不存在的 BLOB 时仍会接收成功。核心模块补充了接收前的资源引用检查后，该测试通过。两处最初依赖新 ID 字符串格式的测试也已改为读取实际映射，避免把实现细节当作契约。

## 本地双库与实际 SMB 目录

CLI 使用两个独立的**本地磁盘 SQLite 数据库**，并启用与应用相同的 WAL 模式。仅交换包、清单和 ACK 写到共享目录，数据库不放在 SMB 上。

合成样本包含一个批次、两张图片、两条审核、一个生产记录；两张图片共用一份原始 SVG；审核各自含有效 SVG BLOB；另有备注及导出测试字节。包共 6 个文件、29,085 字节。测试校验文件长度和 SHA-256、真实尺寸、QT 的 `0` 和空值、产品映射、编组次序、备注名称与字节、审核画布、生产路径和重开后的幂等性。

| 执行 | 结果 | 此小样本流程耗时 |
| --- | --- | --- |
| 本地目录交换，两本地数据库 | 通过 | 357 ms |
| 实际 dev UNC 目录交换，两本地数据库 | 通过 | 506 ms |

按用户最新环境约定，开发和测试使用 `\\192.168.0.66\电商文件\printFlow\dev`，安装后的生产环境使用 `...\production`，各自保留 `historyProduction` 子目录。最新 UNC 检查于 2026-10-14 16:42:02 完成，使用下列全新、独立开发测试目录：

```text
\\192.168.0.66\电商文件\printFlow\dev\historyProduction\shared-validation\probe-handoff-20261014-83c98c76f870479197c2b9d3dd887abf
```

共享目录中的 `verification-report.json` 为该次结构化结果，任务 ID 为 `6ea865af4fdde2de5d6423c368082188`。本地数据库与结果副本位于：

```text
C:\Users\Admin\AppData\Local\Temp\printflow-handoff-23144-0454d3e13eb272f3a9d54145a19896fc
```

接收库最终为：1 批次、2 资产、2 审核、2 BLOB、1 生产记录、1 接收凭据。发送完成后发送库对应业务记录均为 0。接收重开后新增数为 0；发送库重开后再次完成数为 0。

可以用同一 CLI 重复检查，但必须选取**不存在的**新目录；工具拒绝复用已有交换根：

```powershell
$probeRoot = '\\192.168.0.66\电商文件\printFlow\dev\historyProduction\shared-validation\probe-handoff-' + [guid]::NewGuid().ToString('N')
& '.cargo-test-target/shared-transfer/debug/shared-transfer-tests.exe' --shared-root $probeRoot
```

CLI 默认自行新建临时本地根，包含发送库、接收库、源附件、暂存区、接收区及报告。共享目录中只创建合成用户目录和测试任务。没有递归删除操作；测试数据留存用于检查。`finalize` 返回的源文件清理候选已检查非空，但本工具不调用应用的源文件物理清理层。

环境约定调整之前，16:33:32 曾在 `\\192.168.0.66\电商文件\printFlow\production\historyProduction\shared-validation\probe-handoff-20261014-3173f15fb13f470185604a5e1ae08d28` 执行过同样的合成小样本检查，耗时 526 ms，任务 ID 为 `1c87163171d867200a31a0f7f9cce7f0`。该历史测试目录没有迁移或删除，现已弃用；约定调整后的新增 UNC 检查均放在 dev 下，开发测试不再触碰 production。

## 验证范围

以上是**一台 Windows 电脑使用两个本地数据库**的实际 SMB 收发结果，不是两台物理电脑测试。活跃句柄检查也是同机句柄，不可据此宣称多客户端故障处理已通过。

未验证真实断网、SMB 服务器重启、跨电脑同时操作、WebView 界面、实际用户批次、大 SVG 压力，以及完整应用的源文件清理。备注和导出附件是字节一致性测试，未检查 PNG/PDF 渲染。506 ms 仅为这份小型合成样本的测量，不能代表实际生产批次性能。
