import type { FeatureTourRelease } from '../../types'
import dropUpload from './drop-upload.svg'
import replaceOnCanvas from './replace-on-canvas.svg'
import rulerModes from './ruler-modes.svg'
import noteStyle from './note-style.svg'
import layerRoles from './layer-roles.svg'
import reviewConfirm from './review-confirm.svg'
import cloudSync from './cloud-sync.svg'
import saveSync from './save-sync.svg'
import reviewFast from './review-fast.svg'

const staticSlide = (id: string, title: string, description: string, shortcuts: string[], image: string, alt: string) => ({
  id, title, description, shortcuts, animation: image, poster: image, alt,
})

export default {
  version: '0.1.36',
  id: 'schematic-generation-and-sync-2026-10',
  enabled: true,
  slides: [
    staticSlide('drop-upload', '排列页也能继续上传', '在上传区选择 SVG，或直接拖入排列页。解析完成后会加入图片池，并保持原始顺序和尺寸信息。', ['排列页上传', '拖入 SVG'], dropUpload, '图片池与排列页上传 SVG 的示意图'),
    staticSlide('replace-on-canvas', '拖到画布即可替换', '把图片池中的资源拖到已有画布位置，会替换当前图片并保留位置；被替换的原图自动回到图片池。', ['图片池 → 画布', '原图自动回池'], replaceOnCanvas, '从图片池拖动资源替换画布图片的示意图'),
    staticSlide('ruler-modes', '标尺方向可以锁定', '选择垂直、水平或自由方向后点击起点、终点和定位点完成标尺。双击数值还能修改尺寸并同步对应 Size。', ['垂直 / 水平 / 自由', '三次点击'], rulerModes, '画布水平和垂直标尺及尺寸数值的示意图'),
    staticSlide('note-style', '备注可以贴图并调整样式', '备注支持文字、粘贴图片和上传图片，还能设置字号与颜色。备注会跟随图片属性保存，切换图片不会串值。', ['Ctrl+V 图片', '字号 / 颜色'], noteStyle, '图片备注文字和样式控制的示意图'),
    staticSlide('layer-roles', '图层会自动归类', '解析 SVG 时识别正面、彩窗和背面图层，生成示意图时保留图片、描边、裁剪和原始物理尺寸。', ['正面 / 彩窗 / 背面', '自动归类'], layerRoles, 'SVG 图层自动归类为正面彩窗背面的示意图'),
    staticSlide('review-confirm', '生成前先检查分组', '点击生成示意图后按产品和印刷选项分类，数量多的分组优先排列。确认图片池无误后进入排列页，空间不足会自动新建页面。', ['按产品分类', '确认后排版'], reviewConfirm, '生成示意图前按产品和印刷选项分组确认的示意图'),
    staticSlide('cloud-sync', '解析先完成，云端后台同步', 'SVG 解析完成后先加入本地工作副本，图片属性修改也不必等待云端请求。共享文件上传会在后台合并写入、持久化排队并在网络恢复后自动重试；保存批次或确认生成时会等待同步完成。', ['先继续编辑', '后台上传'], cloudSync, '本地工作副本与云端后台同步的示意图'),
    staticSlide('save-sync', '明确操作会确认同步结果', '点击保存批次或确认生成示意图时，会等待当前同步队列完成。成功后清理已完成任务，避免旧队列覆盖最新数据。', ['保存 / 确认', '完成后清队列'], saveSync, '保存批次和确认生成等待同步完成的示意图'),
    staticSlide('review-fast', '审核和拼版读取更轻', '审核资源限制并发并复用当前会话缓存；拼版回退先从列表移除，云端更新放到后台，失败时自动刷新，详情使用短时缓存。', ['最多 4 个并发', '失败自动刷新'], reviewFast, '审核资源缓存和拼版后台回退的示意图'),
  ],
} satisfies FeatureTourRelease
