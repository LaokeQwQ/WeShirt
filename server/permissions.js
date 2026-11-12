import { json,apiErr } from '../packages/core/util.js'
import { readStreamBytes } from '../packages/core/stream-bytes.js'
import { getSiteConfig } from './site.js'
import { PERMISSION_RESOURCES,getUserPermissions,normalizePermissionOverrides } from '../packages/core/permissions.js'
import { resolveMachineDorm } from '../packages/core/buildings.js'
import { withOperationLock } from '../packages/core/operations.js'

const idOk=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(value)
const readMethod=method=>['GET','HEAD','OPTIONS'].includes(method)
// These are the only admin mutations whose handlers operate on one bounded target.
// Global handlers must never become scoped just because their body names a dorm.
const SCOPED_ADMIN_WRITES=[
  ['adminUsers','POST',/^\/api\/admin\/user\/[^/]+$/],
  ['adminUsers','DELETE',/^\/api\/admin\/users?\/[^/]+$/],
  ['adminMachines','POST',/^\/api\/admin\/machine\/[^/]+\/(?:clear-occupancy|clear-queue)$/],
  ['adminMessages','DELETE',/^\/api\/(?:admin\/message|messages)\/[^/]+$/],
  ['adminMessages','POST',/^\/api\/messages\/[^/]+\/pin$/],
  ['adminMessages','PATCH',/^\/api\/messages\/[^/]+\/pin$/],
  ['adminMessages','POST',/^\/api\/moderation\/mutes$/],
  ['adminMessages','DELETE',/^\/api\/moderation\/mutes\/[^/]+$/],
  ['adminMessages','PATCH',/^\/api\/admin\/community-reports\/[^/]+$/],
  ['adminAnnouncements','POST',/^\/api\/admin\/announcements$/],
  ['adminAnnouncements','DELETE',/^\/api\/admin\/announcements\/[^/]+$/],
  ['adminMachines','PATCH',/^\/api\/admin\/machine-feedback\/[^/]+$/],
  ['adminMachines','PATCH',/^\/api\/admin\/machine-time-calibration\/[^/]+$/],
]
const scopedAdminWriteAllowed=(resource,method,path)=>SCOPED_ADMIN_WRITES.some(([key,verb,pattern])=>key===resource&&verb===method&&pattern.test(path))
export function resourceFor(path,method='GET'){
  if(/^\/api\/admin\/(?:login|logout|session|permissions|access-codes)(?:\/|$)/.test(path)||path==='/api/user/permissions')return null
  if(path.startsWith('/api/admin/')){
    const part=path.slice(11).split('/')[0]
    if(part==='status')return 'adminDashboard'
    if(/^(?:user|users|users\.csv|backfill-ding-profile)$/.test(part))return 'adminUsers'
    if(/^(?:machine|machines|machine-feedback|machine-time-calibration)$/.test(part))return 'adminMachines'
    if(/^(?:message|messages|community-reports)$/.test(part))return 'adminMessages'
    if(part==='operations'||part.startsWith('notify'))return 'adminOperations'
    if(part==='telemetry')return 'adminTelemetry'
    if(part==='announcements')return 'adminAnnouncements'
    if(part==='building-groups')return 'adminSite'
    if(part==='site')return 'adminSite'
    if(part==='assistant')return 'adminAssistant'
    if(part.startsWith('audit')||part.startsWith('urge-audit'))return 'adminAudit'
    return 'adminSystem'
  }
  if(path.startsWith('/api/debug/')||path==='/api/upstream-info')return 'adminSystem'
  if(path==='/api/mapping')return readMethod(method)?'board':'adminMachines'
  if(/^\/api\/(?:machines|occupancy)(?:\/|$)/.test(path))return 'board'
  if(['/api/marks','/api/faults/recover','/api/urge','/api/urge/reveal','/api/dryer/stuck'].includes(path))return 'board'
  if(path.startsWith('/api/tasks'))return 'tasks'
  if(path.startsWith('/api/queue'))return 'queue'
  if(/^\/api\/messages\/[^/]+\/pin$/.test(path))return 'messages'
  if(path.startsWith('/api/messages'))return 'messages'
  if(path.startsWith('/api/moderation'))return 'adminMessages'
  if(path.startsWith('/api/inspections'))return 'inspections'
  if(path.startsWith('/api/social'))return 'social'
  if(path.startsWith('/api/assistant')||path==='/api/mcp')return 'assistant'
  return null
}

export function registerPermissionMiddleware(app,{store,env={},authenticate,checkSuperAdmin}){
  app.use('/api/*',async(c,next)=>{
    let resource=resourceFor(c.req.path,c.req.method)
    if(!resource||c.req.method==='OPTIONS')return next()
    if(await checkSuperAdmin?.(c))return next()
    const user=await authenticate(c)
    // Existing role guards remain authoritative; sparse rules only add restrictions.
    const temporary=c.get('temporaryAdminAccess')
    if(!temporary && (!user || !await store.get('access:user:'+user.id,null)))return next()
    if(c.req.method==='DELETE'&&/^\/api\/messages\/[^/]+$/.test(c.req.path)){
      const messageId=c.req.path.split('/').at(-1)
      const messages=await store.get('messages:'+(env.BUILDING_ID||'b1'),[])
      const message=messages.find(row=>row.id===messageId)
      if(message&&message.userId!==user.id)resource='adminMessages'
    }
    const site=await getSiteConfig(store),access=temporary||await getUserPermissions(store,user,site.buildings)
    c.set('userAccess',access)
    const readNotice=c.req.method==='POST'&&/^\/api\/messages\/notices\/(?:[^/]+\/)?read$/.test(c.req.path)
    const row=access.permissions[resource],mode=readMethod(c.req.method)||c.req.path==='/api/mcp'||readNotice?'view':'operate'
    if(!row?.[mode])return apiErr(user||temporary?'forbidden':'unauthorized','当前账号没有此功能的'+(mode==='view'?'查看':'操作')+'权限',user||temporary?403:401)
    const scope=row[mode+'Buildings']
    if(scope===null)return next()
    if(resource==='adminTelemetry'&&!c.req.query('dorm'))return apiErr('scope_required','请选择授权范围内的具体楼栋查看统计',403)
    const bid=env.BUILDING_ID||'b1'
    const [cached,mapping]=await Promise.all([store.get('machines:'+bid,null),store.get('mapping:'+bid,{})])
    const machines=(cached?.board?.floors||[]).flatMap(f=>f.machines||[])
    const dormOf=machineId=>{const m=machines.find(m=>String(m.id)===String(machineId));return m?resolveMachineDorm(m,mapping?.mapping||{},site.buildings):null}
    const allowed=code=>typeof code==='string'&&scope.includes(code)
    const explicit=[c.req.query('dorm'),c.req.query('channel')].filter(Boolean)
    if(explicit.some(code=>!allowed(code)))return apiErr('forbidden','该楼栋不在授权范围内',403)
    if(c.req.query('machineId')&&!allowed(dormOf(c.req.query('machineId'))))return apiErr('forbidden','该机器不在授权范围内',403)
    const isWrite=mode==='operate'
    // These handlers recheck the current principal and every selected target;
    // CSV cannot be safely filtered by the generic JSON response projection.
    if(resource==='adminUsers' && (c.req.path==='/api/admin/users.csv' && !isWrite || c.req.path==='/api/admin/users/batch' && c.req.method==='POST'))return next()
    const isAdminWrite=isWrite&&resource.startsWith('admin')
    if(isAdminWrite&&!scopedAdminWriteAllowed(resource,c.req.method,c.req.path))return apiErr('forbidden','此批量操作需要全部楼栋权限，请选择具体楼栋目标',403)
    if(isAdminWrite&&c.req.query('building')&&c.req.query('building')!==bid)return apiErr('forbidden','该数据源不在授权操作范围内',403)
    let body={}
    const binaryMediaUpload = c.req.method==='POST' && /^\/api\/messages\/(?:media|channels\/[^/]+\/avatar)$/.test(c.req.path)
    if(isWrite&&c.req.raw.body&&!binaryMediaUpload){
      if(Number(c.req.header('content-length'))>1024*1024)return apiErr('too_large','请求内容过长',413)
      try {
        const bytes=await readStreamBytes(c.req.raw.clone().body,1024*1024)
        if(!bytes)return apiErr('too_large','请求内容过长',413)
        body=JSON.parse(new TextDecoder().decode(bytes))
      }catch{return apiErr('bad_param','请求须为有效 JSON 内容',400)}
    }
    let targetCodes=[]
    if(binaryMediaUpload)targetCodes.push(c.req.path==='/api/messages/media'?c.req.query('channel'):decodeURIComponent(c.req.path.split('/')[4]||''))
    if(!isAdminWrite){
      if(body?.dorm||body?.channel||body?.dormBuilding)targetCodes.push(body.dorm||body.channel||body.dormBuilding)
      if(body?.machineId)targetCodes.push(dormOf(body.machineId))
    }
    const suffix=decodeURIComponent(c.req.path.split('/').at(-1)||'')
    if(resource==='tasks'&&c.req.path!=='/api/tasks'){
      const taskId=c.req.path.endsWith('/take')?c.req.path.split('/').at(-2):suffix
      const own=await store.get('tasks:'+user?.id,[]),task=own.find(t=>t.id===taskId)
      if(task)targetCodes.push(dormOf(task.machineId))
    }
    if(resource==='queue'&&c.req.method==='DELETE'&&!c.req.query('machineId')){
      const queue=await store.get('queue:'+bid,[])
      targetCodes.push(...queue.filter(row=>row.userId===user.id).map(row=>dormOf(row.machineId)))
    }
    if(resource==='adminUsers'&&/^\/api\/admin\/users?\/[^/]+$/.test(c.req.path)){
      const target=await store.get('user:'+suffix,null)
      if(target||isAdminWrite)targetCodes.push(target?.dormBuilding)
      if(isAdminWrite&&Object.hasOwn(body||{},'dormBuilding'))targetCodes.push(body.dormBuilding)
    }
    if(resource==='adminMachines'&&/^\/api\/admin\/machine\//.test(c.req.path))targetCodes.push(dormOf(c.req.path.split('/')[4]))
    if(resource==='adminMachines'&&/^\/api\/admin\/machine-time-calibration\/[^/]+$/.test(c.req.path))targetCodes.push(dormOf(suffix))
    if(['messages','adminMessages'].includes(resource)&&/^\/api\/(?:messages|admin\/message)\//.test(c.req.path)&&!/^\/api\/messages\/(?:media|channels|notices|realtime)(?:\/|$)/.test(c.req.path)){
      const msgId=/\/(?:pin|report)$/.test(c.req.path)?c.req.path.split('/').at(-2):suffix
      const messages=await store.get('messages:'+bid,[]),message=messages.find(m=>m.id===msgId)
      if(message||isAdminWrite)targetCodes.push(message&&(message.channel||message.dormBuilding||dormOf(message.machineId)))
    }
    if(isWrite&&resource==='messages'&&!targetCodes.length)targetCodes.push(user?.dormBuilding||site.buildings[0]?.code)
    if(resource==='inspections'&&c.req.path.endsWith('/photo')){const id=c.req.path.split('/').at(-2),rows=await store.get('inspections:'+bid,[]),entry=rows.find(row=>row.id===id);if(entry)targetCodes.push(entry.dormBuilding)}
    if(resource==='adminMessages'&&isAdminWrite&&/^\/api\/moderation\/mutes(?:\/[^/]+)?$/.test(c.req.path)){
      const uid=c.req.method==='DELETE'?suffix:body?.userId
      const target=uid?await store.get('user:'+uid,null):null
      targetCodes.push(target?.dormBuilding)
    }
    if(resource==='adminMessages'&&isAdminWrite&&/^\/api\/admin\/community-reports\/[^/]+$/.test(c.req.path)){
      const reports=await store.get('community:reports:'+bid,[])
      targetCodes.push(reports.find(row=>row.id===suffix)?.channel)
    }
    if(resource==='adminMachines'&&isAdminWrite&&/^\/api\/admin\/machine-feedback\/[^/]+$/.test(c.req.path)){
      const rows=await store.get('machine-feedback:'+bid,[])
      targetCodes.push(rows.find(row=>row.id===suffix)?.dormBuilding)
    }
    if(resource==='adminAnnouncements'&&isWrite){
      if(c.req.method==='POST')targetCodes.push(body?.dormBuilding||null)
      const announcementId=c.req.method==='DELETE'?suffix:body?.id
      if(announcementId){const announcements=await store.get('announcements',[]),entry=announcements.find(row=>row.id===announcementId);targetCodes.push(entry?.dormBuilding)}
    }
    if(targetCodes.some(code=>!allowed(code)))return apiErr('forbidden','目标不在授权操作范围内',403)
    // A scoped manager cannot use an unscoped bulk operation or write an all-building announcement.
    if(isWrite&&resource.startsWith('admin')&&!targetCodes.length)return apiErr('forbidden','此批量操作需要全部楼栋权限，请选择具体楼栋目标',403)
    await next()
    if(c.res.status>=400||!c.res.headers.get('content-type')?.includes('application/json'))return
    const data=await c.res.clone().json().catch(()=>null)
    if(!data||typeof data!=='object')return
    if(data.board){const board=data.board;if(resource==='adminDashboard')board.floors=cached?.board?.floors||[];board.floors=(board.floors||[]).map(f=>({...f,machines:(f.machines||[]).filter(m=>allowed(resolveMachineDorm(m,mapping?.mapping||{},site.buildings)))})).filter(f=>f.machines.length).map(f=>({...f,total:f.machines.length,...Object.fromEntries(['idle','occupied','faulty','unknown'].map(state=>[state,f.machines.filter(m=>m.state===state).length]))}));const all=board.floors.flatMap(f=>f.machines);for(const state of ['idle','occupied','faulty','unknown'])board[state]=all.filter(m=>m.state===state).length;board.total=all.length;if(board.slotMapping)board.slotMapping=Object.fromEntries(Object.entries(board.slotMapping).filter(([,id])=>allowed(dormOf(id))))}
    if(data.occupancy)data.occupancy=Object.fromEntries(Object.entries(data.occupancy).filter(([id])=>allowed(dormOf(id))))
    if(data.mapping){const wrapper=data.mapping.mapping?'mapping':null;const map=wrapper?data.mapping.mapping:data.mapping;const filtered=Object.fromEntries(Object.entries(map).filter(([,id])=>allowed(dormOf(id))));if(wrapper)data.mapping.mapping=filtered;else data.mapping=filtered}
    if(data.dormBuildings)data.dormBuildings=data.dormBuildings.filter(b=>allowed(b.code))
    for(const field of ['tasks','queue','machines','messages','inspections','announcements','items','users','notices','buildings','rows'])if(Array.isArray(data[field])){
      data[field]=data[field].filter(item=>allowed(item.dormBuilding||item.channel||(['buildings'].includes(field)?item.code:null)||dormOf(item.machineId||(['machines','rows'].includes(field)?item.id:null))))
      if(data.total!=null)data.total=data[field].length
      if(data.pagination)data.pagination={...data.pagination,total:data[field].length,hasMore:false}
    }
    if(Array.isArray(data.mutes)){const scopedMutes=[];for(const mute of data.mutes){const u=await store.get('user:'+mute.userId,null);if(allowed(u?.dormBuilding))scopedMutes.push(mute)}data.mutes=scopedMutes}
    if(data.user&&!allowed(data.user.dormBuilding))return c.res=apiErr('forbidden','该用户不在授权查看范围内',403)
    if(resource==='adminDashboard'){delete data.haier;if(data.board)data.board.buildingName='授权楼栋'}
    c.header('Cache-Control','private, no-store')
    const headers=new Headers(c.res.headers);headers.delete('Content-Length')
    c.res=new Response(JSON.stringify(data),{status:c.res.status,headers})
  })
}

export function registerPermissionRoutes(app,{store,authenticate,checkSuperAdmin}){
  const highest=async c=>!c.get('temporaryAdminAccess')&&(await checkSuperAdmin?.(c)||(await getUserPermissions(store,await authenticate(c),(await getSiteConfig(store)).buildings)).identity.role==='super')
  const snapshot=async(c,selectedId)=>{
    const site=await getSiteConfig(store),q=(c.req.query('q')||'').trim().toLowerCase()
    const entries=await store.list('user:'),members=await store.get('meta:siteAdmins',[])
    const users=entries.map(e=>e.value).filter(u=>u?.id&&(!q||(u.id+' '+u.nick).toLowerCase().includes(q))).slice(0,200).map(u=>({id:u.id,nick:u.nick||'同学',dormBuilding:u.dormBuilding||null,role:members.find(m=>m.userId===u.id)?.role||'user'}))
    const user=selectedId?await store.get('user:'+selectedId,null):null
    let selected=null
    if(user){const access=await getUserPermissions(store,user,site.buildings);selected={user:{id:user.id,nick:user.nick||'同学',role:access.identity.role},base:access.base,permissions:access.permissions,overrides:access.overrides}}
    return {canManage:true,resources:PERMISSION_RESOURCES,buildings:site.buildings,users,selected}
  }
  app.get('/api/user/permissions',async c=>{const temporary=c.get('temporaryAdminAccess');const user=await authenticate(c);if(!user&&!temporary)return apiErr('unauthorized','请先登录',401);const access=temporary||await getUserPermissions(store,user,(await getSiteConfig(store)).buildings);return json({identity:access.identity,adminVisible:access.adminVisible,permissions:access.permissions},200,{'cache-control':'no-store'})})
  app.get('/api/admin/permissions',async c=>{if(!await highest(c))return apiErr('forbidden','仅总管可管理个人权限',403);return json(await snapshot(c,c.req.query('userId')),200,{'cache-control':'no-store'})})
  app.patch('/api/admin/permissions/:id',async c=>{
    if(!await highest(c))return apiErr('forbidden','仅总管可管理个人权限',403)
    const uid=c.req.param('id');if(!idOk(uid))return apiErr('bad_param','用户ID无效')
    const raw=await c.req.text();if(raw.length>24000)return apiErr('too_large','权限内容过长',413)
    let body;try{body=JSON.parse(raw);if(!body||Object.keys(body).some(k=>k!=='permissions'))throw new Error()}catch{return apiErr('bad_param','权限格式无效')}
    return withOperationLock(store,'site-config',async()=>{
      if(!await highest(c))return apiErr('forbidden','权限已变更',403)
      const user=await store.get('user:'+uid,null);if(!user)return apiErr('not_found','用户不存在',404)
      const access=await getUserPermissions(store,user,(await getSiteConfig(store)).buildings)
      if(access.identity.role==='super')return apiErr('forbidden','总管权限用于恢复管理，不能通过个人规则禁用；请在成员管理调整身份',403)
      let permissions;try{permissions=normalizePermissionOverrides(body.permissions,access.base,(await getSiteConfig(store)).buildings)}catch(e){return apiErr('bad_param',e.message)}
      await store.put('access:user:'+uid,{permissions,at:new Date().toISOString()})
      return json({ok:true,...await snapshot(c,uid)},200,{'cache-control':'no-store'})
    })
  })
  app.delete('/api/admin/permissions/:id',async c=>{if(!await highest(c))return apiErr('forbidden','仅总管可管理个人权限',403);const uid=c.req.param('id');if(!idOk(uid))return apiErr('bad_param','用户ID无效');return withOperationLock(store,'site-config',async()=>{if(!await highest(c))return apiErr('forbidden','权限已变更',403);await store.del('access:user:'+uid);return json({ok:true,...await snapshot(c,uid)})})})
}
