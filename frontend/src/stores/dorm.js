import { defineStore } from 'pinia'
import { DORM_BUILDINGS, normalizeDormBuilding, dormBuildingName } from '../../../packages/core/buildings.js'
import { useUserStore } from './user'
import { api } from '../api'

const STORAGE_KEY = 'ws_dorm_preferences'
const LAST_ROOM_KEY = 'ws_last_public_dorm'
function readPreferences() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  } catch { return {} }
}
function savePreferences(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)) } catch { /* 本次会话仍可使用 */ }
}
function lastPublicRoom() {
  try { return localStorage.getItem(LAST_ROOM_KEY) || '' } catch { return '' }
}

export const useDormStore = defineStore('dorm', {
  state: () => ({ code: '', showPicker: false, preferences: readPreferences(), activeScope: '', syncing: {}, revision: 0, catalog:DORM_BUILDINGS, siteName:'等衣',iconUrl:'' }),
  getters: {
    name: (state) => dormBuildingName(state.code,state.catalog),
    buildings: (state) => state.catalog.filter(building=>building.enabled!==false),
    saving: (state) => Boolean(state.syncing[state.activeScope]),
    changesRemaining: () => useUserStore().user?.dormChangesRemaining ?? 1,
  },
  actions: {
    async loadSite() {
      try {
        const site=await api('/api/site',{auth:false})
        if(Array.isArray(site.buildings))this.catalog=site.buildings
        this.siteName=site.name||'等衣';this.iconUrl=site.iconUrl||''
        document.title=this.siteName+' · 洗衣房'
        if(this.iconUrl){const icon=document.querySelector('link[rel="icon"]');if(icon)icon.href=this.iconUrl}
        await this.reconcile()
      } catch {}
    },
    async reconcile() {
      const userStore = useUserStore()
      // Only the public room may use a cached profile before authentication.
      // Never persist this preview as a building change on the recovered account.
      if (!userStore.ready) {
        const cachedScope = userStore.user?.id ? `user:${userStore.user.id}` : 'guest'
        const last = lastPublicRoom()
        this.code = normalizeDormBuilding(this.preferences[cachedScope]?.code,this.catalog) || normalizeDormBuilding(userStore.user?.dormBuilding,this.catalog) || normalizeDormBuilding(last,this.catalog) || normalizeDormBuilding(this.preferences.guest?.code,this.catalog) || ''
        return
      }
      const user = userStore.isLoggedIn ? userStore.user : null
      const scope = user ? `user:${user.id}` : 'guest'
      this.activeScope = scope
      const saved = this.preferences[scope]
      const remote = normalizeDormBuilding(user?.dormBuilding,this.catalog)
      const local = normalizeDormBuilding(saved?.code,this.catalog)
      const chosen = (saved?.pending && (user?.dormChangesRemaining ?? 1)>0 ? local : remote || local) || normalizeDormBuilding(this.preferences.guest?.code,this.catalog) || (!user ? normalizeDormBuilding(lastPublicRoom(),this.catalog) : '')
      this.code = chosen || ''
      if (this.code) { try { localStorage.setItem(LAST_ROOM_KEY, this.code) } catch {} }
      // 先恢复本机偏好；身份探测完成后再同步到账号，避免弱网阻塞已有看板。
      if (!userStore.ready) return
      if (chosen) {
        this.preferences[scope] = { code: chosen, pending: Boolean(user && chosen !== remote) }
        savePreferences(this.preferences)
      }
      if (user && chosen && chosen !== remote && !this.syncing[scope]) {
        try { await this.persist(scope, chosen) } catch { /* 下次打开重试，仍保留本机选择 */ }
      }
    },
    async persist(scope, code) {
      const userStore = useUserStore()
      const revision = ++this.revision
      this.syncing[scope] = revision
      try {
        const user = await userStore.setDormBuilding(code)
        if (user && scope === `user:${user.id}` && this.syncing[scope] === revision) {
          this.preferences[scope] = { code, pending: false }
          savePreferences(this.preferences)
        }
      } catch(error) {
        if(['dorm_change_limit','bad_param','building_disabled','forbidden'].includes(error?.code)&&scope===this.activeScope&&this.syncing[scope]===revision){
          const remote=normalizeDormBuilding(userStore.user?.dormBuilding,this.catalog)
          this.code=remote||'';this.preferences[scope]={code:remote||'',pending:false};savePreferences(this.preferences)
        }
        throw error
      } finally {
        if (this.syncing[scope] === revision) delete this.syncing[scope]
      }
    },
    async select(code) {
      if (!normalizeDormBuilding(code,this.catalog)) throw new Error('请选择有效的住宿楼')
      const userStore = useUserStore()
      if (!userStore.ready) throw new Error('正在恢复账号，请稍后修改住宿楼')
      if(userStore.isLoggedIn&&userStore.user?.dormBuilding&&code!==userStore.user.dormBuilding&&this.changesRemaining<=0)throw new Error('自行修改次数已用完，请联系管理员修改住宿楼')
      const scope = userStore.isLoggedIn ? `user:${userStore.user.id}` : 'guest'
      this.activeScope = scope
      this.code = code
      try { localStorage.setItem(LAST_ROOM_KEY, code) } catch {}
      this.preferences[scope] = { code, pending: userStore.isLoggedIn }
      savePreferences(this.preferences)
      this.showPicker = false
      if (userStore.isLoggedIn) await this.persist(scope, code)
    },
  },
})
