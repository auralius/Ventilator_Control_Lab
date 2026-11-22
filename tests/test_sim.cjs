'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const js=fs.readFileSync(require('node:path').join(__dirname,'../sim-worker.js'),'utf8');
let tests=0;
function simulate(code,opts={}) {
  let response;
  const context={self:{postMessage:(m)=>{response=m;}},console,Math,Number,Error,Object,Array,Date,String,Set};
  vm.runInNewContext(js,context,{filename:'sim-worker.js',timeout:5000});
  context.self.onmessage({data:{type:'simulate',code,config:{dt:.02, tidalVolume:.5,bpm:15,inspirationFraction:.35,maxPressure:25,scenario:'baseline',...opts}}});
  return response;
}
function test(name,fn){fn();tests++;console.log('✓',name);}
const at=(r,t)=>r.samples[Math.round(t/r.config.dt)];
test('exact ZOH pressure step at 15 cmH2O',()=>{
  const r=simulate('function controller(){return 15;}');
  assert.equal(r.type,'result');
  for(const t of [.02,.2,.5,1,4,12,32]) assert.ok(Math.abs(at(r,t).volume-.5*(1-Math.exp(-t/.5)))<1e-9,'t='+t);
  assert.equal(r.stats.calls,1600);
});
test('at PEEP there is no inflation',()=>{const r=simulate('function controller(){return params.peep;}');assert.equal(r.type,'result');assert.equal(at(r,32).volume,0);});
test('out-of-bounds pressure clips to ceiling and exports saturation',()=>{const r=simulate('function controller(){return 200;}',{scenario:'limited'});assert.equal(r.type,'result');assert.ok(Math.abs(at(r,16).volume-.35)<1e-9);assert.equal(r.stats.saturationPct,100);assert.equal(at(r,12).maxPressure,12);});
test('lower saturation clips at PEEP',()=>{const r=simulate('function controller(){return -100;}');assert.equal(r.type,'result');assert.equal(at(r,7).volume,0);assert.equal(r.stats.saturationPct,100);});
test('compliance changes precisely at t=12s',()=>{const r=simulate('function controller(){return 15;}',{scenario:'stiff'});assert.equal(r.type,'result');assert.equal(at(r,11.98).compliance,.05);assert.equal(at(r,12).compliance,.05);assert.equal(at(r,12.02).compliance,.025);assert.ok(Math.abs(at(r,20).volume-.25)<1e-5);});
test('resistance changes to 22 at t=12s',()=>{const r=simulate('function controller(){return 15;}',{scenario:'resistant'});assert.equal(r.type,'result');assert.equal(at(r,12.02).resistance,22);});
test('init called exactly once and memory persists',()=>{const r=simulate('function init(){memory.counter=0;} function controller(){memory.counter++;return params.peep+0.01*memory.counter;}');assert.equal(r.type,'result');assert.ok(at(r,32).pressure>20);});
test('target profile repeats at each breathing cycle',()=>{const r=simulate('function controller(){return params.peep;}');assert.equal(r.type,'result');for(const t of [0,4,8,12,16,20,24,28,32])assert.ok(Math.abs(at(r,t).target)<1e-9);for(const t of [1.4,5.4,9.4])assert.ok(Math.abs(at(r,t).target-.5)<1e-9);});
test('sample time changes callback count',()=>{for(const dt of [.01,.02,.05,.1]){const r=simulate('function controller(){return params.peep;}',{dt});assert.equal(r.type,'result');assert.equal(r.stats.calls,Math.round(32/dt));}});
test('missing controller reports helpful error',()=>{const r=simulate('function init() {}');assert.equal(r.type,'error');assert.match(r.message,/controller/);});
test('syntax errors report compile errors',()=>{const r=simulate('function controller() { return ; x(@) }');assert.equal(r.type,'error');assert.match(r.message,/compile error/);});
test('non-finite controller outputs rejected',()=>{const r=simulate('function controller(){return Infinity;}');assert.equal(r.type,'error');assert.match(r.message,/finite pressure/);});
test('model-based feedforward tracks analytic reference',()=>{const r=simulate('function controller(){return params.peep+state.target.volume/params.compliance+params.resistance*state.target.flow;}');assert.equal(r.type,'result');assert.ok(r.stats.rmse<.016,'RMSE '+r.stats.rmse);});
console.log(`\n${tests} tests passed`);
