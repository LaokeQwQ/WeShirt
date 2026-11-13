// 用户身份 store（pinia）
// 身份只来自钉钉登录：没有匿名注册这条路，所以不会出现「换个设备变成另一个人」。
import { defineStore } from 'pinia'
import { api, setToken, getToken, onReauth, restoreDeviceSession, NEED_LOGIN, logout as apiLogout } from '../api'

const PROFILE_KEY = 'ws_profile'

function mergeChangedFields(current, incoming, fields) {
  if (!current || !incoming || current.id !== incoming.id) return null
  return { ...current, ...Object.fromEntries(fields.filter((field) => Object.hasOwn(incoming, field)).map((field) => [field, incoming[field]])) }
}

// 本地资料快照：登录后立刻缓存，界面先渲染再等接口刷新，避免闪「未登录」
function readCached() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeCached(u) {
  try {
    if (u) localStorage.setItem(PROFILE_KEY, JSON.stringify(u))
    else localStorage.removeItem(PROFILE_KEY)
  } catch {
    /* 隐私模式下可能抛错，忽略 */
  }
}

export const useUserStore = defineStore('user', {
  state: () => ({
    user: readCached(),
    token: localStorage.getItem('ws_token') || '',
    // 是否已确认登录态（bootstrap 完成后为 true），路由守卫用它避免误跳
    ready: false,
    profileRevision: 0
  }),
  getters: {
    isLoggedIn: (s) => Boolean(s.token && s.user && s.user.id)
  },
  actions: {
    // 应用启动调用：注册 401 回调，并尝试用设备密钥恢复登录态
    init() {
      onReauth((t, u) => {
        this.token = t || ''
        if (u) this.applyUser(u)
        else {
          this.profileRevision++
          this.user = null
          writeCached(null)
        }
      })
    },
    // 统一写入用户资料 + 本地快照
    applyUser(u) {
      if (!u) return
      this.profileRevision++
      this.user = u
      writeCached(u)
    },
    /**
     * 启动初始化：有 token 就拉一次 /me 验证；没有就用设备密钥续用。
     * 都失败 → 视为未登录（不抛错，交由路由守卫引导登录）。
     */
    async bootstrap() {
      const requestRevision = this.profileRevision
      const requestToken = this.token
      try {
        if (!this.token) {
          // 没有 token：尝试设备密钥续用（老设备可能绑过）
          const data = await restoreDeviceSession({ silent: true })
          if (this.profileRevision !== requestRevision || this.token !== requestToken) return this.isLoggedIn
          setToken(data.token)
          this.token = data.token
          this.applyUser(data.user)
        } else {
          // silent：启动探测失败不应该把用户从公开页面硬拉到登录页
          const data = await api('/api/auth/me', { silent: true })
          if (this.profileRevision === requestRevision && this.token === requestToken) this.applyUser(data.user)
        }
      } catch {
        // 网络短暂中断时保留资料；认证层确认失效才清理。
        if (this.profileRevision !== requestRevision || this.token !== requestToken) return this.isLoggedIn
        this.token = getToken()
        if (!this.token) {
          this.user = null
          writeCached(null)
        }
      } finally {
        this.ready = true
      }
      return this.isLoggedIn
    },
    // 确保已登录：未登录直接抛 NEED_LOGIN，由 api 层的全局钩子带去登录页
    async ensureAuth() {
      if (this.token && this.user) return this.token
      if (!this.token) {
        // 仍尝试一次设备密钥（比如 token 被 401 清掉了，但设备还绑着）
        try {
          const requestRevision = this.profileRevision, requestToken = this.token
          const data = await restoreDeviceSession()
          if (this.profileRevision !== requestRevision || this.token !== requestToken) {
            if(this.token === data.token && this.user?.id === data.user?.id)return this.token
            throw new Error(NEED_LOGIN)
          }
          setToken(data.token)
          this.token = data.token
          this.applyUser(data.user)
          return this.token
        } catch {
          throw new Error(NEED_LOGIN)
        }
      }
      throw new Error(NEED_LOGIN)
    },
    // 拉取最新身份信息
    async me() {
      if (!this.token) await this.ensureAuth()
      const requestRevision = this.profileRevision
      const requestToken = this.token
      const data = await api('/api/auth/me')
      if (this.profileRevision === requestRevision && this.token === requestToken) this.applyUser(data.user)
      return this.user
    },
    // 退出登录
    async logout() {
      this.profileRevision++
      // Clear private UI/cache immediately, even while device revocation is offline.
      this.token = ''
      this.user = null
      writeCached(null)
      await apiLogout()
    },
    // 取衣提醒偏好：on 开关、leadMin 提前分钟
    async setNotify(patch) {
      if (!this.token) await this.ensureAuth()
      const requestUser = this.user?.id, requestToken = this.token
      const data = await api('/api/user/notify', { method: 'POST', body: patch })
      if (this.user?.id !== requestUser || this.token !== requestToken) return null
      this.applyUser(mergeChangedFields(this.user, data.user, [...(patch.on !== undefined ? ['notifyOn'] : []), ...(patch.leadMin !== undefined ? ['notifyLeadMin'] : [])]))
      return this.user
    },
    // 修改资料（昵称 / 头像 key / 自定义头像 URL）
    async setDormBuilding(dormBuilding) {
      if (!this.token) await this.ensureAuth()
      const userId = this.user?.id
      const requestToken = this.token
      const data = await api('/api/user/profile', { method: 'POST', body: { dormBuilding } })
      if (this.user?.id !== userId || this.token !== requestToken) return null
      this.applyUser(mergeChangedFields(this.user, data.user, ['dormBuilding','dormChangesRemaining']))
      return this.user
    },
    async setProfile({ nick, avatar, avatarUrl }) {
      if (!this.token) await this.ensureAuth()
      const requestUser = this.user?.id, requestToken = this.token
      const body = { nick, avatar }
      if (avatarUrl !== undefined) body.avatarUrl = avatarUrl
      const data = await api('/api/user/profile', { method: 'POST', body })
      if (this.user?.id !== requestUser || this.token !== requestToken) return null
      this.applyUser(mergeChangedFields(this.user, data.user, Object.keys(body).filter((field) => body[field] !== undefined)))
      return this.user
    },
    // 掷一个随机昵称/头像（只在本地预览，点保存才落库）
    async randomProfile(field = 'both') {
      if (!this.token) await this.ensureAuth()
      return await api('/api/user/random?field=' + field)
    },
    // 设置自定义头像：data URL（本地上传压缩后）或 https 链接；传 null 清空
    async setAvatarUrl(avatarUrl) {
      if (!this.token) await this.ensureAuth()
      const requestUser = this.user?.id, requestToken = this.token
      const data = await api('/api/user/profile', { method: 'POST', body: { avatarUrl } })
      if (this.user?.id !== requestUser || this.token !== requestToken) return null
      this.applyUser(mergeChangedFields(this.user, data.user, ['avatarUrl']))
      return this.user
    },
    // 拉取钉钉头像并保存
    async useDingtalkAvatar() {
      if (!this.token) await this.ensureAuth()
      const requestUser = this.user?.id, requestToken = this.token
      const data = await api('/api/user/dingtalk-avatar')
      if (this.user?.id !== requestUser || this.token !== requestToken) return null
      this.applyUser(mergeChangedFields(this.user, data.user, ['avatarUrl']))
      return data
    }
  }
})
