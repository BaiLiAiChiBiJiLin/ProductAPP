# 本地 SVG 上传 API

PrintFlow 启动后会在本机回环地址监听一个轻量 HTTP API，供订单系统、设计工具或脚本触发 SVG 上传。接口优先使用 `47821`，如果被占用会自动尝试后续备用端口。接口只监听 `127.0.0.1`，不会对局域网开放。

## 地址

默认地址为 `http://127.0.0.1:47821`。实际端口以启动后生成的文件为准：

```text
printflow-data/cache/local-api.json
```

文件示例：

```json
{"host":"127.0.0.1","port":47821,"url":"http://127.0.0.1:47821"}
```

## 健康检查

```http
GET /api/health
```

也可以使用 `GET /api/port` 查询当前端口；两个接口都会返回 `host`、`port` 和 `url`。

成功响应：

```json
{"ok":true,"service":"printflow"}
```

## 触发 SVG 上传

```http
POST /api/import-svg
Content-Type: application/json

{"path":"D:\\订单\\4171734146.svg"}
```

PowerShell 示例：

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:47821/api/import-svg `
  -ContentType "application/json" `
  -Body '{"path":"D:\\订单\\4171734146.svg"}'
```

成功时返回 HTTP `202`：

```json
{"accepted":true,"path":"D:\\订单\\4171734146.svg"}
```

请求被接受后，软件通过已有的 SVG 上传流程解析文件，因此会继续使用原有的拆分、进度条、图片池和当前批次逻辑。

## 校验和限制

- `path` 必须是绝对路径。
- 文件扩展名必须是 `.svg`，不区分大小写。
- 文件必须存在且必须是普通文件。
- SVG 最大大小为 500MB。
- 请求体最大为 16KB。
- 当前页面处于图片上传页时，文件加入当前打开的批次；没有打开批次时按现有规则创建批次。
- 启动时优先绑定 `47821`，随后依次尝试最多 20 个备用端口。
- 每次启动成功后原子写入 `printflow-data/cache/local-api.json`；外部程序应读取该文件或调用健康检查获取实际地址。

## 实现位置

- Rust HTTP 服务：`src-tauri/src/local_api.rs`
- Tauri 启动注册：`src-tauri/src/lib.rs`
- 前端事件接收：`src/modules/schematic/SchematicPage.tsx`
- 事件名：`external-svg-import`
