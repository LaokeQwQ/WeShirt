import { getSiteConfig } from './site.js'
import { issueTicket, verifyTicket } from '../packages/core/auth.js'
import { normalizeDormBuilding, dormBuildingName } from '../packages/core/buildings.js'
import { ASSISTANT_LIMITS, AssistantError, BUILTIN_SKILLS, MACHINE_TOOL, assistantConfig, publicAssistantConfig, patchAssistantConfig, validateSkill, beijingDay, pruneHistory, memoryHabits, machineStatus, callAssistant, readBoundedJson, plainObject, discoverAssistantModels, normalizePromptProfiles } from '../packages/core/assistant.js'
import { mobileDigest } from '../packages/core/mobile-auth.js'

const runtimes = new WeakMap()
function runtime(store) { if (!runtimes.has(store)) runtimes.set(store, new Set()); return runtimes.get(store) }
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } })
const fail = (error) => json({ error: { code: error instanceof AssistantError ? error.code : 'unavailable', message: error instanceof AssistantError ? error.message : '助手服务暂时不可用，请稍后再试' } }, error instanceof AssistantError ? error.status : 503)
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)
const configKey = 'assistant:config'
const memoryKey = (id) => `assistant:memory:${id}`
const historyKey = (id) => `assistant:history:${id}`
const skillsKey = (id) => `assistant:skills:${id}`
const preferencesKey = (id) => `assistant:preferences:${id}`
const emptyMemory = () => ({ enabled: false, note: '', since: 0 })

async function locked(store, key, action) {
  const active = runtime(store)
  if (active.has(key)) throw new AssistantError('busy', '已有请求正在处理，请稍后再试', 429)
  active.add(key)
  try { return await action() } finally { active.delete(key) }
}
async function readBody(c) {
  const body = await readBoundedJson(c.req.raw, 196608)
  if (!plainObject(body)) throw new AssistantError('bad_param', '请求须为 JSON 对象')
  return body
}
function cleanMemory(value) {
  return { enabled: value?.enabled === true, note: typeof value?.note === 'string' ? value.note.slice(0, 500) : '', since: Number.isFinite(value?.since) ? value.since : 0 }
}
function usageFor(value, config, now = Date.now()) {
  const day = beijingDay(now)
  const minute = Math.floor(now / 60000)
  const count = value?.day === day ? Number(value?.count) || 0 : 0
  const minuteCount = value?.minute === minute ? Number(value?.minuteCount) || 0 : 0
  return { day, count, minute, minuteCount, dailyLimit: config.dailyLimit, minuteLimit: config.minuteLimit, dailyRemaining: Math.max(0, config.dailyLimit - count), minuteRemaining: Math.max(0, config.minuteLimit - minuteCount) }
}
function visibleUsage(value) { const { day, count, dailyLimit, minuteLimit, dailyRemaining, minuteRemaining } = value; return { day, used: count, dailyLimit, minuteLimit, dailyRemaining, minuteRemaining } }
const rpcError = (id, code, message, status = 200) => json({ jsonrpc: '2.0', id, error: { code, message } }, status)

// Run from the existing maintenance cron so inactive accounts also lose expired chat data.
export async function pruneAssistantStorage(store, now = Date.now()) {
  let pruned = 0
  for (const { key, value } of await store.list('assistant:history:')) {
    const userId = key.slice('assistant:history:'.length)
    if (runtime(store).has(`chat:${userId}`)) continue
    const messages = pruneHistory(value, now)
    if (JSON.stringify(value) !== JSON.stringify(messages)) {
      if (messages.length) await store.put(key, messages)
      else await store.del(key)
      pruned++
    }
  }
  return { pruned }
}

export async function deleteAssistantUserData(store, userId) {
  for (const key of [memoryKey(userId), historyKey(userId), skillsKey(userId), preferencesKey(userId), `assistant:usage:${userId}`, `assistant:mcp:${userId}`]) await store.del(key)
}

/** All identity and board access is resolved server-side; clients cannot pass a user or building. */
export function registerAssistantRoutes(app, { store, env = {}, authenticate, checkAdmin, getBoard, fetchImpl = globalThis.fetch, atomicStore }) {
  async function userFor(c) {
    const identity = await authenticate(c)
    const id = typeof identity === 'string' ? identity : identity?.id || identity?.userId
    if (!id || typeof id !== 'string') throw new AssistantError('unauthorized', '请先登录', 401)
    const user = await store.get(`user:${id}`, null)
    if (!user || user.disabled || user.blocked) throw new AssistantError('unauthorized', '账号不可用，请重新登录', 401)
    return { ...user, id }
  }
  const loadConfig = async () => assistantConfig(await store.get(configKey, {}), env)
  const quotaKey = async id => 'mobile:limit:assistant:' + await mobileDigest(id)
  async function readUsage(id, config) {
    if (atomicStore) {
      try { const row = await atomicStore.get(await quotaKey(id)); return usageFor(row?.value || await store.get(`assistant:usage:${id}`,{}),config) }
      catch { throw new AssistantError('quota_unavailable','调用额度暂时无法核验，请稍后重试',503) }
    }
    return usageFor(await store.get(`assistant:usage:${id}`,{}),config)
  }
  async function reserveRequest(id, config, first) {
    const reserve = value => {
      const usage = usageFor(value,config)
      if ((first && !usage.dailyRemaining) || !usage.minuteRemaining) throw new AssistantError('rate_limit',first && !usage.dailyRemaining ? '今日 AI 额度已用完，明天再来' : '本分钟模型请求已达上限，请稍后重试',429)
      return {day:usage.day,count:usage.count+(first?1:0),minute:usage.minute,minuteCount:usage.minuteCount+1}
    }
    if (!atomicStore) {
      const next = reserve(await store.get(`assistant:usage:${id}`,{}))
      await store.put(`assistant:usage:${id}`,next)
      return usageFor(next,config)
    }
    try {
      const key = await quotaKey(id)
      for(let attempt=0;attempt<8;attempt++) {
        const row = await atomicStore.get(key)
        const next = reserve(row?.value || await store.get(`assistant:usage:${id}`,{}))
        if (await atomicStore.compareAndSet(key,row?.version || null,next,{expiresAt:Date.now()+2*86400000})) return usageFor(next,config)
      }
    } catch(error) { if(error instanceof AssistantError)throw error; throw new AssistantError('quota_unavailable','调用额度暂时无法核验，请稍后重试',503) }
    throw new AssistantError('busy','调用额度正在更新，请稍后重试',429)
  }
  async function withChatLease(id,action) {
    if(!atomicStore)return action()
    const key='mobile:limit:assistant-chat:'+await mobileDigest(id),owner=crypto.randomUUID()
    let claimed=false
    try {
      for(let attempt=0;attempt<8;attempt++) {
        const row=await atomicStore.get(key)
        if(row?.value?.until>Date.now())throw new AssistantError('busy','已有问题正在处理，请稍后再试',429)
        if(await atomicStore.compareAndSet(key,row?.version||null,{owner,until:Date.now()+30000},{expiresAt:Date.now()+30000})){claimed=true;break}
      }
      if(!claimed)throw new AssistantError('busy','已有问题正在处理，请稍后再试',429)
    }catch(error){if(error instanceof AssistantError)throw error;throw new AssistantError('quota_unavailable','暂时无法确认处理状态，请稍后重试',503)}
    try{return await action()}
    finally{
      try{const row=await atomicStore.get(key);if(row?.value?.owner===owner)await atomicStore.compareAndSet(key,row.version,{owner:'',until:0},{expiresAt:Date.now()+1000})}catch{/* The bounded lease expires even if a release fails. */}
    }
  }
  async function readPreferences(user,config) {
    const saved = await store.get(preferencesKey(user.id),null)
    let promptProfiles
    try { promptProfiles = saved ? normalizePromptProfiles(saved.promptProfiles) : config.promptProfiles } catch { promptProfiles = config.promptProfiles }
    return {promptProfiles,activePromptId:promptProfiles.some(row=>row.id===saved?.activePromptId) ? saved.activePromptId : promptProfiles.some(row=>row.id===config.activePromptId) ? config.activePromptId : promptProfiles[0].id,customized:!!saved}
  }
  const wrap = (action) => async (c) => { try { return await action(c) } catch (error) { return fail(error) } }
  const ownSkills = async (id) => {
    const data = await store.get(skillsKey(id), [])
    return (Array.isArray(data) ? data : []).slice(0, 20)
  }
  async function statusFor(user, kind) {
    const catalog = (await getSiteConfig(store)).buildings
    if (!normalizeDormBuilding(user.dormBuilding, catalog)) throw new AssistantError('building_required', '请先在设置中绑定住宿楼', 409)
    const result = await getBoard({ userId: user.id, dormBuilding: user.dormBuilding })
    return machineStatus({ ...(result?.board ? result : { board: result }), buildings: catalog }, user, kind)
  }
  async function readMemory(user) {
    const memory = cleanMemory(await store.get(memoryKey(user.id), emptyMemory()))
    const habits = memory.enabled ? memoryHabits(await store.get(`tasks:${user.id}`, []), Date.now(), memory.since) : null
    return { ...memory, habits }
  }
  async function readHistory(user) {
    const source = await store.get(historyKey(user.id), [])
    const messages = pruneHistory(source)
    if (JSON.stringify(source) !== JSON.stringify(messages)) await store.put(historyKey(user.id), messages)
    return messages
  }
  app.get('/api/admin/assistant', wrap(async (c) => {
    if (!await checkAdmin(c)) throw new AssistantError('forbidden', '请先登录管理后台', 401)
    return json(publicAssistantConfig(await loadConfig()))
  }))
  app.patch('/api/admin/assistant', wrap(async (c) => {
    if (!await checkAdmin(c)) throw new AssistantError('forbidden', '请先登录管理后台', 401)
    const body = await readBody(c)
    return locked(store, 'assistant:config', async () => {
      const next = patchAssistantConfig(await loadConfig(), body)
      await store.put(configKey, next)
      return json(publicAssistantConfig(next))
    })
  }))
  app.post('/api/admin/assistant/models',wrap(async c=>{
    if(!await checkAdmin(c))throw new AssistantError('forbidden','请先登录管理后台',401)
    const body=await readBody(c)
    if(Object.keys(body).some(key=>!['protocol','endpoint','apiKey'].includes(key)))throw new AssistantError('bad_param','模型发现参数无效')
    const current=await loadConfig()
    const config=patchAssistantConfig({...current,enabled:false},body)
    return locked(store,'assistant:models',async()=>json(await discoverAssistantModels({config,fetchImpl,resolveHost:env.ASSISTANT_RESOLVE_HOST})))
  }))
  app.get('/api/assistant/preferences',wrap(async c=>json(await readPreferences(await userFor(c),await loadConfig()))))
  app.patch('/api/assistant/preferences',wrap(async c=>{
    const user=await userFor(c),body=await readBody(c)
    if(Object.keys(body).some(key=>!['promptProfiles','activePromptId','reset'].includes(key)) || own(body,'reset') && typeof body.reset!=='boolean')throw new AssistantError('bad_param','提示词设置无效')
    return locked(store,`preferences:${user.id}`,async()=>{
      const config=await loadConfig()
      if(body.reset===true){await store.del(preferencesKey(user.id));return json(await readPreferences(user,config))}
      const current=await readPreferences(user,config)
      const promptProfiles=own(body,'promptProfiles') ? normalizePromptProfiles(body.promptProfiles) : current.promptProfiles
      const activePromptId=body.activePromptId ?? current.activePromptId
      if(!promptProfiles.some(row=>row.id===activePromptId))throw new AssistantError('bad_param','请选择存在的提示词')
      await store.put(preferencesKey(user.id),{promptProfiles,activePromptId})
      return json({promptProfiles,activePromptId,customized:true})
    })
  }))
  app.get('/api/assistant/status', wrap(async (c) => {
    const user = await userFor(c)
    const [site, config, memory] = await Promise.all([
      getSiteConfig(store), loadConfig(), store.get(memoryKey(user.id), emptyMemory()),
    ])
    const usage = await readUsage(user.id,config)
    const catalog = site.buildings
    return json({ enabled: config.enabled, ready: publicAssistantConfig(config).ready, dormBuilding: normalizeDormBuilding(user.dormBuilding, catalog), buildingName: dormBuildingName(user.dormBuilding, catalog), usage: visibleUsage(usage), limits: { input: ASSISTANT_LIMITS.input, history: ASSISTANT_LIMITS.history, retentionDays: 14,context:128000,minuteHardLimit:30 },skillsEnabled:true,mcpEnabled:true,readonlyTools:[MACHINE_TOOL.name], memoryEnabled: cleanMemory(memory).enabled })
  }))
  app.get('/api/assistant/history', wrap(async (c) => json({ messages: await readHistory(await userFor(c)) })))
  app.delete('/api/assistant/history', wrap(async (c) => {
    const user = await userFor(c)
    return locked(store, `chat:${user.id}`, () => withChatLease(user.id,async () => { await store.del(historyKey(user.id)); return json({ ok: true, messages: [] }) }))
  }))
  app.get('/api/assistant/memory', wrap(async (c) => json(await readMemory(await userFor(c)))))
  app.patch('/api/assistant/memory', wrap(async (c) => {
    const user = await userFor(c)
    const body = await readBody(c)
    if (Object.keys(body).some((key) => !['enabled', 'note'].includes(key)) || (own(body, 'enabled') && typeof body.enabled !== 'boolean') || (own(body, 'note') && (typeof body.note !== 'string' || body.note.length > 500 || body.note.includes('\0')))) throw new AssistantError('bad_param', '记忆设置无效，备注最多 500 字')
    return locked(store, `memory:${user.id}`, async () => {
      const memory = cleanMemory(await store.get(memoryKey(user.id), emptyMemory()))
      const next = { ...memory, ...(own(body, 'enabled') ? { enabled: body.enabled } : {}), ...(own(body, 'note') ? { note: body.note.trim() } : {}) }
      await store.put(memoryKey(user.id), next)
      return json(await readMemory(user))
    })
  }))
  app.delete('/api/assistant/memory', wrap(async (c) => {
    const user = await userFor(c)
    return locked(store, `memory:${user.id}`, async () => { const next = { enabled: false, note: '', since: Date.now() }; await store.put(memoryKey(user.id), next); return json({ ...next, habits: null }) })
  }))
  app.get('/api/assistant/skills', wrap(async (c) => {
    const user = await userFor(c)
    return json({ skills: [...BUILTIN_SKILLS, ...await ownSkills(user.id)] })
  }))
  async function saveSkill(user, value) {
    const clean = validateSkill(value)
    return locked(store, `skills:${user.id}`, async () => {
      const skills = await ownSkills(user.id)
      if (skills.length >= 20) throw new AssistantError('skill_limit', '最多保存 20 个自定义 Skill', 409)
      const skill = { ...clean, id: 'skill-' + crypto.randomUUID(), builtin: false }
      await store.put(skillsKey(user.id), [...skills, skill])
      return json({ skill }, 201)
    })
  }
  app.post('/api/assistant/skills', wrap(async (c) => saveSkill(await userFor(c), await readBody(c))))
  app.delete('/api/assistant/skills/:id', wrap(async (c) => {
    const user = await userFor(c)
    return locked(store, `skills:${user.id}`, async () => {
      const skills = await ownSkills(user.id)
      const next = skills.filter((skill) => skill.id !== c.req.param('id'))
      if (next.length === skills.length) throw new AssistantError('not_found', '此自定义 Skill 不存在', 404)
      await store.put(skillsKey(user.id), next)
      return json({ ok: true })
    })
  }))
  app.post('/api/assistant/skills/:id/share', wrap(async (c) => {
    const user = await userFor(c)
    const skill = [...BUILTIN_SKILLS, ...await ownSkills(user.id)].find((s) => s.id === c.req.param('id'))
    if (!skill) throw new AssistantError('not_found', '此 Skill 不存在', 404)
    const secret = String(env.AUTH_SECRET || '')
    if (secret.length < 16) throw new AssistantError('not_configured', '分享功能暂未配置', 503)
    const expiresAt = Date.now() + 7 * 86400000
    const ticket = await issueTicket({ type: 'assistant_skill', skill: validateSkill(skill), exp: expiresAt }, secret)
    return json({ ticket, expiresAt })
  }))
  app.post('/api/assistant/skills/import', wrap(async (c) => {
    const user = await userFor(c)
    const body = await readBody(c)
    if (typeof body.ticket !== 'string' || body.ticket.length > 10000 || String(env.AUTH_SECRET || '').length < 16) throw new AssistantError('bad_ticket', '分享码无效或已过期')
    const data = await verifyTicket(body.ticket, env.AUTH_SECRET)
    if (data?.type !== 'assistant_skill') throw new AssistantError('bad_ticket', '分享码无效或已过期')
    return saveSkill(user, data.skill)
  }))
  app.post('/api/assistant/chat', wrap(async (c) => {
    const user = await userFor(c)
    const body = await readBody(c)
    if (typeof body.input !== 'string' || !body.input.trim() || body.input.length > 1000 || body.input.includes('\0') || Object.keys(body).some((key) => !['input', 'skillId'].includes(key)) || (body.skillId != null && (typeof body.skillId !== 'string' || body.skillId.length > 100))) throw new AssistantError('bad_param', '请输入 1 至 1000 字的问题')
    const config = await loadConfig()
    if (!publicAssistantConfig(config).ready) throw new AssistantError('not_configured', 'AI 助手暂未启用，请先使用看板查询', 503)
    if (!normalizeDormBuilding(user.dormBuilding,(await getSiteConfig(store)).buildings)) throw new AssistantError('building_required', '请先在设置中绑定住宿楼', 409)
    const skill = body.skillId ? [...BUILTIN_SKILLS, ...await ownSkills(user.id)].find((s) => s.id === body.skillId) : null
    if (body.skillId && !skill) throw new AssistantError('not_found', '所选 Skill 不存在', 404)
    return locked(store, `chat:${user.id}`, () => withChatLease(user.id, async () => {
      let usage = await readUsage(user.id,config)
      if (!usage.dailyRemaining || !usage.minuteRemaining) throw new AssistantError('rate_limit', !usage.dailyRemaining ? '今日 AI 额度已用完，明天再来' : '本分钟模型请求已达上限，请稍后重试', 429)
      const memory = await readMemory(user)
      const history = await readHistory(user)
      const preferences = await readPreferences(user,config)
      const prompt = preferences.promptProfiles.find(row=>row.id===preferences.activePromptId)?.text
      let first = true, context = null
      const reply = await callAssistant({ config, input: body.input.trim(), history, skill, skills:[...BUILTIN_SKILLS,...await ownSkills(user.id)], prompt, memory: memory.enabled ? { note: memory.note, habits: memory.habits } : null, getStatus: (kind) => statusFor(user, kind), fetchImpl, resolveHost: env.ASSISTANT_RESOLVE_HOST,
        beforeRequest:async()=>{usage=await reserveRequest(user.id,config,first);first=false},onContext:value=>{context=value} })
      const at = new Date().toISOString()
      const messages = pruneHistory([...history, { role: 'user', content: body.input.trim(), at }, { role: 'assistant', content: reply, at }])
      await store.put(historyKey(user.id), messages)
      return json({ reply, messages, context, usage: visibleUsage(usage) })
    }))
  }))

  app.post('/api/mcp', async (c) => {
    let id = null
    try {
      const user = await userFor(c)
      let body
      try { body = await readBody(c) } catch (error) { return rpcError(null, error.code === 'bad_json' ? -32700 : -32600, 'Invalid Request', 400) }
      if (body.jsonrpc !== '2.0' || typeof body.method !== 'string' || (own(body, 'id') && body.id !== null && typeof body.id !== 'string' && !(typeof body.id === 'number' && Number.isFinite(body.id)))) return rpcError(null, -32600, 'Invalid Request', 400)
      id = own(body, 'id') ? body.id : null
      const protocol = c.req.header('MCP-Protocol-Version')
      if (protocol && protocol !== '2025-06-18') return rpcError(id, -32600, 'Unsupported protocol version', 400)
      return await locked(store, `mcp:${user.id}`, async () => {
        const minute = Math.floor(Date.now() / 60000)
        const previous = await store.get(`assistant:mcp:${user.id}`, {})
        const count = previous?.minute === minute ? Number(previous.count) || 0 : 0
        if (count >= 20) return rpcError(id, -32029, 'Too many requests', 429)
        await store.put(`assistant:mcp:${user.id}`, { minute, count: count + 1 })
        if (!own(body, 'id')) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
        let result
        if (body.method === 'initialize') {
          if (!plainObject(body.params) || typeof body.params.protocolVersion !== 'string' || !plainObject(body.params.capabilities) || !plainObject(body.params.clientInfo) || typeof body.params.clientInfo.name !== 'string' || typeof body.params.clientInfo.version !== 'string') return rpcError(id, -32602, 'Invalid initialize params')
          result = { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'weshirt-readonly', version: '1.0.0' } }
        } else if (body.method === 'ping') result = {}
        else if (body.method === 'tools/list') result = { tools: [{ name: MACHINE_TOOL.name, description: MACHINE_TOOL.description, inputSchema: MACHINE_TOOL.parameters, annotations: { title: '当前住宿楼机器状态', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }] }
        else if (body.method === 'tools/call') {
          const params = body.params
          if (!plainObject(params) || params.name !== 'get_machine_status' || !plainObject(params.arguments) || Object.keys(params.arguments).some((key) => key !== 'kind') || !['all', 'washer', 'dryer'].includes(params.arguments.kind)) return rpcError(id, -32602, 'Unknown tool or invalid arguments')
          try { result = { content: [{ type: 'text', text: JSON.stringify(await statusFor(user, params.arguments.kind)) }], isError: false } }
          catch (error) { result = { content: [{ type: 'text', text: error instanceof AssistantError ? error.message : '机器状态暂时不可用' }], isError: true } }
        } else return rpcError(id, -32601, 'Method not found')
        return json({ jsonrpc: '2.0', id, result })
      })
    } catch (error) {
      return rpcError(id, error?.status === 401 ? -32001 : error?.status === 429 ? -32029 : -32603, error?.status === 401 ? 'Unauthorized' : error?.status === 429 ? 'Too many requests' : 'Internal error', error?.status === 401 ? 401 : error?.status === 429 ? 429 : 500)
    }
  })
}
