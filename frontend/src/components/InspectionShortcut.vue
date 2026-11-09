<template><router-link v-if="visible" class="inspection-shortcut" to="/inspection"><van-icon name="passed" /><span>巡检</span><small>{{ identity.label }}</small></router-link></template>
<script setup>
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../api'
import { useUserStore } from '../stores/user'
const user=useUserStore(),route=useRoute(),identity=ref({role:'user'})
const visible=computed(()=>user.isLoggedIn&&!route.meta.full&&route.path!=='/inspection'&&['super','admin','volunteer'].includes(identity.value.role))
let generation=0,lastFetch=0,pending=false
async function refresh(){if(!user.isLoggedIn||document.hidden||pending||Date.now()-lastFetch<60000)return;const request=++generation;pending=true;try{const data=await api('/api/user/identity',{silent:true});if(request===generation){identity.value=data.identity||{role:'user'};lastFetch=Date.now()}}catch{if(request===generation)identity.value={role:'user'}}finally{if(request===generation)pending=false}}
watch(()=>user.user?.id,()=>{generation++;pending=false;identity.value={role:'user'};lastFetch=0;refresh()},{immediate:true})
onMounted(()=>document.addEventListener('visibilitychange',refresh))
onUnmounted(()=>{generation++;document.removeEventListener('visibilitychange',refresh)})
</script>
<style scoped>.inspection-shortcut{position:fixed;left:12px;bottom:calc(66px + env(safe-area-inset-bottom));z-index:35;display:flex;align-items:center;gap:7px;padding:10px 12px;border:1px solid #486788;border-radius:12px;color:#bfdbfe;background:rgba(18,32,53,.96);box-shadow:0 5px 18px #0005;font-size:13px}.inspection-shortcut small{font-size:10px;color:#94a3b8}</style>
