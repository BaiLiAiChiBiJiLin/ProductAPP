import type { FeatureTourRelease } from '../../types'
import blockResizeAnimation from './block-resize.gif'
import blockResizePoster from './block-resize.png'
import imageScaleAnimation from './image-scale.gif'
import imageScalePoster from './image-scale.png'
import manualRulerAnimation from './manual-ruler.gif'
import manualRulerPoster from './manual-ruler.png'
import multiCombineAnimation from './multi-combine.gif'
import multiCombinePoster from './multi-combine.png'

export default {
  version: '0.1.32',
  id: 'schematic-editing-2026-10',
  enabled: true,
  slides: [
    { id: 'block-resize', title: '块缩放，让布局更合适',
      description: '选中块后拖动边缘：宽度按 1、2、3 列调整，高度自由调整。拖动角点可同时调整宽高，后面的块会自动重排。',
      shortcuts: ['拖动边缘', '拖动角点'], animation: blockResizeAnimation, poster: blockResizePoster, alt: '块缩放操作示意：选中块，拖动边缘和角点调整宽高' },
    { id: 'image-scale', title: '图片大小，滚轮就能调',
      description: '先选中图片或图片组，按住 Alt 滚动鼠标，每次调整 10%。图片与标尺同步缩放，真实尺寸保持不变。',
      shortcuts: ['Alt + 滚轮', '每次 10%'], animation: imageScaleAnimation, poster: imageScalePoster, alt: '图片缩放操作示意：按住 Alt 使用滚轮调整显示比例，标尺同步变化' },
    { id: 'manual-ruler', title: '手动画标尺，三次点击完成',
      description: '先点击测量起点和终点，再移动鼠标决定延伸线的方向与长度，第三次点击完成。标尺文字会跟随角度旋转。',
      shortcuts: ['① 起点', '② 终点', '③ 定位'], animation: manualRulerAnimation, poster: manualRulerPoster, alt: '手动画标尺操作示意：先点击两个测量端点，移动后第三次点击确定延伸线' },
    { id: 'multi-combine', title: '多张一起组合，还能继续加',
      description: '按住 Ctrl 多选同产品的块，再点击“组合”。已经组合的块也能继续与其他图片、其他组合合并。',
      shortcuts: ['Ctrl + 多选', '可继续组合'], animation: multiCombineAnimation, poster: multiCombinePoster, alt: '组合操作示意：多选三个块完成组合，再把已有组合与其他块继续合并' },
  ],
} satisfies FeatureTourRelease
