import { ref, watch, onMounted, onUnmounted } from 'vue'
import { loadBoard } from './boardQuery'

// 楼栋切换即清空旧视图；迟到响应只可写回发起时的楼栋。
export function useDormBoard(dorm) {
  const sourceBoard = ref(null)
  const error = ref('')
  const refreshing = ref(false)
  const now = ref(Date.now())
  const pending = new Map()
  let disposed = false
  let timer, clock
  let failures = 0
  async function load(force = false) {
    const code = dorm.code
    if (!code || disposed) return
    if (pending.has(code)) return pending.get(code)
    const job = (async () => {
      try {
        const data = await loadBoard({ dorm: code, force })
        if (disposed || dorm.code !== code) return
        sourceBoard.value = data.board
        now.value = Date.now()
        error.value = ''
        failures = 0
      } catch (e) {
        if (!disposed && dorm.code === code) { error.value = e?.message || '暂时无法刷新'; failures++ }
      } finally { if (dorm.code === code) refreshing.value = false }
    })()
    pending.set(code, job)
    try { return await job } finally { pending.delete(code) }
  }
  function stop() { clearTimeout(timer); clearInterval(clock) }
  function schedule() {
    clearTimeout(timer)
    if (disposed || document.hidden) return
    timer = setTimeout(async () => { await load(); schedule() }, Math.min(180000, 45000 * 2 ** Math.min(failures, 2)) + Math.random() * 3000)
  }
  function onVisibility() {
    stop()
    if (!document.hidden) { now.value = Date.now(); load(); clock = setInterval(() => { now.value = Date.now() }, 1000); schedule() }
  }
  watch(() => dorm.code, () => { sourceBoard.value = null; error.value = ''; failures = 0; load() }, { immediate: true })
  onMounted(() => { onVisibility(); document.addEventListener('visibilitychange', onVisibility) })
  onUnmounted(() => { disposed = true; stop(); document.removeEventListener('visibilitychange', onVisibility) })
  return { sourceBoard, error, refreshing, now, load }
}
