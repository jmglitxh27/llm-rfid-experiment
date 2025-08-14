import React, { useCallback, useState } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import FFT from "fft.js";

// =====================
// Numeric helpers
// =====================

function fmt(v, d=3) {
  if (v === null || v === undefined || Number.isNaN(v)) return "NA";
  return Number(v).toFixed(d);
}

function statLine(tagName, feats, cols) {
  // cols = array of selected feature keys to include
  const parts = [];
  for (const k of cols) {
    if (k in feats) parts.push(`${k.replaceAll('_',' ')} ${fmt(feats[k])}`);
  }
  // Example: "Tag 1 (detrended): mean 0.012, std 0.083, spectral entropy 0.742, ..."
  return `- ${tagName}: ${parts.join(", ")}.`;
}

function structuralParagraph(structRows) {
  // structRows: [{window_index, start_time, end_time, tag1_residual_label, ...}]
  if (!structRows || !structRows.length) return "";
  const lines = [];
  for (const r of structRows) {
    const s = fmt(r.start_time, 3), e = fmt(r.end_time, 3);
    const t1r = r.tag1_residual_label ?? "";
    const t2r = r.tag2_residual_label ?? "";
    const t1d = r.tag1_detrend_label ?? "";
    const t2d = r.tag2_detrend_label ?? "";
    lines.push(
      `• ${s}s–${e}s → tag1_res(${t1r}), tag2_res(${t2r}), tag1_det(${t1d}), tag2_det(${t2d})`
    );
  }
  return lines.join("\n");
}

// Build one structural table in memory (same as your LLM sheet logic)
function buildCombinedStructuralRows(time, series, winSec, hopSec, slidingWindowCaptions) {
  const WIN = Number(winSec), HOP = Number(hopSec);
  const makeRows = (arr) => {
    const raw = slidingWindowCaptions(time, arr, WIN, HOP);
    const T0 = time[0];
    return raw.map(r => {
      const nominalStart = T0 + r.window_index * HOP;
      const nominalEnd   = nominalStart + WIN;
      let si = time.findIndex(t => t >= nominalStart);
      if (si < 0) si = 0;
      let ei = si;
      for (let i = si; i < time.length && time[i] <= nominalEnd; i++) ei = i;
      return {
        window_index: r.window_index,
        start_time: time[si],
        end_time: time[ei] ?? nominalEnd,
        label: r.label
      };
    });
  };

  const tag1_res = makeRows(series.tag1_residual_rad);
  const tag2_res = makeRows(series.tag2_residual_rad);
  const tag1_det = makeRows(series.tag1_detrend_rad);
  const tag2_det = makeRows(series.tag2_detrend_rad);

  const byIdx = new Map();
  const merge = (rows, key) => {
    for (const r of rows) {
      if (!byIdx.has(r.window_index)) {
        byIdx.set(r.window_index, {
          window_index: r.window_index,
          start_time: r.start_time,
          end_time: r.end_time
        });
      }
      const row = byIdx.get(r.window_index);
      row.start_time = Math.min(row.start_time, r.start_time);
      row.end_time   = Math.max(row.end_time,   r.end_time);
      row[key] = r.label;
    }
  };
  merge(tag1_res, "tag1_residual_label");
  merge(tag2_res, "tag2_residual_label");
  merge(tag1_det, "tag1_detrend_label");
  merge(tag2_det, "tag2_detrend_label");

  return Array.from(byIdx.values()).sort((a,b)=>a.window_index-b.window_index);
}

const EPS = 1e-12;
const isFiniteNum = (v) => Number.isFinite(v) && !Number.isNaN(v);

function median(arr) {
  const a = [...arr].filter(isFiniteNum).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function medianAbsDeviation(arr) {
  const m = median(arr);
  const devs = arr.map((v) => Math.abs(v - m));
  return median(devs);
}
function autocorrDecayHalf(x) {
  const n = x.length;
  if (n < 3) return n;
  const mean = x.reduce((s, v) => s + v, 0) / n;
  const xc = x.map((v) => v - mean);
  const ac = new Array(n).fill(0);
  for (let lag = 0; lag < n; lag++) {
    let s = 0;
    for (let i = 0; i < n - lag; i++) s += xc[i] * xc[i + lag];
    ac[lag] = s;
  }
  if (Math.abs(ac[0]) < EPS) return 0;
  for (let i = 0; i < n; i++) ac[i] /= ac[0];
  for (let i = 1; i < n; i++) if (ac[i] < 0.5) return i;
  return n;
}
function spectralEntropy(power) {
  const sum = power.reduce((s, v) => s + v, 0);
  if (!(sum > 0)) return 0;
  let H = 0;
  for (let i = 0; i < power.length; i++) {
    const p = power[i] / sum;
    H += -p * Math.log2(p + EPS);
  }
  return H;
}
function isPowerOfTwo(n) { return n > 1 && (n & (n - 1)) === 0; }
function nextPow2(n) { let p = 1; while (p < Math.max(2, n)) p <<= 1; return p; }

function rfftPower(xIn, fs) {
  if (!isFiniteNum(fs) || fs <= 0) return { freqs: [], power: [] };
  const x = xIn.filter(isFiniteNum);
  let n = x.length;
  if (n < 2) return { freqs: [], power: [] };

  const xm = x.reduce((s, v) => s + v, 0) / n;
  const z = x.map((v) => v - xm);

  const N = isPowerOfTwo(n) ? n : nextPow2(n);
  const input = new Float64Array(N);
  input.set(z.slice(0, Math.min(n, N)));

  const out = new Float64Array(2 * N);
  const fft = new FFT(N);
  fft.realTransform(out, input);
  fft.completeSpectrum(out);

  const half = Math.floor(N / 2);
  const power = new Array(half + 1);
  for (let k = 0; k <= half; k++) {
    const re = out[2 * k];
    const im = out[2 * k + 1];
    power[k] = (re * re + im * im) / N;
  }
  const freqs = Array.from({ length: half + 1 }, (_, k) => (k * fs) / N);
  return { freqs, power };
}

function spectralFeatures(x, fs) {
  const n = x.length;
  if (!isFiniteNum(fs) || n < 8) {
    return {
      spectral_centroid: NaN,
      ent: NaN,
      f1: NaN,
      f1_power: NaN,
      band_0_2: NaN,
      band_2_5: NaN,
      band_5_10: NaN,
      band_10_20: NaN,
    };
  }
  const { freqs, power } = rfftPower(x, fs);
  if (!freqs.length) {
    return {
      spectral_centroid: NaN, ent: NaN, f1: NaN, f1_power: NaN,
      band_0_2: NaN, band_2_5: NaN, band_5_10: NaN, band_10_20: NaN,
    };
  }
  const sumP = power.reduce((s, v) => s + v, 0) + EPS;
  const sc = freqs.reduce((s, f, i) => s + f * power[i], 0) / sumP;
  const ent = spectralEntropy(power);
  let idx = 0; for (let i = 1; i < power.length; i++) if (power[i] > power[idx]) idx = i;
  const f1 = freqs[idx];
  const f1p = power[idx];
  const band = (a, b) => {
    let s = 0;
    for (let i = 0; i < freqs.length; i++) if (freqs[i] >= a && freqs[i] < b) s += power[i];
    return s;
  };
  return {
    spectral_centroid: sc,
    ent,
    f1,
    f1_power: f1p,
    band_0_2: band(0, 2),
    band_2_5: band(2, 5),
    band_5_10: band(5, 10),
    band_10_20: band(10, 20),
  };
}

function linearFitSlope(t, y) {
  const n = t.length;
  if (n < 2) return { m: NaN, r2: NaN };
  const sumT = t.reduce((s, v) => s + v, 0);
  const sumY = y.reduce((s, v) => s + v, 0);
  const sumTT = t.reduce((s, v) => s + v * v, 0);
  const sumTY = t.reduce((s, v, i) => s + v * y[i], 0);
  const denom = n * sumTT - sumT * sumT + EPS;
  const m = (n * sumTY - sumT * sumY) / denom;
  const b = (sumY - m * sumT) / n;
  const yhat = t.map((v) => m * v + b);
  const meanY = sumY / n;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) { const e = y[i] - yhat[i]; ssRes += e * e; const d = y[i] - meanY; ssTot += d * d; }
  const r2 = 1 - ssRes / (ssTot + EPS);
  return { m, r2 };
}

function medianDelta(time) {
  const dts = [];
  for (let i = 1; i < time.length; i++) { const dt = time[i] - time[i - 1]; if (isFiniteNum(dt) && dt > 0) dts.push(dt); }
  return median(dts);
}

function computeSeriesFeatures(time, yIn) {
  const timeClean = time.filter(isFiniteNum);
  const y = yIn.filter(isFiniteNum);
  const n = Math.min(timeClean.length, y.length);
  if (n < 4) {
    return {
      fs: NaN, n,
      mean: NaN, std: NaN, mad: NaN, rng: NaN, skew: NaN, kurt: NaN, cv: NaN,
      slope: NaN, slope_r2: NaN, ac_half: NaN,
      spectral_centroid: NaN, spectral_entropy: NaN,
      dom_freq: NaN, dom_power: NaN,
      band_0_2: NaN, band_2_5: NaN, band_5_10: NaN, band_10_20: NaN,
      low_mid_ratio: NaN,
    };
  }
  const yy = y.slice(0, n);
  const tt = timeClean.slice(0, n);

  const mean = yy.reduce((s, v) => s + v, 0) / n;
  const std = Math.sqrt(yy.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  const mad = medianAbsDeviation(yy);
  const rng = Math.max(...yy) - Math.min(...yy);
  const x0 = std > 0 ? yy.map((v) => (v - mean) / (std + EPS)) : yy.map(() => 0);
  const skew = x0.reduce((s, v) => s + v ** 3, 0) / n;
  const kurt = x0.reduce((s, v) => s + v ** 4, 0) / n - 3;
  const cv = std / (Math.abs(mean) + EPS);
  const { m: slope, r2: slope_r2 } = linearFitSlope(tt, yy);
  const ac_half = autocorrDecayHalf(yy);

  const dtMed = medianDelta(tt);
  const fs = isFiniteNum(dtMed) && dtMed > 0 ? 1 / dtMed : NaN;
  const spec = spectralFeatures(yy, fs);
  const low_mid = spec.band_0_2 / ((spec.band_2_5 || 0) + (spec.band_5_10 || 0) + EPS);

  return {
    fs, n, mean, std, mad, rng, skew, kurt, cv,
    slope, slope_r2, ac_half,
    spectral_centroid: spec.spectral_centroid,
    spectral_entropy: spec.ent,
    dom_freq: spec.f1, dom_power: spec.f1_power,
    band_0_2: spec.band_0_2, band_2_5: spec.band_2_5,
    band_5_10: spec.band_5_10, band_10_20: spec.band_10_20,
    low_mid_ratio: low_mid,
  };
}

// Build a single structural sheet with all tags as columns.
// rows = { window_index, start_time, end_time, tag1_residual_label, tag2_residual_label, tag1_detrend_label, tag2_detrend_label }
function buildCombinedStructuralSheet(time, series, winSec, hopSec) {
  const WIN = Number(winSec), HOP = Number(hopSec);
  const makeRows = (arr) => {
    const raw = slidingWindowCaptions(time, arr, WIN, HOP); // [{window_index,label}]
    const T0 = time[0];
    return raw.map(r => {
      const nominalStart = T0 + r.window_index * HOP;
      const nominalEnd   = nominalStart + WIN;
      let si = time.findIndex(t => t >= nominalStart);
      if (si < 0) si = 0;
      let ei = si;
      for (let i = si; i < time.length && time[i] <= nominalEnd; i++) ei = i;
      return { window_index: r.window_index, start_time: time[si], end_time: time[ei] ?? nominalEnd, label: r.label };
    });
  };

  const t1r = makeRows(series.tag1_residual_rad);
  const t2r = makeRows(series.tag2_residual_rad);
  const t1d = makeRows(series.tag1_detrend_rad);
  const t2d = makeRows(series.tag2_detrend_rad);

  const byIdx = new Map();
  const merge = (rows, key) => {
    for (const r of rows) {
      if (!byIdx.has(r.window_index)) byIdx.set(r.window_index, {
        window_index: r.window_index, start_time: r.start_time, end_time: r.end_time
      });
      const row = byIdx.get(r.window_index);
      row.start_time = Math.min(row.start_time, r.start_time);
      row.end_time   = Math.max(row.end_time,   r.end_time);
      row[key] = r.label;
    }
  };
  merge(t1r, "tag1_residual_label");
  merge(t2r, "tag2_residual_label");
  merge(t1d, "tag1_detrend_label");
  merge(t2d, "tag2_detrend_label");

  return Array.from(byIdx.values()).sort((a,b) => a.window_index - b.window_index);
}



function labelFromSlope(slope, sd, seconds) {
  const norm = Math.abs(slope) / (sd / (seconds || 1) + EPS);
  if (norm >= 1.5) return slope > 0 ? "sharp rise" : "sharp drop";
  if (norm >= 0.4) return slope > 0 ? "increasing" : "decreasing";
  return "constant";
}

function slidingWindowCaptions(time, y, winSec, hopSec) {
  const out = [];
  if (!time || time.length < 2) return out;
  const T0 = time[0];
  const T1 = time[time.length - 1];
  let k = 0;
  for (let start = T0; start <= T1 - 1e-9; start += hopSec, k++) {
    const end = start + winSec;
    const idx = [];
    for (let i = 0; i < time.length; i++) {
      const t = time[i];
      const inWin = t >= start && ((end < T1) ? t < end : t <= end);
      if (inWin) idx.push(i);
    }
    if (idx.length < 2) continue;
    const tk = idx.map((i) => time[i]);
    const yk = idx.map((i) => y[i]);
    const { m, r2 } = linearFitSlope(tk, yk);
    const mu = yk.reduce((s, v) => s + v, 0) / yk.length;
    const sd = Math.sqrt(yk.reduce((s, v) => s + (v - mu) ** 2, 0) / yk.length);
    const label = labelFromSlope(m, sd, winSec);
    out.push({ window_index: k, label });
  }
  return out;
}

// =====================
// UI
// =====================
export default function App() {
  const [files, setFiles] = useState([]);
  const [rowsByFile, setRowsByFile] = useState({});
  const [processing, setProcessing] = useState(false);
  const [log, setLog] = useState([]);
  const [winSec, setWinSec] = useState(1.0);
  const [hopSec, setHopSec] = useState(0.5);
  const [computedByFile, setComputedByFile] = useState({});

  // --- Feature selection + export options ---
const FEATURE_COLUMNS = [
  "fs","n","mean","std","mad","rng","skew","kurt","cv",
  "slope","slope_r2","ac_half",
  "spectral_centroid","spectral_entropy","dom_freq","dom_power",
  "band_0_2","band_2_5","band_5_10","band_10_20","low_mid_ratio"
];

const [useStat, setUseStat] = useState(true);
const [useStruct, setUseStruct] = useState(true);
const [selectedFeatCols, setSelectedFeatCols] = useState(new Set(FEATURE_COLUMNS));

  const onDrop = useCallback((ev) => {
    ev.preventDefault();
    const picked = [...ev.dataTransfer.files];
    setFiles((prev) => [...prev, ...picked]);
  }, []);
  const onPick = (ev) => {
    const picked = [...ev.target.files];
    setFiles((prev) => [...prev, ...picked]);
  };
  const prevent = (ev) => ev.preventDefault();

  const parseAll = async () => {
    setProcessing(true);
    setLog([]);
    const byFile = {};

    for (const f of files) {
      const text = await f.text();
      const parsed = Papa.parse(text, { header: true, dynamicTyping: true });
      const cols = parsed.meta.fields || [];
      const needed = [
        "time_s",
        "tag1_residual_rad",
        "tag2_residual_rad",
        "tag1_detrend_rad",
        "tag2_detrend_rad",
      ];
      const missing = needed.filter((c) => !cols.includes(c));
      if (missing.length) {
        setLog((L) => [...L, `${f.name}: missing columns ${missing.join(", ")}`]);
        continue;
      }

      const raw = parsed.data;
      const time = [];
      const tag1_residual_rad = [], tag2_residual_rad = [];
      const tag1_detrend_rad = [], tag2_detrend_rad = [];
      for (const r of raw) {
        const t = Number(r.time_s);
        const a1 = Number(r.tag1_residual_rad);
        const a2 = Number(r.tag2_residual_rad);
        const d1 = Number(r.tag1_detrend_rad);
        const d2 = Number(r.tag2_detrend_rad);
        if ([t, a1, a2, d1, d2].every(isFiniteNum)) {
          time.push(t);
          tag1_residual_rad.push(a1); tag2_residual_rad.push(a2);
          tag1_detrend_rad.push(d1);  tag2_detrend_rad.push(d2);
        }
      }
      if (time.length < 8) {
        setLog((L) => [...L, `${f.name}: too few valid rows after cleaning (${time.length})`]);
        continue;
      }
      // enforce strictly increasing time
      for (let i = 1; i < time.length; i++) if (!(time[i] > time[i - 1])) time[i] = time[i - 1] + 1e-6;

      byFile[f.name] = {
        time,
        series: { tag1_residual_rad, tag2_residual_rad, tag1_detrend_rad, tag2_detrend_rad },
      };
      setLog((L) => [...L, `${f.name}: parsed ${time.length} cleaned rows`]);
    }

    setRowsByFile(byFile);
    setProcessing(false);
  };
  const buildPromptForFile = (fname, time, series, cached, wantedFeatureCols, useStat, useStruct) => {
    // Header (you can tweak to your favorite prompt style)
    const header = `You classify indoor environments (Bedroom, Corridor, Home Office, Lab) from RFID phase summaries.\n` +
        `Return: a single label and one sentence of rationale.\n`;

    // Statistical section
    let statSection = "";
    if (useStat) {
        // Look up the four rows we computed in runExtraction
        const getRow = (col) => cached.featureRows.find(r => r.column === col) || {};
        const t1r = getRow("tag1_residual_rad");
        const t2r = getRow("tag2_residual_rad");
        const t1d = getRow("tag1_detrend_rad");
        const t2d = getRow("tag2_detrend_rad");

        statSection =
        `\nStatistical features (selected):\n` +
        statLine("Tag 1 (residual)", t1r, wantedFeatureCols) + "\n" +
        statLine("Tag 2 (residual)", t2r, wantedFeatureCols) + "\n" +
        statLine("Tag 1 (detrended)", t1d, wantedFeatureCols) + "\n" +
        statLine("Tag 2 (detrended)", t2d, wantedFeatureCols) + "\n";
    }

    // Structural section
    let structSection = "";
    if (useStruct) {
        const rows = buildCombinedStructuralRows(time, series, winSec, hopSec, slidingWindowCaptions);
        structSection = `\nStructural labels by time window:\n` + structuralParagraph(rows) + "\n";
    }

    const footer = `\nOutput format:\nLabel: <Bedroom|Corridor|Home Office|Lab> — <≤20 words reason>`;

    return `File: ${fname}\n${header}${statSection}${structSection}${footer}\n`;
    };
    function downloadText(filename, text) {
        const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = filename; a.click();
        URL.revokeObjectURL(url);
        }

    function buildLLMPrompts(captionsByTag) {
    // captionsByTag is an object: { tagName: [{window_index, start_time, end_time, label}, ...], ... }

    // Merge all tag arrays by window_index
    const merged = {};
        for (const [tagName, rows] of Object.entries(captionsByTag)) {
            rows.forEach(row => {
            if (!merged[row.window_index]) {
                merged[row.window_index] = {
                start_time: row.start_time,
                end_time: row.end_time,
                };
            }
            merged[row.window_index][tagName] = row.label;
            });
        }

        // Build prompts
        const prompts = Object.values(merged)
            .sort((a, b) => a.start_time - b.start_time)
            .map(row => {
            return `Between ${row.start_time.toFixed(3)} - ${row.end_time.toFixed(3)} seconds, ` +
                `Tag 1 (residual) is ${row.tag1_residual_rad || "unknown"}. ` +
                `Tag 2 (residual) is ${row.tag2_residual_rad || "unknown"}. ` +
                `Tag 1 (detrended) is ${row.tag1_detrend_rad || "unknown"}. ` +
                `Tag 2 (detrended) is ${row.tag2_detrend_rad || "unknown"}.`;
            });

        return prompts;
    }



  const exportLLMPackage = async () => {
    if (!Object.keys(rowsByFile).length) return;

    const WIN = Number(winSec);
    const HOP = Number(hopSec);

    for (const [fname, { time, series }] of Object.entries(rowsByFile)) {
        // get cached results or compute on the fly
        let cached = computedByFile[fname];
        if (!cached) {
        const featureRows = [];
        for (const [key, arr] of Object.entries(series)) {
            const feats = computeSeriesFeatures(time, arr);
            featureRows.push({ file: fname, column: key, ...feats });
        }
        const captions = {
            tag1_residual_rad: slidingWindowCaptions(time, series.tag1_residual_rad, WIN, HOP),
            tag2_residual_rad: slidingWindowCaptions(time, series.tag2_residual_rad, WIN, HOP),
            tag1_detrend_rad:  slidingWindowCaptions(time, series.tag1_detrend_rad,  WIN, HOP),
            tag2_detrend_rad:  slidingWindowCaptions(time, series.tag2_detrend_rad,  WIN, HOP),
        };
        cached = { featureRows, captions };
        }

        // -------- STRUCTURAL: one sheet with all tag labels --------
        const wbStruct = XLSX.utils.book_new();
        const structuralRows = buildCombinedStructuralSheet(time, series, WIN, HOP);
        const wsStructural = XLSX.utils.json_to_sheet(
        structuralRows.length
            ? structuralRows
            : [{ window_index:"", start_time:"", end_time:"", tag1_residual_label:"", tag2_residual_label:"", tag1_detrend_label:"", tag2_detrend_label:"" }]
        );
        XLSX.utils.book_append_sheet(wbStruct, wsStructural, "structural");
        const structName = fname.replace(/\.[^.]+$/, "") + "_LLM_structural.xlsx";
        XLSX.writeFile(wbStruct, structName);
        setLog(L => [...L, `${fname}: exported ${structName}`]);

        // -------- STATISTICAL: one sheet (use your selected columns) --------
        const wbStat = XLSX.utils.book_new();
        const rows = [];
        const wanted = Array.from(selectedFeatCols); // <- your selected columns Set
        for (const key of [
        "tag1_residual_rad","tag2_residual_rad","tag1_detrend_rad","tag2_detrend_rad"
        ]) {
        const full = cached.featureRows.find(r => r.column === key);
        if (!full) continue;
        const filtered = { column: key };
        for (const col of wanted) filtered[col] = full[col];
        rows.push(filtered);
        }
        const wsStat = XLSX.utils.json_to_sheet(rows.length ? rows : [{ column: "" }]);
        XLSX.utils.book_append_sheet(wbStat, wsStat, "statistical");
        const statName = fname.replace(/\.[^.]+$/, "") + "_LLM_statistical.xlsx";
        XLSX.writeFile(wbStat, statName);
        setLog(L => [...L, `${fname}: exported ${statName}`]);
    }

    setLog(L => [...L, "LLM export complete."]);
    };



  const runExtraction = async () => {
    setProcessing(true);
    setLog(L => [...L, `Computing features + captions (no export)… win=${winSec}s, hop=${hopSec}s`]);

    const WIN = Number(winSec);
    const HOP = Number(hopSec);
    const next = {};

    for (const [fname, { time, series }] of Object.entries(rowsByFile)) {
        // ---- features for all four series
        const featureRows = [];
        for (const [key, arr] of Object.entries(series)) {
        const feats = computeSeriesFeatures(time, arr);
        featureRows.push({ file: fname, column: key, ...feats });
        }

        // ---- captions (per tag)
        const captions = {
        tag1_residual_rad: slidingWindowCaptions(time, series.tag1_residual_rad, WIN, HOP),
        tag2_residual_rad: slidingWindowCaptions(time, series.tag2_residual_rad, WIN, HOP),
        tag1_detrend_rad:  slidingWindowCaptions(time, series.tag1_detrend_rad,  WIN, HOP),
        tag2_detrend_rad:  slidingWindowCaptions(time, series.tag2_detrend_rad,  WIN, HOP),
        };

        next[fname] = { featureRows, captions };
        setLog(L => [...L, `${fname}: computed & cached (${featureRows.length} feature rows, captions per tag).`]);
    }

    setComputedByFile(next);
    setProcessing(false);
    setLog(L => [...L, "Compute step finished. Use step 3 to export LLM sheets."]);
    };



  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 p-6">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-3xl font-semibold mb-4">RFID Phase Feature Extractor</h1>
        <p className="text-sm text-gray-600 mb-6">
          Drop CSVs with columns: <code>time_s, tag1_residual_rad, tag2_residual_rad, tag1_detrend_rad, tag2_detrend_rad</code>.
          Then extract statistical features and sliding-window structural captions. Two Excel files are produced per input.
        </p>

        <div
          onDrop={onDrop}
          onDragOver={prevent}
          onDragEnter={prevent}
          onDragLeave={prevent}
          className="border-2 border-dashed border-gray-300 rounded-2xl p-8 flex flex-col items-center justify-center bg-white shadow-sm"
        >
          <p className="mb-4">Drag & drop CSV files here</p>
          <input id="filepick" type="file" accept=".csv" multiple onChange={onPick} className="hidden" />
          <label htmlFor="filepick" className="px-4 py-2 rounded-xl bg-black text-white hover:opacity-90 cursor-pointer">Browse files</label>
        </div>

        {files.length > 0 && (
          <div className="mt-6 bg-white rounded-2xl p-4 shadow-sm">
            <h2 className="font-semibold mb-2">Selected files</h2>
            <ul className="list-disc list-inside text-sm text-gray-700">
              {files.map((f, i) => (<li key={i}>{f.name}</li>))}
            </ul>
          </div>
        )}
        {/* Export options */}
        <div className="mt-6 bg-white rounded-2xl p-4 shadow-sm">
        <h2 className="font-semibold mb-3">LLM export options</h2>

        <div className="flex flex-wrap gap-4">
            <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={useStat} onChange={e=>setUseStat(e.target.checked)} />
            <span>Include <b>Statistical</b> features</span>
            </label>
            <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={useStruct} onChange={e=>setUseStruct(e.target.checked)} />
            <span>Include <b>Structural</b> captions</span>
            </label>
        </div>

        {/* Statistical column picker */}
        <div className="mt-4">
            <p className="text-sm text-gray-700 mb-2">Statistical columns to include:</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {FEATURE_COLUMNS.map(col => (
                <label key={col} className="inline-flex items-center gap-2">
                <input
                    type="checkbox"
                    checked={selectedFeatCols.has(col)}
                    onChange={(e) => {
                    setSelectedFeatCols(prev => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(col);
                        else next.delete(col);
                        return next;
                    });
                    }}
                />
                <span className="text-sm">{col}</span>
                </label>
            ))}
            </div>
        </div>
        </div>


        <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white p-4 rounded-2xl shadow-sm">
            <label className="block text-sm font-medium">Window (s)</label>
            <input type="number" step="0.1" value={winSec} onChange={(e)=>setWinSec(parseFloat(e.target.value)||1.0)} className="mt-1 w-full border rounded-lg px-3 py-2" />
          </div>
          <div className="bg-white p-4 rounded-2xl shadow-sm">
            <label className="block text-sm font-medium">Hop (s)</label>
            <input type="number" step="0.1" value={hopSec} onChange={(e)=>setHopSec(parseFloat(e.target.value)||0.5)} className="mt-1 w-full border rounded-lg px-3 py-2" />
          </div>
          <div className="flex items-end">
            <button onClick={parseAll} disabled={!files.length || processing} className="w-full px-4 py-3 rounded-xl bg-blue-600 text-white shadow hover:bg-blue-700 disabled:opacity-50">
              1) Read files
            </button>
          </div>
        </div>

        <div className="mt-4">
          <button
            onClick={runExtraction}
            disabled={!Object.keys(rowsByFile).length || processing}
            className="w-full md:w-auto px-6 py-3 rounded-xl bg-emerald-600 text-white shadow hover:bg-emerald-700 disabled:opacity-50"
            >
            2) Compute (no export)
            </button>
        </div>

        <div className="mt-4">
            <button
            onClick={exportLLMPackage}
            disabled={!Object.keys(rowsByFile).length || processing}
            className="w-full md:w-auto px-6 py-3 rounded-xl bg-purple-600 text-white shadow hover:bg-purple-700 disabled:opacity-50"
            >
            3) Build LLM sheets → export 2 files
            </button>
            </div>
            <div className="mt-4">
            <button
                onClick={buildLLMPrompts}
                disabled={!Object.keys(rowsByFile).length || processing}
                className="w-full md:w-auto px-6 py-3 rounded-xl bg-indigo-600 text-white shadow hover:bg-indigo-700 disabled:opacity-50"
            >
                4) Build LLM prompt(s) → .txt
            </button>
            </div>



        <div className="mt-6 bg-white p-4 rounded-2xl shadow-sm">
          <h3 className="font-semibold mb-2">Log</h3>
          <div className="text-sm whitespace-pre-wrap text-gray-700 min-h-[80px]">
            {processing ? "Processing..." : log.join("")}
          </div>
        </div>
      </div>
    </div>
  );
}
