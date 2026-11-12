<template>
  <span class="channel-avatar" :class="{ public: code === 'public' }" aria-hidden="true">
    <img v-if="src" :src="src" alt="" />
    <svg v-else-if="code === 'public'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-5 3v-3H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z"/><path d="M7 9h10M7 13h6"/></svg>
    <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16M3 21h18M10 21v-5h4v5M8 7h1m6 0h1M8 11h1m6 0h1"/></svg>
  </span>
</template>
<script setup>
defineProps({code:{type:String,default:''},src:{type:String,default:''}})
</script>
<style scoped>
.channel-avatar{display:grid;place-items:center;flex:none;width:46px;height:46px;border-radius:15px;background:color-mix(in srgb,var(--text-dim) 12%,var(--bg-card));color:var(--text-dim);overflow:hidden}.channel-avatar.public{background:color-mix(in srgb,#4997aa 17%,var(--bg-card));color:#77bac7}.channel-avatar svg{width:25px;height:25px}.channel-avatar img{width:100%;height:100%;object-fit:cover}
</style>
