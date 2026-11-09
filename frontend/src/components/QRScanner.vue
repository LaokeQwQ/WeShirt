<template><div class="scanner"><van-button size="small" :loading="busy" @click="start">{{stream?'停止扫描':'相机扫码'}}</van-button><label class="scan-file">从图片识别<input type="file" accept="image/*" @change="file" /></label><video v-show="stream" ref="video" muted playsinline /><p v-if="error" role="status">{{error}}</p></div></template>
<script setup>
import { ref,onUnmounted,nextTick } from 'vue'
import jsQR from 'jsqr'
const emit=defineEmits(['result'])
const video=ref(null),stream=ref(null),busy=ref(false),error=ref('')
let frame,tick=0
function stop(){cancelAnimationFrame(frame);stream.value?.getTracks().forEach(t=>t.stop());stream.value=null}
function decode(source,width,height){const scale=Math.min(1,800/Math.max(width,height));const canvas=document.createElement('canvas');canvas.width=Math.round(width*scale);canvas.height=Math.round(height*scale);const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(source,0,0,canvas.width,canvas.height);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);return jsQR(pixels.data,pixels.width,pixels.height,{inversionAttempts:'dontInvert'})?.data}
function detected(value){if(!value)return false;stop();emit('result',value);return true}
function loop(time){if(!stream.value)return;if(time-tick>300&&video.value?.readyState>=2){tick=time;try{if(detected(decode(video.value,video.value.videoWidth,video.value.videoHeight)))return}catch{}}frame=requestAnimationFrame(loop)}
async function start(){if(stream.value){stop();return}busy.value=true;error.value='';try{if(!navigator.mediaDevices?.getUserMedia)throw new Error('此浏览器无法使用相机，请从二维码图片识别');stream.value=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'},audio:false});await nextTick();video.value.srcObject=stream.value;await video.value.play();frame=requestAnimationFrame(loop)}catch(e){stop();error.value=e.name==='NotAllowedError'?'相机权限未开启，可从图片识别':e.message}finally{busy.value=false}}
async function file(e){const f=e.target.files?.[0];e.target.value='';if(!f)return;if(f.size>10000000){error.value='图片请小于10MB';return}busy.value=true;error.value='';let bitmap;try{bitmap=await createImageBitmap(f);if(!detected(decode(bitmap,bitmap.width,bitmap.height)))error.value='未识别到二维码，请选择清晰完整的图片'}catch{error.value='图片读取失败，可粘贴邀请链接'}finally{bitmap?.close();busy.value=false}}
onUnmounted(stop)
</script>
<style scoped>.scanner{margin:12px 0}.scanner video{display:block;width:100%;max-height:300px;border-radius:12px;margin-top:10px}.scan-file{display:inline-block;border:1px solid var(--border);border-radius:6px;padding:6px 10px;margin-left:8px;font-size:12px;cursor:pointer}.scan-file input{display:none}.scanner p{font-size:12px;color:#fbbf24}</style>
