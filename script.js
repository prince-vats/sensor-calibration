/* ============================================================
   SENSOR CALIBRATION TOOL — script.js  (Part 1/2)
   Namespaces: State, UI, Parser, Validator, Resampler, Merger
   ============================================================ */

'use strict';

/* ── STATE ──────────────────────────────────────────────── */
const State = {
  selectedParams: [],
  sensorRaw: null,   // validated rows after NaN-drop
  referenceRaw: null,
  sensorFile: '',
  referenceFile: '',
  sensorLabel: 'Sensor',     // filename without extension, set on upload
  refLabel: 'Reference',  // filename without extension, set on upload
  overlapStart: null,
  overlapEnd: null,
  intervalSec: 3600,
  mergedData: null,   // final joined dataset
  analysisResults: {},     // keyed by param
  sensorShift: 0,
  refShift: 0,
};

/* Strip file extension → label, e.g. "EQM9a.csv" → "EQM9a" */
function baseName(filename) {
  return filename.replace(/\.[^/.]+$/, '');
}

/* ── UI HELPERS ─────────────────────────────────────────── */
const UI = {
  _pct: 0,

  log(msg, cls = 'log-info') {
    const el = document.getElementById('statusLog');
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = msg;
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;
  },

  step(label) {
    document.getElementById('statusCurrentStep').textContent = label;
    this.log('▶ ' + label, 'log-step');
  },

  pass(msg) { this.log('  ✔ ' + msg, 'log-pass'); },
  fail(msg) { this.log('  ✘ ' + msg, 'log-fail'); },
  warn(msg) { this.log('  ⚠ ' + msg, 'log-warn'); },
  info(msg) { this.log('  · ' + msg, 'log-muted'); },

  progress(pct) {
    this._pct = pct;
    document.getElementById('progressBar').style.width = pct + '%';
    document.getElementById('statusPct').textContent = Math.round(pct) + '%';
  },

  vlog(elId, msg, ok) {
    const el = document.getElementById(elId);
    const d = document.createElement('div');
    d.className = ok ? 'pass' : 'fail';
    d.textContent = (ok ? '✔ ' : '✘ ') + msg;
    el.appendChild(d);
  },

  vclear(elId) { document.getElementById(elId).innerHTML = ''; },

  unlock(id) { document.getElementById(id).classList.remove('locked'); },
  lock(id) { document.getElementById(id).classList.add('locked'); },

  setFileName(elId, name) { document.getElementById(elId).textContent = name || 'No file selected'; },
};

/* ── PARSER ─────────────────────────────────────────────── */
const Parser = {

  parseTimestamp(value) {
    if (value === null || value === undefined) return null;

    // Excel numeric serial date
    if (typeof value === 'number') {
      const base = new Date(1899, 11, 30);
      return new Date(base.getTime() + value * 86400000);
    }

    let ts = String(value).trim().replace(/\s+/g, ' ');
    if (!ts) return null;
    ts = ts.replace(/\.\d+$/, ''); // strip milliseconds

    // Native parse first
    let d = new Date(ts);
    if (!isNaN(d.getTime())) return d;

    const pats = [
      // DD-MM-YYYY HH:mm:ss [AM/PM]
      /^(\d{2})[-\/](\d{2})[-\/](\d{4}) (\d{2}):(\d{2}):(\d{2})(?: ?([APap][Mm]))?$/,
      // YYYY-MM-DD HH:mm:ss
      /^(\d{4})[-\/](\d{2})[-\/](\d{2}) (\d{2}):(\d{2}):(\d{2})$/,
      // DD-MM-YYYY
      /^(\d{2})[-\/](\d{2})[-\/](\d{4})$/,
      // YYYY-MM-DD
      /^(\d{4})[-\/](\d{2})[-\/](\d{2})$/,
    ];

    for (const p of pats) {
      const m = ts.match(p);
      if (!m) continue;
      let y, mn, dy, h = 0, mi = 0, s = 0;
      if (m[1].length === 4) {
        [, y, mn, dy, h = 0, mi = 0, s = 0] = m.map(Number);
        mn -= 1;
      } else {
        dy = +m[1]; mn = +m[2] - 1; y = +m[3];
        h = +(m[4] || 0); mi = +(m[5] || 0); s = +(m[6] || 0);
        const ap = m[7] && m[7].toUpperCase();
        if (ap === 'PM' && h < 12) h += 12;
        if (ap === 'AM' && h === 12) h = 0;
      }
      d = new Date(y, mn, dy, h, mi, s);
      if (!isNaN(d.getTime())) return d;
    }
    return null;
  },

  loadFile(file) {
    return new Promise((resolve, reject) => {
      const ext = file.name.split('.').pop().toLowerCase();
      if (ext === 'csv') {
        Papa.parse(file, {
          header: true,
          skipEmptyLines: true,
          dynamicTyping: false,
          complete: r => resolve(r.data),
          error: e => reject(e),
        });
      } else {
        const reader = new FileReader();
        reader.onload = e => {
          try {
            const wb = XLSX.read(e.target.result, { type: 'binary' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            resolve(XLSX.utils.sheet_to_json(ws, { raw: true }));
          } catch (err) { reject(err); }
        };
        reader.onerror = reject;
        reader.readAsBinaryString(file);
      }
    });
  },
};

/* ── VALIDATOR ──────────────────────────────────────────── */
const Validator = {

  validate(type, rawData, statusElId) {
    const log = (msg, ok) => UI.vlog(statusElId, msg, ok);
    let valid = true;

    // Remove completely empty rows
    let data = rawData.filter(row =>
      Object.values(row).some(v => v !== null && v !== undefined && String(v).trim() !== '')
    );

    if (!data.length) {
      log('File contains no usable rows', false); return null;
    }

    // Check 1: first column = Timestamp
    const cols = Object.keys(data[0]);
    const check1 = cols[0] === 'Timestamp';
    log(`Check 1 — First column is "Timestamp": ${cols[0]}`, check1);
    if (!check1) { valid = false; }

    // Check 2: timestamp validity
    let badTs = [];
    data = data.map(row => {
      const parsed = Parser.parseTimestamp(row.Timestamp);
      if (!parsed) { badTs.push(row.Timestamp); return null; }
      return { ...row, Timestamp: parsed };
    }).filter(Boolean);

    if (badTs.length === 0) {
      log(`Check 2 — All timestamps valid (${data.length} rows)`, true);
    } else {
      log(`Check 2 — ${badTs.length} unparseable timestamps. Examples: ${badTs.slice(0, 3).join(' | ')}`, false);
      valid = false;
    }

    // Check 3: required columns
    const required = [...State.selectedParams];
    if (type === 'sensor') required.push('T', 'RH');
    const missing = required.filter(c => !cols.includes(c));
    if (!missing.length) {
      log(`Check 3 — Required columns present: ${required.join(', ')}`, true);
    } else {
      log(`Check 3 — Missing columns: ${missing.join(', ')}`, false);
      valid = false;
    }

    if (!valid) return null;

    // Check 4: numeric coercion
    required.forEach(col => {
      let bad = 0;
      data.forEach(row => {
        const v = parseFloat(row[col]);
        if (isNaN(v)) { row[col] = NaN; bad++; }
        else { row[col] = v; }
      });
      if (bad) log(`Check 4 — "${col}": ${bad} non-numeric → NaN`, true);
      else log(`Check 4 — "${col}": all numeric`, true);
    });

    // Check 5: drop NaN rows
    const before = data.length;
    const invalidStr = new Set(['nan', 'NaN', 'null', 'undefined', '']);
    data = data.filter(row =>
      required.every(col => {
        const v = row[col];
        if (v === null || v === undefined) return false;
        if (typeof v === 'number' && isNaN(v)) return false;
        if (invalidStr.has(String(v).trim())) return false;
        return true;
      })
    );
    const dropped = before - data.length;
    log(`Check 5 — Dropped ${dropped} invalid rows. Remaining: ${data.length}`, true);

    if (!data.length) {
      log('No valid rows remain after cleaning', false); return null;
    }

    log(`✔ ${type === 'sensor' ? 'Sensor' : 'Reference'} file accepted (${data.length} rows)`, true);
    return data;
  },
};

/* ── RESAMPLER ──────────────────────────────────────────── */
const Resampler = {

  resample(data, intervalSec) {
    const ms = intervalSec * 1000;
    // getTimezoneOffset() is negative for UTC+ zones (e.g. IST = -330 min).
    // Subtracting it shifts t into a "local epoch" so that floor() snaps to
    // LOCAL midnight / local hour / local minute boundaries, not UTC ones.
    const tzOffMs = new Date().getTimezoneOffset() * 60000; // e.g. -19800000 for IST
    const bins = {};

    data.forEach(row => {
      const t = row.Timestamp.getTime();
      const localT = t - tzOffMs;               // express t in local-time ms
      // interval-end bin label in local time, then convert back to UTC ms
      const key = Math.floor(localT / ms) * ms + ms + tzOffMs;
      if (!bins[key]) bins[key] = [];
      bins[key].push(row);
    });

    const cols = Object.keys(data[0]).filter(c => c !== 'Timestamp');

    return Object.entries(bins)
      .sort(([a], [b]) => a - b)
      .map(([key, rows]) => {
        const out = { Timestamp: new Date(Number(key)) };
        cols.forEach(col => {
          const vals = rows.map(r => r[col]).filter(v => typeof v === 'number' && !isNaN(v));
          out[col] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
        });
        return out;
      });
  },
};

/* ── MERGER ─────────────────────────────────────────────── */
const Merger = {

  merge(sensorResampled, refResampled) {
    if (!sensorResampled.length || !refResampled.length) return [];

    // Sort reference by time for binary search
    const refArr = refResampled.slice().sort((a, b) => a.Timestamp - b.Timestamp);
    const refTimes = refArr.map(r => r.Timestamp.getTime());

    // Auto-detect the reference's natural sampling interval (median gap)
    // so we can set a tolerance even when the user chooses a finer resolution.
    let refNatural = Infinity;
    if (refArr.length > 1) {
      const gaps = [];
      for (let i = 1; i < refArr.length; i++)
        gaps.push(refTimes[i] - refTimes[i - 1]);
      gaps.sort((a, b) => a - b);
      refNatural = gaps[Math.floor(gaps.length / 2)]; // median gap
    }
    // Each sensor bin matches the closest reference bin within ±half the
    // reference's natural interval (so every sensor bin gets a reference value).
    const tol = refNatural / 2;

    UI.info(`Reference natural interval: ${(refNatural / 1000).toFixed(0)} s  |  match tolerance: ±${(tol / 1000).toFixed(0)} s`);
    if (refNatural > State.intervalSec * 1000) {
      UI.warn(`Selected resolution (${State.intervalSec}s) is finer than reference interval (~${(refNatural / 1000).toFixed(0)}s). Each reference reading will be reused for multiple sensor bins.`);
    }

    const rows = [];
    sensorResampled.forEach(sr => {
      const t = sr.Timestamp.getTime();

      // Binary search: find index of closest reference timestamp
      let lo = 0, hi = refTimes.length - 1, bestIdx = -1, bestDiff = Infinity;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const diff = Math.abs(refTimes[mid] - t);
        if (diff < bestDiff) { bestDiff = diff; bestIdx = mid; }
        if (refTimes[mid] < t) lo = mid + 1; else hi = mid - 1;
      }
      if (bestIdx < 0 || bestDiff > tol) return; // outside tolerance

      const rr = refArr[bestIdx];
      const row = { Timestamp: sr.Timestamp };
      State.selectedParams.forEach(p => {
        row[`${p}_sensor`] = sr[p];
        row[`${p}_reference`] = rr[p];
      });
      row.T = sr.T;
      row.RH = sr.RH;
      rows.push(row);
    });
    return rows;
  },
};


/* ── REGRESSION ─────────────────────────────────────────── */
const Regression = {

  /* Ordinary Least Squares  y = mx + b */
  simple(xs, ys) {
    const n = xs.length;
    const sx = xs.reduce((a, b) => a + b, 0);
    const sy = ys.reduce((a, b) => a + b, 0);
    const sxy = xs.reduce((a, x, i) => a + x * ys[i], 0);
    const sx2 = xs.reduce((a, x) => a + x * x, 0);
    const m = (n * sxy - sx * sy) / (n * sx2 - sx * sx);
    const b = (sy - m * sx) / n;
    return { m, b };
  },

  /* Multiple linear regression via normal equations X'X β = X'y
     Inputs: rows of [sensor, T, RH], output: y = reference
     Returns: { a, b, c, d } where y = a*sensor + b*T + c*RH + d  */
  multiple(sensorArr, Tarr, RHarr, yArr) {
    const n = sensorArr.length;
    // Build X matrix (n x 4) with intercept column
    const X = [];
    for (let i = 0; i < n; i++) {
      X.push([sensorArr[i], Tarr[i], RHarr[i], 1]);
    }
    const Xt = this._transpose(X);
    const XtX = this._matMul(Xt, X);
    const Xty = this._matVec(Xt, yArr);
    const beta = this._solve(XtX, Xty);
    return { a: beta[0], b: beta[1], c: beta[2], d: beta[3] };
  },

  _transpose(M) {
    return M[0].map((_, ci) => M.map(row => row[ci]));
  },

  _matMul(A, B) {
    const rows = A.length, cols = B[0].length, inner = B.length;
    const C = Array.from({ length: rows }, () => new Array(cols).fill(0));
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) for (let k = 0; k < inner; k++)
      C[r][c] += A[r][k] * B[k][c];
    return C;
  },

  _matVec(A, v) {
    return A.map(row => row.reduce((s, a, i) => s + a * v[i], 0));
  },

  /* Gaussian elimination with partial pivoting */
  _solve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
      let maxR = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[maxR][c])) maxR = r;
      [M[c], M[maxR]] = [M[maxR], M[c]];
      for (let r = c + 1; r < n; r++) {
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      x[i] = M[i][n];
      for (let j = i + 1; j < n; j++) x[i] -= M[i][j] * x[j];
      x[i] /= M[i][i];
    }
    return x;
  },
};

/* ── METRICS ────────────────────────────────────────────── */
const Metrics = {

  compute(yTrue, yPred) {
    const n = yTrue.length;
    if (!n) return {};

    const meanTrue = yTrue.reduce((a, b) => a + b, 0) / n;
    const meanPred = yPred.reduce((a, b) => a + b, 0) / n;

    const ss_res = yTrue.reduce((s, y, i) => s + Math.pow(y - yPred[i], 2), 0);
    const ss_tot = yTrue.reduce((s, y) => s + Math.pow(y - meanTrue, 2), 0);
    const r2 = 1 - ss_res / ss_tot;

    const rmse = Math.sqrt(ss_res / n);
    const mae = yTrue.reduce((s, y, i) => s + Math.abs(y - yPred[i]), 0) / n;
    const mape = yTrue.reduce((s, y, i) => s + (y !== 0 ? Math.abs((y - yPred[i]) / y) : 0), 0) / n * 100;
    const bias = yPred.reduce((s, p) => s + p, 0) / n - meanTrue;

    // Pearson
    const covNum = yTrue.reduce((s, y, i) => s + (y - meanTrue) * (yPred[i] - meanPred), 0);
    const stdT = Math.sqrt(yTrue.reduce((s, y) => s + Math.pow(y - meanTrue, 2), 0) / n);
    const stdP = Math.sqrt(yPred.reduce((s, p) => s + Math.pow(p - meanPred, 2), 0) / n);
    const pearson = (stdT && stdP) ? covNum / (n * stdT * stdP) : NaN;

    return { r2, rmse, mae, mape, bias, pearson };
  },
};

/* ── ALIGNER ────────────────────────────────────────────── */
const Aligner = {

  /* Apply shift offsets and return realigned sensor/ref arrays.
     Direction convention (intuitive / visual):
       sensorShift = +1  →  right arrow pressed  →  sensor series moves RIGHT in the plot
                            achieved by: at time grid[i], use sensor value from index i-1
                            (an earlier sensor reading appears at a later timestamp)
       sensorShift = -1  →  left arrow  →  sensor series moves LEFT
     The output timestamp is always merged[i].Timestamp (fixed grid, no drift).      */
  apply(merged, sensorShift, refShift) {
    const n = merged.length;
    const rows = [];
    for (let i = 0; i < n; i++) {
      // Negate the shift: right (+1) → pick from i-1 so value appears later → moves RIGHT
      const si = i - sensorShift;
      const ri = i - refShift;
      if (si < 0 || si >= n || ri < 0 || ri >= n) continue;
      const sRow = merged[si];
      const rRow = merged[ri];
      const row = { Timestamp: merged[i].Timestamp }; // fixed time grid
      State.selectedParams.forEach(p => {
        row[`${p}_sensor`] = sRow[`${p}_sensor`];
        row[`${p}_reference`] = rRow[`${p}_reference`];
      });
      row.T = sRow.T;
      row.RH = sRow.RH;
      rows.push(row);
    }
    return rows;
  },
};

/* ── PLOTTER ────────────────────────────────────────────── */
const Plotter = {

  scatter_simple(divId, xs, ys, coeff, metrics, param) {
    const { m, b } = coeff;
    const xLine = [
      xs.reduce((a, v) => v < a ? v : a, Infinity),
      xs.reduce((a, v) => v > a ? v : a, -Infinity),
    ];
    const yLine = xLine.map(x => m * x + b);

    const eq = `y = ${m.toFixed(4)}x + ${b.toFixed(4)}`;
    const ann = `R²=${metrics.r2.toFixed(4)}  RMSE=${metrics.rmse.toFixed(4)}  MAE=${metrics.mae.toFixed(4)}<br>MAPE=${metrics.mape.toFixed(2)}%  Bias=${metrics.bias.toFixed(4)}  r=${metrics.pearson.toFixed(4)}`;
    Plotly.newPlot(divId, [
      { x: xs, y: ys, mode: 'markers', name: `${State.sensorLabel}`, marker: { size: 5, color: '#FF4500', opacity: 0.65 } },
      { x: xLine, y: yLine, mode: 'lines', name: 'Fit', line: { color: '#ffffff', width: 1.5 } },
    ], {
      paper_bgcolor: '#0a0a0a', plot_bgcolor: '#0a0a0a',
      font: { color: '#aaa', family: 'JetBrains Mono, monospace', size: 11 },
      title: { text: `${param} — Simple Linear Regression`, font: { color: '#e0e0e0', size: 13 } },
      xaxis: { title: `${param} — ${State.sensorLabel}`, zeroline: false, gridcolor: '#1e1e1e', color: '#888' },
      yaxis: { title: `${param} — ${State.refLabel}`, zeroline: false, gridcolor: '#1e1e1e', color: '#888' },
      annotations: [{
        xref: 'paper', yref: 'paper', x: 0.02, y: 0.98, xanchor: 'left', yanchor: 'top',
        text: eq + '<br>' + ann, showarrow: false,
        font: { size: 10, color: '#ccc', family: 'JetBrains Mono, monospace' },
        bgcolor: 'rgba(20,20,20,0.9)', bordercolor: '#333', borderwidth: 1
      }],
      margin: { t: 45, b: 95, l: 60, r: 20 },

      legend: {
        orientation: 'h',
        x: 0.5,
        y: -0.35,              // pushes legend below x-axis
        xanchor: 'center',
        yanchor: 'top',
        font: { color: '#888' },

        bgcolor: 'rgba(20,20,20,0.9)',   // box background
        bordercolor: '#333',
        borderwidth: 1
      },
    }, { responsive: true });
  },

  scatter_mlr(divId, yTrue, yPred, metrics, param) {
    const mn = [...yTrue, ...yPred].reduce((a, v) => v < a ? v : a, Infinity);
    const mx = [...yTrue, ...yPred].reduce((a, v) => v > a ? v : a, -Infinity);
    const ann = `R²=${metrics.r2.toFixed(4)}  RMSE=${metrics.rmse.toFixed(4)}<br>MAE=${metrics.mae.toFixed(4)}  r=${metrics.pearson.toFixed(4)}`;
    Plotly.newPlot(divId, [
      { x: yTrue, y: yPred, mode: 'markers', name: `MLR Predicted vs ${State.refLabel}`, marker: { size: 5, color: '#00C896', opacity: 0.65 } },
      { x: [mn, mx], y: [mn, mx], mode: 'lines', name: '1:1 line', line: { color: '#555', dash: 'dash', width: 1.5 } },
    ], {
      paper_bgcolor: '#0a0a0a', plot_bgcolor: '#0a0a0a',
      font: { color: '#aaa', family: 'JetBrains Mono, monospace', size: 11 },
      title: { text: `${param} \u2014 MLR Predicted vs ${State.refLabel}`, font: { color: '#e0e0e0', size: 13 } },
      xaxis: { title: `${param} — ${State.refLabel}`, zeroline: false, gridcolor: '#1e1e1e', color: '#888' },
      yaxis: { title: 'MLR Predicted', zeroline: false, gridcolor: '#1e1e1e', color: '#888' },
      annotations: [{
        xref: 'paper', yref: 'paper', x: 0.02, y: 0.98, xanchor: 'left', yanchor: 'top',
        text: ann, showarrow: false, font: { size: 10, color: '#ccc', family: 'JetBrains Mono, monospace' },
        bgcolor: 'rgba(20,20,20,0.9)', bordercolor: '#333', borderwidth: 1
      }],
      margin: { t: 45, b: 95, l: 60, r: 20 },

      legend: {
        orientation: 'h',
        x: 0.5,
        y: -0.35,              // pushes legend below x-axis
        xanchor: 'center',
        yanchor: 'top',
        font: { color: '#888' },

        bgcolor: 'rgba(20,20,20,0.9)',   // box background
        bordercolor: '#333',
        borderwidth: 1
      },
    }, { responsive: true });
  },

  timeseries(divId, timestamps, refVals, rawSensor, simpleCal, mlrCal, param) {
    const ts = timestamps.map(t => t.toISOString());
    Plotly.newPlot(divId, [
      { x: ts, y: refVals, mode: 'lines', name: `${State.refLabel}`, line: { color: '#FF4136', width: 1.5 } },
      { x: ts, y: rawSensor, mode: 'lines', name: `${State.sensorLabel} (Raw)`, line: { color: '#0074D9', width: 1.5 } },
      { x: ts, y: simpleCal, mode: 'lines', name: `${State.sensorLabel} (SLR Calibrated)`, line: { color: '#2ECC40', dash: 'dash', width: 1.5 } },
      { x: ts, y: mlrCal, mode: 'lines', name: `${State.sensorLabel} (MLR Calibrated)`, line: { color: '#FF851B', dash: 'dot', width: 1.5 } },
    ], {
      paper_bgcolor: '#0a0a0a', plot_bgcolor: '#0a0a0a',
      font: { color: '#aaa', family: 'JetBrains Mono, monospace', size: 11 },
      title: { text: `${param} \u2014 Time Series`, font: { color: '#e0e0e0', size: 13 } },
      xaxis: { title: 'Time', type: 'date', rangeslider: { visible: true, bgcolor: '#111', bordercolor: '#222', thickness: 0.08 }, gridcolor: '#1e1e1e', color: '#888' },
      yaxis: { title: param, zeroline: false, gridcolor: '#1e1e1e', color: '#888' },
      showlegend: true,
      legend: { orientation: 'h', x: 0.5, y: -0.63, xanchor: 'center', yanchor: 'top', bgcolor: 'rgba(20,20,20,0.9)', bordercolor: '#333', borderwidth: 1, font: { color: '#aaa' } },
      margin: { t: 45, b: 125, l: 60, r: 20 },
    }, { responsive: true });
  },
};


/* ── EXPORTER ────────────────────────────────────────────── */
const Exporter = {
  fmtTs(d) {
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  },
  buildExportRows(alignedData) {
    const sL = State.sensorLabel;
    const rL = State.refLabel;
    return alignedData.map(row => {
      const out = { Timestamp: this.fmtTs(row.Timestamp) };
      State.selectedParams.forEach(p => {
        out[`${p}_${sL}`] = row[`${p}_sensor`];
        out[`${p}_${rL}`] = row[`${p}_reference`];
        const res = State.analysisResults[p];
        if (res) {
          const { slr, mlr } = res;
          out[`${p}_${sL}_SLR_cal`] = slr.coeff.m * row[`${p}_sensor`] + slr.coeff.b;
          out[`${p}_${sL}_MLR_cal`] = mlr.coeff.a * row[`${p}_sensor`] + mlr.coeff.b * row.T + mlr.coeff.c * row.RH + mlr.coeff.d;
        }
      });
      out.T = row.T;
      out.RH = row.RH;
      out._sensor_shift_indices = State.sensorShift;
      out._ref_shift_indices = State.refShift;
      return out;
    });
  },
  toCSV(alignedData) {
    const rows = this.buildExportRows(alignedData);
    const blob = new Blob([Papa.unparse(rows)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `calibration_${State.sensorLabel}_vs_${State.refLabel}.csv`;
    a.click();
  },
  toExcel(alignedData) {
    const rows = this.buildExportRows(alignedData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Processed Data');
    const metricRows = [];
    State.selectedParams.forEach(p => {
      const res = State.analysisResults[p];
      if (!res) return;
      const { slr, mlr } = res;
      const sL = State.sensorLabel;
      const rL = State.refLabel;
      metricRows.push({
        Parameter: p, Sensor: sL, Reference: rL, Model: 'Simple Linear',
        Equation: `y=${slr.coeff.m.toFixed(6)}*${sL}+${slr.coeff.b.toFixed(6)}`,
        R2: slr.metrics.r2, RMSE: slr.metrics.rmse, MAE: slr.metrics.mae,
        MAPE: slr.metrics.mape, Bias: slr.metrics.bias, Pearson_r: slr.metrics.pearson
      });
      metricRows.push({
        Parameter: p, Sensor: sL, Reference: rL, Model: 'Multiple Linear',
        Equation: `y=${mlr.coeff.a.toFixed(6)}*${sL}+${mlr.coeff.b.toFixed(6)}*T+${mlr.coeff.c.toFixed(6)}*RH+${mlr.coeff.d.toFixed(6)}`,
        R2: mlr.metrics.r2, RMSE: mlr.metrics.rmse, MAE: mlr.metrics.mae,
        MAPE: mlr.metrics.mape, Bias: mlr.metrics.bias, Pearson_r: mlr.metrics.pearson
      });
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(metricRows), 'Metrics Summary');
    XLSX.writeFile(wb, `calibration_${State.sensorLabel}_vs_${State.refLabel}.xlsx`);
  },
};

/* ── ANALYSIS PIPELINE ──────────────────────────────────── */
function runAnalysis(data) {
  State.analysisResults = {};
  State.selectedParams.forEach(p => {
    const valid = data.filter(r =>
      [r[`${p}_sensor`], r[`${p}_reference`], r.T, r.RH]
        .every(v => typeof v === 'number' && !isNaN(v))
    );
    if (valid.length < 4) { UI.warn(`${p}: only ${valid.length} valid rows — skipping regression`); return; }
    const xs = valid.map(r => r[`${p}_sensor`]);
    const ys = valid.map(r => r[`${p}_reference`]);
    const Ts = valid.map(r => r.T);
    const RHs = valid.map(r => r.RH);
    const slrCoeff = Regression.simple(xs, ys);
    const slrPred = xs.map(x => slrCoeff.m * x + slrCoeff.b);
    const mlrCoeff = Regression.multiple(xs, Ts, RHs, ys);
    const mlrPred = valid.map((_, i) => mlrCoeff.a * xs[i] + mlrCoeff.b * Ts[i] + mlrCoeff.c * RHs[i] + mlrCoeff.d);
    State.analysisResults[p] = {
      slr: { coeff: slrCoeff, metrics: Metrics.compute(ys, slrPred), xs, ys },
      mlr: { coeff: mlrCoeff, metrics: Metrics.compute(ys, mlrPred), yTrue: ys, pred: mlrPred },
      validRows: valid,
    };
  });
}

function renderAnalysis() {
  const tabBar = document.getElementById('analysisTabs');
  const content = document.getElementById('analysisContent');
  tabBar.innerHTML = '';
  content.innerHTML = '';
  const params = Object.keys(State.analysisResults);
  if (!params.length) { content.innerHTML = '<p style="color:red">No results.</p>'; return; }

  params.forEach((p, idx) => {
    const res = State.analysisResults[p];
    const tab = document.createElement('div');
    tab.className = 'tab' + (idx === 0 ? ' active' : '');
    tab.textContent = p;
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('panel-' + p).classList.add('active');
    });
    tabBar.appendChild(tab);

    const { slr, mlr } = res;
    const slrEq = `y = ${slr.coeff.m.toFixed(6)}·${State.sensorLabel} + ${slr.coeff.b.toFixed(6)}`;
    const mlrEq = `y = ${mlr.coeff.a.toFixed(6)}·${State.sensorLabel} + ${mlr.coeff.b.toFixed(6)}·T + ${mlr.coeff.c.toFixed(6)}·RH + ${mlr.coeff.d.toFixed(6)}`;
    const mRow = (label, v) => `<tr><td>${label}</td><td>${typeof v === 'number' ? v.toFixed(6) : v}</td></tr>`;
    const mTable = (m, label, eq) => `
      <div class="metrics-equation">
        <span class="eq-label"><strong>${label}:</strong></span>
        <button class="copy-eq-btn" data-eq="${eq.replace(/"/g, '&quot;')}" title="Copy equation">🗐</button>
        <br><code>${eq}</code>
      </div>
      <table class="metrics-table"><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody>
        ${mRow('R²', m.r2)}${mRow('RMSE', m.rmse)}${mRow('MAE', m.mae)}
        ${mRow('MAPE (%)', m.mape.toFixed(4))}${mRow('Bias', m.bias)}${mRow('Pearson r', m.pearson)}
      </tbody></table>`;

    const panel = document.createElement('div');
    panel.className = 'tab-panel' + (idx === 0 ? ' active' : '');
    panel.id = 'panel-' + p;
    panel.innerHTML = `<div class="param-section"><h3>${p}</h3>
      <div class="grid-2">
        <div>${mTable(slr.metrics, 'Simple Linear Regression', slrEq)}</div>
        <div>${mTable(mlr.metrics, 'Multiple Linear Regression', mlrEq)}</div>
      </div>
      <div class="grid-2">
        <div><div class="plot-container" id="scatter-slr-${p}" style="min-height:320px"></div></div>
        <div><div class="plot-container" id="scatter-mlr-${p}" style="min-height:320px"></div></div>
      </div>
      <div class="plot-container" id="timeseries-${p}" style="min-height:380px"></div>
    </div>`;
    content.appendChild(panel);

    // Wire copy buttons for equations
    panel.querySelectorAll('.copy-eq-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(btn.dataset.eq).catch(() => { });
        const orig = btn.textContent;
        btn.textContent = '✓';
        btn.style.color = 'var(--pass)';
        setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 1500);
      });
    });
  });

  requestAnimationFrame(() => {
    params.forEach(p => {
      const res = State.analysisResults[p];
      if (!res) return;
      const { slr, mlr, validRows } = res;
      Plotter.scatter_simple('scatter-slr-' + p, slr.xs, slr.ys, slr.coeff, slr.metrics, p);
      Plotter.scatter_mlr('scatter-mlr-' + p, mlr.yTrue, mlr.pred, mlr.metrics, p);
      const ts = validRows.map(r => r.Timestamp);
      const refSeries = validRows.map(r => r[`${p}_reference`]);
      const rawSeries = validRows.map(r => r[`${p}_sensor`]);
      const simpleSer = rawSeries.map(x => slr.coeff.m * x + slr.coeff.b);
      const mlrSer = validRows.map(r => mlr.coeff.a * r[`${p}_sensor`] + mlr.coeff.b * r.T + mlr.coeff.c * r.RH + mlr.coeff.d);
      Plotter.timeseries('timeseries-' + p, ts, refSeries, rawSeries, simpleSer, mlrSer, p);
    });
  });
}

/* ── OVERLAP CHECK ──────────────────────────────────────── */
function checkOverlap() {
  // Use reduce instead of Math.min/max spread — avoids stack overflow on large datasets
  const sTs = State.sensorRaw.map(r => r.Timestamp.getTime());
  const rTs = State.referenceRaw.map(r => r.Timestamp.getTime());
  const sMin = sTs.reduce((a, b) => b < a ? b : a, Infinity);
  const sMax = sTs.reduce((a, b) => b > a ? b : a, -Infinity);
  const rMin = rTs.reduce((a, b) => b < a ? b : a, Infinity);
  const rMax = rTs.reduce((a, b) => b > a ? b : a, -Infinity);
  const start = new Date(Math.max(sMin, rMin));
  const end = new Date(Math.min(sMax, rMax));
  const el = document.getElementById('overlapResult');
  if (start < end) {
    const durHrs = ((end - start) / 3600000).toFixed(1);
    State.overlapStart = start;
    State.overlapEnd = end;
    el.className = 'ok';
    el.innerHTML = `Overlap found<br>Start: <strong>${start.toLocaleString()}</strong><br>End: <strong>${end.toLocaleString()}</strong><br>Duration: <strong>${durHrs} hours</strong>`;
    UI.unlock('step5Section');
    UI.unlock('step6Section');
    document.getElementById('prepareBtn').disabled = false;
    UI.pass('Overlap: ' + start.toLocaleString() + ' → ' + end.toLocaleString() + ' (' + durHrs + 'h)');
    UI.progress(60);
  } else {
    el.className = 'fail';
    el.textContent = 'No overlapping calibration period exists. Cannot proceed.';
    UI.fail('No overlap found between sensor and reference datasets.');
  }
}

/* ── MERGE & PREVIEW ────────────────────────────────────── */
function doMerge() {
  UI.step('Step 6: Resampling and merging…');
  State.intervalSec = parseInt(document.getElementById('resolutionSelect').value, 10);
  const sRes = Resampler.resample(State.sensorRaw, State.intervalSec);
  const rRes = Resampler.resample(State.referenceRaw, State.intervalSec);
  UI.info(`Sensor bins: ${sRes.length}  Reference bins: ${rRes.length}`);
  State.mergedData = Merger.merge(sRes, rRes);
  State.sensorShift = 0; State.refShift = 0;
  document.getElementById('sensorShiftVal').textContent = '0';
  document.getElementById('refShiftVal').textContent = '0';
  if (!State.mergedData.length) { UI.fail('No matching timestamps — reference may have no overlap with sensor range, or check your data.'); return; }
  UI.pass('Merged rows: ' + State.mergedData.length);
  // Show the preview card
  const s6 = document.getElementById('step6Section');
  s6.style.display = '';
  s6.classList.remove('locked');
  renderMergePreview(State.mergedData);
  UI.progress(75);
  UI.step('Step 7: Running calibration analysis…');
  runAnalysis(State.mergedData);
  renderAnalysis();
  UI.pass('Calibration analysis complete');
  UI.unlock('step7Section');
  // Show alignment + download toolbar (utility strip, not a step)
  document.getElementById('alignToolbar').style.display = 'flex';
  document.getElementById('downloadCSV').disabled = false;
  document.getElementById('downloadExcel').disabled = false;
  UI.progress(100);
  document.getElementById('statusCurrentStep').textContent = 'Done ✔';
}

function renderMergePreview(data) {
  const labels = { 1: '1s', 60: '1min', 300: '5min', 900: '15min', 1800: '30min', 3600: '1hr', 43200: '12hr', 86400: '24hr' };
  document.getElementById('mergedRows').textContent = data.length;
  document.getElementById('mergedStart').textContent = data[0].Timestamp.toLocaleString();
  document.getElementById('mergedEnd').textContent = data[data.length - 1].Timestamp.toLocaleString();
  document.getElementById('mergedInterval').textContent = labels[State.intervalSec] || State.intervalSec + 's';
  document.getElementById('mergeStatusText').textContent = data.length + ' rows merged';
  document.getElementById('mergedMeta').style.display = '';
  document.getElementById('previewWrap').style.display = '';
  const cols = Object.keys(data[0]);
  let html = '<thead><tr>' + cols.map(c => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>';
  data.slice(0, 20).forEach(r => {
    html += '<tr>' + cols.map(c => {
      const v = c === 'Timestamp' ? r[c].toLocaleString() : (typeof r[c] === 'number' ? r[c].toFixed(4) : r[c]);
      return '<td>' + v + '</td>';
    }).join('') + '</tr>';
  });
  document.getElementById('previewTable').innerHTML = html + '</tbody>';
}

/* ── REALIGN ────────────────────────────────────────────── */
function realign() {
  if (!State.mergedData) return;
  document.getElementById('sensorShiftVal').textContent = State.sensorShift;
  document.getElementById('refShiftVal').textContent = State.refShift;
  UI.step(`Realigning: sensor=${State.sensorShift}, ref=${State.refShift}`);
  const aligned = Aligner.apply(State.mergedData, State.sensorShift, State.refShift);
  if (aligned.length < 4) { UI.fail('Too few rows after shift. Try smaller offset.'); return; }
  runAnalysis(aligned);
  renderAnalysis();
  UI.pass('Realignment done — ' + aligned.length + ' rows');
}

/* ── EVENT WIRING ───────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {

  document.querySelectorAll('#paramGrid input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      State.selectedParams = [...document.querySelectorAll('#paramGrid input:checked')].map(x => x.value);
      document.getElementById('selectedParamsDisplay').innerHTML =
        'Selected: <strong>' + (State.selectedParams.join(', ') || 'None') + '</strong>';
    });
  });

  document.getElementById('sensorFile').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    if (!State.selectedParams.length) { alert('Select at least one parameter first.'); e.target.value = ''; return; }
    UI.step('Step 2: Loading sensor file…');
    UI.vclear('sensorStatus');
    UI.setFileName('sensorFileName', file.name);
    State.sensorFile = file.name;
    try {
      const raw = await Parser.loadFile(file);
      UI.pass('Sensor raw rows: ' + raw.length);
      const data = Validator.validate('sensor', raw, 'sensorStatus');
      if (!data) { UI.fail('Sensor validation failed.'); return; }
      State.sensorRaw = data;
      State.sensorLabel = baseName(file.name);
      document.getElementById('sensorTagLabel').textContent = State.sensorLabel;
      UI.pass(`Sensor accepted as “${State.sensorLabel}”. Upload reference file.`);
      UI.progress(30);
      document.getElementById('referenceFile').disabled = false;
      UI.unlock('step3Section');
    } catch (err) { UI.fail('Error: ' + err.message); }
  });

  document.getElementById('referenceFile').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    UI.step('Step 3: Loading reference file…');
    UI.vclear('referenceStatus');
    UI.setFileName('refFileName', file.name);
    State.referenceFile = file.name;
    try {
      const raw = await Parser.loadFile(file);
      UI.pass('Reference raw rows: ' + raw.length);
      const data = Validator.validate('reference', raw, 'referenceStatus');
      if (!data) { UI.fail('Reference validation failed.'); return; }
      State.referenceRaw = data;
      State.refLabel = baseName(file.name);
      document.getElementById('refTagLabel').textContent = State.refLabel;
      UI.pass(`Reference accepted as “${State.refLabel}”.`);
      UI.progress(50);
      UI.step('Step 4: Checking temporal overlap…');
      UI.unlock('step4Section');
      checkOverlap();
    } catch (err) { UI.fail('Error: ' + err.message); }
  });

  document.getElementById('prepareBtn').addEventListener('click', doMerge);
  document.getElementById('sensorShiftLeft').addEventListener('click', () => { State.sensorShift--; realign(); });
  document.getElementById('sensorShiftRight').addEventListener('click', () => { State.sensorShift++; realign(); });
  document.getElementById('refShiftLeft').addEventListener('click', () => { State.refShift--; realign(); });
  document.getElementById('refShiftRight').addEventListener('click', () => { State.refShift++; realign(); });
  document.getElementById('resetAlignment').addEventListener('click', () => { State.sensorShift = 0; State.refShift = 0; realign(); });
  document.getElementById('downloadCSV').addEventListener('click', () => {
    Exporter.toCSV(Aligner.apply(State.mergedData, State.sensorShift, State.refShift));
  });
  document.getElementById('downloadExcel').addEventListener('click', () => {
    Exporter.toExcel(Aligner.apply(State.mergedData, State.sensorShift, State.refShift));
  });

  // Info panel toggle
  document.getElementById('infoToggle').addEventListener('click', () => {
    document.getElementById('infoPanel').classList.toggle('open');
  });

  UI.log('Tool ready. Select parameters to begin.', 'log-info');
});
