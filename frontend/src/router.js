// 路由表（契约 §5）
// 身份只能来自钉钉登录 → 需要「我的数据」的页面加 meta.login，
// 由全局守卫引导到 /login；看板/大屏/留言板公开可看。
import { createRouter, createWebHashHistory } from 'vue-router'
import Board from './views/Board.vue'
import Display from './views/Display.vue'
import Task from './views/Task.vue'
import Settings from './views/Settings.vue'
import Messages from './views/Messages.vue'
import Admin from './views/Admin.vue'
import Login from './views/Login.vue'

// 3D 场景依赖 three（~600KB），按需加载，避免拖慢其他页面
import Room3D from './views/RoomEntry.vue'
// 管理子页（用户/留言/机器/审计）按需加载，普通用户不会访问
const AdminDetail = () => import('./views/AdminDetail.vue')

const routes = [
  { path: '/inspection', name: 'inspection', component: () => import('./views/Inspection.vue'), meta: { title: '楼栋巡检', login: true } },
  { path: '/social', name: 'social', component: () => import('./views/Social.vue'), meta: { title: '朋友与代取' } },
  { path: '/assistant', name: 'assistant', component: () => import('./views/Assistant.vue'), meta: { title: '洗衣助手', login: true } },
  { path: '/login', name: 'login', component: Login, meta: { title: '登录', full: true } },
  // 默认首页 = 3D 洗衣房（只读可看；要登记/排队会引导登录）
  { path: '/', name: 'room3d', component: Room3D, meta: { title: '3D 洗衣房' } },
  { path: '/list', name: 'board', component: Board, meta: { title: '看板' } },
  { path: '/display', name: 'display', component: Display, meta: { title: '大屏', full: true } },
  { path: '/task', name: 'task', component: Task, meta: { title: '我的洗衣', login: true } },
  { path: '/settings', name: 'settings', component: Settings, meta: { title: '设置', login: true } },
  { path: '/board', name: 'messages', component: Messages, meta: { title: '留言板' } },
  { path: '/admin', name: 'admin', component: Admin, meta: { title: '管理', full: true } },
  {
    path: '/admin/users',
    name: 'admin-users',
    component: AdminDetail,
    props: { tab: 'users' },
    meta: { title: '用户管理', full: true },
  },
  {
    path: '/admin/messages',
    name: 'admin-messages',
    component: AdminDetail,
    props: { tab: 'messages' },
    meta: { title: '留言板管理', full: true },
  },
  {
    path: '/admin/machines',
    name: 'admin-machines',
    component: AdminDetail,
    props: { tab: 'machines' },
    meta: { title: '机器状态', full: true },
  },
  {
    path: '/admin/audits',
    name: 'admin-audits',
    component: AdminDetail,
    props: { tab: 'audits' },
    meta: { title: '上报事件审计', full: true },
  },
  {
    path: '/admin/logs',
    name: 'admin-logs',
    component: AdminDetail,
    props: { tab: 'logs' },
    meta: { title: '操作日志', full: true },
  }
]

const router = createRouter({
  // H5 静态托管（EdgeOne）下使用 hash 路由，避免刷新 404
  history: createWebHashHistory(),
  routes
})

// 全局守卫：需要登录的页面，未登录就带去登录页并记住回跳目标
// 注意不能在这里 await bootstrap()——boot 在 main.js 里做，
// 守卫只读 store 状态，避免每个路由都触发一次网络请求。
router.beforeEach((to) => {
  if (!to.meta.login) return true
  // 动态 import 避免 router 与 store 的循环依赖
  const token = localStorage.getItem('ws_token')
  const profile = localStorage.getItem('ws_profile')
  if (token && profile) return true
  return { path: '/login', query: { to: to.fullPath } }
})

export default router
