/* Barefoot Ventilator Control Lab v1.0 · entirely client-side · no dependencies. */
'use strict';
const $ = id => document.getElementById(id);
const cl = (x,a,b) => Math.max(a,Math.min(b,x));
const fmt = (x,d=1) => Number(x).toFixed(d);
const DURATION = 32;
const PEEP = 5;
const examples = {
  pi_ff: `// PI controller + model-based feedforward\n// Return ABSOLUTE airway pressure (cmH2O).\nfunction init() {\n  memory.integral = 0;\n}\n\nfunction controller() {\n  const e = state.target.volume - state.volume;\n  const Kp = 16;  // cmH2O per L\n  const Ki = 5;   // cmH2O per (L*s)\n\n  // Ideal pressure for the desired V and Vdot:\n  const feedforward = params.peep\n    + state.target.volume / params.compliance\n    + params.resistance * state.target.flow;\n\n  const raw = feedforward + Kp*e + Ki*memory.integral;\n  const pressure = Math.max(params.peep,\n                     Math.min(params.maxPressure, raw));\n\n  // Conditional integration (simple anti-windup).\n  if ((raw === pressure) ||\n      (raw > pressure && e < 0) ||\n      (raw < pressure && e > 0)) {\n    memory.integral += e * params.dt;\n  }\n  return pressure;\n}`,
  starter: `// Starter: edit controller() to track V_ref(t).\nfunction init() {\n  memory.integral = 0;\n}\n\nfunction controller() {\n  const error = state.target.volume - state.volume;\n  // TODO: calculate pressure from the error.\n  // Output is absolute pressure, not a PWM percentage.\n  return params.peep;\n}`,
  p: `// Simple proportional controller with elastic offset.\nfunction init() {\n  // No memory is needed for a P controller.\n}\n\nfunction controller() {\n  const e = state.target.volume - state.volume;\n  const Kp = 35; // cmH2O per L\n  return params.peep + Kp * e;\n}`,
  pi: `// PI control with simple conditional anti-windup.\nfunction init() {\n  memory.integral = 0;\n}\n\nfunction controller() {\n  const e = state.target.volume - state.volume;\n  const Kp = 35, Ki = 20;\n  const raw = params.peep + Kp*e + Ki*memory.integral;\n  const pressure = Math.max(params.peep,\n                     Math.min(params.maxPressure, raw));\n  if ((raw === pressure) ||\n      (raw > pressure && e < 0) ||\n      (raw < pressure && e > 0)) {\n    memory.integral += e * params.dt;\n  }\n  return pressure;\n}`,
  ff: `// Model-based feedforward (no feedback correction).\nfunction init() {}\n\nfunction controller() {\n  return params.peep\n    + state.target.volume / params.compliance\n    + params.resistance * state.target.flow;\n}`
};
const scenarioNotes = {
  baseline:'Baseline: C = 0.050 L/cmH₂O, R = 10 cmH₂O·s/L, PEEP = 5 cmH₂O. Experiment length: 32 seconds.',
  stiff:'At t = 12 s, lung compliance drops from 0.050 to 0.025 L/cmH₂O. The lung requires more pressure for the same volume.',
  resistant:'At t = 12 s, airway resistance rises from 10 to 22 cmH₂O·s/L. Inspiration and passive expiration become slower.',
  limited:'Pressure ceiling is restricted to 12 cmH₂O (PEEP = 5), regardless of the selector. A 500 mL target is unreachable at steady state.'
};
let results=null, activeIndex=0, playing=false, playbackTime=0, lastFrame=0, lastPlotFrame=0, worker=null, workerTimeout=null, dirty=true, serial=0;
let currentCode='';
function setStatus(text, mode='ok') { $('statusText').textContent=text; $('statusDot').className=mode; }
function setMessage(text, kind='') { const m=$('message'); m.textContent=text; m.className='code-message '+kind; }
function configFromUI() { return {dt:Number($('dtSelect').value), tidalVolume:Number($('tidalInput').value), bpm:Number($('bpmInput').value), inspirationFraction:Number($('inspInput').value), maxPressure:Number($('maxPressureSelect').value), scenario:$('scenarioSelect').value}; }
function updateSettings() { $('tidalOutput').textContent=Math.round(Number($('tidalInput').value)*1000)+' mL'; $('bpmOutput').textContent=$('bpmInput').value+' /min'; $('inspOutput').textContent=Math.round(Number($('inspInput').value)*100)+'%'; $('scenarioNote').textContent=scenarioNotes[$('scenarioSelect').value]; dirty=true; if(results) setMessage('Experiment settings changed. Press Run or Apply & reset.', ''); }
function setCode(source) { $('codeEditor').value=source; updateLines(); dirty=true; }
function updateLines() { const area=$('codeEditor'); const n=area.value.split('\n').length; $('lineNumbers').textContent=Array.from({length:n},(_,i)=>i+1).join('\n'); }
function configInputs(disable) { for(const id of ['scenarioSelect','tidalInput','bpmInput','inspInput','dtSelect','maxPressureSelect','applyBtn']) $(id).disabled=disable; }
function stopWorker() { if(worker){worker.terminate();worker=null;} if(workerTimeout){clearTimeout(workerTimeout);workerTimeout=null;} }
function simulate(autoplay=false) {
  playing=false;
  stopWorker();
  const code=$('codeEditor').value;
  currentCode=code;
  results=null; activeIndex=0; playbackTime=0;
  updateFrame();
  configInputs(true); setStatus('Compiling controller…','running'); setMessage('Running a 32-second simulation in an isolated Web Worker…','');
  const thisRun=++serial;
  try { worker = new Worker('./sim-worker.js?v=1.0.0'); }
  catch(e) { configInputs(false); setStatus('Worker unavailable','error'); setMessage('The simulation worker could not start. Serve the folder with python3 -m http.server 8000. '+e.message,'error'); return; }
  const w = worker;
  workerTimeout=setTimeout(()=>{
    if(thisRun!==serial)return;
    stopWorker(); configInputs(false); setStatus('Timed out','error');
    setMessage('Controller exceeded 5 seconds. Check for infinite loops or excessive computation.','error');
  },5000);
  w.onerror = event => {
    if(thisRun!==serial)return;
    stopWorker();configInputs(false);setStatus('Worker error','error');setMessage('Worker failed: '+(event.message||'unknown browser error'),'error');
  };
  w.onmessage = event => {
    if(thisRun!==serial)return;
    const msg=event.data;
    stopWorker();configInputs(false);
    if(msg.type==='error') { setStatus('Controller error','error');setMessage(msg.message,'error');return; }
    if(msg.type!=='result')return;
    results=msg;activeIndex=0;playbackTime=0;dirty=false;
    $('rmseRead').textContent=fmt(msg.stats.rmse*1000,1)+' mL';
    $('satRead').textContent=fmt(msg.stats.saturationPct,1)+'%';
    $('callsRead').textContent=msg.stats.calls.toLocaleString();
    setStatus(autoplay?'Simulating':'Ready to run',autoplay?'running':'ok');
    setMessage(`Compiled successfully. ${msg.stats.calls} controller calls at Tₛ = ${fmt(msg.config.dt*1000,0)} ms. ${autoplay?'Playing now.':'Press Run to animate.'}`,'good');
    updateFrame(true);
    if(autoplay){playing=true;lastFrame=0;requestAnimationFrame(animate);}
  };
  w.postMessage({type:'simulate',code,config:configFromUI()});
}
function animate(now){
  if(!playing || !results)return;
  if(!lastFrame)lastFrame=now;
  const seconds=Math.min(.12,Math.max(0,(now-lastFrame)/1000));lastFrame=now;
  playbackTime=Math.min(DURATION,playbackTime+seconds*Number($('speedSelect').value));
  activeIndex=Math.min(results.samples.length-1,Math.floor((playbackTime+1e-8)/results.config.dt));
  if(now-lastPlotFrame>30 || playbackTime>=DURATION){updateFrame(true);lastPlotFrame=now;}else updateFrame(false);
  if(playbackTime>=DURATION){playing=false;setStatus('Complete','ok');return;}
  requestAnimationFrame(animate);
}
function getSample(){return results?results.samples[activeIndex]:{t:0,volume:0,target:0,pressure:PEEP,flow:0,compliance:.05,resistance:10,maxPressure:25,phase:'inspiration',saturated:false};}
function updateFrame(draw=true){
  const s=getSample(), config=results?.config || configFromUI();
  const period=60/config.bpm;
  $('statVolume').textContent=fmt(s.volume*1000,0);$('statTarget').textContent=fmt(s.target*1000,0);
  $('statPressure').textContent=fmt(s.pressure,1);$('statFlow').textContent=(s.flow>=0?'+':'')+fmt(s.flow,2);
  $('stageVolume').textContent=fmt(s.volume*1000,0);$('stageTarget').textContent=fmt(s.target*1000,0);
  $('stageTime').textContent=fmt(s.t,2)+' s';
  $('breathCount').textContent=(s.t===0?1:Math.min(Math.floor((s.t+1e-7)/period)+1,Math.ceil(DURATION/period)))+' / '+Math.ceil(DURATION/period);
  const phase=s.phase==='inspiration'; $('phaseText').textContent=phase?'Inspiration':'Expiration';
  $('phasePill').textContent=results?(phase?'INSPIRATION':'EXPIRATION'):'READY';
  $('phasePill').style.color=phase?'#087f7b':'#8a5bc1';
  $('readCompliance').textContent=fmt(s.compliance,3);$('readResistance').textContent=fmt(s.resistance,1);$('readTau').textContent=fmt(s.compliance*s.resistance,2);$('readLimit').textContent=fmt(s.maxPressure,1);
  const frac=cl(s.volume/.75,0,1), tgt=cl(s.target/.75,0,1);
  $('fillVolume').style.width=fmt(frac*100,2)+'%';$('targetTick').style.left=fmt(tgt*100,2)+'%';
  const scale=.89+frac*.24;
  $('lungLeft').style.transform=`scale(${scale}, ${scale})`;
  $('lungRight').style.transform=`scale(${scale}, ${scale})`;
  $('diaphragm').style.transform=`translateY(${frac*12}px)`;
  const msg=s.saturated?'Command reached a pressure limit.':s.phase==='expiration'?'Expiration can be passive at PEEP.':'The airway pressure is held between controller samples.';
  $('pressureNote').textContent=msg;$('pressureNote').classList.toggle('alert',s.saturated);
  $('timelineLabel').textContent=fmt(s.t,1)+' / '+fmt(DURATION,1)+' s';$('timelineFill').style.width=fmt(s.t/DURATION*100,2)+'%';
  if(draw)drawAllCharts();
}
function niceNumber(x){const p=Math.pow(10,Math.floor(Math.log10(Math.abs(x)||1)));const d=x/p;return(d<=1?1:d<=2?2:d<=5?5:10)*p;}
function drawPlot(id, curves, yMin,yMax,unit,zero=false) {
  const can=$(id);if(!can)return;
  const ratio=Math.min(2,window.devicePixelRatio||1);const bounds=can.getBoundingClientRect();const width=bounds.width||500,height=bounds.height||180;
  const pxW=Math.round(width*ratio),pxH=Math.round(height*ratio);
  if(can.width!==pxW||can.height!==pxH){can.width=pxW;can.height=pxH;}
  const ctx=can.getContext('2d');ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,width,height);
  const p={left:51,right:13,top:13,bottom:28};const innerW=width-p.left-p.right,innerH=height-p.top-p.bottom;
  const X=t=>p.left+(t/DURATION)*innerW;const Y=v=>p.top+(yMax-v)/(yMax-yMin)*innerH;
  ctx.font='10px ui-sans-serif,system-ui,sans-serif';ctx.textBaseline='middle';
  for(let i=0;i<=4;i++){const v=yMin+(yMax-yMin)*i/4,y=Y(v);ctx.beginPath();ctx.moveTo(p.left,y);ctx.lineTo(width-p.right,y);ctx.strokeStyle=(zero&&Math.abs(v)<1e-10)?'#bccbd4':'#e9eef2';ctx.lineWidth=1;ctx.stroke();ctx.fillStyle='#8795a5';ctx.textAlign='right';ctx.fillText((Math.abs(v)>=10?fmt(v,0):fmt(v,1)),p.left-8,y);}
  ctx.textBaseline='top';ctx.textAlign='center';
  for(let i=0;i<=8;i++){const t=i*4,x=X(t);ctx.beginPath();ctx.moveTo(x,p.top);ctx.lineTo(x,height-p.bottom);ctx.strokeStyle='#f0f3f5';ctx.stroke();ctx.fillStyle='#8290a0';ctx.fillText(String(t),x,height-p.bottom+7);}
  ctx.fillStyle='#98a4b0';ctx.textAlign='right';ctx.fillText('s',width-5,height-15);
  if(results){
    const n=Math.max(1,activeIndex),samples=results.samples;
    for(const curve of curves){ctx.beginPath();ctx.lineWidth=curve.width||2;ctx.strokeStyle=curve.color;ctx.lineJoin='round';ctx.lineCap='round';
      if(curve.dash)ctx.setLineDash(curve.dash);else ctx.setLineDash([]);
      let started=false;
      // Render visible sample stream up to current time, decimating only if needed.
      const stride=Math.max(1,Math.floor(n/1800));
      for(let i=0;i<=n;i+=stride){const row=samples[i],v=curve.val(row),x=X(row.t),y=Y(cl(v,yMin-(yMax-yMin),yMax+(yMax-yMin)));
        if(!started){ctx.moveTo(x,y);started=true;}else ctx.lineTo(x,y);
      }
      if(n%stride){const row=samples[n];ctx.lineTo(X(row.t),Y(curve.val(row)));}
      ctx.stroke();ctx.setLineDash([]);
    }
    if(activeIndex>0){const x=X(samples[activeIndex].t);ctx.beginPath();ctx.strokeStyle='#879cb2';ctx.lineWidth=1;ctx.setLineDash([3,4]);ctx.moveTo(x,p.top);ctx.lineTo(x,height-p.bottom);ctx.stroke();ctx.setLineDash([]);}
  }
}
function drawAllCharts(){
  const maxPressure=results?.config?.scenario==='limited'?12:Number($('maxPressureSelect').value);
  drawPlot('volumeChart',[
    {color:'#e39a4e',val:r=>r.target*1000,width:2,dash:[5,4]},
    {color:'#3276d2',val:r=>r.volume*1000,width:2.5}],0,800,'mL');
  drawPlot('pressureChart',[
    {color:'#a4b3bf',val:()=>PEEP,width:1.2,dash:[4,4]},
    {color:'#df6b72',val:()=>maxPressure,width:1.1,dash:[5,5]},
    {color:'#7865d6',val:r=>r.pressure,width:2.4}],0,32,'cmH2O');
  drawPlot('flowChart',[{color:'#0e9994',val:r=>r.flow,width:2.4}],-1.2,1.2,'L/s',true);
}
function runButton(){ if(dirty||!results){simulate(true);return;} if(activeIndex>=results.samples.length-1){activeIndex=0;playbackTime=0;} if(!playing){playing=true;lastFrame=0;setStatus('Simulating','running');requestAnimationFrame(animate);} }
function pause(){playing=false;setStatus(results?'Paused':'Ready', 'ok');}
function step(){if(dirty||!results){simulate(false);return;}playing=false;activeIndex=Math.min(results.samples.length-1,activeIndex+1);playbackTime=results.samples[activeIndex].t;updateFrame(true);setStatus('Paused','ok');}
function reset(){playing=false;activeIndex=0;playbackTime=0;lastFrame=0;if(dirty){simulate(false);return;}updateFrame(true);setStatus('Ready','ok');}
function end(){if(dirty||!results){simulate(false);return;}playing=false;activeIndex=results.samples.length-1;playbackTime=DURATION;updateFrame(true);setStatus('Complete','ok');}
function saveBlob(blob,name){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function csv(){if(!results){setMessage('Run the experiment before exporting a CSV.');return;}
  const header=['time_s','volume_L','target_L','error_L','flow_L_per_s','target_flow_L_per_s','airway_pressure_cmH2O','compliance_L_per_cmH2O','resistance_cmH2O_s_per_L','max_pressure_cmH2O','phase','saturated'];
  const rows=results.samples.map(r=>[r.t,r.volume,r.target,r.error,r.flow,r.targetFlow,r.pressure,r.compliance,r.resistance,r.maxPressure,r.phase,r.saturated?1:0].join(','));
  saveBlob(new Blob([[header.join(','),...rows].join('\n')+'\n'],{type:'text/csv;charset=utf-8'}),'ventilator_control_'+results.config.scenario+'.csv');
}
function savePlots(){if(!results){setMessage('Run the experiment before saving plots.');return;}
  const plots=['volumeChart','pressureChart','flowChart'];const merged=document.createElement('canvas');const width=1200,height=720;merged.width=width;merged.height=height;
  const ctx=merged.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);ctx.fillStyle='#102235';ctx.font='bold 25px system-ui';ctx.fillText('Barefoot Ventilator Lab · '+results.config.scenario,30,35);
  const labels=['Lung volume (mL)','Airway pressure (cmH2O)','Airflow (L/s)'];
  plots.forEach((id,i)=>{ctx.fillStyle='#32495b';ctx.font='bold 15px system-ui';ctx.fillText(labels[i],35,65+220*i);ctx.drawImage($(id),0,0,$(id).width,$(id).height,30,80+220*i,1130,170);});
  merged.toBlob(blob=>blob&&saveBlob(blob,'ventilator_plots.png'),'image/png');
}
$('codeEditor').addEventListener('input',()=>{updateLines();dirty=true;setMessage('Code changed. Press Apply & reset to test it.');});
$('codeEditor').addEventListener('scroll',()=>{$('lineNumbers').scrollTop=$('codeEditor').scrollTop;});
$('codeEditor').addEventListener('keydown',e=>{if(e.key==='Tab'){e.preventDefault();const el=$('codeEditor'),s=el.selectionStart;el.setRangeText('  ',s,el.selectionEnd,'end');updateLines();dirty=true;}});
$('restoreBtn').onclick=()=>{setCode(examples[$('exampleSelect').value]);setMessage('Example loaded. Press Apply & reset.');};
$('runBtn').onclick=runButton;$('pauseBtn').onclick=pause;$('stepBtn').onclick=step;$('resetBtn').onclick=reset;$('finishBtn').onclick=end;
$('applyBtn').onclick=()=>simulate(false);
$('downloadCodeBtn').onclick=()=>saveBlob(new Blob([$('codeEditor').value+'\n'],{type:'text/javascript'}),'ventilator_student_controller.js');
$('exportBtn').onclick=csv;$('exportPlotBtn').onclick=savePlots;
for(const id of ['scenarioSelect','tidalInput','bpmInput','inspInput','dtSelect','maxPressureSelect'])$(id).addEventListener('change',updateSettings);
for(const id of ['tidalInput','bpmInput','inspInput'])$(id).addEventListener('input',updateSettings);
let resizeTimer;window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(drawAllCharts,80);});
setCode(examples.pi_ff);updateSettings();setStatus('Ready','ok');updateFrame();simulate(false);
