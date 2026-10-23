# Photoshop PDF 专色通道兼容性

调查日期：2026-10-22。目标是直接打开导出的 PDF 时，在 Photoshop 2020 中保留 CMYK、White、C2、M2、Y2、K2，而不是仅验证 RIP 能否分色。

## 问题与规范边界

四个过程色加五个专色是 **9 个实际墨版**。Photoshop 通道面板还显示一个 CMYK 复合项，因此用户的标准截图共 **10 行**。复合项不应作为第十个实际墨版写进文件。

标准 PDF 的 `DeviceN / NChannel` 可以表达上述九个墨版，但不规定图像编辑器打开后必须生成可编辑专色通道。[PDF 32000-1:2008 §8.6.6.5](https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf#page=168) 定义的是设备着色、过程色与专色，以及显示设备的替代解释。该节还明确允许 NChannel 查看器使用自己的屏幕混色算法，而不使用给定的 tint transformation。因此，“替代函数只显示前四通道”也不能保证所有程序的合成预览相同。

Adobe 托管的同一规范 [§14.5，Page-Piece Dictionaries](https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf#page=559) 明确把 Photoshop 图层信息列为 `PieceInfo` 中私有应用数据的例子。`Private` 可以是任意类型，通常是字典；通用 PDF 阅读器可以忽略这些数据。规范没有公开规定 Photoshop 字典内部键的完整格式。

因此需要分开验收：

1. Ghostscript / 生产 RIP 能得到正确的九个墨版。
2. Photoshop 直接打开 PDF 后，存在四个过程通道、五个正确命名的专色通道，复合 CMYK 图像颜色正常。

通过第一项不能推断第二项通过。

## Photoshop 自身生成文件的实证

证据来自本机 Adobe Photoshop 2020 / 21.2 新建的专用小样，不涉及修改用户已经打开的文件。保存 Photoshop PDF 时保留编辑能力，然后用 pypdf 解读生成文件。这是实际产品输出的观察，不是公开稳定的格式承诺。

参考样本：`C:/Users/Admin/AppData/Local/Temp/printflow-ps-channels-08835c3344164249bc4771ddcafe4778/reference.pdf`，另存同名 PSD 用于对照。

参考 PDF 的页面中包含：

```text
/PieceInfo <<
  /AdobePhotoshop <<
    /LastModified (...)
    /Private 43 0 R
  >>
>>
```

其中对象 43 是字典，不是一整个嵌入 PSD：

```text
<<
  /CompositeImage 44 0 R
  /ImageResources 45 0 R
  /RoundTrip true
  /SaveTransparency true
  /SpotChannels << /N 5 /XObject 47 0 R >>
  /StandardImageFileData 46 0 R
  /StandardImageFileLength 3292
  /EmbedFonts true
  /ExportCrispy true
  /UseTextOutlines false
>>
```

相关对象结构：

| 对象 | 样本内容 | 实现意义 |
| --- | --- | --- |
| 44 | 完整页面的四通道 ICCBased CMYK Image XObject，100 × 120 px，另引用透明遮罩 49 | 编辑模式的合成主图；不是九通道 DeviceN 图像 |
| 45 | Flate 压缩的 Photoshop Image Resource Blocks，解压后 3314 字节 | 包含资源 1005 的 400 ppi 信息等；不是完整 PSD 文件 |
| 46 | 多个 `8BIM` 标记块，解压后 3292 字节 | 除 Layr 图层像素外，还包含关键的 Alph 专色描述块；后续验证证明只需 Alph 就能恢复通道 |
| 47 | 字典 `/Im1` 至 `/Im5` 分别引用对象 36 至 40 | 五个专色图像的顺序入口 |
| 36–40 | 五幅完整页面的单通道 Image XObject，与合成主图尺寸相同 | White / C2 / M2 / Y2 / K2 的逐像素数据 |

每个专色图像使用 `Indexed` 色彩空间，base 是对应命名的 `Separation`，lookup table 从 255 递减到 0：

```text
[/Indexed [/Separation /White alternateSpace tintTransform] 255 reverseTable]
```

这与 Photoshop 灰度通道的约定一致：原始灰度 0 表示满墨、255 表示空白；而 PDF Separation tint 0 表示无墨、1 表示满墨。[PDF §8.6.6.4](https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf#page=166) 明确说明这种 tint 约定与 DeviceGray 相反。实现中不能混淆墨量与灰度。

页面绘制流还包含 Photoshop 自定义 marked content：

```text
/MultiChannelImage <<
  /MainChannel /CMYKColorMode
  /Spot [(White) (C2) (M2) (Y2) (K2)]
>> BDC
  /SeparationImages BMC
    /SpotImage << /Ink (White) >> BDC ... /Im0 Do ... EMC
    ...
    /MainChannelImage BMC ... /Im5 Do ... EMC
  EMC
EMC
```

实际字符串采用含 BOM 的 UTF-16BE，并带结尾空字符；上面为了阅读简写成普通文字。标准规定 BMC / BDC / EMC 的语法和作用，但不规定上述 Photoshop 标签的业务含义。[PDF §14.6](https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf#page=560)。

## 最小兼容格式的验证方法

已从参考样本生成不覆盖源文件的差异小样，交由实际 Photoshop 打开验收：

| 小样 | 改动 |
| --- | --- |
| `removeStandard.pdf` | 删除 StandardImageFileData 与长度 |
| `removeStandardAndImageResources.pdf` | 再删除 ImageResources |
| `privateMinimal.pdf` | Private 仅保留 CompositeImage、SpotChannels、RoundTrip、SaveTransparency |
| `noPieceInfo.pdf` | 删除完整 PieceInfo |
| `noMarkedContent.pdf` | 保留绘图，移除 BMC / BDC / EMC 标记 |
| `directSeparation.pdf` | 专色不使用 Indexed wrapper，改用 Separation + Decode [1 0] |

通过实际 Photoshop COM 打开的结果：

| 变体 | Photoshop 实际结果 |
| --- | --- |
| 原参考文件 | 9 个实际通道，五个专色名字正确 |
| 删除 StandardImageFileData | 仅 4 个过程通道 |
| 删除 PieceInfo | 仅 4 个过程通道 |
| 删除 StandardImageFileData 和 ImageResources | 无法按编辑文件打开 |
| Private 仅保留四个字段 | 无法按编辑文件打开 |
| 删除 marked content | 仍有正确的 9 个通道 |
| Indexed 改为 Separation + Decode [1 0] | 仍有正确的 9 个通道 |
| StandardImageFileData 仅保留 Alph | 仍有正确的 9 个通道 |
| 删除 Layr 图层像素块 | 仍有正确的 9 个通道 |
| 保留所有块但删除 Alph | 仅 4 个过程通道 |
| 使用独立编码器重建 Alph | 正确的 9 个通道 |
| ImageResources 仅保留 1005 分辨率资源 | 正确的 9 个通道 |
| ImageResources 保留空流 | 正确的 9 个通道 |
| 删除 ImageResources 键 | 无法按编辑文件打开 |
| 删除 RoundTrip | 仅 4 个过程通道 |
| 删除 SaveTransparency | 正确的 9 个通道 |
| Private 中专色图像改为 DeviceGray | 正确的 9 个通道 |

**恢复专色通道的关键是私有 Alph 描述；恢复独立可编辑图层还需要 Layr 像素块。** 只有 Alph 时会恢复九通道，但图层面板只有背景。最小字典只保留 RoundTrip、CompositeImage、SpotChannels、ImageResources、StandardImageFileData 和长度，且 CompositeImage 去掉遮罩后，实测仍恢复九通道。

2026-10-23，以 Photoshop 自建“图片 + 彩窗”两层样本验证：StandardImageFileData 只保留独立编码的 Layr 与 Alph，仍可打开为上层“图片”、下层“彩窗”及九个实际墨版。Layr 记录按从底到顶写入；每层四个 CMYK 平面和独立 alpha，每通道 ZIP=2 压缩，CMYK 字节反向、alpha 正向。使用 luni 保存中文名称，无需复制 Photoshop 的历史、效果、时间戳等额外块。有彩窗的生产导出采用此结构；两份彩窗只相互合并，图片像素保持独立。

## Alph 的独立编码

以下是参考样本的直接解码，已用独立编码器重建，所得 568 字节与参考 Alph 块逐字节一致。`Alph` 没有出现在本次可读取的公开 Adobe PDF 规范里，应视作经过实测的 Photoshop 2020 私有结构。

所有整数使用大端。每个标记块使用如下格式，数据之后补零到 4 字节边界：

```text
8BIM            4 bytes
key             4 bytes
dataLength      u32，不含头和补零
data            dataLength bytes
padding         0–3 bytes
```

外层 `Alph` 的 data 为：

```text
totalChannels   u32 = 9
extraChannels   u32 = 5
repeat 5 times:
  recordLength  u32，不含本字段
  channelIndex  u32 = 4,5,6,7,8
  associatedID  i32 = -1
  tagged name   u32(UTF-16 code-unit count) + UTF-16BE，不带 BOM
  tagged kind   8BIMspot
  tagged opac   单字节 255，即密度 100%
  tagged colr   u16(2，CMYK) + 4 × u16(反向 CMYK)
  tagged id␠␠   u32，样本中依次为 3,4,5,6,7
```

每个 tagged 项本身也使用上述 `8BIM + key + length + data + padding` 格式。`White` 的 recordLength 为 112，其他名字长度为 2 的通道均为 104。Alph data 共 556 字节，加 12 字节头为 568 字节。

| 通道 | colr 中四个 16 位值 | 显示含义 |
| --- | --- | --- |
| White | FFFF FFFF FFFF 0000 | 黑色专色预览 |
| C2 | 0000 FFFF FFFF FFFF | 纯青 |
| M2 | FFFF 0000 FFFF FFFF | 纯洋红 |
| Y2 | FFFF FFFF 0000 FFFF | 纯黄 |
| K2 | FFFF FFFF FFFF 0000 | 纯黑 |

该反向颜色编码是专色的显示色元数据；墨量仍取每个专色 Image XObject 的像素，不能用显示色替代实际墨量。

ImageResources 最少可以保留资源 1005，独立生成分辨率元数据，不复制参考文档的历史、缩略图和打印设置：

```text
8BIM               4 bytes
resourceID         u16 = 1005
emptyPascalName    00 00
dataLength         u32 = 16
hResolution        u32 = dpi × 65536，16.16 定点数
hResolutionUnit    u16 = 1，像素/英寸
widthDisplayUnit   u16 = 2，厘米
vResolution        u32 = dpi × 65536
vResolutionUnit    u16 = 1
heightDisplayUnit  u16 = 2
```

与 Alph 不同，ImageResources 按 Photoshop 的图像资源块格式编码，名称和数据补齐规则为偶数字节，不能直接复用 Alph 的四字节补齐器。

## 生产实现约束

Photoshop 的私有合成主图与专色样本都是整板栅格。当前每个 SVG 原图一次转换、QT 复用 XObject 的页面内容可以继续用于通用 PDF，但不能直接假设多个小图的 Form XObject 可以替代 Photoshop 的 CompositeImage。

300 × 464 mm、400 ppi 约为 4724 × 7307 px。九个 8 位通道的裸数据约 296 MiB，还不包含原图解码、透明遮罩与压缩器。即使需要完整板材的私有图像，也应按单通道、分块或逐行构造并压缩，避免同时分配完整九通道板材缓冲。

验收应保留真实 Photoshop 打开的回归小样；使用私有字段需要明确版本范围。此前只通过 Ghostscript 分色和通用查看器预览的验证应补充 Photoshop 打开检查。

## 来源可用性

已读取 Adobe 官方托管的 PDF 32000-1:2008 全文。Adobe HelpX 的 Photoshop PDF / 专色说明和 adobe.com 的旧 Photoshop 文件格式页面在本次命令行访问中返回 403；没有把无法读取的页面当作已确认依据。上述 Photoshop 私有键来自本机产品输出的直接观察，未声称 Adobe 公布了其稳定规范。

## 实际导出实现的验收

使用本项目原生导出器生成四种模式，全部通过 Photoshop 2020 实际打开检查：9 个实际墨版、五个专色名称及顺序正确、密度 100%、400 ppi、配置 `250.icm`。两个真实整板的 400 ppi 及一个真实整板的 300 ppi 文件也通过。

另外把导出小样通过 Photoshop 保存为 PSD，解码其 RLE 通道像素后逐通道比较，九个通道与本项目生成的恢复数据完全一致，确认不仅通道名称正确，墨量、极性和位置也保持一致。参考样本及过程变体保存在系统临时目录，不作为软件运行依赖。可用 `scripts/verify-cmyk-photoshop.ps1` 对后续实际输出复查。
