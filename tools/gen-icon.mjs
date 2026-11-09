// 生成 WeShirt PWA 图标（零依赖 PNG 编码）
// 用法：node tools/gen-icon.mjs
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(__dirname, '../public')

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// 图形：深色底 + 绿色滚筒圆环 + 白色舱门 + 顶部指示灯
function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4)
  const cx = size / 2
  const cy = size * 0.57
  const rOuter = size * 0.33
  const rInner = size * 0.235
  const rDoor = size * 0.115
  const knobX = size / 2
  const knobY = size * 0.185
  const knobR = size * 0.045

  const BG = [11, 18, 32]
  const GREEN = [34, 197, 94]
  const WHITE = [226, 232, 240]

  // 4x 超采样抗锯齿
  const SS = 4
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0]
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px_ = x + (sx + 0.5) / SS
          const py_ = y + (sy + 0.5) / SS
          let c = BG
          const d = Math.hypot(px_ - cx, py_ - cy)
          const dk = Math.hypot(px_ - knobX, py_ - knobY)
          if (d <= rOuter && d >= rInner) c = GREEN
          else if (d < rDoor) c = WHITE
          else if (dk <= knobR) c = GREEN
          acc[0] += c[0]
          acc[1] += c[1]
          acc[2] += c[2]
        }
      }
      const i = (y * size + x) * 4
      const n = SS * SS
      px[i] = Math.round(acc[0] / n)
      px[i + 1] = Math.round(acc[1] / n)
      px[i + 2] = Math.round(acc[2] / n)
      px[i + 3] = 255
    }
  }
  return px
}

mkdirSync(OUT, { recursive: true })
for (const size of [192, 512]) {
  const png = encodePNG(size, size, drawIcon(size))
  const file = resolve(OUT, `icon-${size}.png`)
  writeFileSync(file, png)
  console.log(`generated ${file} (${png.length} bytes)`)
}
