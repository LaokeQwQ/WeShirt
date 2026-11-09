import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { mergeStaticEnvironment, disposeObjectResources } from '../frontend/src/room/resources.js'

test('共享材质的环境细节合为一次绘制，几何世界位置保持不变', () => {
  const scene = new THREE.Scene()
  const group = new THREE.Group(); group.position.x = 10; scene.add(group)
  const material = new THREE.MeshStandardMaterial()
  const geometry = new THREE.BoxGeometry(1, 1, 1)
  for (const x of [0, 2, 4]) { const mesh = new THREE.Mesh(geometry, material); mesh.position.x = x; group.add(mesh) }
  assert.equal(mergeStaticEnvironment(scene), 2)
  const batch = scene.children.find((object) => object.name === 'static-environment-batch')
  batch.geometry.computeBoundingBox()
  assert.equal(batch.geometry.boundingBox.min.x, 9.5)
  assert.equal(batch.geometry.boundingBox.max.x, 14.5)
  assert.equal(group.children.length, 0)
  disposeObjectResources(scene)
})

test('窗扇、交互目标及透明玻璃不被合并，仍能独立活动和拾取', () => {
  const scene = new THREE.Scene()
  const dynamic = new THREE.Group(); scene.add(dynamic)
  const material = new THREE.MeshStandardMaterial()
  const geometry = new THREE.BoxGeometry()
  const targets = []
  for (let i = 0; i < 3; i++) { const mesh = new THREE.Mesh(geometry, material); dynamic.add(mesh); targets.push(mesh) }
  const glass = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.5 })); scene.add(glass)
  assert.equal(mergeStaticEnvironment(scene, [dynamic, targets[0]]), 0)
  assert.equal(dynamic.children.length, 3)
  assert.equal(glass.parent, scene)
  dynamic.rotation.y = 0.8
  assert.equal(targets[0].parent, dynamic)
  disposeObjectResources(scene)
})

test('共享几何、材质和纹理只释放一次，动态阴影也释放', () => {
  const scene = new THREE.Scene()
  const geometry = new THREE.BoxGeometry()
  const texture = new THREE.Texture()
  const material = new THREE.MeshStandardMaterial({ map: texture })
  let geometries = 0, materials = 0, textures = 0, shadows = 0
  geometry.addEventListener('dispose', () => geometries++)
  material.addEventListener('dispose', () => materials++)
  texture.addEventListener('dispose', () => textures++)
  scene.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material))
  const light = new THREE.DirectionalLight(); light.shadow.dispose = () => shadows++; scene.add(light)
  disposeObjectResources(scene, [geometry], [material])
  assert.deepEqual([geometries, materials, textures, shadows], [1, 1, 1, 1])
})

test('移除排队道具时保留其他机位仍在用的共享衣物材质', () => {
  const group = new THREE.Group()
  const shared = new THREE.MeshStandardMaterial()
  const local = new THREE.MeshStandardMaterial()
  let sharedDisposals = 0, localDisposals = 0
  shared.addEventListener('dispose', () => sharedDisposals++)
  local.addEventListener('dispose', () => localDisposals++)
  group.add(new THREE.Mesh(new THREE.BoxGeometry(), shared), new THREE.Mesh(new THREE.BoxGeometry(), local))
  disposeObjectResources(group, [], [], [shared])
  assert.equal(sharedDisposals, 0)
  assert.equal(localDisposals, 1)
  shared.dispose()
})
