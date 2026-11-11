import { api } from './api'
import { createBoardQuery } from './boardQueryCore'
export { filterDormFloors } from '../../packages/core/buildings.js'
export { boardAgeMinutes } from './boardQueryCore'

// 统一走包含机位类型、估时、人工故障修正的公开看板，避免两套语义互相覆盖。
export const loadBoard = createBoardQuery(api)
