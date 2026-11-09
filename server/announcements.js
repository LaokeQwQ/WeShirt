import { getSiteConfig } from './site.js'
import { json, apiErr, randomKey } from '../packages/core/util.js'
import { normalizeDormBuilding } from '../packages/core/buildings.js'

const locks = new WeakMap()
export function registerAnnouncementRoutes(app, { store, authenticate, checkAdmin }) {
  const serial = (fn) => { const job = (locks.get(store) || Promise.resolve()).catch(()=>{}).then(fn); locks.set(store,job); return job.finally(()=>{if(locks.get(store)===job)locks.delete(store)}) }
  app.get('/api/announcements', async(c) => {
    const dorm = c.req.query('dorm') || ''
    if (dorm && !normalizeDormBuilding(dorm,(await getSiteConfig(store)).buildings)) return apiErr('bad_param','住宿楼无效')
    const now = Date.now()
    const list = await store.get('announcements', [])
    return json({announcements:list.filter((a)=>a.published && (!a.startsAt || Date.parse(a.startsAt)<=now) && (!a.endsAt || Date.parse(a.endsAt)>now) && (!a.dormBuilding || a.dormBuilding===dorm)).map(({id,version,title,markdown,updatedAt})=>({id,version,title,markdown,updatedAt}))},200,{'Cache-Control':'public, max-age=30'})
  })
  app.get('/api/admin/announcements',async(c)=> { if(!await checkAdmin(c)) return apiErr('unauthorized','需要后台登录',401); return json({announcements:await store.get('announcements',[])}) })
  app.post('/api/admin/announcements',async(c)=> {
    if(!await checkAdmin(c)) return apiErr('unauthorized','需要后台登录',401)
    const raw=await c.req.text(); if(new TextEncoder().encode(raw).length>65536)return apiErr('too_large','公告过长',413)
    let b;try{b=JSON.parse(raw)}catch{return apiErr('bad_param','格式错误')}
    const title=typeof b.title==='string'?b.title.trim():'';const markdown=typeof b.markdown==='string'?b.markdown:''
    if(!title||title.length>100||!markdown.trim()||markdown.length>20000||(b.dormBuilding&&!normalizeDormBuilding(b.dormBuilding,(await getSiteConfig(store)).buildings)))return apiErr('bad_param','请填写标题和正文，正文最多20000字')
    for(const key of ['startsAt','endsAt'])if(b[key]&&!Number.isFinite(Date.parse(b[key])))return apiErr('bad_param','公告时间无效')
    if(b.endsAt && b.startsAt && Date.parse(b.endsAt)<=Date.parse(b.startsAt))return apiErr('bad_param','结束时间须晚于开始时间')
    return serial(async()=>{
      const list=await store.get('announcements',[]); const old=b.id?list.find((a)=>a.id===b.id):null
      if(b.id&&!old)return apiErr('not_found','公告不存在',404)
      if(old&&b.version!==old.version)return apiErr('conflict','公告已被修改，请刷新后编辑',409)
      const announcement={id:old?.id||randomKey(16),version:(old?.version||0)+1,title,markdown,published:b.published===true,dormBuilding:b.dormBuilding||null,startsAt:b.startsAt||null,endsAt:b.endsAt||null,updatedAt:new Date().toISOString()}
      await store.put('announcements',[announcement,...list.filter((a)=>a.id!==announcement.id)].slice(0,50));return json({announcement})
    })
  })
  app.delete('/api/admin/announcements/:id',async(c)=>{if(!await checkAdmin(c))return apiErr('unauthorized','需要后台登录',401);return serial(async()=>{await store.put('announcements',(await store.get('announcements',[])).filter((a)=>a.id!==c.req.param('id')));return json({ok:true})})})
  app.get('/api/user/announcements',async(c)=>{const u=await authenticate(c);if(!u)return apiErr('unauthorized','请先登录',401);return json({enabled:u.announcementsOn!==false,dismissed:u.dismissedAnnouncements||{}})})
  app.patch('/api/user/announcements',async(c)=>{
    const u=await authenticate(c);if(!u)return apiErr('unauthorized','请先登录',401)
    const b=await c.req.json().catch(()=>({}));if(b.enabled!==undefined&&typeof b.enabled!=='boolean')return apiErr('bad_param','开关无效')
    return serial(async()=>{
      const fresh=await store.get(`user:${u.id}`,null);if(!fresh)return apiErr('unauthorized','账号不存在',401)
      if(b.enabled!==undefined)fresh.announcementsOn=b.enabled
      if(b.dismiss){const list=await store.get('announcements',[]);const a=list.find((v)=>v.id===b.dismiss.id&&v.version===b.dismiss.version);if(!a)return apiErr('bad_param','公告版本无效');fresh.dismissedAnnouncements={...(fresh.dismissedAnnouncements||{}),[a.id]:a.version};const ids=new Set(list.map((v)=>v.id));fresh.dismissedAnnouncements=Object.fromEntries(Object.entries(fresh.dismissedAnnouncements).filter(([id])=>ids.has(id)))}
      await store.put(`user:${u.id}`,fresh);return json({enabled:fresh.announcementsOn!==false,dismissed:fresh.dismissedAnnouncements||{}})
    })
  })
}
