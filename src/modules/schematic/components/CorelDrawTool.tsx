import { useState } from 'react'
import { Button, message } from 'antd'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke, isTauri } from '@tauri-apps/api/core'

export default function CorelDrawTool() {
  const [loading, setLoading] = useState(false)
  const [messageApi, contextHolder] = message.useMessage()
  const launch = async () => {
    if (!isTauri()) return messageApi.warning('请在桌面版应用中使用 CorelDRAW 联动')
    setLoading(true)
    try {
      const path = await open({ multiple: false, filters: [{ name: '图片文件', extensions: ['svg', 'png', 'jpg', 'jpeg', 'cdr'] }] })
      if (typeof path !== 'string') return
      await invoke('open_with_coreldraw', { path })
      messageApi.success('已启动 CorelDRAW 打开所选文件，请在其中使用魔镜工具处理')
    }
    catch (error) { messageApi.error(String(error)) }
    finally { setLoading(false) }
  }
  return <div className="coreldraw-tool">{contextHolder}<div className="coreldraw-tool-title">CorelDRAW 魔镜工具</div><p>单独打开图片并交给 CorelDRAW 处理，不会加入当前批次。</p><Button block loading={loading} onClick={() => void launch()}>上传图片并打开 CorelDRAW</Button></div>
}
