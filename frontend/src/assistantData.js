import { api } from './api'
import { createAssistantResourceCache } from './assistantResourceCache'

export const assistantData = createAssistantResourceCache({
  request: key => api('/api/assistant/' + key, { silent: true, retry: false }),
})
