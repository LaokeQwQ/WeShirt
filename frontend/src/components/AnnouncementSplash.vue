<template><van-popup :show="!!current" round :close-on-click-overlay="false" class="announcement-popup"><section v-if="current" class="announcement"><header><span>公告 · {{index+1}} / {{items.length}}</span><h2>{{current.title}}</h2></header><div class="announcement-content"><MarkdownView :value="current.markdown" /></div><footer><van-button block plain @click="close(false)">退出</van-button><van-button block type="primary" :loading="saving" @click="close(true)">不再提醒并退出</van-button></footer><p v-if="error" role="status">{{error}}</p></section></van-popup></template>
<script setup>
import { ref, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../api'
import { useDormStore } from '../stores/dorm'
import { useUserStore } from '../stores/user'
import MarkdownView from './MarkdownView.vue'
import { showToast } from 'vant'
const dorm=useDormStore(),user=useUserStore(),route=useRoute()
const items=ref([]),index=ref(0),saving=ref(false),error=ref('')
const current=computed(()=>items.value[index.value]||null)
let revision=0
function read(key,fallback){try{return JSON.parse(localStorage.getItem(key))??fallback}catch{return fallback}}
const key=()=>`ws_announcements:${user.user?.id||'guest'}`
watch(()=>[dorm.code,user.user?.id,user.ready,route.meta.full],async()=>{
  const seq=++revision;items.value=[];index.value=0
  if(!dorm.code||!user.ready||route.meta.full)return
  let pref=read(key(),{enabled:true,dismissed:{}})
  try{if(user.isLoggedIn){const data=await api('/api/user/announcements',{silent:true});pref=data;localStorage.setItem(key(),JSON.stringify(pref))}if(!pref.enabled)return;const data=await api('/api/announcements?dorm='+dorm.code,{auth:false});if(seq!==revision)return;items.value=(data.announcements||[]).filter((a)=>pref.dismissed?.[a.id]!==a.version&&!sessionStorage.getItem(`ws_seen:${user.user?.id||'guest'}:${a.id}:${a.version}`))}catch{}
},{immediate:true})
async function close(permanent){const a=current.value;if(!a||saving.value)return;saving.value=true;error.value='';try{if(permanent){if(user.isLoggedIn)await api('/api/user/announcements',{method:'PATCH',body:{dismiss:{id:a.id,version:a.version}}});const pref=read(key(),{enabled:true,dismissed:{}});pref.dismissed={...pref.dismissed,[a.id]:a.version};localStorage.setItem(key(),JSON.stringify(pref))}sessionStorage.setItem(`ws_seen:${user.user?.id||'guest'}:${a.id}:${a.version}`,'1');index.value++}catch{error.value='保存失败，请重试；也可点“退出”先关闭'}finally{saving.value=false}}
</script>
<style scoped>.announcement-popup{width:min(92vw,720px);max-height:88dvh;background:var(--bg-card);color:var(--text)}.announcement{padding:22px;display:flex;flex-direction:column;max-height:86dvh;box-sizing:border-box}.announcement header span{font-size:12px;color:#93c5fd}.announcement h2{font-size:21px;margin:10px 0 16px}.announcement-content{overflow:auto;min-height:40px;padding-bottom:12px}.announcement footer{display:flex;gap:10px;border-top:1px solid var(--border);padding-top:16px;margin-top:8px;flex:none}.announcement footer>.van-button{flex:1;font-size:13px}.announcement>p{color:#fca5a5;font-size:12px}</style>
