# 产品选项图片上传

选项卡片使用“上传图片／替换图片”选择文件，上传成功后将稳定 HTTPS URL 写入选项值的 `image` 字段；点击页面“保存”才保存产品配置。失败保留原图。移除图片只清除配置引用，不删除 OSS 对象。

支持 PNG、JPEG、WebP、GIF，最大 4 MiB。客户端先检查类型和大小，服务端再次检查大小、MIME 和文件头；这不是完整的图片解码或像素尺寸检查。

## 桌面配置

实际配置位于应用数据目录下的 `settings/product-options/oss.local.json`。开发项目对应 `D:/project/productionAPP/printflow-data/settings/product-options/oss.local.json`，可参考本文档目录中的 `oss.config.example.json` 填写。该文件不随配置 JSON 导出、不打包、不提交 Git，Vite 也禁止通过 HTTP 读取。非空同名环境变量可以覆盖桌面配置值。

`OSS_ENDPOINT` 可以填 Region 域名或带 Bucket 的域名，两种都会规范为一次 Bucket 前缀。`OSS_ENDPOINT_IS_CNAME=false` 用于阿里云官方域名；自定义绑定域名才设为 `true`。

默认对象路径：

```text
uploads/product-options/<entityKey>/<valueId>/<随机名称>.<扩展名>
```

例如 `techniqueId/G1` 与 `accessoryStyleId/P1` 分别存放。配置 `OSS_OBJECT_PREFIX` 时，在上述路径前追加指定目录。每次替换创建新对象并禁止覆盖，因此其他产品引用的旧地址仍有效。

Tauri 命令 `upload_product_option_image` 接收 `{ input: { entityKey, valueId, contentType, contentBase64 } }`，返回 `{ url, objectKey }`。密钥只由原生后端读取，前端不接收密钥。增加原生命令后，正在运行的桌面应用需要重新编译／启动后才能调用。

## 将来部署到 Vercel

前端已支持同源接口：

```http
POST /api/product-options/images?entityKey=techniqueId&valueId=G1
Content-Type: image/png

<原始图片字节>
```

成功返回 `{ "url": "https://…", "objectKey": "uploads/…" }`。采用原始字节避免 base64 增大浏览器请求，4 MiB 上限为 Vercel Function 的请求体限制留出余量。浏览器不直连 OSS，因此无需为这条上传链路开放 Bucket CORS。

`imageUploadHandler.server.ts` 提供标准 Web Request/Response 处理器，适合接入 Vercel 上的 Next.js Node.js Route Handler：

```ts
import { createImageUploadHandler } from '@/modules/settings/product-options/server/imageUploadHandler.server'
import { getAdminSession } from '@/server/auth' // 对接独立站实际的管理端登录

export const runtime = 'nodejs'
export const POST = createImageUploadHandler({
  authorize: async request => Boolean((await getAdminSession(request))?.canManageProductOptions),
})
```

将此路由放在 `app/api/product-options/images/route.ts`，并在 Vercel 服务端环境变量中填写示例文件中的 `OSS_*` 值。**不要使用 `VITE_` 或 `NEXT_PUBLIC_` 前缀，不要从浏览器组件导入 `server/` 文件。** 未接入管理端登录时不得将上传接口公开；处理器会拒绝认证失败和不同来源的请求。

当前项目是桌面应用，本次没有创建或部署独立 Vercel 站点。迁出时还需将产品配置的读取／保存接口从 Tauri 改为数据库或对象存储，不能把 Vercel 本地文件当成持久数据库。上传接口与配置存储是独立职责。

当前 Bucket 的图片可公开读取，返回 URL 不含临时签名；若以后改成私有 Bucket，需要另行配置图片 CDN 或受控读取接口，不能将短期签名 URL 当长期配置保存。

本模块保存图片不会自动发布到旧 Shopify 网站。旧站仍从商品 `customizer.product_options` metafield 读取选项，需要额外的转换／同步流程。
