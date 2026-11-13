/** A test targets only this browser's existing subscription, without requesting consent. */
export async function currentWebPushTarget({ navigator = globalThis.navigator, Notification = globalThis.Notification, secure = globalThis.isSecureContext } = {}) {
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
  if (!secure || !navigator?.serviceWorker || !Notification) fail('unsupported', '当前环境不支持浏览器通知，请使用支持通知的浏览器；iPhone 请从添加到主屏幕的图标打开。')
  if (Notification.permission === 'denied') fail('denied', '通知权限已被阻止，请在浏览器的网站设置中允许通知，再开启 Web Push 订阅。')
  if (Notification.permission !== 'granted') fail('not_subscribed', '请先点击“开启通知”并允许通知，再测试当前浏览器。')
  const registration = await navigator.serviceWorker.getRegistration()
  const subscription = await registration?.pushManager?.getSubscription()
  if (!subscription?.endpoint) fail('not_subscribed', '当前浏览器还未订阅通知，请先点击“开启通知”。')
  return { channel: 'web', endpoint: subscription.endpoint }
}
