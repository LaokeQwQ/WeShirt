<template><div class="markdown" v-html="html" /></template>
<script setup>
import { computed } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
const props=defineProps({value:{type:String,default:''}})
const html=computed(()=>DOMPurify.sanitize(marked.parse(props.value.slice(0,20000),{gfm:true,breaks:true}),{USE_PROFILES:{html:true},FORBID_TAGS:['style','iframe','form','input','button'],FORBID_ATTR:['style']}))
</script>
<style scoped>.markdown{line-height:1.8;overflow-wrap:anywhere;font-size:14px}.markdown :deep(img){max-width:100%;height:auto}.markdown :deep(pre){background:var(--bg);padding:12px;border-radius:8px;overflow:auto}.markdown :deep(table){border-collapse:collapse;display:block;overflow:auto}.markdown :deep(th),.markdown :deep(td){border:1px solid var(--border);padding:5px 10px}.markdown :deep(a){color:#93c5fd}.markdown :deep(blockquote){border-left:3px solid #60a5fa;margin-left:0;padding-left:14px;color:var(--text-dim)}.markdown :deep(h1){font-size:24px}.markdown :deep(h2){font-size:21px}</style>
