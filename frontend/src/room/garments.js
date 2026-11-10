import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// 简单轮廓保留袖子、领口、裤腿。无逐顶点模拟，所有机位共享几何。
const outlines = {
  shirt: [[-.27,.53],[-.58,.42],[-.79,.12],[-.55,-.04],[-.4,.16],[-.4,-.53],[.4,-.53],[.4,.16],[.55,-.04],[.79,.12],[.58,.42],[.27,.53],[.18,.35],[0,.29],[-.18,.35]],
  trousers: [[-.39,.53],[-.44,-.5],[-.1,-.54],[0,.1],[.1,-.54],[.44,-.5],[.39,.53]],
}
export function createGarmentGeometry(kind = 'shirt') {
  const points = outlines[kind] || outlines.shirt
  const shape = new THREE.Shape(points.map(([x,y]) => new THREE.Vector2(x,y)))
  const geometry = new THREE.ShapeGeometry(shape)
  const position = geometry.attributes.position
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i)
    position.setZ(i, Math.sin(x * 5) * .035 + Math.sin(y * 4) * .02)
  }
  geometry.computeVertexNormals()
  geometry.name = `garment-${kind}`
  return geometry
}

export function createGarmentAssets() {
  const shirt = createGarmentGeometry('shirt'), trousers = createGarmentGeometry('trousers')
  const material = new THREE.MeshStandardMaterial({ roughness: .94, side: THREE.DoubleSide, vertexColors: true })
  // 三件衣物合为一次绘制；领口背后留空，避免轮廓重叠成碎片。
  const pieces = [
    { geometry: trousers, color: 0x537ba6, at: [-.31,-.31,-.035], scale: [.7,.85,.65], angle: -.35 },
    { geometry: shirt, color: 0xc68a7e, at: [.4,-.1,-.018], scale: [.6,.7,.7], angle: .45 },
    { geometry: shirt, color: 0xf0eee4, at: [0,.12,.045], scale: [1.05,1.05,.75], angle: -.12 },
  ]
  const geometries = pieces.map(piece => {
    const geometry = piece.geometry.index ? piece.geometry.toNonIndexed() : piece.geometry.clone()
    const transform = new THREE.Matrix4().compose(new THREE.Vector3(...piece.at),new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),piece.angle),new THREE.Vector3(...piece.scale))
    geometry.applyMatrix4(transform)
    const color = new THREE.Color(piece.color), colors = new Float32Array(geometry.attributes.position.count * 3)
    for (let i=0;i<colors.length;i+=3) { colors[i]=color.r; colors[i+1]=color.g; colors[i+2]=color.b }
    geometry.setAttribute('color',new THREE.BufferAttribute(colors,3))
    return geometry
  })
  const pile = mergeGeometries(geometries)
  pile.name = 'garment-pile'
  for (const geometry of geometries) geometry.dispose()
  return { shirt, trousers, pile, material, geometries: [shirt,trousers,pile] }
}

export function makeGarmentPile(assets, radius, facing) {
  const mesh = new THREE.Mesh(assets.pile,assets.material)
  mesh.scale.setScalar(radius * 1.25)
  mesh.rotation.y = facing * Math.PI / 2
  return mesh
}
