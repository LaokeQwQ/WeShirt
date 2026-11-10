import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { createGarmentGeometry, createGarmentAssets, makeGarmentPile } from '../frontend/src/room/garments.js'
import { roomDampingFactor } from '../frontend/src/room/motion.js'

function covers(geometry,x,y) {
  const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}))
  return new THREE.Raycaster(new THREE.Vector3(x,y,2),new THREE.Vector3(0,0,-1)).intersectObject(mesh).length>0
}
test('衣服有可辨认领口、两袖，裤子有独立裤腿而不是矩形平面',()=>{
  const shirt=createGarmentGeometry('shirt'),pants=createGarmentGeometry('trousers')
  assert.equal(covers(shirt,0,.47),false,'neck opening')
  assert.equal(covers(shirt,-.61,.17),true,'left sleeve')
  assert.equal(covers(shirt,.61,.17),true,'right sleeve')
  assert.equal(covers(shirt,0,-.35),true,'torso')
  assert.equal(covers(pants,0,-.35),false,'space between trouser legs')
  assert.equal(covers(pants,-.25,-.35),true)
  assert.equal(covers(pants,.25,-.35),true)
  assert.ok(shirt.index.count<60&&pants.index.count<30,'low polygon outlines')
  shirt.dispose();pants.dispose()
})
test('所有机位复用单件衣堆几何与材质，正对左右舱门并收在桶内',()=>{
  const assets=createGarmentAssets(),left=makeGarmentPile(assets,.15,1),right=makeGarmentPile(assets,.15,-1)
  assert.equal(left.geometry,right.geometry);assert.equal(left.material,right.material)
  assert.ok(assets.pile.attributes.position.count<120,'three garments remain under120 vertices')
  assert.ok(assets.pile.attributes.color.count>0)
  for(const mesh of [left,right]){mesh.updateMatrixWorld();const bounds=new THREE.Box3().setFromObject(mesh);assert.ok(bounds.max.x-bounds.min.x<.03,'shallow pile fits door cavity');assert.ok(bounds.max.y-bounds.min.y<.3)}
  const normal=new THREE.Vector3(0,0,1).applyEuler(left.rotation)
  assert.ok(normal.x>.99)
  for(const geometry of assets.geometries)geometry.dispose();assets.material.dispose()
})
test('按时间换算阻尼，在30/60fps同样迅速停止拖尾，拖动直接响应',()=>{
  const at60=Math.pow(1-roomDampingFactor(1/60),60*.5)
  const at30=Math.pow(1-roomDampingFactor(1/30),30*.5)
  assert.ok(Math.abs(at60-at30)<1e-10)
  assert.ok(at30<.002,'settled within half a second')
  assert.ok(roomDampingFactor(1/60,true)>.4,'gesture starts without long easing delay')
  assert.ok(roomDampingFactor(Infinity)>0&&roomDampingFactor(Infinity)<1)
})
