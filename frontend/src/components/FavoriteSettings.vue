<template>
  <section class="favorite-settings card">
    <div class="heading"><h3>收藏与洗衣时段</h3><button type="button" class="link" :disabled="loading || saving" @click="load">刷新</button></div>
    <p class="dim intro">收藏常用机器，在你的洗衣时段空闲时提醒你。每半小时最多一次，每个时段最多三次；本时段登记洗衣后停止。</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="loading && !loaded" class="dim" role="status">正在读取收藏…</p>
    <template v-if="loaded">
      <div class="favorites"><h4>我的收藏 <span>{{ preferences.favorites.length }}/20</span></h4><p v-if="!favorites.length" class="dim small">还没有收藏。到看板点机器旁的星标即可添加。</p><div v-for="machine in favorites" :key="machine.id" class="favorite-row"><span>{{ machine.floor }} {{ machine.name }}</span><button type="button" class="link danger" :disabled="saving" @click="removeFavorite(machine)">取消收藏</button></div><router-link class="link" to="/list">去看板添加 →</router-link></div>
      <form @submit.prevent="save">
        <label class="toggle"><span>时段内收藏空闲提醒</span><input v-model="preferences.enabled" type="checkbox" :disabled="saving" /></label>
        <p class="dim small">需要同时在通知设置中开启取衣提醒，并绑定钉钉。时间均为北京时间。</p>
        <div v-for="(window, index) in preferences.timeWindows" :key="index" class="window">
          <div class="heading"><h4>提醒时段 {{ index + 1 }}</h4><button type="button" class="link danger" :disabled="saving" @click="preferences.timeWindows.splice(index, 1)">移除</button></div>
          <div class="times"><label>开始<input v-model="window.start" type="time" required :disabled="saving" /></label><span aria-hidden="true">—</span><label>结束<input v-model="window.end" type="time" required :disabled="saving" /></label></div>
          <p v-if="window.start > window.end" class="dim small">跨午夜，到所选星期的次日结束。</p>
          <fieldset :disabled="saving"><legend>星期（按开始时间所在日）</legend><label v-for="day in days" :key="day.value" :class="{ selected: window.days.includes(day.value) }"><input v-model="window.days" type="checkbox" :value="day.value" /><span>{{ day.label }}</span></label></fieldset>
        </div>
        <div class="actions"><button v-if="preferences.timeWindows.length < 3" type="button" class="link" :disabled="saving" @click="addWindow">＋添加时段</button><van-button native-type="submit" size="small" type="primary" :loading="saving">保存偏好</van-button></div>
        <p v-if="saved" class="success small" role="status">已保存</p>
      </form>
    </template>
    <van-button v-else-if="!loading" size="small" @click="load">重试</van-button>
  </section>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { api } from '../api'
const preferences = reactive({ favorites: [], enabled: false, timeWindows: [] })
const machines = ref([]), loading = ref(false), loaded = ref(false), saving = ref(false), error = ref(''), saved = ref(false)
const days = [{ value: 1, label: '一' }, { value: 2, label: '二' }, { value: 3, label: '三' }, { value: 4, label: '四' }, { value: 5, label: '五' }, { value: 6, label: '六' }, { value: 7, label: '日' }]
const favorites = computed(() => machines.value.filter((machine) => preferences.favorites.includes(machine.id)))
let alive = true
function apply(data) { Object.assign(preferences, { favorites: data.preferences.favorites || [], enabled: data.preferences.enabled === true, timeWindows: (data.preferences.timeWindows || []).map((window) => ({ ...window, days: [...window.days] })) }); machines.value = data.machines || []; loaded.value = true }
async function load() {
  if (loading.value || saving.value) return
  loading.value = true; error.value = ''; saved.value = false
  try { const data = await api('/api/user/laundry-preferences'); if (alive) apply(data) }
  catch (e) { if (alive) error.value = e?.message || '偏好读取失败' }
  finally { if (alive) loading.value = false }
}
function addWindow() { preferences.timeWindows.push({ start: '18:00', end: '22:00', days: [1, 2, 3, 4, 5, 6, 7] }); saved.value = false }
async function save() {
  if (saving.value) return
  const invalid = preferences.timeWindows.some((window) => !window.days.length || !window.start || !window.end || window.start === window.end)
  if (invalid) { error.value = '每个时段请选择星期，且开始与结束时间不能相同'; return }
  if (preferences.enabled && (!preferences.favorites.length || !preferences.timeWindows.length)) { error.value = '开启前请收藏机器并添加时段'; return }
  saving.value = true; error.value = ''; saved.value = false
  try { const data = await api('/api/user/laundry-preferences', { method: 'PATCH', retry: false, body: { favorites: [...preferences.favorites], enabled: preferences.enabled, timeWindows: preferences.timeWindows.map((window) => ({ start: window.start, end: window.end, days: [...window.days] })) } }); if (alive) { apply(data); saved.value = true } }
  catch (e) { if (alive) error.value = e?.message || '保存失败' }
  finally { if (alive) saving.value = false }
}
function removeFavorite(machine) {
  if (saving.value) return
  // Save the edited windows too, so removing a favorite never discards a visible draft.
  preferences.favorites = preferences.favorites.filter((id) => id !== machine.id)
  if (!preferences.favorites.length) preferences.enabled = false
  saved.value = false
  error.value = '收藏已从列表移出，请保存偏好后生效'
}
onMounted(load)
onUnmounted(() => { alive = false })
</script>

<style scoped>
.favorite-settings{margin:12px;padding:16px}.heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.heading h3{margin:0;font-size:16px}.intro{font-size:12px;line-height:1.8}.dim{color:var(--text-dim,#94a3b8)}.small{font-size:11px;line-height:1.8}.link{border:0;background:transparent;color:#7dd3fc;font:inherit;font-size:12px;cursor:pointer;text-decoration:none;min-height:34px;padding:6px 0}.link:disabled{opacity:.4;cursor:default}.danger{color:#fca5a5}.favorites{border-bottom:1px solid var(--border,#334155);padding-bottom:12px;margin-bottom:16px}.favorites h4,.window h4{font-size:13px;margin:4px 0}.favorites h4 span{font-size:11px;color:var(--text-dim,#94a3b8);font-weight:400;margin-left:6px}.favorite-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:6px 0;font-size:12px}.favorite-row>span{overflow-wrap:anywhere}.toggle{display:flex;justify-content:space-between;align-items:center;font-size:13px;gap:12px}.toggle input{width:20px;height:20px;accent-color:#3b82f6}.window{border:1px solid var(--border,#334155);border-radius:10px;padding:12px;margin:12px 0}.times{display:flex;align-items:end;gap:10px;margin:8px 0}.times label{display:grid;gap:5px;flex:1;min-width:0;font-size:11px;color:var(--text-dim,#94a3b8)}.times input{width:100%;min-width:0;box-sizing:border-box;padding:9px 6px;border:1px solid var(--border,#334155);border-radius:8px;background:var(--bg,#0b1526);color:var(--text,#e8f0fb);font:inherit;font-size:14px;color-scheme:dark}.times>span{padding-bottom:10px;color:var(--text-dim,#94a3b8)}fieldset{border:0;margin:12px 0 0;padding:0;display:flex;gap:6px;flex-wrap:wrap}legend{font-size:10px;color:var(--text-dim,#94a3b8);padding:0 0 8px}fieldset label{display:flex;position:relative;align-items:center;justify-content:center;width:32px;height:32px;border:1px solid var(--border,#334155);border-radius:8px;font-size:12px;color:var(--text-dim,#94a3b8);cursor:pointer}fieldset label.selected{border-color:#3b82f6;color:#bfdbfe;background:rgba(59,130,246,.15)}fieldset input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}fieldset label:focus-within{outline:2px solid #7dd3fc;outline-offset:2px}.actions{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px}.error{color:#fca5a5;font-size:12px;overflow-wrap:anywhere}.success{color:#86efac}
</style>
