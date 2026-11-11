// The room sits below optional account/building bars. Use the visible viewport,
// including keyboard changes, instead of subtracting a fixed header guess.
export function availableRoomHeight({ pageTop = 0, viewportHeight = 0, viewportTop = 0, tabbarTop } = {}) {
  const top = Number.isFinite(pageTop) ? pageTop : 0
  const visibleTop = Number.isFinite(viewportTop) ? Math.max(0, viewportTop) : 0
  const height = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0
  const bottom = visibleTop + height
  const availableBottom = Number.isFinite(tabbarTop) && tabbarTop > top && tabbarTop <= bottom ? tabbarTop : bottom
  return Math.max(0, Math.floor(availableBottom - top))
}
