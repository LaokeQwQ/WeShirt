<template>
  <button class="machine-card" @click="open = true"><span class="mc-bar" :class="'bg-' + status.cls"></span><span class="mc-body"><span class="mc-kind">{{ machine.kind === 'dryer' ? '烘干机' : '洗衣机' }}<span>{{favorite?'已收藏 · ':''}}查看 ›</span></span><strong class="mc-name">{{ machine.displayName || machine.name || machine.id }}</strong><span class="mc-state" :class="'state-' + status.cls">{{ status.text }}</span><span class="mc-time">{{ detail }}</span></span></button>
  <van-popup v-model:show="open" position="bottom" round closeable><section class="machine-detail"><h2>{{ machine.displayName || machine.name }}</h2><p :class="'state-' + status.cls">{{ status.text }} · {{ detail }}</p><p v-if="machine.suspectedUncollected" class="text-dim">根据登记时间推测，衣物是否仍在桶内请到现场确认。</p><CareRecord :record="care" /><van-button block type="primary" :disabled="['faulty','unknown'].includes(machine.state)" @click="register">{{ machine.state === 'idle' ? '开始使用并登记' : '登记这台机器的洗衣' }}</van-button><van-button block plain :loading="favoriteSaving" @click="toggleFavorite">{{favorite?'取消收藏':'收藏为常用机器'}}</van-button><QueuePanel :machine="machine" :dorm="dorm.code" /><SocialInbox v-if="occupantId" :to-user-id="occupantId" :machine-id="String(machine.id)" /><van-button block plain @click="$router.push({path:'/board',query:{channel:dorm.code,machine:machine.id}})">查看这台机器的留言</van-button></section></van-popup>
</template>
<script setup>
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'
import { useDormStore } from '../stores/dorm'
import QueuePanel from './QueuePanel.vue'
import CareRecord from './CareRecord.vue'
import SocialInbox from './SocialInbox.vue'
const props = defineProps({ machine: { type: Object, required: true },favorite:{type:Boolean,default:false} })
const emit=defineEmits(['favorite'])
const favoriteSaving=ref(false)
async function toggleFavorite(){if(favoriteSaving.value)return;favoriteSaving.value=true;try{await api('/api/user/favorites/toggle',{method:'POST',body:{machineId:String(props.machine.id)}});emit('favorite')}catch(e){const {showToast}=await import('vant');showToast(e.message)}finally{favoriteSaving.value=false}}
const router = useRouter()
const dorm = useDormStore()
const open = ref(false)
const occupantId = ref('')
const care = ref(null)
const status = computed(() => props.machine.suspectedUncollected ? { cls:'occupied',text:'疑似未取' } : ({idle:{cls:'idle',text:'空闲'},occupied:{cls:'occupied',text:'运行中'},abnormal:{cls:'occupied',text:'状态待复核'},faulty:{cls:'faulty',text:'故障已确认'},unknown:{cls:'unknown',text:'状态未知'}}[props.machine.state] || {cls:'unknown',text:'状态未知'}))
const detail = computed(() => { const m = props.machine; if (m.suspectedUncollected) return '请确认桶内衣物'; if (m.state === 'idle') return '可前往现场使用'; if (m.state === 'faulty') return '暂不可使用'; if (m.state === 'occupied') return m.leftMin > 0 ? `${m.estimated ? '估计' : '预计'}剩余 ${m.leftMin} 分钟` : '结束时间待确认'; return '请以现场状态为准' })
watch(open, async (value) => { occupantId.value = ''; care.value = null; if (!value) return; try { const d = await api('/api/occupancy?machineId=' + encodeURIComponent(props.machine.id), {auth:'optional',silent:true}); if (open.value) { const occupant = d.occupancy?.[props.machine.id]; occupantId.value = occupant?.userId || ''; care.value = occupant?.care || null } } catch {} })
function register() { open.value = false; router.push({path:'/task',query:{machine:props.machine.id}}) }
</script>
<style scoped>
.machine-card{position:relative;border-radius:14px;overflow:hidden;background:var(--bg-card);border:1px solid var(--border);cursor:pointer;padding:0;color:var(--text);text-align:left;min-height:148px;width:100%}.machine-card:focus-visible{outline:2px solid #93c5fd;outline-offset:3px}.mc-bar{display:block;height:4px}.mc-body{display:flex;flex-direction:column;padding:12px;gap:7px}.mc-kind{font-size:11px;color:var(--text-dim);display:flex;justify-content:space-between;gap:4px}.mc-name{font-size:15px;line-height:1.4}.mc-state{font-size:14px}.mc-time{font-size:12px;color:var(--text-dim)}.machine-detail{padding:24px 18px calc(30px + env(safe-area-inset-bottom));background:var(--bg-card);color:var(--text)}.machine-detail h2{font-size:19px;margin-right:24px}.machine-detail>.van-button{margin-top:12px}
</style>