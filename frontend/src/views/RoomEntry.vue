<template>
  <div class="room-entry" @weshirt-room-failure="onRoomFailure" @webglcontextlost.capture="onContextLost">
    <component :is="room" v-if="room && !failure" :key="attempt" />
    <main v-else class="room-start" aria-live="polite">
      <van-nav-bar title="3D 洗衣房" />
      <section class="room-status">
        <div class="room-mark" aria-hidden="true"><span></span></div>
        <h1>{{ failure ? '暂时无法显示 3D' : '正在准备洗衣房' }}</h1>
        <p>{{ message }}</p>
        <p v-if="failure && embedded" class="room-hint">可以更新钉钉后重试，或从右上角菜单选择在浏览器中打开。</p>
        <div class="room-actions">
          <van-button v-if="failure" type="primary" @click="retry">重试 3D</van-button>
          <router-link class="list-link" to="/list">使用 2D 看板</router-link>
        </div>
        <button v-if="failure === 'module_failed' || failure === 'load_timeout'" class="reload-link" type="button" @click="reload">刷新页面</button>
        <small v-if="eventId" class="trace">问题编号：{{ eventId }}</small>
      </section>
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, onErrorCaptured, ref, shallowRef } from 'vue'
import { createRoomLoadSession, isEmbeddedRoomBrowser } from '../room/compatibility'
import { reportClientError } from '../telemetry'

const room = shallowRef(null), failure = ref(''), eventId = ref(''), attempt = ref(0)
const embedded = isEmbeddedRoomBrowser()
const message = computed(() => {
  if (!failure.value) return '加载期间也可以先用 2D 看板查看机器、登记和排队。'
  if (failure.value === 'webgl2_unavailable') return '当前浏览器暂不支持这个 3D 场景，2D 看板仍可正常使用。'
  if (failure.value === 'module_failed' || failure.value === 'load_timeout') return '场景资源没有加载完成。请重试，或刷新页面获取最新版本。'
  return '场景未能正常运行。可以重试，或使用功能相同的 2D 看板。'
})
const session = createRoomLoadSession({
  load: () => import('./Room3D.vue'),
  onChange(state) {
    room.value = state.component
    failure.value = state.phase === 'failed' ? state.reason : ''
    if (failure.value && !eventId.value) {
      const error = new Error('Room unavailable')
      error.name = 'RoomError'
      eventId.value = reportClientError(error, { kind: 'resource' }).eventId
    }
  },
})
function retry() { eventId.value = ''; attempt.value++; session.start() }
function reload() { location.reload() }
function onRoomFailure(event) { session.fail(event.detail?.reason) }
function onContextLost(event) { event.preventDefault(); session.fail('context_lost') }
onErrorCaptured((error) => {
  eventId.value = reportClientError(error, { kind: 'vue' }).eventId
  session.fail('render_failed')
  return false
})
onMounted(retry)
onUnmounted(() => session.dispose())
</script>

<style scoped>
.room-entry { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.room-start { flex: 1; min-height: 0; overflow-y: auto; background: var(--bg, #0b1220); color: var(--text, #e6edf6); }
.room-status { max-width: 440px; margin: 0 auto; padding: 64px 24px 40px; text-align: center; }
.room-mark { display: grid; place-items: center; width: 66px; height: 76px; margin: 0 auto 28px; border: 2px solid #456782; border-radius: 10px; background: #102336; }
.room-mark span { width: 42px; height: 42px; border: 3px solid #86cbef; border-radius: 50%; box-shadow: inset 0 0 0 5px #193b52; }
h1 { margin: 0 0 12px; font-size: 21px; line-height: 1.4; }
p { font-size: 14px; line-height: 1.8; color: var(--text-dim, #9aa7bd); margin: 0 0 16px; }
.room-hint { font-size: 12px; }
.room-actions { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 12px; margin-top: 26px; }
.list-link { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 18px; border: 1px solid #54758f; border-radius: 6px; color: #b8e3fb; background: #122d42; font-size: 14px; }
.reload-link { display: block; margin: 20px auto 0; border: 0; background: transparent; color: #a4cce6; font: inherit; font-size: 12px; padding: 8px; cursor: pointer; }
.trace { display: block; margin-top: 24px; font-size: 10px; color: #8197ad; overflow-wrap: anywhere; }
a:focus-visible, button:focus-visible { outline: 2px solid #7dd3fc; outline-offset: 3px; }
</style>
