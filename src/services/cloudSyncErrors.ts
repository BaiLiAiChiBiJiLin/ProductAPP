export type CloudSyncFailure = {
  kind: 'connection' | 'conflict' | 'source' | 'permission' | 'configuration' | 'data' | 'unknown' | 'local-storage'
  retryable: boolean
  message: string
  action: string
}

/** Legacy native commands return safe Chinese messages, not structured error codes.
 * Only definite business failures stop automatic retries; ambiguous I/O stays retryable.
 */
export function classifyCloudSyncError(error: unknown): CloudSyncFailure {
  const message = error instanceof Error ? error.message : String(error)
  const failure = (kind: CloudSyncFailure['kind'], retryable: boolean, action: string): CloudSyncFailure => ({ kind, retryable, message, action })
  const databaseCode = Number(message.match(/云数据库操作失败（代码\s+(\d+)）/)?.[1])
  if ([1044, 1045, 1142, 1143].includes(databaseCode)) return failure('permission', false, '请检查数据库账号和访问权限，处理后重试。')
  if ([1049, 1054, 1146].includes(databaseCode)) return failure('configuration', false, '请检查数据库结构与软件版本，处理后重试。')
  if (/同步队列.*(写入|保存|读取)|同步请求.*(写入|保存|读取)|本地同步.*(写入|保存|读取)|本地云端同步日志|QuotaExceeded/i.test(message)) {
    return failure('local-storage', false, '本地同步记录未能保存，请保留当前页面，释放磁盘空间后重试。')
  }
  if (/记录已被其他用户修改|读取的云端记录已过期|请求编号已用于不同内容|保存请求内容不一致/.test(message)) {
    return failure('conflict', false, '云端版本有变化，本地待同步修改仍保留。请核对云端内容后处理，自动重试不会覆盖其他人的修改。')
  }
  if (/已转移或不属于当前用户|用户不存在或已停用|已绑定的云端用户不可用|请先设置用户名|请先设置用户名并连接|用户配置无效/.test(message)) {
    return failure('permission', false, '请检查当前账号和批次归属，处理后重试。')
  }
  if (/未找到可恢复的共享副本|需归档的图片或导出文件不存在/.test(message)) {
    return failure('source', false, '请恢复源文件或重新导入缺失图片；当前批次的待同步修改已保留。')
  }
  if (/存储配置格式错误|存储模式只能|缺少当前环境|填写.*数据库|共享文件目录必须|结构版本不兼容/.test(message)) {
    return failure('configuration', false, '请检查存储配置或更新软件，处理后重试。')
  }
  if (/图片资产格式错误|批次没有图片|图片 ID 缺失或重复|缺少或无效字段|历史批次不存在|历史批次已删除|共享资源标识无效|共享资源路径无效|超出存储目录|共享资源内容冲突|共享图片校验失败/.test(message)) {
    return failure('data', false, '请核对批次和图片数据后重试；待同步内容不会被自动丢弃。')
  }
  if (/连接|网络|超时|目录不可访问|其他电脑正在|无法读取存储配置|offline|network|timeout|connection/i.test(message)) {
    return failure('connection', true, '连接恢复后会自动重试，也可以立即重试。')
  }
  return failure('unknown', true, '后台将自动重试；若持续失败，请根据失败原因检查共享目录和数据库连接。')
}
