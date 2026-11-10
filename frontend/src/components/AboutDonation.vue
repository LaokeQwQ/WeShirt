<template>
  <section class="about-donation card">
    <h3>关于 {{ dorm.siteName }}</h3>
    <p>本程序的初衷只是为了方便作者自己洗衣服，若有帮到您，您的认可是对我最大的鼓励。如果可以的话，可以请我喝杯咖啡嘛。</p>
    <p>至今耗费 20 亿 Token 和数天用于开发调试，部署于腾讯云 CloudBase，这些都是不小的费用。</p>
    <button class="donation-code" type="button" aria-label="放大微信赞赏码" @click="preview">
      <img src="/donate-wechat.png" width="240" height="240" loading="lazy" alt="作者提供的微信赞赏码" />
    </button>
    <div class="code-caption">微信扫码或长按识别 · 自愿支持</div>
    <footer>
      <span>WeShirt v{{ version }}</span>
      <a class="source-link" href="https://github.com/LaokeQwQ/WeShirt" target="_blank" rel="noopener noreferrer">
        <svg class="github-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 1a11 11 0 0 0-3.48 21.44c.55.1.75-.24.75-.53v-2.13c-3.06.67-3.71-1.3-3.71-1.3-.5-1.27-1.22-1.6-1.22-1.6-1-.69.08-.67.08-.67 1.1.08 1.68 1.13 1.68 1.13.98 1.67 2.57 1.19 3.2.91.1-.71.38-1.19.7-1.46-2.44-.28-5.01-1.22-5.01-5.44 0-1.2.43-2.18 1.13-2.95-.11-.28-.49-1.4.11-2.91 0 0 .92-.3 3.03 1.13a10.5 10.5 0 0 1 5.51 0c2.1-1.42 3.02-1.13 3.02-1.13.6 1.51.22 2.63.11 2.91.7.77 1.13 1.75 1.13 2.95 0 4.23-2.58 5.16-5.03 5.43.39.34.74 1.01.74 2.04v3.09c0 .3.2.64.76.53A11 11 0 0 0 12 1Z" /></svg>
        源代码与反馈
      </a>
    </footer>
    <div class="made-by">Made with 💗 by Laoke</div>
  </section>
</template>
<script setup>
import { showImagePreview } from 'vant'
import { version } from '../../../package.json'
import { useDormStore } from '../stores/dorm'
const dorm=useDormStore()
function preview(){showImagePreview({images:['/donate-wechat.png'],closeable:true,showIndex:false})}
</script>
<style scoped>
.about-donation { margin: 16px 12px; padding: 18px; }
.about-donation h3 { margin: 0; font-size: 16px; }
.about-donation p { font-size: 13px; line-height: 1.9; color: var(--text-dim); overflow-wrap: anywhere; }
.donation-code { display: block; margin: 16px auto 10px; padding: 10px; border: 0; border-radius: 14px; background: white; max-width: 100%; cursor: zoom-in; }
.donation-code img { display: block; width: 240px; max-width: 100%; height: auto; }
.code-caption, .made-by { text-align: center; font-size: 11px; color: var(--text-dim); }
footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-top: 20px; font-size: 11px; color: var(--text-dim); }
.source-link { display: inline-flex; align-items: center; gap: 5px; min-height: 36px; }
.github-icon { width: 16px; height: 16px; flex: none; }
.made-by { margin-top: 12px; }
.source-link:focus-visible, .donation-code:focus-visible { outline: 2px solid #7dd3fc; outline-offset: 3px; }
</style>
