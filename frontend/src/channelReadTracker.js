// A read receipt lists only messages that remained on screen. There is no
// timestamp/watermark which could silently consume unseen older messages.
export function createChannelReadTracker({ context, visibleIds, send, onRead = () => {}, onError = () => {}, visible = () => true, delay = 450, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let epoch = 0, timer, disposed = false, active = '', sent = new Set(), inFlight = false
  const valid = value => value?.owner && value.channel && value.key
  function reset() { epoch++; clearTimer(timer); active='';sent=new Set();inFlight=false }
  function schedule() {
    clearTimer(timer)
    const view=context()
    if(disposed || !valid(view) || !visible())return
    if(active!==view.key){reset();active=view.key}
    if(inFlight)return
    const generation=epoch, candidates=new Set(visibleIds().filter(id=>!sent.has(id)))
    if(!candidates.size)return
    timer=setTimer(async()=>{
      if(disposed || generation!==epoch || context()?.key!==view.key || !visible())return
      const ids=visibleIds().filter(id=>candidates.has(id)&&!sent.has(id)).slice(0,50)
      if(!ids.length)return
      inFlight=true
      let accepted=false
      try {
        const result=await send({channel:view.channel,messageIds:ids},view)
        if(disposed || generation!==epoch || context()?.key!==view.key)return
        ids.forEach(id=>sent.add(id));accepted=true;onRead(result,view)
      } catch(error) { if(!disposed && generation===epoch && context()?.key===view.key)onError(error,view) }
      finally {if(generation===epoch){inFlight=false;if(accepted)schedule()}}
    },delay)
  }
  return {schedule,reset,pause(){clearTimer(timer)},dispose(){disposed=true;reset()}}
}

export function visibleChannelMessageIds(root,{top=0,bottom=globalThis.innerHeight||0}={}) {
  if(!root || bottom<=top)return []
  return [...root.querySelectorAll('[data-message-id]')].filter(node=>{
    const rect=node.getBoundingClientRect(),height=Math.min(rect.bottom,bottom)-Math.max(rect.top,top)
    return rect.width>0 && height>=Math.min(rect.height*.65,120) && height>0
  }).map(node=>node.dataset.messageId).filter(Boolean)
}
