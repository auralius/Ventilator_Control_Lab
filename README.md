# Mechanical Ventilator Control Lab v1.0

**Virtual Lab Control Series · Educational biomedical process-control simulator · GitHub Pages-ready**

A lightweight browser-based virtual lab in which students write a JavaScript controller to regulate **lung volume** by commanding **airway pressure**. The reference follows a repeating inspiration/expiration cycle. The lab is built with native HTML, CSS, JavaScript, Canvas, SVG, and a Web Worker; no Python, Node.js, external CDNs, or JavaScript frameworks are required.

> **Educational demonstration only.** This is not a clinical ventilator model or a medical-device controller. It must never be connected to a patient or used to inform treatment. It omits oxygen exchange, patient effort, sensors, safety alarms, valve dynamics, nonlinear lung mechanics, and many other essential physiological and engineering effects.

## Run locally

From this folder:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Browsers may block `sim-worker.js` when opening `index.html` directly using `file://`. Run the local server instead. Stop it with **Ctrl+C**.

## Publish to GitHub Pages

Upload the **contents** of this directory (`index.html`, `styles.css`, `app.js`, `sim-worker.js`, `README.md`) to your repository root. Under GitHub **Settings → Pages**, choose **Deploy from a branch → main → /(root)** (if your repository does not already use an Actions-based deployment workflow). The resulting public HTTPS site runs the simulation entirely in visitors' browsers.

## Simplified single-compartment lung model

With lung volume **above the equilibrium baseline at PEEP** as output, and airway pressure as control input:

$$
P_{aw}(t)-PEEP = R\frac{dV(t)}{dt}+\frac{V(t)}{C}.
$$

Thus:

$$
\frac{dV}{dt}=\frac{P_{aw}-PEEP-V/C}{R}, \qquad
G(s)=\frac{V(s)}{P_{aw}(s)-PEEP}=\frac{C}{RCs+1}.
$$

`R` is respiratory resistance in **cmH₂O·s/L**, `C` is respiratory-system compliance in **L/cmH₂O**, `P_aw` and `PEEP` are **cmH₂O**, and `V` is **L**. Airflow `dV/dt` is **L/s**. This idealized model presumes a passive, linear, lumped system with no leaks, no patient effort, and equal inspiratory/expiratory resistance.

**Default parameters:**

| Parameter | Meaning | Value |
| --- | --- | ---: |
| `C` | Compliance | `0.050 L/cmH₂O` |
| `R` | Airway resistance | `10 cmH₂O·s/L` |
| `RC` | Time constant | `0.5 s` |
| `PEEP` | End-expiratory pressure | `5 cmH₂O` |
| `Paw,max` | Airway-pressure limit | `25 cmH₂O` (selectable) |
| `Vt` | Target tidal inflation | `0.5 L` (300–700 mL selectable) |
| `f_b` | Breathing frequency | `15 breaths/min` (10–20 selectable) |
| `Ti/T` | Inspiration fraction | `0.35` (0.25–0.50 selectable) |
| `Ts` | Sampling period | `0.02 s` (10, 20, 50, 100 ms selectable) |
| `t_end` | Experiment duration | `32 s` |

### Volume reference

Let `T=60/bpm`, `Ti=T*inspirationFraction`, `Te=T−Ti`, and `a=t modulo T`. A smooth repeating desired volume is:

$$
V_{ref}(a)=\begin{cases}
\frac{V_T}{2}\bigl(1-\cos(\pi a/T_i)\bigr), &0\le a<T_i,\$$3pt]
\frac{V_T}{2}\bigl(1+\cos(\pi(a-T_i)/T_e)\bigr), &T_i\le a<T.
\end{cases}
$$

The exact derivative is provided to students as `state.target.flow`. The resulting reference is a **pedagogical waveform**, not a specified clinical ventilation mode. The simulator does not guarantee it is reachable, especially during passive exhalation.

### Discretization: exact zero-order hold (ZOH)

`controller()` runs once per `Ts`. The commanded pressure is clipped to the range `PEEP … maxPressure` and **held constant** for that interval. With `alpha = exp(-Ts/(RC))` and `Veq=C*(Paw−PEEP)`, the simulator updates:

$$
V[k+1]=V_{eq}[k]+\bigl(V[k]-V_{eq}[k]\bigr)\alpha.
$$

This is **exact for a fixed C, R, and pressure within one sample**; the simulator updates C and R at experiment transitions. The displayed and exported airflow uses the **sample-mean** `(V[k+1]−V[k])/Ts`, not instantaneous flow at the sample boundary. The simulated controller, reference, and plant are all evaluated at deterministic simulation times, independent of visualization playback speed.

## Programming API

The engine compiles student code inside a Web Worker and exposes three globals **within the student callbacks**:

- `state`: read-only by convention. `state.volume` (L), `state.flow` (L/s, previous sample mean), `state.pressure` (cmH₂O, previous held command), `state.target.volume` (L), `state.target.flow` (L/s), `state.error` (L), `state.time` (s), `state.phase`, `state.breath`.
- `params`: read-only by convention. `params.dt`, `params.compliance`, `params.resistance`, `params.peep`, `params.maxPressure`, `params.tidalVolume`, `params.breathsPerMin`, `params.inspirationFraction`.
- `memory`: writable student-owned object, reset to `{}` each experiment. Use it for integrator state, history buffers, etc.

Functions:

- `init()` (optional): run once per new experiment, **before** the first sample.
- `controller()` (required): run once per sampling period; return a **numeric absolute airway pressure** (cmH₂O), or an object `{ pressure: value }`.

The worker enforces `PEEP ≤ P_aw ≤ maxPressure`. The controller cannot actively generate below-PEEP pressure for expiration; passive lung elastic recoil drives expiration in this model.

Example:

```javascript
function init() {
  memory.integral = 0;
}

function controller() {
  const e = state.target.volume - state.volume;
  const Kp = 35;
  const Ki = 20;
  memory.integral += e * params.dt;
  return params.peep + Kp * e + Ki * memory.integral;
}
```

This simple PI example lacks anti-windup; the built-in PI example includes conditional integration.

**Built-in example controllers:** PEEP-only starter, P, PI, model-based feedforward, PI + model-based feedforward. Each is editable. Load an example and press **Apply & reset**. Press **Run** to animate. **Pause**, **Step**, **End**, and **Reset** change playback only; the simulation has already evaluated each discrete controller sample in the worker. An excessively long-running controller is terminated after 5 seconds; Web Workers reduce UI freeze risk but **do not constitute a security sandbox for untrusted scripts**.

## Four experiments

1. **Healthy baseline:** `C=0.050`, `R=10`, `PEEP=5` throughout.
2. **Reduced compliance:** at `t=12 s`, `C` drops to `0.025 L/cmH₂O`.
3. **Increased resistance:** at `t=12 s`, `R` increases to `22 cmH₂O·s/L`.
4. **Pressure-limited challenge:** the maximum allowed airway pressure is `12 cmH₂O` despite the selector. At baseline compliance, steady-state inflation cannot exceed `C(12−5)=0.35 L`.

The pressure and volume reference are plotted against time, as is the signed airflow. Controller output constraints and both mechanics parameters appear in the live plant view and CSV.

## Data exports and verification

- **Export CSV:** all samples, target volume and flow, actual volume and mean flow, applied airway pressure, instantaneous parameters, output error, and saturation flag.
- **Save plots:** PNG with volume, pressure, and flow plots as currently shown.
- **Volume RMSE:** RMS sampled volume tracking error over the full run, excluding initial sample, in mL.
- **Pressure saturation:** fraction of samples where the requested pressure was clipped at either the PEEP floor or the maximum-pressure ceiling.
- **Student callbacks:** total number of controller calls (`32/Ts`).

A suitable teaching sequence is: examine the uncontrolled lung; tune P, then PI; try feedforward; test unexpected changes in C and R; inspect failure under pressure saturation; and compare your code against the exact discrete-time update.

## Project structure

```text
index.html       — responsive lab UI and animation
styles.css       — UI styling
app.js           — editor, playback, charts, exports
sim-worker.js    — isolated user code and exact-ZOH plant
README.md        — physics, API, teaching exercises
```

No network access is needed after the static files have loaded. All calculations run locally in the browser.

**Motto:** *If you can derive it, you can code it. If you can code it, you can test it.*

## Further reading

- [Respiratory Mechanics](https://pmc.ncbi.nlm.nih.gov/articles/PMC8360707/) — compliance, resistance, and the limitations of the single-compartment equation of motion.
- [Single-compartment respiratory mechanics simulation](https://pmc.ncbi.nlm.nih.gov/articles/PMC7538006/) — an example of a lung model using resistance and compliance under pressure-controlled ventilation.

## Developer checks

The included Node.js test suite uses only built-in modules:

```bash
node tests/test_sim.cjs
```

It checks the exact exponential response, PEEP equilibrium, pressure clipping, parameter transitions, reference periodicity, sample counts, memory, invalid controller outputs, and feedforward tracking.
