import { getUserIdentity } from './identity.js'

export const PERMISSION_RESOURCES = Object.freeze([
  ['board','机器看板',true],['tasks','洗衣登记与取衣',true],['queue','排队预约',true],['messages','留言频道',true],['social','朋友与私聊',false],['assistant','个人 AI 与 Skills',false],['inspections','楼栋巡检',true],
  ['adminDashboard','后台概览',true],['adminUsers','用户管理',true],['adminMachines','机器管理与机位',true],['adminMessages','内容治理与禁言',true],['adminOperations','运营与通知',false],['adminTelemetry','性能统计',true],['adminAnnouncements','公告管理',true],['adminSite','网站与成员管理',false],['adminAssistant','模型配置',false],['adminSystem','数据源与系统配置',false],['adminAudit','操作日志与导出',false],
].map(([key,label,scoped])=>Object.freeze({key,label,scoped})))

export function basePermissions(identity, loggedIn) {
  const role=identity?.role||'user', high=role==='super', admin=high||role==='admin', operator=role==='operator'
  return Object.fromEntries(PERMISSION_RESOURCES.map(({key,scoped})=>{
    let view=loggedIn,operate=loggedIn,scope=null
    if(['board','messages','queue'].includes(key))view=true
    if(key.startsWith('admin')) {view=admin||operator;operate=admin}
    if(key==='adminSystem'){view=high;operate=high}
    if(key==='adminAssistant')operate=high
    if(key==='inspections'){view=admin||role==='volunteer';operate=view;if(role==='volunteer')scope=identity.buildings||[]}
    return [key,{view,operate,viewBuildings:scoped?scope:null,operateBuildings:scoped?scope:null}]
  }))
}

export function normalizePermissionOverrides(input, base, buildings) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('权限须为对象')
  const out={},catalog=new Set([...buildings.map(b=>b.code),'public'])
  for(const [key,value] of Object.entries(input)){
    const resource=PERMISSION_RESOURCES.find(r=>r.key===key)
    if(!resource||!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['view','operate','viewBuildings','operateBuildings'].includes(k)))throw new Error('权限字段无效')
    const row={...base[key],...value}
    if(typeof row.view!=='boolean'||typeof row.operate!=='boolean'||row.operate&&!row.view)throw new Error('操作权限必须同时具备查看权限')
    if(row.view&&!base[key].view||row.operate&&!base[key].operate)throw new Error('请先授予相应身份，再配置该功能权限')
    for(const mode of ['view','operate']){
      const field=mode+'Buildings',scope=row[field],ceiling=base[key][field]
      if(scope!==null&&(!resource.scoped||!Array.isArray(scope)||scope.length>31||scope.some(code=>typeof code!=='string'||!catalog.has(code))||new Set(scope).size!==scope.length))throw new Error('楼栋权限范围无效')
      if(ceiling!==null&&(scope===null||scope.some(code=>!ceiling.includes(code))))throw new Error('范围不能超出角色获授楼栋')
      row[field]=scope===null?null:[...scope]
    }
    if(row.viewBuildings!==null&&(row.operateBuildings===null||row.operateBuildings.some(code=>!row.viewBuildings.includes(code))))throw new Error('操作范围不能超出查看范围')
    out[key]=row
  }
  return out
}

export async function getUserPermissions(store,user,buildings) {
  const identity=await getUserIdentity(store,user?.id),base=basePermissions(identity,Boolean(user&&!user.disabled&&!user.blocked))
  let overrides={}
  if(identity.role!=='super'&&user?.id){
    const saved=await store.get('access:user:'+user.id,{})
    // Validate each saved resource independently; removing a building fails closed for that scope.
    for(const [key,row] of Object.entries(saved?.permissions||{})){
      try{Object.assign(overrides,normalizePermissionOverrides({[key]:row},base,buildings))}
      catch{if(base[key])overrides[key]={...base[key],view:false,operate:false,viewBuildings:[],operateBuildings:[]}}
    }
  }
  const permissions={...base,...overrides}
  return {identity,base,overrides,permissions,adminVisible:Object.entries(permissions).some(([key,row])=>key.startsWith('admin')&&row.view)}
}
