/**
 * 会话地图扩展：项目下全部会话的会话级自由画布。
 * - 一会话一卡片；fork 后连线连到源会话；卡片可拖动，位置持久化（pi.state）
 * - 删除会话：派生子会话断线提升为新的根（removeSession 语义）
 * - mapData 一次性拉：会话列表 + 当前会话 + 已保存的节点坐标
 */
const handles = new Map()

export default function pi(api) {
  api.registerCommand('graph', {
    description: '打开会话地图（会话卡片画布：fork 连线、可拖动、删除断线提升）',
    handler: (_args, ctx) => {
      handles.get(ctx.sessionId)?.close()
      const handle = api.openPanel(
        { title: '会话地图', entry: 'panel/index.html', width: 760, height: 720 },
        {
          onMessage: async (op, params, c) => {
            if (op === 'mapData') {
              return {
                sessions: await c.sessions.listSessions(c.workspacePath),
                currentId: c.sessionId,
                positions: api.state.get('positions') ?? {}
              }
            }
            if (op === 'savePositions') {
              api.state.set('positions', params.positions && typeof params.positions === 'object' ? params.positions : {})
              return 'ok'
            }
            if (op === 'open') {
              const sid = String(params.sessionId ?? '')
              return sid || null
            }
            if (op === 'branch') {
              const sid = String(params.sessionId ?? '')
              const tree = await c.sessions.getTree(sid)
              if (!tree.leafId) return null
              return await c.sessions.fork(sid, tree.leafId)
            }
            if (op === 'remove') {
              return await c.sessions.removeSession(String(params.sessionId ?? ''))
            }
            throw new Error('未知操作：' + op)
          }
        },
        ctx.sessionId
      )
      handles.set(ctx.sessionId, handle)
      return '已打开会话地图'
    }
  })

  const refresh = (_payload, ctx) => {
    handles.get(ctx.sessionId)?.push({ kind: 'refresh' })
  }
  api.on('agent_end', refresh)
  api.on('turn_end', refresh)
  api.on('compacted', refresh)

  api.on('session_end', (_payload, ctx) => {
    handles.get(ctx.sessionId)?.close()
    handles.delete(ctx.sessionId)
  })
}
