export const COMMUNITY_MEDIA_LIMIT = 4 * 1024 * 1024
const invalid = (message = '视频格式不完整，请选择 30 秒内的 H.264 MP4 视频') => { throw Object.assign(new Error(message), { code: 'bad_media', status: 400 }) }

// ISO BMFF 结构、所有轨道计时和样本位置都从文件读取，不接受客户端 duration/MIME 声明。
export function inspectMp4(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 64 || bytes.length > COMMUNITY_MEDIA_LIMIT) invalid()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u32 = (at) => { if (at < 0 || at + 4 > bytes.length) invalid(); return view.getUint32(at) }
  const u64 = (at) => { const value = u32(at) * 4294967296 + u32(at + 4); if (!Number.isSafeInteger(value)) invalid(); return value }
  const str = (at, n = 4) => String.fromCharCode(...bytes.subarray(at, at + n))
  let count = 0
  function boxes(start, end) {
    const list = []
    for (let at = start; at < end;) {
      if (++count > 4096 || at + 8 > end) invalid()
      let size = u32(at), header = 8
      const type = str(at + 4)
      if (size === 1) { size = u64(at + 8); header = 16 }
      if (size === 0 && type === 'mdat') size = end - at
      if (!/^[\x20-\x7e]{4}$/.test(type) || size < header || at + size > end) invalid()
      list.push({ type, at, data: at + header, end: at + size }); at += size
    }
    return list
  }
  const one = (list, type) => { const values = list.filter((box) => box.type === type); if (values.length !== 1) invalid(); return values[0] }
  function duration(box) {
    const version = bytes[box.data]
    if (![0, 1].includes(version)) invalid()
    const scaleAt = box.data + (version ? 20 : 12), durationAt = scaleAt + 4
    if (durationAt + (version ? 8 : 4) > box.end) invalid()
    const scale = u32(scaleAt), ticks = version ? u64(durationAt) : u32(durationAt)
    if (!scale || !ticks || !Number.isFinite(ticks / scale) || ticks / scale > 30) invalid('视频须大于 0 秒且不超过 30 秒')
    return { scale, seconds: ticks / scale }
  }
  const top = boxes(0, bytes.length), ftyp = one(top, 'ftyp'), moov = one(top, 'moov'), mdats = top.filter((box) => box.type === 'mdat' && box.end > box.data)
  let inspectedBytes = 0
  function containsSample(offset, size) {
    let low = 0, high = mdats.length - 1, found = null
    while (low <= high) { const mid = (low + high) >> 1; if (mdats[mid].data <= offset) { found = mdats[mid]; low = mid + 1 } else high = mid - 1 }
    return found && offset + size <= found.end
  }
  if (ftyp.at !== 0 || ftyp.end - ftyp.data < 8 || (ftyp.end - ftyp.data) % 4 || !mdats.length || top.some((box) => ['moof', 'mfra', 'sidx'].includes(box.type))) invalid()
  const brands = [str(ftyp.data), ...Array.from({ length: (ftyp.end - ftyp.data - 8) / 4 }, (_, i) => str(ftyp.data + 8 + 4 * i))]
  if (!brands.some((brand) => ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ', 'qt  '].includes(brand))) invalid()
  const movie = boxes(moov.data, moov.end), movieDuration = duration(one(movie, 'mvhd')).seconds
  const tracks = movie.filter((box) => box.type === 'trak')
  if (!tracks.length || tracks.length > 3) invalid()
  let width = 0, height = 0, videoTracks = 0, actualDuration = movieDuration
  for (const track of tracks) {
    const children = boxes(track.data, track.end), tkhd = one(children, 'tkhd'), mdia = one(children, 'mdia'), media = boxes(mdia.data, mdia.end)
    const timing = duration(one(media, 'mdhd')), hdlr = one(media, 'hdlr')
    actualDuration = Math.max(actualDuration, timing.seconds)
    if (hdlr.data + 12 > hdlr.end) invalid()
    const handler = str(hdlr.data + 8)
    if (!['vide', 'soun'].includes(handler)) invalid('视频包含不支持的轨道，请导出为普通 MP4 视频')
    const video = handler === 'vide'
    if (video) {
      videoTracks++
      if (tkhd.end - tkhd.data < 84) invalid()
      width = Math.round(u32(tkhd.end - 8) / 65536); height = Math.round(u32(tkhd.end - 4) / 65536)
      if (!width || !height || width > 3840 || height > 3840 || width * height > 8294400) invalid('视频分辨率过高，请先压缩')
    }
    const minf = one(media, 'minf'), info = boxes(minf.data, minf.end), stbl = one(info, 'stbl'), table = boxes(stbl.data, stbl.end)
    const dinf = one(info, 'dinf'), dref = one(boxes(dinf.data, dinf.end), 'dref')
    if (u32(dref.data + 4) !== 1) invalid()
    const reference = one(boxes(dref.data + 8, dref.end), 'url ')
    if (reference.end - reference.data !== 4 || u32(reference.data) !== 1) invalid('视频不能包含外部媒体引用')
    const stsd = one(table, 'stsd')
    if (u32(stsd.data + 4) !== 1) invalid()
    const descriptions = boxes(stsd.data + 8, stsd.end), description = one(descriptions, video ? 'avc1' : 'mp4a')
    const fields = video ? 78 : 28
    if (description.end - description.data < fields || view.getUint16(description.data + 6) !== 1) invalid()
    if (video) {
      const avcc = one(boxes(description.data + fields, description.end), 'avcC')
      if (avcc.end - avcc.data < 7 || bytes[avcc.data] !== 1 || (bytes[avcc.data + 4] & 3) !== 3) invalid()
      let at = avcc.data + 6
      const sps = bytes[avcc.data + 5] & 31
      if (!sps) invalid()
      function parameterSets(n, type) {
        for (let i = 0; i < n; i++) {
          if (at + 2 > avcc.end) invalid()
          const length = view.getUint16(at); at += 2
          if (!length || at + length > avcc.end || (bytes[at] & 31) !== type) invalid()
          at += length
        }
      }
      parameterSets(sps, 7)
      if (at >= avcc.end || !bytes[at]) invalid()
      const pps = bytes[at++]; parameterSets(pps, 8)
    }
    const stts = one(table, 'stts'), sizeBox = one(table, 'stsz'), chunks = table.find((box) => box.type === 'stco' || box.type === 'co64'), stsc = one(table, 'stsc')
    if (!chunks || table.filter((box) => ['stco', 'co64'].includes(box.type)).length !== 1) invalid()
    const timeCount = u32(stts.data + 4)
    if (!timeCount || timeCount > 60000 || stts.data + 8 + timeCount * 8 !== stts.end) invalid()
    let sampleCount = 0, ticks = 0
    for (let i = 0; i < timeCount; i++) { const n = u32(stts.data + 8 + i * 8), delta = u32(stts.data + 12 + i * 8); if (!n || !delta) invalid(); sampleCount += n; ticks += n * delta }
    if (sampleCount > 60000 || !Number.isSafeInteger(ticks) || ticks / timing.scale > 30 || Math.abs(ticks / timing.scale - timing.seconds) > 0.15) invalid('视频样本计时须在 30 秒以内，且与文件声明一致')
    const fixed = u32(sizeBox.data + 4), n = u32(sizeBox.data + 8)
    if (n !== sampleCount || sizeBox.data + 12 + (fixed ? 0 : n * 4) !== sizeBox.end) invalid()
    const sizes = Array.from({ length: n }, (_, i) => fixed || u32(sizeBox.data + 12 + i * 4))
    const chunkCount = u32(chunks.data + 4), chunkBytes = chunks.type === 'co64' ? 8 : 4, mapCount = u32(stsc.data + 4)
    if (!chunkCount || chunkCount > 60000 || chunks.data + 8 + chunkCount * chunkBytes !== chunks.end || !mapCount || mapCount > chunkCount || stsc.data + 8 + mapCount * 12 !== stsc.end) invalid()
    const maps = Array.from({ length: mapCount }, (_, i) => ({ first: u32(stsc.data + 8 + i * 12), count: u32(stsc.data + 12 + i * 12), description: u32(stsc.data + 16 + i * 12) }))
    if (maps[0].first !== 1 || maps.some((map, i) => !map.count || map.count > n || map.description !== 1 || map.first > chunkCount || i && map.first <= maps[i - 1].first)) invalid()
    let sample = 0, mapAt = 0
    for (let i = 0; i < chunkCount; i++) {
      if (mapAt + 1 < maps.length && maps[mapAt + 1].first === i + 1) mapAt++
      let offset = chunkBytes === 8 ? u64(chunks.data + 8 + i * 8) : u32(chunks.data + 8 + i * 4)
      for (let j = 0; j < maps[mapAt].count; j++) {
        const size = sizes[sample++]
        inspectedBytes += size
        if (!size || inspectedBytes > bytes.length || !containsSample(offset, size)) invalid()
        if (video) {
          let at = offset
          while (at < offset + size) { const length = u32(at); at += 4; if (!length || at + length > offset + size || !(bytes[at] & 31) || (bytes[at] & 31) > 23) invalid(); at += length }
          if (at !== offset + size) invalid()
        }
        offset += size
      }
    }
    if (sample !== n) invalid()
  }
  if (videoTracks !== 1) invalid()
  return { kind: 'video', mime: 'video/mp4', duration: actualDuration, width, height, size: bytes.byteLength }
}

export async function readMediaBytes(request, max = COMMUNITY_MEDIA_LIMIT) {
  if (Number(request.headers.get('content-length')) > max) throw Object.assign(new Error('附件过大，图片最多 500KB，视频最多 4MB'), { code: 'too_large', status: 413 })
  const reader = request.body?.getReader()
  if (!reader) invalid('请选择附件')
  const chunks = []; let size = 0
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > max) { reader.cancel().catch(() => {}); throw Object.assign(new Error('附件超过 4MB，请压缩后发送'), { code: 'too_large', status: 413 }) } chunks.push(part.value) }
  } finally { reader.releaseLock() }
  const result = new Uint8Array(size); let at = 0
  for (const chunk of chunks) { result.set(chunk, at); at += chunk.byteLength }
  return result
}
