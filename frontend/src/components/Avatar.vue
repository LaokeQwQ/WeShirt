<template>
  <!-- 有图就显示图（钉钉头像 / 用户上传） -->
  <img
    v-if="src"
    class="avatar"
    :src="src"
    :width="px"
    :height="px"
    alt="头像"
    referrerpolicy="no-referrer"
  />
  <!-- 没有图就显示昵称首字，颜色按昵称稳定散列，同一个人永远同一个色 -->
  <span
    v-else
    class="avatar txt"
    :style="{ width: px + 'px', height: px + 'px', background: bg, fontSize: Math.round(px * 0.42) + 'px' }"
    :aria-label="'头像 ' + (initial || '匿')"
    role="img"
  >{{ initial }}</span>
</template>

<script setup>
// 头像规则（2026-10 定稿）：不再提供预设卡通头像。
// 有钉钉头像/上传头像就显示图片，否则显示昵称首字。
// 好处：新用户不用选头像，也不会出现"一屋子粉兔子"。
import { computed } from 'vue'

const props = defineProps({
  // 昵称：没有图片时取首字
  name: { type: String, default: '' },
  // 兼容旧调用：以前传 seed（av1..av12），现在只用于稳定配色
  seed: { type: String, default: '' },
  src: { type: String, default: '' },
  size: { type: [Number, String], default: 40 }
})

const px = computed(() => {
  const n = Number(props.size)
  return Number.isFinite(n) && n > 0 ? n : 40
})

const label = computed(() => String(props.name || props.seed || '').trim())

// 首字：中文取第一个字；英文/数字取首字母大写
const initial = computed(() => {
  const s = label.value
  if (!s) return '匿'
  const first = [...s][0]
  return /[a-z]/.test(first) ? first.toUpperCase() : first
})

// 稳定配色：同一昵称永远同一个颜色，改昵称才换
const PALETTE = [
  ['#1d4ed8', '#3b82f6'],
  ['#0e7490', '#06b6d4'],
  ['#047857', '#10b981'],
  ['#b45309', '#f59e0b'],
  ['#be123c', '#f43f5e'],
  ['#6d28d9', '#8b5cf6'],
  ['#a16207', '#eab308'],
  ['#0f766e', '#14b8a6']
]
const bg = computed(() => {
  const s = label.value || '匿名'
  let h = 0
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)) % 100000
  const [a, b] = PALETTE[h % PALETTE.length]
  return `linear-gradient(160deg, ${a}, ${b})`
})
</script>

<style scoped>
.avatar {
  display: block;
  border-radius: 50%;
  flex: none;
}
img.avatar {
  object-fit: cover;
  background: #1b2430;
}
.txt {
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-weight: 600;
  line-height: 1;
  user-select: none;
  letter-spacing: 0;
}
</style>
