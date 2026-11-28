import { prepareCommunityFile } from './communityMedia'

export async function prepareAssistantPhoto(file) {
  if (!/^image\/(?:jpeg|png|webp|gif)$/.test(file.type)) throw new Error('请选择 JPEG、PNG、WebP 或 GIF 图片。')
  const photo = await prepareCommunityFile(file)
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string' && reader.result.startsWith('data:image/jpeg;base64,') && reader.result.length <= 1300000) resolve(reader.result)
      else reject(new Error('照片处理后仍过大，请选择较小的照片。'))
    }
    reader.onerror = () => reject(new Error('照片无法读取，请重试。'))
    reader.readAsDataURL(photo)
  })
}
