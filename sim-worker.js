/* Barefoot Ventilator Lab v1.1 · student controller execution and exact-ZOH plant simulation.
   This worker isolates long-running student code from the page. It is NOT a security sandbox. */
'use strict';
const LIMITS = { C: 0.050, R: 10, peep: 5, duration: 32 };
// Educational threshold: two consecutive completed breaths with <90% of
// desired inspiratory volume AND >=10% of inspiratory samples at the ceiling.
const LOW_VOLUME_RATIO = 0.90;
const CEILING_FRACTION = 0.10;
const PRESSURE_EPS = 1e-8;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
function referenceAt(t, config) {
  const period = 60 / config.bpm;
  const ti = period * config.inspirationFraction;
  const cycletime = ((t % period) + period) % period;
  const inspiration = cycletime < ti;
  const f = inspiration ? cycletime / ti : (cycletime - ti) / (period - ti);
  const a = Math.PI * f;
  const volume = inspiration ? config.tidalVolume * (1 - Math.cos(a)) / 2
                             : config.tidalVolume * (1 + Math.cos(a)) / 2;
  const flow = inspiration ? config.tidalVolume * Math.PI * Math.sin(a) / (2 * ti)
                           : -config.tidalVolume * Math.PI * Math.sin(a) / (2 * (period - ti));
  return { volume, flow, phase: inspiration ? 'inspiration' : 'expiration', breath: Math.floor((t + 1e-8) / period) + 1 };
}
function mechanicsAt(t, config) {
  const changing = t >= 12 - 1e-8;
  return {
    compliance: config.scenario === 'stiff' && changing ? 0.025 : LIMITS.C,
    resistance: config.scenario === 'resistant' && changing ? 22 : LIMITS.R,
    peep: LIMITS.peep,
    maxPressure: config.scenario === 'limited' ? 12 : config.maxPressure
  };
}
function validate(config) {
  if (!config || typeof config !== 'object') throw new Error('Missing experiment configuration.');
  if (![0.01, 0.02, 0.05, 0.1].some(v => Math.abs(config.dt - v) < 1e-9)) throw new Error('Sampling time must be 10, 20, 50, or 100 ms.');
  if (!(config.tidalVolume >= 0.3 && config.tidalVolume <= 0.7)) throw new Error('Tidal volume must be between 0.30 and 0.70 L.');
  if (!(config.bpm >= 10 && config.bpm <= 20)) throw new Error('Breathing rate must be 10–20 breaths/min.');
  if (!(config.inspirationFraction >= .25 && config.inspirationFraction <= .5)) throw new Error('Inspiration fraction must be 25–50%.');
  if (![20, 25, 30].includes(config.maxPressure)) throw new Error('Maximum pressure must be 20, 25, or 30 cmH₂O.');
  if (!['baseline','stiff','resistant','limited'].includes(config.scenario)) throw new Error('Unknown experiment scenario.');
}
function runExperiment(code, config) {
  validate(config);
  if (typeof code !== 'string' || !code.trim()) throw new Error('The controller editor is empty.');
  let compiled;
  try {
    // Student functions share access to supplied state, params, and memory.
    compiled = new Function('state', 'params', 'memory', `"use strict";\n${code}\nreturn {\n  init: typeof init === "function" ? init : null,\n  controller: typeof controller === "function" ? controller : null\n};`);
  } catch (e) { throw new Error('JavaScript compile error: ' + e.message); }
  let volume = 0, flow = 0, airwayPressure = LIMITS.peep;
  const memory = {};
  let params = null, state = null;
  let funcs;
  function assignValues(t) {
    const mech = mechanicsAt(t, config), ref = referenceAt(t, config);
    params = Object.freeze({
      dt: config.dt, compliance: mech.compliance, resistance: mech.resistance,
      peep: mech.peep, maxPressure: mech.maxPressure, tidalVolume: config.tidalVolume,
      breathsPerMin: config.bpm, inspirationFraction: config.inspirationFraction
    });
    state = Object.freeze({
      time: t, t, volume, flow, pressure: airwayPressure,
      target: Object.freeze({volume: ref.volume, flow: ref.flow}),
      error: ref.volume - volume, phase: ref.phase, breath: ref.breath,
      previousPressure: airwayPressure
    });
    return { mech, ref };
  }
  // Functions from new Function close over these bindings only if they are created within its scope.
  // The functions capture the argument bindings of the wrapper. Recreate that environment at each step
  // by passing mutable proxy objects whose properties are replaced in place.
  const stateHolder = {}, paramsHolder = {};
  try { funcs = compiled(stateHolder, paramsHolder, memory); } catch (e) { throw new Error('Controller setup error: ' + e.message); }
  if (!funcs.controller) throw new Error('Please define function controller() { ... }.');
  function fillHolders() {
    for (const key of Object.keys(stateHolder)) delete stateHolder[key];
    for (const key of Object.keys(paramsHolder)) delete paramsHolder[key];
    Object.assign(stateHolder, state);
    Object.assign(paramsHolder, params);
    Object.freeze(stateHolder.target);
  }
  const first = assignValues(0);
  fillHolders();
  try { if (funcs.init) funcs.init(); } catch (e) { throw new Error('init() failed: ' + e.message); }
  const samples = [{t:0, volume:0, target:0, flow:0, targetFlow:0, pressure:LIMITS.peep,
    compliance:first.mech.compliance, resistance:first.mech.resistance, maxPressure:first.mech.maxPressure,
    phase:'inspiration', saturated:false, ceilingActive:false, lowerLimitActive:true,
    reportedPressure:LIMITS.peep, rawPressure:LIMITS.peep, rawProvided:false,
    clipped:false, pressureLimitActive:false, commandPhase:'inspiration', error:0}];
  const n = Math.round(LIMITS.duration / config.dt);
  let sumSquare = 0, saturationCount = 0, ceilingCount = 0, clipCount = 0, rawReportedCount = 0;
  for (let k = 0; k < n; k++) {
    const t = k * config.dt;
    const {mech, ref} = assignValues(t);
    fillHolders();
    let requested;
    try { requested = funcs.controller(); } catch (e) {
      throw new Error(`controller() at t=${t.toFixed(2)} s: ${e.message}`);
    }
    // Legacy: return a number or {pressure: number}. For controllers that clip
    // internally to implement anti-windup, use {pressure, rawPressure} so both
    // the unclipped demand and the returned command can be inspected.
    const isObject = requested !== null && typeof requested === 'object';
    const output = isObject ? requested.pressure : requested;
    const rawProvided = isObject && Object.prototype.hasOwnProperty.call(requested, 'rawPressure');
    const raw = rawProvided ? requested.rawPressure : output;
    if (typeof output !== 'number' || !Number.isFinite(output) ||
        typeof raw !== 'number' || !Number.isFinite(raw))
      throw new Error(`controller() must return finite pressure values at t=${t.toFixed(2)} s.`);
    if (rawProvided) rawReportedCount++;
    const command = clamp(output, mech.peep, mech.maxPressure);
    const clipped = Math.abs(command - output) > PRESSURE_EPS ||
                    Math.abs(raw - command) > PRESSURE_EPS;
    const ceilingActive = command >= mech.maxPressure - PRESSURE_EPS;
    const lowerLimitActive = command <= mech.peep + PRESSURE_EPS;
    // Upper-ceiling occupancy is observable even when student code pre-clips.
    // Do not treat normal expiration at PEEP as an upper-pressure ceiling event.
    const saturated = clipped || ceilingActive;
    if (saturated) saturationCount++;
    if (ceilingActive) ceilingCount++;
    if (clipped) clipCount++;
    // C and R are held constant across a sample. Exact ZOH update for
    // dV/dt = (Paw-PEEP - V/C) / R, including passive expiration at Paw=PEEP.
    const equilibrium = mech.compliance * (command - mech.peep);
    const alpha = Math.exp(-config.dt / (mech.resistance * mech.compliance));
    let next = equilibrium + (volume - equilibrium) * alpha;
    if (next < 0 && next > -1e-12) next = 0;
    if (next < -1e-8 || !Number.isFinite(next)) throw new Error('Invalid plant state.');
    flow = (next - volume) / config.dt; // sample-mean airflow, not instantaneous
    volume = next;
    airwayPressure = command;
    const nt = (k + 1) * config.dt;
    const targetNow = referenceAt(nt, config);
    const err = targetNow.volume - volume;
    sumSquare += err * err;
    samples.push({t:nt, volume, target:targetNow.volume, flow, targetFlow:targetNow.flow,
      pressure:command, compliance:mech.compliance, resistance:mech.resistance,
      maxPressure:mech.maxPressure, phase:targetNow.phase, commandPhase:ref.phase,
      reportedPressure:output, rawPressure:raw, rawProvided,
      saturated, clipped, pressureLimitActive:saturated, ceilingActive, lowerLimitActive, error:err});
  }
  // Group each completed breathing cycle by controller-sample midpoint. This
  // avoids shifting a cycle's final sample into the next cycle at its boundary.
  // "Inspired volume" is the positive-flow integral during inspiration,
  // a teaching proxy, NOT a clinical tidal-volume measurement or alarm.
  const period = 60 / config.bpm;
  const completeBreaths = Math.floor((LIMITS.duration + 1e-8) / period);
  const breaths = [];
  let consecutiveLow = 0;
  for (let j = 0; j < completeBreaths; j++) {
    const rows = samples.slice(1).filter(row =>
      Math.floor((row.t - config.dt / 2 + 1e-9) / period) === j);
    const insp = rows.filter(row => row.commandPhase === 'inspiration');
    const inspiredVolume = insp.reduce((sum, row) => sum + Math.max(0, row.flow) * config.dt, 0);
    const ceilingSamples = insp.filter(row => row.ceilingActive).length;
    const ceilingFraction = insp.length ? ceilingSamples / insp.length : 0;
    const peakVolume = rows.reduce((mx,row) => Math.max(mx,row.volume), 0);
    const lowVolume = inspiredVolume < LOW_VOLUME_RATIO * config.tidalVolume;
    const ceilingConstrained = ceilingFraction >= CEILING_FRACTION;
    const failedBreath = lowVolume && ceilingConstrained;
    consecutiveLow = failedBreath ? consecutiveLow + 1 : 0;
    breaths.push({number:j+1, end:(j+1)*period, inspiredVolume,
      peakVolume, ceilingFraction, lowVolume, ceilingConstrained,
      failedBreath, consecutiveLow, warningActive:consecutiveLow >= 2});
  }
  return { samples, breaths, config, stats: {
    rmse: Math.sqrt(sumSquare / n), saturationPct: 100*saturationCount/n,
    ceilingPct: 100*ceilingCount/n, clipPct: 100*clipCount/n,
    rawReportedPct: 100*rawReportedCount/n,
    lowVolumeBreaths: breaths.filter(b=>b.failedBreath).length,
    warningTriggered: breaths.some(b=>b.warningActive),
    calls:n, duration:LIMITS.duration
  } };
}
self.onmessage = event => {
  try {
    const {type, code, config} = event.data || {};
    if (type !== 'simulate') return;
    const result = runExperiment(code, config);
    self.postMessage({type:'result', ...result});
  } catch (e) {
    self.postMessage({type:'error', message:e && e.message ? e.message : String(e)});
  }
};
// Node.js unit tests can invoke the pure simulation functions via vm context.
