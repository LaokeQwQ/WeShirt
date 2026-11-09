// 生成 Web Push VAPID 密钥对，并输出可直接粘贴到 .env 的格式
// 用法：node tools/gen-vapid.mjs
import { generateVapidKeys } from '../packages/core/webpush.js'

const keys = await generateVapidKeys()
console.log('# 粘贴到 .env（或 EdgeOne 环境变量）')
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`)
console.log(`VAPID_PRIVATE_JWK=${JSON.stringify(keys.privateJwk)}`)
console.log(`VAPID_SUBJECT=mailto:dev@weshirt.local`)
