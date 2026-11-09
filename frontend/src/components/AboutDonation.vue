<template><section class="about-donation card"><h3>关于 {{ dorm.siteName }}</h3><p>本程序的初衷只是为了方便作者自己洗衣服，若有帮到您，您的认可是对我最大的鼓励。如果可以的话，可以请我喝杯咖啡嘛。</p><button class="donation-code" type="button" aria-label="放大微信赞赏码" @click="preview"><img src="/donate-wechat.png" width="240" height="240" loading="lazy" alt="作者提供的微信赞赏码" /></button><div class="code-caption">微信扫码或长按识别 · 自愿支持</div><footer><span>WeShirt {{ version }}</span><a href="https://github.com/LaokeQwQ/WeShirt" target="_blank" rel="noopener noreferrer">源代码与反馈</a></footer></section></template>
<script setup>
import { showImagePreview } from 'vant'
import { version } from '../../../package.json'
import { useDormStore } from '../stores/dorm'
const dorm=useDormStore()
function preview(){showImagePreview({images:['/donate-wechat.png'],closeable:true,showIndex:false})}
</script>
<style scoped>.about-donation{margin:16px 12px;padding:18px}.about-donation h3{margin:0;font-size:16px}.about-donation p{font-size:13px;line-height:1.9;color:var(--text-dim)}.donation-code{display:block;margin:16px auto 10px;padding:10px;border:0;border-radius:14px;background:white;max-width:100%;cursor:zoom-in}.donation-code img{display:block;width:240px;max-width:100%;height:auto}.code-caption{text-align:center;font-size:11px;color:var(--text-dim)}footer{display:flex;justify-content:space-between;gap:12px;margin-top:20px;font-size:11px;color:var(--text-dim)}</style>
