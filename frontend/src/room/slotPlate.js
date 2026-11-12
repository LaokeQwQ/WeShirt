import * as THREE from 'three'

export function createSlotPlate(no,{facing=1,bodyHeight=.95,canvas=document.createElement('canvas')}={}) {
  canvas.width=512;canvas.height=256
  const ctx=canvas.getContext('2d')
  ctx.fillStyle='#e7eef3';ctx.fillRect(0,0,512,256)
  ctx.strokeStyle='#253a4c';ctx.lineWidth=18;ctx.strokeRect(9,9,494,238)
  ctx.fillStyle='#142a3c';ctx.font='800 188px ui-sans-serif,system-ui,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle'
  ctx.fillText(String(no),256,140,450)
  const tex=new THREE.CanvasTexture(canvas);tex.colorSpace=THREE.SRGBColorSpace
  tex.anisotropy=8
  const material=new THREE.MeshBasicMaterial({map:tex,toneMapped:false})
  const plate=new THREE.Mesh(new THREE.PlaneGeometry(.2,.1),material)
  // Control panel ends at |x|=.323. The face is 6 mm outside that
  // surface, above the door and fixed to the cabinet rather than a sprite.
  plate.position.set(facing*.329,bodyHeight-.11,-facing*.12)
  plate.rotation.y=facing*Math.PI/2
  plate.userData.machineNo=no;plate.name='machine-slot-'+no
  return {plate,canvas,tex}
}

