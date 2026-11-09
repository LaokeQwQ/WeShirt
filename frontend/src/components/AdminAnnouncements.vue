<template><section class="card admin-announcements"><h2>开屏公告</h2><div class="actions"><van-button size="small" @click="create">新建公告</van-button><van-button size="small" @click="load">刷新列表</van-button></div><div class="notice-list"><button v-for="a in list" :key="a.id" @click="edit(a)">{{a.published?'已发布':'草稿'}} · {{a.title}} · v{{a.version}}</button></div><template v-if="draft"><label>标题<input v-model="draft.title" maxlength="100" /></label><div class="notice-options"><label>可见楼栋<select v-model="draft.dormBuilding"><option value="">全部楼栋</option><option v-for="d in buildings" :key="d.code" :value="d.code">{{d.name}}</option></select></label><label><input v-model="draft.published" type="checkbox" />发布</label><label>开始<input v-model="startsAt" type="datetime-local" /></label><label>结束<input v-model="endsAt" type="datetime-local" /></label></div><MarkdownEditor v-model="draft.markdown" @save="save" /><p class="text-dim">发布新版本后，曾选择“不再提醒”的用户会再次看到更新内容。</p><div class="actions"><van-button type="primary" :loading="saving" @click="save">保存{{draft.published?'并发布':'草稿'}}</van-button><van-button v-if="draft.id" type="danger" plain @click="remove">删除公告</van-button></div></template><p v-if="error" class="error">{{error}}</p></section></template>
<script setup>
import { ref, computed, onMounted } from 'vue'
import { showToast, showConfirmDialog } from 'vant'
import { api } from '../api'
import { useDormStore } from '../stores/dorm'
import MarkdownEditor from './MarkdownEditor.vue'
const list=ref([]),draft=ref(null),saving=ref(false),error=ref(''),startsAt=ref(''),endsAt=ref('')
const dorm=useDormStore(),buildings=computed(()=>dorm.buildings)
function local(t){if(!t)return '';const d=new Date(t);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16)}
async function load(){try{list.value=(await api('/api/admin/announcements')).announcements;error.value=''}catch(e){error.value=e.message}}
function create(){draft.value={title:'',markdown:'# 公告\n\n请在这里填写公告内容。',published:false,dormBuilding:''};startsAt.value='';endsAt.value=''}
function edit(a){draft.value={...a,dormBuilding:a.dormBuilding||''};startsAt.value=local(a.startsAt);endsAt.value=local(a.endsAt)}
async function save(){if(saving.value)return;saving.value=true;try{const d=await api('/api/admin/announcements',{method:'POST',body:{...draft.value,startsAt:startsAt.value?new Date(startsAt.value).toISOString():null,endsAt:endsAt.value?new Date(endsAt.value).toISOString():null}});edit(d.announcement);await load();showToast('已保存')}catch(e){error.value=e.message}finally{saving.value=false}}
async function remove(){try{await showConfirmDialog({title:'删除公告',message:'确认删除这条公告？'});await api('/api/admin/announcements/'+draft.value.id,{method:'DELETE'});draft.value=null;await load()}catch{}}
onMounted(load)
</script>
<style scoped>.admin-announcements{padding:16px;margin:12px}.admin-announcements h2{font-size:18px;margin-top:0}.actions,.notice-options{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0}.notice-list{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.notice-list button{border:1px solid var(--border);background:var(--bg);color:var(--text);padding:8px;border-radius:8px}.admin-announcements label{font-size:13px}.admin-announcements input:not([type=checkbox]),select{background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:5px;padding:8px;max-width:100%}.admin-announcements>label{display:flex;gap:10px;align-items:center}.admin-announcements>label input{flex:1}.error{color:#fca5a5}</style>
