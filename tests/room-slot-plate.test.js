import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import {createSlotPlate} from '../frontend/src/room/slotPlate.js'
import {machineSlot} from '../frontend/src/machineSlot.js'
test('physical numbers are derived exclusively from the administrator slot mapping',()=>{
 assert.equal(machineSlot({'1':'upstream-other','D2':'dryer-id'},'dryer-id'),'D2')
 assert.equal(machineSlot({'1':'upstream-other'},'1'),'')
 assert.equal(machineSlot({'88':'bad-slot'},'bad-slot'),'')
})
test('both rows have a readable front face beyond the control panel, above the door, without floating text or z-fighting',()=>{
 for(const facing of [-1,1])for(const no of ['1','D2']){
  const painted=[],ctx={fillRect(){},strokeRect(){},fillText(...args){painted.push(args)}}
  const canvas={getContext:()=>ctx},bodyHeight=no==='D2'?1.02:.95
  const {plate,tex}=createSlotPlate(no,{facing,bodyHeight,canvas})
  plate.updateMatrixWorld(true)
  assert.equal(painted[0][0],no)
  assert.ok(Math.abs(plate.position.x)>.323)
  assert.ok(plate.position.y+.05<bodyHeight,'number is attached below cabinet top')
  assert.ok(plate.position.y-.05>.765,'number clears door motion')
  const normal=new THREE.Vector3(0,0,1).applyEuler(plate.rotation)
  assert.ok(normal.x*facing>.99)
  const ray=new THREE.Raycaster(new THREE.Vector3(facing,plate.position.y,plate.position.z),new THREE.Vector3(-facing,0,0))
  assert.ok(ray.intersectObject(plate).length>0,'number remains a clickable face from the aisle')
  assert.equal(plate.isSprite,undefined)
  plate.geometry.dispose();plate.material.dispose();tex.dispose()
 }
})
