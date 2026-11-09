import { defineStore } from 'pinia'
import { DORM_BUILDINGS, normalizeDormBuilding, dormBuildingName } from '../../../packages/core/buildings.js'
import { useUserStore } from './user'
import { api } from '../api'

const STORAGE_KEY = 'ws_dorm_preferences'
function readPreferences() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  } catch { return {} }
}
function savePreferences(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)) } catch { /* 本次会话仍可使用 */ }
}

export const useDormStore = defineStore('dorm', {
  state: () => ({ code: '', showPicker: false, preferences: readPreferences(), activeScope: '', syncing: {}, revision: 0, catalog:DORM_BUILDINGS, siteName:'等衣',iconUrl:'' }),
  getters: {
    name: (state) => dormBuildingName(state.code,state.catalog),
    buildings: (state) => state.catalog,
    saving: (state) => Boolean(state.syncing[state.activeScope]),
  },
  actions: {
    async loadSite() {
      try {
        const site=await api('/api/site',{auth:false})
        if(Array.isArray(site.buildings)&&site.buildings.length)this.catalog=site.buildings
        this.siteName=site.name||'等衣';this.iconUrl=site.iconUrl||''
        document.title=this.siteName+' · 洗衣房'
        if(this.iconUrl){const icon=document.querySelector('link[rel="icon"]');if(icon)icon.href=this.iconUrl}
        await this.reconcile()
      } catch {}
    },
    async reconcile() {
      const userStore = useUserStore()
      const user = userStore.isLoggedIn ? userStore.user : null
      const scope = user ? `user:${user.id}` : 'guest'
      this.activeScope = scope
      const saved = this.preferences[scope]
      const remote = normalizeDormBuilding(user?.dormBuilding,this.catalog)
      const local = normalizeDormBuilding(saved?.code,this.catalog)
      const chosen = (saved?.pending ? local : remote || local) || normalizeDormBuilding(this.preferences.guest?.code,this.catalog)
      this.code = chosen || ''
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
      } finally {
        if (this.syncing[scope] === revision) delete this.syncing[scope]
      }
    },
    async select(code) {
      if (!normalizeDormBuilding(code,this.catalog)) throw new Error('请选择有效的住宿楼')
      const userStore = useUserStore()
      const scope = userStore.isLoggedIn ? `user:${userStore.user.id}` : 'guest'
      this.activeScope = scope
      this.code = code
      this.preferences[scope] = { code, pending: userStore.isLoggedIn }
      savePreferences(this.preferences)
      this.showPicker = false
      if (userStore.isLoggedIn) await this.persist(scope, code)
    },
  },
})