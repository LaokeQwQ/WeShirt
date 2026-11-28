<template>
  <article class="machine-card" :class="'is-' + status.cls">
    <button class="mc-open" type="button" @click="open = true" :aria-label="`查看${machine.displayName || machine.remarkName || machine.name || '机器'}详情，${status.text}，${detail}`">
      <span class="mc-meta">
        <span>{{ machine.kind === 'dryer' ? '烘干机' : '洗衣机' }}</span>
        <span v-if="slot" class="mc-slot">{{ slot }}</span>
      </span>
      <strong class="mc-name">{{ machine.displayName || machine.remarkName || machine.name || machine.id }}</strong>
      <small v-if="machine.originalName && machine.originalName !== (machine.displayName || machine.remarkName || machine.name)" class="mc-original">{{ machine.originalName }}</small>
      <span class="mc-foot">
        <span class="mc-state" :class="'state-' + status.cls"><i aria-hidden="true"></i>{{ status.text }}</span>
        <span v-if="machine.state !== 'idle' || machine.registrationPending || machine.suspectedUncollected" class="mc-time">{{ detail }}</span>
      </span>
    </button>
    <button class="mc-favorite" type="button" :aria-label="`${favorite ? '取消收藏' : '收藏'}${machine.displayName || machine.name || '机器'}`" :aria-pressed="favorite" :disabled="favoriteSaving || !userStore.ready" @click="toggleFavorite"><van-icon :name="favorite ? 'star' : 'star-o'" aria-hidden="true" /></button>
  </article>
  <van-popup v-model:show="open" position="bottom" round closeable><section class="machine-detail"><h2><span v-if="slot" class="mc-slot">{{ slot }}</span>{{ machine.displayName || machine.remarkName || machine.name }}</h2><p v-if="machine.originalName && machine.originalName !== (machine.displayName || machine.remarkName || machine.name)" class="mc-original">原名：{{ machine.originalName }}</p><p :class="'state-' + status.cls">{{ status.text }} · {{ detail }}</p><p v-if="machine.suspectedUncollected" class="text-dim">根据登记时间推测，衣物是否仍在桶内请到现场确认。</p><CareRecord :record="care" /><van-button block type="primary" :disabled="!userStore.ready || ['faulty','unknown'].includes(machine.state)" @click="register">{{ machine.state === 'idle' ? '开始使用并登记' : '登记这台机器的洗衣' }}</van-button><van-button block plain :loading="favoriteSaving" :disabled="!userStore.ready" @click="toggleFavorite">{{favorite?'取消收藏':'收藏为常用机器'}}</van-button><p v-if="!userStore.ready" class="text-dim">账号恢复后即可登记、收藏和排队。</p><QueuePanel v-if="userStore.ready" :machine="machine" :dorm="dorm.code" /><SocialInbox v-if="userStore.ready && occupantId" :to-user-id="occupantId" :machine-id="String(machine.id)" /><van-button block plain @click="$router.push({path:'/board',query:{channel:dorm.code,machine:machine.id}})">查看这台机器的留言</van-button><MachineFeedback v-if="userStore.ready" :machine-id="String(machine.id)" :name="machine.displayName || machine.remarkName || machine.name" /></section></van-popup>
</template>
<script setup>
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'
import { useDormStore } from '../stores/dorm'
import { useUserStore } from '../stores/user'
import QueuePanel from './QueuePanel.vue'
import MachineFeedback from './MachineFeedback.vue'
import CareRecord from './CareRecord.vue'
import SocialInbox from './SocialInbox.vue'
const props = defineProps({ machine: { type: Object, required: true },favorite:{type:Boolean,default:false},slot:{type:String,default:''} })
const emit=defineEmits(['favorite'])
const userStore = useUserStore()
const favoriteSaving=ref(false)
async function toggleFavorite(){if(favoriteSaving.value||!userStore.ready)return;if(!userStore.isLoggedIn){router.push({path:'/login',query:{to:'/list'}});return}const owner=userStore.user?.id,token=userStore.token;favoriteSaving.value=true;try{await api('/api/user/favorites/toggle',{method:'POST',body:{machineId:String(props.machine.id)}});if(owner===userStore.user?.id&&token===userStore.token)emit('favorite')}catch(e){if(owner===userStore.user?.id&&token===userStore.token){const {showToast}=await import('vant');showToast(e.message)}}finally{favoriteSaving.value=false}}
const router = useRouter()
const dorm = useDormStore()
const open = ref(false)
const occupantId = ref('')
const care = ref(null)
const status = computed(() => props.machine.availabilityLabel ? { cls:'occupied',text:props.machine.availabilityLabel } : props.machine.suspectedUncollected ? { cls:'occupied',text:'疑似未取' } : ({idle:{cls:'idle',text:'空闲'},occupied:{cls:'occupied',text:'运行中'},abnormal:{cls:'occupied',text:'状态待复核'},faulty:{cls:'faulty',text:'故障已确认'},unknown:{cls:'unknown',text:'状态未知'}}[props.machine.state] || {cls:'unknown',text:'状态未知'}))
const detail = computed(() => { const m = props.machine; if (m.registrationPending) return '登记推测占用，请现场确认机器是否启动'; if (m.suspectedUncollected) return '请确认桶内衣物'; if (m.state === 'idle') return '现在可用'; if (m.state === 'faulty') return '暂不可使用'; if (m.state === 'occupied') return m.leftMin > 0 ? `${m.estimated ? '估算' : '预计'}剩余 ${m.leftMin} 分钟` : (m.leftMin === 0 ? '即将完成' : '结束时间待确认'); return '请以现场状态为准' })
watch(open, async (value) => { occupantId.value = ''; care.value = null; if (!value) return; try { const d = await api('/api/occupancy?machineId=' + encodeURIComponent(props.machine.id), {auth:'optional',silent:true}); if (open.value) { const occupant = d.occupancy?.[props.machine.id]; occupantId.value = occupant?.userId || ''; care.value = occupant?.care || null } } catch {} })
function register() { if(!userStore.ready)return;open.value = false; router.push({path:'/task',query:{machine:props.machine.id}}) }
</script>
<style scoped>
.machine-card {
  position: relative;
  display: flex;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--bg-card);
  color: var(--text);
}
.mc-open {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
  min-height: 124px;
  padding: 12px;
  gap: 4px;
  border: 0;
  border-radius: inherit;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
}
.mc-open:focus-visible, .mc-favorite:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
.mc-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  min-height: 24px;
  max-width: calc(100% - 32px);
  gap: 4px 6px;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.35;
}
.mc-slot {
  display: inline-grid;
  place-items: center;
  min-width: 22px;
  min-height: 19px;
  padding: 1px 5px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--primary) 13%, var(--bg-card));
  color: var(--primary);
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.mc-name { width: 100%; font-size: 16px; font-weight: 650; line-height: 1.4; overflow-wrap: anywhere; }
.mc-original { width: 100%; color: var(--text-dim); font-size: 11px; line-height: 1.4; overflow-wrap: anywhere; }
.mc-open .mc-original { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-foot { display: flex; width: 100%; align-items: baseline; flex-wrap: wrap; margin-top: auto; padding-top: 6px; gap: 3px 8px; }
.mc-state { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 650; line-height: 1.5; }
.mc-state i { flex: none; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.mc-time { min-width: 0; color: var(--text-dim); font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
.mc-favorite {
  position: absolute;
  inset: 0 1px auto auto;
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 20px;
}
.mc-favorite[aria-pressed=true] { color: #d6a34e; }
.mc-favorite:disabled { opacity: .5; cursor: wait; }
.machine-detail {
  max-height: 85dvh;
  overflow-y: auto;
  overscroll-behavior: contain;
  box-sizing: border-box;
  padding: 24px 18px calc(30px + env(safe-area-inset-bottom));
  background: var(--bg-card);
  color: var(--text);
}
.machine-detail h2 { display: flex; align-items: baseline; gap: 8px; font-size: 19px; margin-right: 24px; line-height: 1.5; overflow-wrap: anywhere; }
.machine-detail > .van-button { margin-top: 12px; white-space: normal; min-height: 44px; height: auto; padding-block: 10px; }
@media (max-width: 350px) {
  .mc-open { padding-inline: 9px; }
  .mc-name { font-size: 15px; }
}
</style>
