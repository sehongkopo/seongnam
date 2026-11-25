/* 공통 로직: 데이터 읽기, 경보 규칙, 설정 저장. index.html 과 admin.html 이 함께 쓴다. */
'use strict';
const FM = (() => {
  /* ---------- 열 이름 ---------- */
  // data.csv 형식(Time (s), Temp PV …)과 ARA 배양기 로그 형식(Count, pH, DO, Temp, RPM, ACID, BASE …)을 모두 받는다.
  const COLS = {
    t: /^time\s*\(s\)/i, date: /^date$|^datetime$|^timestamp$/i,
    tsp: /^temp.*\bsp\b/i, T: /^temp(?!.*\bsp\b)/i,
    phsp: /^ph.*\bsp\b/i, pH: /^ph(?!.*\bsp\b)/i,
    dosp: /^do.*\bsp\b/i, DO: /^do(?!.*\bsp\b)(\b|\s|$)/i,
    rpm: /agitation|^rpm$|^stirr/i,
    na: /naoh\s*pump/i, hc: /hcl\s*pump/i,
    nac: /naoh\s*cum|^base$/i, hcc: /hcl\s*cum|^acid$/i,
    od: /od600/i, ev: /^event/i,
  };
  const REQUIRED = ['T', 'pH', 'DO', 'rpm'];
  const NAMES = { t: '시간(s)', date: '날짜·시각', tsp: '온도 SP', T: '온도', phsp: 'pH SP', pH: 'pH', dosp: 'DO SP', DO: 'DO',
    rpm: '교반', na: 'NaOH 펌프 상태', hc: 'HCl 펌프 상태', nac: 'NaOH 누적', hcc: 'HCl 누적', od: 'OD600', ev: '이벤트' };

  /* ---------- 경보 기준 (관리자 페이지에서 바꿀 수 있다) ---------- */
  const DEF_TH = {
    T_warn: 0.3, T_dang: 1.0,        // |온도 - SP| (°C)
    pH_warn: 0.025, pH_dang: 0.05,   // |pH - SP|
    DO_warn: 5, DO_dang: 30,         // DO < SP - DO_warn (주의), DO < DO_dang % (위험)
    DO_high: 10,                     // DO 가 최근 5분 최저값보다 DO_high 넘게 올라 SP 위에 60 s 머물면 기질 고갈 의심
    rpm_warn: 700, rpm_dang: 800,    // 교반 상한 근접·도달
    pump_max: 60,                    // 펌프 연속 가동 (s)
    suppress: 900,                   // SP 변경 뒤 편차 경보 억제 (s)
  };
  const TH_INFO = [
    ['T_warn', '온도 편차 주의', '°C'], ['T_dang', '온도 편차 위험', '°C'],
    ['pH_warn', 'pH 편차 주의', ''], ['pH_dang', 'pH 편차 위험', ''],
    ['DO_warn', 'DO 저하 주의 (SP 아래)', '%p'], ['DO_dang', 'DO 저하 위험 (절대값)', '%'],
    ['DO_high', 'DO 급등 (최근 5분 최저값 대비 상승)', '%p'],
    ['rpm_warn', '교반 상한 근접', 'rpm'], ['rpm_dang', '교반 상한 도달', 'rpm'],
    ['pump_max', '펌프 연속 가동 한도', 's'], ['suppress', 'SP 변경 뒤 편차 경보 억제', 's'],
  ];

  /* ---------- 설정 (브라우저마다 따로 저장) ---------- */
  const KEY = 'fm.settings';
  const bc = 'BroadcastChannel' in window ? new BroadcastChannel('fm') : null;
  function settings() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
  function saveSettings(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} if (bc) bc.postMessage('settings'); }
  function thresholds() { return { ...DEF_TH, ...(settings().th || {}) }; }
  function todayMidnight() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function runStart(s = settings()) { return s.start || todayMidnight(); }

  /* ---------- 올린 파일 (IndexedDB) ---------- */
  function idb() {
    return new Promise((ok, no) => {
      const r = indexedDB.open('fm', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
    });
  }
  async function idbDo(mode, fn) {
    const db = await idb();
    return new Promise((ok, no) => {
      const tx = db.transaction('files', mode), st = tx.objectStore('files'), r = fn(st);
      tx.oncomplete = () => ok(r && r.result); tx.onerror = () => no(tx.error);
    });
  }
  const getUpload = () => idbDo('readonly', st => st.get('current')).catch(() => null);
  const putUpload = rec => idbDo('readwrite', st => st.put(rec, 'current')).then(() => bc && bc.postMessage('data'));
  const clearUpload = () => idbDo('readwrite', st => st.delete('current')).then(() => bc && bc.postMessage('data'));

  /* ---------- CSV ---------- */
  function parseCSV(txt) {
    const out = [];
    for (const ln of txt.replace(/^﻿/, '').split(/\r?\n/)) {
      if (!ln.trim()) continue;
      if (ln.indexOf('"') < 0) { out.push(ln.split(',')); continue; }
      const r = []; let cur = '', q = false;
      for (let i = 0; i < ln.length; i++) {
        const ch = ln[i];
        if (q) { if (ch === '"') { if (ln[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
        else if (ch === '"') q = true; else if (ch === ',') { r.push(cur); cur = ''; } else cur += ch;
      }
      r.push(cur); out.push(r);
    }
    return out;
  }
  const toCSV = rows => rows.map(r => r.map(v => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',')).join('\n');
  const num = v => { if (v == null || v === '') return NaN; if (typeof v === 'number') return v; const s = String(v).trim().replace(/,/g, ''); return s === '' ? NaN : +s; };
  // "2026-10-29 PM 12:00:08", "2026-10-29 오후 12:00:08", "2026-10-29 12:00:08"
  function parseDate(v) {
    const m = String(v).trim().match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})\s*(AM|PM|오전|오후)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/i);
    if (!m) return NaN;
    let h = +m[5]; const ap = (m[4] || '').toUpperCase();
    if ((ap === 'PM' || ap === '오후') && h < 12) h += 12;
    if ((ap === 'AM' || ap === '오전') && h === 12) h = 0;
    return new Date(+m[1], +m[2] - 1, +m[3], h, +m[6], +(m[7] || 0)).getTime() / 1000;
  }

  function matchColumns(header) {
    const ix = {}, used = new Set();
    for (const k in COLS) {
      ix[k] = header.findIndex((h, j) => !used.has(j) && COLS[k].test(String(h ?? '').trim()));
      if (ix[k] >= 0) used.add(ix[k]);
    }
    return ix;
  }

  /* 표(header + rows)를 데이터 객체로 만든다. 열 이름이 맞지 않으면 오류를 던진다. */
  function build(header, rows) {
    const ix = matchColumns(header);
    const miss = REQUIRED.filter(k => ix[k] < 0);
    if (miss.length) throw new Error('필수 열이 없습니다: ' + miss.map(k => NAMES[k]).join(', '));
    rows = rows.filter(r => r && r.length > 1 && !isNaN(num(r[ix.T])));
    const n = rows.length;
    if (n < 2) throw new Error('데이터 행이 2개 미만입니다.');
    const D = { n, ix, header };
    for (const k in COLS) {
      if (k === 'ev' || k === 'date') continue;
      const a = new Float64Array(n), j = ix[k];
      for (let i = 0; i < n; i++) a[i] = j < 0 ? NaN : num(rows[i][j]);
      D[k] = a;
    }
    // 시간: Time (s) 열 → 날짜 열 → 행 번호(1 s)
    if (ix.t < 0) {
      let ok = false;
      if (ix.date >= 0) {
        const s0 = parseDate(rows[0][ix.date]);
        if (!isNaN(s0)) { ok = true; for (let i = 0; i < n; i++) { const s = parseDate(rows[i][ix.date]); D.t[i] = isNaN(s) ? (i ? D.t[i - 1] + 1 : 0) : s - s0; } }
      }
      if (!ok) for (let i = 0; i < n; i++) D.t[i] = i;
    } else { const t0 = D.t[0]; for (let i = 0; i < n; i++) D.t[i] -= t0; }
    for (let i = 1; i < n; i++) if (!(D.t[i] > D.t[i - 1])) D.t[i] = D.t[i - 1] + 1e-3;   // 단조 증가 보장
    const dts = []; for (let i = 1; i < Math.min(n, 200); i++) dts.push(D.t[i] - D.t[i - 1]);
    dts.sort((a, b) => a - b); D.dt = Math.max(1e-3, dts[dts.length >> 1]);
    D.period = D.t[n - 1] + D.dt;
    // 펌프 상태가 없으면 누적량이 늘어난 시점을 가동으로 본다.
    for (const [p, c] of [['na', 'nac'], ['hc', 'hcc']]) if (ix[p] < 0 && ix[c] >= 0) for (let i = 1; i < n; i++) D[p][i] = D[c][i] > D[c][i - 1] + 1e-9 ? 1 : 0;
    for (const p of ['na', 'hc']) for (let i = 0; i < n; i++) if (isNaN(D[p][i])) D[p][i] = 0;
    D.events = [];
    if (ix.ev >= 0) rows.forEach((r, i) => { const v = r[ix.ev]; if (v != null && String(v).trim()) D.events.push({ i, text: String(v).trim() }); });
    return D;
  }

  /* t(초) → 행 번호 */
  function indexAt(D, s) {
    let lo = 0, hi = D.n - 1;
    if (s <= D.t[0]) return 0; if (s >= D.t[hi]) return hi;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (D.t[m] <= s) lo = m; else hi = m - 1; }
    return lo;
  }

  /* ---------- 경보 규칙 ---------- */
  // 각 규칙은 행마다 0(정상)·1(주의)·2(위험)을 낸다. hold 초 이상 이어져야 켜지고, 5 s 동안 정상이어야 꺼진다.
  function rules(D, th) {
    const n = D.n, spT = D.tsp, spP = D.phsp, spD = D.dosp;
    const sinceSP = new Float64Array(n);   // 마지막 SP 변경 뒤 경과 시간
    let lastChange = -Infinity;
    for (let i = 0; i < n; i++) {
      if (i && ((Math.abs(spT[i] - spT[i - 1]) > 1e-6) || (Math.abs(spP[i] - spP[i - 1]) > 1e-6))) lastChange = D.t[i];
      sinceSP[i] = D.t[i] - lastChange;
    }
    const run = p => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = D[p][i] > 0 ? (i ? a[i - 1] : 0) + (i ? D.t[i] - D.t[i - 1] : D.dt) : 0; return a; };
    const runNa = run('na'), runHc = run('hc');
    // 최근 5분 동안의 DO 최저값 (급등 판정용)
    const doMin = new Float64Array(n), dq = [];
    for (let i = 0; i < n; i++) {
      const v = D.DO[i];
      while (dq.length && !(D.DO[dq[dq.length - 1]] < v)) dq.pop();
      dq.push(i);
      while (D.t[dq[0]] < D.t[i] - 300) dq.shift();
      doMin[i] = D.DO[dq[0]];
    }
    const dev = (v, sp, w, d) => { if (isNaN(sp) || isNaN(v)) return 0; const e = Math.abs(v - sp); return e > d ? 2 : e > w ? 1 : 0; };
    const sensorBad = i => (D.pH[i] < 2 || D.pH[i] > 12) || (D.DO[i] < -2 || D.DO[i] > 130) || (D.T[i] < 5 || D.T[i] > 60);
    return [
      { id: 'T', name: '온도 편차', ch: 'T', hold: 30, f: i => sinceSP[i] < th.suppress || sensorBad(i) ? 0 : dev(D.T[i], spT[i], th.T_warn, th.T_dang) },
      { id: 'pH', name: 'pH 편차', ch: 'pH', hold: 10, f: i => sinceSP[i] < th.suppress || sensorBad(i) ? 0 : dev(D.pH[i], spP[i], th.pH_warn, th.pH_dang) },
      { id: 'DOlo', name: 'DO 저하', ch: 'DO', hold: 10, f: i => sensorBad(i) ? 0 : D.DO[i] < th.DO_dang ? 2 : (!isNaN(spD[i]) && D.DO[i] < spD[i] - th.DO_warn) ? 1 : 0 },
      { id: 'DOhi', name: 'DO 급등 · 기질 고갈 의심', ch: 'DO', hold: 60, f: i => !sensorBad(i) && !isNaN(spD[i]) && D.DO[i] > spD[i] + 3 && D.DO[i] - doMin[i] > th.DO_high ? 1 : 0 },
      { id: 'rpm', name: '교반 상한', ch: 'rpm', hold: 30, f: i => D.rpm[i] >= th.rpm_dang ? 2 : D.rpm[i] >= th.rpm_warn ? 1 : 0 },
      { id: 'pump', name: '펌프 연속 가동', ch: 'pump', hold: 0, f: i => runNa[i] > th.pump_max || runHc[i] > th.pump_max ? 2 : 0 },
      { id: 'both', name: '산·염기 동시 투입', ch: 'pump', hold: 0, f: i => D.na[i] > 0 && D.hc[i] > 0 ? 2 : 0 },
      { id: 'sensor', name: '센서 값 이상', ch: 'all', hold: 5, f: i => sensorBad(i) ? 2 : 0 },
    ];
  }

  /* 규칙마다 행별 상태 배열(lv)과 상태 변화 목록(changes)을 만든다. */
  function evaluate(D, th = thresholds()) {
    const R = rules(D, th), n = D.n, changes = [];
    for (const r of R) {
      const lv = new Uint8Array(n);
      let cur = 0, onT = null, offT = null;
      for (let i = 0; i < n; i++) {
        const raw = r.f(i), t = D.t[i];
        if (raw > 0) { if (onT === null) onT = t; offT = null; } else { onT = null; if (offT === null) offT = t; }
        let nxt = cur;
        if (cur === 0) { if (raw > 0 && t - onT >= r.hold) nxt = raw; }
        else if (raw > 0) nxt = raw;
        else if (t - offT >= 5) nxt = 0;
        if (nxt !== cur) changes.push({ i, rule: r.id, from: cur, to: nxt });
        cur = nxt; lv[i] = cur;
      }
      r.lv = lv;
    }
    changes.sort((a, b) => a.i - b.i);
    return { rules: R, changes, th };
  }

  /* 기본 data.csv 또는 관리자 페이지에서 올린 파일을 읽는다. */
  async function loadData() {
    const up = await getUpload();
    if (up && up.csv) {
      try { const rows = parseCSV(up.csv); return { D: build(rows[0], rows.slice(1)), source: up.name, uploaded: true, savedAt: up.savedAt }; }
      catch (e) { console.warn('올린 파일을 읽지 못해 기본 데이터로 돌아갑니다', e); }
    }
    const r = await fetch('data.csv', { cache: 'no-cache' });
    if (!r.ok) throw new Error('data.csv 를 받지 못했습니다 (' + r.status + ')');
    const rows = parseCSV(await r.text());
    return { D: build(rows[0], rows.slice(1)), source: 'data.csv', uploaded: false };
  }

  /* 실시간 가정: 배양 시작 시각부터 흐른 시간(× 배속)을 기록의 시간축에 맞춘다. */
  function liveClock(D, s = settings(), now = Date.now()) {
    const speed = s.speed || 1, loop = s.loop !== false, start = runStart(s);
    let el = (now - start) / 1000 * speed;
    if (el < 0) return { i: 0, el: 0, waiting: true, start, speed, loop, cycle: 0 };
    const cycle = Math.floor(el / D.period);
    if (loop) el -= cycle * D.period; else if (el >= D.period) return { i: D.n - 1, el: D.t[D.n - 1], ended: true, start, speed, loop, cycle: 0 };
    return { i: indexAt(D, el), el, start, speed, loop, cycle };
  }

  const hms = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return [h, m, x].map(v => String(v).padStart(2, '0')).join(':'); };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = ms => { const d = new Date(ms), p = v => String(v).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

  return { COLS, NAMES, REQUIRED, DEF_TH, TH_INFO, settings, saveSettings, thresholds, runStart, todayMidnight,
    getUpload, putUpload, clearUpload, parseCSV, toCSV, matchColumns, build, indexAt, evaluate, loadData, liveClock,
    hms, esc, fmtDate, bc };
})();
