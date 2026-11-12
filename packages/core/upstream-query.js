// Transport/query failures describe the observation, never the physical machine.
export function upstreamQueryFailure(value) {
  if (!value || typeof value !== 'object') return null
  const source = value.upstreamQuery && typeof value.upstreamQuery === 'object' ? value.upstreamQuery : value
  for (const key of ['httpStatus', 'queryStatus', 'upstreamStatus', 'fetchStatus']) {
    const status = Number(source[key])
    if (Number.isInteger(status) && status >= 400 && status <= 599) return status
  }
  const match = String(source.error || '').match(/\bHAIER HTTP (\d{3})\b/)
  if (match) return Number(match[1])
  return source.queryFailed === true || source.querySucceeded === false || source.ok === false ? 0 : null
}
