const version = document.querySelector('#version')
const download = document.querySelector('#download')

async function loadRelease() {
  try {
    const response = await fetch('./latest.json', { cache: 'no-store', redirect: 'error' })
    if (!response.ok) throw new Error()
    const release = await response.json()
    const { versionCode, versionName, size } = release
    if (!Number.isSafeInteger(versionCode) || versionCode <= 0 ||
        typeof versionName !== 'string' || !/^\d+(?:\.\d+){1,3}$/.test(versionName) ||
        !Number.isSafeInteger(size) || size <= 0) throw new Error()
    const name = 'WeShirt-v' + versionName + '-build' + versionCode + '.apk'
    download.href = './' + name
    download.download = name
    version.textContent = 'v' + versionName + ' · Build ' + versionCode + ' · ' + (size / (1024 * 1024)).toFixed(1) + ' MB'
    download.hidden = false
  } catch {
    version.textContent = '暂时无法读取发行版本，刷新页面后重试。'
  }
}

loadRelease()
