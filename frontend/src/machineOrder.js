export function sortByAvailability(list, now=Date.now()) {
  const rank=(m)=>{
    if(m.state==='idle'&&!m.suspectedUncollected)return [0,0]
    const end=Date.parse(m.finishAt||'')
    if(m.state==='occupied'&&Number.isFinite(end)&&end>now)return [1,end]
    if(m.suspectedUncollected||m.state==='occupied'||m.state==='abnormal')return [2,Infinity]
    return [m.state==='faulty'?4:3,Infinity]
  }
  return [...list].sort((a,b)=>{const x=rank(a),y=rank(b);return x[0]-y[0]||(Number.isFinite(x[1]-y[1])?x[1]-y[1]:0)||String(a.displayName||a.name||a.id).localeCompare(String(b.displayName||b.name||b.id),'zh-CN',{numeric:true})})
}
