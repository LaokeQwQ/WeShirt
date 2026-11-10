import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// 合批静态、不透明、共享材质的环境细节，保留交互对象及活动窗扇。
export function mergeStaticEnvironment(scene, excluded = [], { shareMaterials = false } = {}) {
  const exclusions = new Set(excluded.filter(Boolean))
  const groups = new Map()
  const materials = new Map()
  scene.updateMatrixWorld(true)
  scene.traverse((object) => {
    if (!object.isMesh || !object.visible || !object.geometry || Array.isArray(object.material) || object.material.transparent) return
    for (let ancestor = object; ancestor; ancestor = ancestor.parent) if (exclusions.has(ancestor) || !ancestor.visible) return
    // 仅静态对象复用完全相同的材质；状态灯、活动门等必须先排除。
    // toJSON 保留所有渲染属性与纹理身份，不能只按颜色错误合并。
    if (shareMaterials) {
      const properties = object.material.toJSON({ textures: {}, images: {} })
      delete properties.uuid; delete properties.name
      const signature = JSON.stringify(properties)
      const shared = materials.get(signature)
      if (shared && shared !== object.material) object.material = shared
      else materials.set(signature, object.material)
    }
    const attributes = Object.entries(object.geometry.attributes).map(([name, attr]) => `${name}:${attr.itemSize}`).sort().join(',')
    const key = `${object.material.uuid}:${attributes}:${object.castShadow}:${object.receiveShadow}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(object)
  })
  const detached = new Set()
  let savedCalls = 0
  for (const meshes of groups.values()) {
    if (meshes.length < 3) continue
    const parts = meshes.map((mesh) => {
      const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()
      geometry.applyMatrix4(mesh.matrixWorld)
      return geometry
    })
    const geometry = mergeGeometries(parts, false)
    for (const part of parts) part.dispose()
    if (!geometry) continue
    const batch = new THREE.Mesh(geometry, meshes[0].material)
    batch.name = 'static-environment-batch'
    batch.castShadow = meshes[0].castShadow
    batch.receiveShadow = meshes[0].receiveShadow
    scene.add(batch)
    for (const mesh of meshes) { detached.add(mesh.geometry); mesh.removeFromParent() }
    savedCalls += meshes.length - 1
  }
  scene.traverse((object) => detached.delete(object.geometry))
  for (const geometry of detached) geometry.dispose()
  return savedCalls
}

export function disposeObjectResources(root, extraGeometries = [], extraMaterials = [], retainedMaterials = [], retainedGeometries = []) {
  const retained = new Set(retainedMaterials)
  const keepGeometry = new Set(retainedGeometries)
  const geometries = new Set(extraGeometries.filter(Boolean))
  const materials = new Set(extraMaterials.filter(Boolean))
  const textures = new Set()
  root?.traverse((object) => {
    if (object.geometry && !keepGeometry.has(object.geometry)) geometries.add(object.geometry)
    if (object.isLight) object.shadow?.dispose()
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) if (material && !retained.has(material)) materials.add(material)
  })
  for (const material of materials) for (const value of Object.values(material)) if (value?.isTexture) textures.add(value)
  for (const geometry of geometries) geometry.dispose()
  for (const material of materials) material.dispose()
  for (const texture of textures) texture.dispose()
}
