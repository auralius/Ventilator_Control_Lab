
function init() {
  memory.integral = 0;
  memory.prevError = 0;
  memory.derivative = 0;
}

function controller() {
  const Kp = 60;
  const Ki = 20;
  const Kd = 8;

  const dt = params.dt;
  const e = state.target.volume - state.volume;

  // Proportional
  const P = Kp * e;

  // Derivative with low-pass filtering
  const de = (e - memory.prevError) / dt;
  const tauD = 0.06;
  const alpha = dt / (tauD + dt);

  memory.derivative += alpha * (de - memory.derivative);
  const D = Kd * memory.derivative;

  // Integral
  const I = Ki * memory.integral;

  // PID output + baseline pressure (PEEP)
  const raw = params.peep + P + I + D;

  // Pressure saturation
  const pressure = Math.max(
    params.peep,
    Math.min(params.maxPressure, raw)
  );

  // Integral anti-windup
  if (
    raw === pressure ||
    (raw > pressure && e < 0) ||
    (raw < pressure && e > 0)
  ) {
    memory.integral += e * dt;
  }

  memory.prevError = e;

  return pressure;
}

