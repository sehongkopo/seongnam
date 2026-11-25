/* 공통 로직: 데이터 읽기, 단계·피크 판정, 경보 규칙, 설정 저장. index.html 과 admin.html 이 함께 쓴다. */
'use strict';
const FP = (() => {
  /* ---------- 열 이름 ---------- */
  // ÄKTA 내보내기 표: Time (min), Volume (mL), UV 280 (mAU), Cond (mS/cm), Conc B (%), Flow (mL/min), System pressure (MPa), pH, Fraction, Run log
  const COLS = {
    t: /^time/i, vol: /^vol/i, uv: /uv|a280|absorb/i, cond: /^cond/i, B: /conc\.?\s*b|%\s*b\b|^b\s*[(%]/i,
    flow: /flow/i, P: /press/i, pH: /^ph\b/i, frac: /^frac/i, ev: /run\s*log|logbook|^event/i,
  };
  const REQUIRED = ['t', 'uv'];
  const NAMES = { t: '시간', vol: '부피', uv: 'UV 280', cond: '전도도', B: '농도 B', flow: '유량', P: '압력', pH: 'pH', frac: '분획 번호', ev: '런 로그' };
  const CH = {
    uv: { name: 'UV 280', unit: 'mAU', d: 1, c: '--uv' }, cond: { name: '전도도', unit: 'mS/cm', d: 2, c: '--cond' },
    B: { name: '농도 B', unit: '%', d: 1, c: '--B' }, P: { name: '압력', unit: 'MPa', d: 3, c: '--P' },
    flow: { name: '유량', unit: 'mL/min', d: 3, c: '--flow' }, pH: { name: 'pH', unit: '', d: 2, c: '--pH' },
  };

  /* ---------- 단계 ---------- */
  // 런 로그 문장에서 단계를 읽는다. 위에서부터 먼저 맞는 것을 쓴다.
  const PHASES = [
    { id: 'none', name: '대기', col: '#adb5bd' }, { id: 'equil', name: '평형화', col: '#8fa3ad' }, { id: 'load', name: '시료 주입', col: '#e8a33d' },
    { id: 'wash', name: '세척', col: '#4dabf7' }, { id: 'elute', name: '용출', col: '#9775fa' }, { id: 'strip', name: '스트립', col: '#f06595' },
    { id: 'reeq', name: '재평형화', col: '#51cf66' }, { id: 'end', name: '종료', col: '#868e96' }];
  const PH_RE = [
    ['reeq', /re-?\s*equil|재평형/i], ['end', /method\s*end|run\s*end/i], ['strip', /strip|100\s*%\s*b\s*hold|cip/i],
    ['elute', /gradient|elut|용출|구배/i], ['wash', /wash|세척/i], ['load', /inject|sample\s*app|시료/i], ['equil', /equil|평형/i]];
  const phaseOf = text => { for (const [id, re] of PH_RE) if (re.test(text)) return PHASES.findIndex(p => p.id === id); return -1; };

  /* ---------- 기준값 (관리자 페이지에서 바꿀 수 있다) ---------- */
  const DEF_TH = {
    P_warn: 0.40, P_dang: 0.50,      // 압력 상한 (MPa)
    P_rise: 0.10,                    // 최근 60 s 최저값 대비 상승 (MPa)
    P_low: 0.05,                     // 유량이 있는데 압력이 이보다 낮음 (MPa)
    flow_sp: 0,                      // 설정 유량 (mL/min), 0 이면 기록의 중앙값
    flow_warn: 5, flow_dang: 10,     // 유량 편차 (%)
    UV_warn: 2000, UV_dang: 3000,    // UV 흡광도 (mAU)
    base_max: 10,                    // 용출 시작 시점의 UV 상한 (mAU)
    grad_min: 0.2,                   // %B 가 10 %p 변하는 동안 전도도 변화의 하한 (mS/cm)
    pH_lo: 6.8, pH_hi: 8.0,          // pH 정상 범위
    pk_min: 50,                      // 피크로 보는 UV 하한 (mAU)
    cv: 1,                           // 컬럼 부피 (mL)
    imA: 20, imB: 500,               // 완충액 A, B 의 이미다졸 농도 (mM)
  };
  const TH_INFO = [
    ['P_warn', '압력 상한 주의', 'MPa'], ['P_dang', '압력 상한 위험', 'MPa'],
    ['P_rise', '압력 급상승 (최근 60 s 최저값 대비)', 'MPa'], ['P_low', '압력 저하 위험', 'MPa'],
    ['flow_sp', '설정 유량 (0 이면 기록의 중앙값)', 'mL/min'], ['flow_warn', '유량 편차 주의', '%'], ['flow_dang', '유량 편차 위험', '%'],
    ['UV_warn', 'UV 범위 초과 주의', 'mAU'], ['UV_dang', 'UV 범위 초과 위험', 'mAU'],
    ['base_max', '용출 시작 시점의 UV 상한', 'mAU'], ['grad_min', '구배 중 전도도 변화 하한', 'mS/cm'],
    ['pH_lo', 'pH 정상 범위 하한', ''], ['pH_hi', 'pH 정상 범위 상한', ''],
    ['pk_min', '피크로 보는 UV 하한', 'mAU'], ['cv', '컬럼 부피', 'mL'],
    ['imA', '완충액 A 이미다졸', 'mM'], ['imB', '완충액 B 이미다졸', 'mM'],
  ];

  /* ---------- 설정 (브라우저마다 따로 저장) ---------- */
  const KEY = 'fp.settings';
  const bc = 'BroadcastChannel' in window ? new BroadcastChannel('fp') : null;
  function settings() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
  function saveSettings(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} if (bc) bc.postMessage('settings'); }
  function thresholds() { return { ...DEF_TH, ...(settings().th || {}) }; }
  function todayMidnight() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function runStart(s = settings()) { return s.start || todayMidnight(); }

  /* ---------- 올린 파일 (IndexedDB) ---------- */
  function idb() {
    return new Promise((ok, no) => {
      const r = indexedDB.open('fp', 1);
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

  /* ---------- 글자 인코딩과 표 읽기 ---------- */
  // 장비 PC 에서 내보낸 파일은 UTF-8 이 아닐 수 있다. UTF-16(BOM) → UTF-8 → EUC-KR 순서로 읽는다.
  function decode(buf) {
    const b = new Uint8Array(buf);
    if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf);
    if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch {}
    try { return new TextDecoder('euc-kr').decode(buf); } catch {}
    return new TextDecoder('utf-8').decode(buf);
  }
  // 탭 또는 쉼표로 나뉜 표. 첫 줄에서 구분자를 정한다.
  function parseTable(txt) {
    const lines = txt.replace(/^﻿/, '').split(/\r?\n/), out = [];
    const first = lines.find(l => l.trim()) || '';
    const sep = (first.split('\t').length > first.split(',').length) ? '\t' : ',';
    for (const ln of lines) {
      if (!ln.trim()) continue;
      if (ln.indexOf('"') < 0) { out.push(ln.split(sep)); continue; }
      const r = []; let cur = '', q = false;
      for (let i = 0; i < ln.length; i++) {
        const ch = ln[i];
        if (q) { if (ch === '"') { if (ln[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
        else if (ch === '"') q = true; else if (ch === sep) { r.push(cur); cur = ''; } else cur += ch;
      }
      r.push(cur); out.push(r);
    }
    return out;
  }
  const toTSV = rows => rows.map(r => r.map(v => { v = v == null ? '' : String(v); return /["\t\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join('\t')).join('\n');
  const num = v => { if (v == null || v === '') return NaN; if (typeof v === 'number') return v; const s = String(v).trim().replace(/,/g, ''); return s === '' ? NaN : +s; };

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
    rows = rows.filter(r => r && r.length > 1 && !isNaN(num(r[ix.t])) && !isNaN(num(r[ix.uv])));
    const n = rows.length;
    if (n < 2) throw new Error('데이터 행이 2개 미만입니다.');
    const D = { n, ix, header };
    for (const k in COLS) {
      if (k === 'ev') continue;
      const a = new Float64Array(n), j = ix[k];
      for (let i = 0; i < n; i++) a[i] = j < 0 ? NaN : num(rows[i][j]);
      D[k] = a;
    }
    // 단위: 시간은 초, 압력은 MPa 로 맞춘다.
    const hT = String(header[ix.t]), kT = /\(\s*s(ec)?\s*\)/i.test(hT) ? 1 : /\(\s*h/i.test(hT) ? 3600 : 60;
    const t0 = D.t[0]; for (let i = 0; i < n; i++) D.t[i] = (D.t[i] - t0) * kT;
    // 분 단위 네 자리로 적힌 시간(0.0167 min)은 초로 바꾸면 1.002 s 처럼 어긋나므로 0.1 s 로 맞춘다.
    if (n > 2 && (D.t[n - 1] - D.t[0]) / (n - 1) >= 0.5) for (let i = 0; i < n; i++) D.t[i] = Math.round(D.t[i] * 10) / 10;
    for (let i = 1; i < n; i++) if (!(D.t[i] > D.t[i - 1])) D.t[i] = D.t[i - 1] + 1e-3;   // 단조 증가 보장
    if (ix.P >= 0) { const hP = String(header[ix.P]), kP = /mpa/i.test(hP) ? 1 : /kpa/i.test(hP) ? 1e-3 : /bar/i.test(hP) ? 0.1 : /psi/i.test(hP) ? 0.00689476 : 1; if (kP !== 1) for (let i = 0; i < n; i++) D.P[i] *= kP; }
    const dts = []; for (let i = 1; i < Math.min(n, 200); i++) dts.push(D.t[i] - D.t[i - 1]);
    dts.sort((a, b) => a - b); D.dt = Math.max(1e-3, dts[dts.length >> 1]);
    D.period = D.t[n - 1];   // 마지막 행이 런의 끝이다
    // 부피가 없으면 유량을 적분한다. 유량도 없으면 부피는 비워 둔다.
    if (ix.vol < 0 && ix.flow >= 0) { D.vol[0] = 0; for (let i = 1; i < n; i++) D.vol[i] = D.vol[i - 1] + (D.flow[i] || 0) * (D.t[i] - D.t[i - 1]) / 60; }
    const fl = Array.from(D.flow).filter(v => v > 0).sort((a, b) => a - b); D.flowSP = fl.length ? fl[fl.length >> 1] : NaN;
    for (let i = 0; i < n; i++) if (!(D.frac[i] > 0)) D.frac[i] = 0;   // 0 = 수집 안 함
    // UV 면적 누적 (mAU·mL). 부피가 없으면 시간(min)으로 적분한다.
    D.cumA = new Float64Array(n);
    for (let i = 1; i < n; i++) { const dv = isNaN(D.vol[i]) ? (D.t[i] - D.t[i - 1]) / 60 : D.vol[i] - D.vol[i - 1]; D.cumA[i] = D.cumA[i - 1] + (isNaN(D.uv[i]) ? 0 : (D.uv[i] + D.uv[i - 1]) / 2 * dv); }
    // 런 로그와 단계
    D.events = []; D.phase = new Uint8Array(n); D.phaseStart = new Int32Array(n);
    if (ix.ev >= 0) rows.forEach((r, i) => { const v = r[ix.ev]; if (v != null && String(v).trim()) D.events.push({ i, text: String(v).trim(), phase: phaseOf(String(v)) }); });
    let ph = 0, ps = 0, e = 0;
    for (let i = 0; i < n; i++) {
      while (e < D.events.length && D.events[e].i <= i) { if (D.events[e].phase >= 0) { ph = D.events[e].phase; ps = D.events[e].i; } e++; }
      D.phase[i] = ph; D.phaseStart[i] = ps;
    }
    return D;
  }

  /* t(초) → 행 번호 */
  function indexAt(D, s) {
    let lo = 0, hi = D.n - 1;
    if (s <= D.t[0]) return 0; if (s >= D.t[hi]) return hi;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (D.t[m] <= s) lo = m; else hi = m - 1; }
    return lo;
  }

  /* ---------- 피크 ---------- */
  // 지나간 값만 써서 판정한다. det: 피크로 알아본 행, conf: 정점이 확정된 행(정점의 90 % 아래로 내려옴), endDet: 끝이 확정된 행.
  function findPeaks(D, th) {
    const n = D.n, u = D.uv, s = new Float64Array(n), lo = th.pk_min, out = [];
    for (let i = 0; i < n; i++) { let a = 0, k = 0; for (let j = Math.max(0, i - 4); j <= i; j++) if (!isNaN(u[j])) { a += u[j]; k++; } s[i] = k ? a / k : NaN; }
    let p = null;
    const open = (a, i) => { p = { start: a, det: i, apex: i, max: s[i], conf: -1, end: -1, endDet: -1, vi: i, vv: s[i] }; out.push(p); };
    for (let i = 0; i < n; i++) {
      const v = s[i]; if (isNaN(v)) continue;
      if (!p) {
        if (v > lo) { let a = i; const fl = out.length ? out[out.length - 1].end : 0; while (a > fl && s[a - 1] <= s[a] && s[a] > lo * 0.1) a--; open(a, i); }
        continue;
      }
      if (p.conf < 0) {
        if (v > p.max) { p.max = v; p.apex = i; }
        else if (v < p.max * 0.9) { p.conf = i; p.vi = i; p.vv = v; let a = p.apex; for (let j = Math.max(p.start, p.apex - 4); j <= p.apex; j++) if (u[j] > u[a]) a = j; p.apex = a; }
      }
      if (p.conf >= 0) {
        if (v < p.vv) { p.vv = v; p.vi = i; }
        if (v < lo * 0.8) { p.end = i; p.endDet = i; p = null; }
        else if (v > p.vv * 1.3 && v - p.vv > lo * 0.5) { const vi = p.vi; p.end = vi; p.endDet = i; open(vi, i); }   // 골짜기에서 나눈다
      }
    }
    return out;
  }

  /* ---------- 경보 규칙 ---------- */
  // 각 규칙은 행마다 0(정상)·1(주의)·2(위험)을 낸다. hold 초 이상 이어져야 켜지고, 5 s 동안 정상이어야 꺼진다.
  function rules(D, th) {
    const n = D.n, sp = th.flow_sp > 0 ? th.flow_sp : D.flowSP;
    // 최근 60 s 동안의 압력 최저값
    const pMin = new Float64Array(n), dq = [];
    for (let i = 0; i < n; i++) {
      const v = D.P[i];
      while (dq.length && !(D.P[dq[dq.length - 1]] < v)) dq.pop();
      dq.push(i);
      while (D.t[dq[0]] < D.t[i] - 60) dq.shift();
      pMin[i] = D.P[dq[0]];
    }
    const back = new Int32Array(n); { let j = 0; for (let i = 0; i < n; i++) { while (D.t[j] < D.t[i] - 120) j++; back[i] = j; } }
    const sensorBad = i => isNaN(D.uv[i]) || D.uv[i] < -100 || D.uv[i] > 7000 || D.cond[i] < 0 || D.P[i] < 0 || D.pH[i] < 0 || D.pH[i] > 14;
    const ph = id => PHASES.findIndex(p => p.id === id), EL = ph('elute'), ST = ph('strip');
    return [
      { id: 'Phi', name: '압력 상한', ch: 'P', hold: 3, f: i => D.P[i] >= th.P_dang ? 2 : D.P[i] >= th.P_warn ? 1 : 0 },
      { id: 'Prise', name: '압력 급상승 · 막힘 의심', ch: 'P', hold: 5, f: i => D.P[i] - pMin[i] > th.P_rise ? 1 : 0 },
      { id: 'Plo', name: '압력 저하 · 누액 의심', ch: 'P', hold: 5, f: i => D.flow[i] > 0.05 && D.P[i] < th.P_low ? 2 : 0 },
      { id: 'flow', name: '유량 편차', ch: 'flow', hold: 5, f: i => { if (!(sp > 0) || isNaN(D.flow[i])) return 0; const e = Math.abs(D.flow[i] - sp) / sp * 100; return e > th.flow_dang ? 2 : e > th.flow_warn ? 1 : 0; } },
      { id: 'uv', name: 'UV 범위 초과', ch: 'uv', hold: 5, f: i => sensorBad(i) ? 0 : D.uv[i] >= th.UV_dang ? 2 : D.uv[i] >= th.UV_warn ? 1 : 0 },
      { id: 'base', name: '기준선 미복귀 · 세척 부족', ch: 'uv', hold: 0, f: i => D.phase[i] === EL && D.t[i] - D.t[D.phaseStart[i]] < 120 && D.uv[D.phaseStart[i]] > th.base_max ? 1 : 0 },
      { id: 'grad', name: '구배 이상 · B 펌프 의심', ch: 'cond', hold: 10, f: i => Math.abs(D.B[i] - D.B[back[i]]) > 10 && Math.abs(D.cond[i] - D.cond[back[i]]) < th.grad_min ? 1 : 0 },
      { id: 'pH', name: 'pH 이탈', ch: 'pH', hold: 10, f: i => { const v = D.pH[i]; if (isNaN(v) || sensorBad(i)) return 0; return v < th.pH_lo - 0.5 || v > th.pH_hi + 0.5 ? 2 : v < th.pH_lo || v > th.pH_hi ? 1 : 0; } },
      { id: 'miss', name: '수집 밖 피크', ch: 'frac', hold: 3, f: i => (D.phase[i] === EL || D.phase[i] === ST) && D.frac[i] === 0 && D.uv[i] > th.pk_min && !sensorBad(i) ? 2 : 0 },
      { id: 'sensor', name: '센서 값 이상', ch: 'all', hold: 2, f: i => sensorBad(i) ? 2 : 0 },
    ];
  }

  /* 규칙마다 행별 상태 배열(lv)과 상태 변화 목록(changes)을 만들고, 피크도 함께 찾는다. */
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
    return { rules: R, changes, th, peaks: findPeaks(D, th) };
  }

  /* 기본 data.txt 또는 관리자 페이지에서 올린 파일을 읽는다. */
  async function loadData() {
    const up = await getUpload();
    if (up && up.txt) {
      try { const rows = parseTable(up.txt); return { D: build(rows[0], rows.slice(1)), source: up.name, uploaded: true, savedAt: up.savedAt }; }
      catch (e) { console.warn('올린 파일을 읽지 못해 기본 데이터로 돌아갑니다', e); }
    }
    const r = await fetch('data.txt', { cache: 'no-cache' });
    if (!r.ok) throw new Error('data.txt 를 받지 못했습니다 (' + r.status + ')');
    const rows = parseTable(decode(await r.arrayBuffer()));
    return { D: build(rows[0], rows.slice(1)), source: 'data.txt', uploaded: false };
  }

  /* 실시간 가정: 런 시작 시각부터 흐른 시간(× 배속)을 기록의 시간축에 맞춘다. */
  function liveClock(D, s = settings(), now = Date.now()) {
    const speed = s.speed || 1, loop = s.loop !== false, start = runStart(s);
    let el = (now - start) / 1000 * speed;
    if (el < 0) return { i: 0, el: 0, waiting: true, start, speed, loop, cycle: 0 };
    const cycle = Math.floor(el / D.period);
    if (loop) el -= cycle * D.period; else if (el >= D.period) return { i: D.n - 1, el: D.period, ended: true, start, speed, loop, cycle: 0 };
    return { i: indexAt(D, el), el, start, speed, loop, cycle };
  }

  const hms = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return [h, m, x].map(v => String(v).padStart(2, '0')).join(':'); };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = ms => { const d = new Date(ms), p = v => String(v).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

  return { COLS, NAMES, REQUIRED, CH, PHASES, DEF_TH, TH_INFO, settings, saveSettings, thresholds, runStart, todayMidnight,
    getUpload, putUpload, clearUpload, decode, parseTable, toTSV, matchColumns, build, indexAt, evaluate, loadData, liveClock,
    hms, esc, fmtDate, bc };
})();
