// Local elapsed time only interpolates the last server deadline between polls.
export function platformNow(board, localNow = Date.now()) {
  const server = Date.parse(board?.freshness?.serverNow || '')
  const received = board?.freshness?.receivedAt
  return Number.isFinite(server) && Number.isFinite(received) ? server + Math.max(0, localNow - received) : localNow
}
