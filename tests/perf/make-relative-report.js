/**
 * k6 --out json → 경과시간(0→종료) 한글 HTML
 *
 * 단일(지표 많음, k6 대시보드에 가깝게):
 *   node tests/perf/make-relative-report.js tests/perf/results/load-vus150.json out.html
 *
 * 비교(요약 4개):
 *   node tests/perf/make-relative-report.js --overlay a.json:VU150 b.json:VU200 out.html
 *
 * 비교(상세 그래프에 VU 겹침):
 *   node tests/perf/make-relative-report.js --overlay-rich a.json:VU150 b.json:VU500 out.html
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const TRACK = [
  'vus',
  'vus_max',
  'http_reqs',
  'http_req_duration',
  'http_req_waiting',
  'http_req_sending',
  'http_req_receiving',
  'http_req_connecting',
  'http_req_blocked',
  'http_req_failed',
  'iteration_duration',
  'iterations',
  'data_received',
  'data_sent',
  'checks',
  'products_list_duration',
  'products_detail_duration',
  'cart_add_duration',
  'cart_get_duration',
];

function downsample(series, maxPoints) {
  if (series.length <= maxPoints) return series;
  const step = Math.ceil(series.length / maxPoints);
  return series.filter((_, i) => i % step === 0);
}

function rollingPercentile(samples, windowSec, pct) {
  const out = [];
  let j = 0;
  const buf = [];
  for (let i = 0; i < samples.length; i += 1) {
    const cur = samples[i];
    buf.push(cur);
    while (j < buf.length && cur.t - buf[j].t > windowSec) j += 1;
    const values = buf.slice(j).map((p) => p.v).sort((a, b) => a - b);
    if (values.length === 0) continue;
    const idx = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * pct) - 1));
    out.push({ t: cur.t, v: values[idx] });
  }
  return downsample(out, 220);
}

function rollingAvg(samples, windowSec) {
  const out = [];
  let j = 0;
  let sum = 0;
  const buf = [];
  for (let i = 0; i < samples.length; i += 1) {
    const cur = samples[i];
    buf.push(cur);
    sum += cur.v;
    while (j < buf.length && cur.t - buf[j].t > windowSec) {
      sum -= buf[j].v;
      j += 1;
    }
    const n = buf.length - j;
    if (n > 0) out.push({ t: cur.t, v: sum / n });
  }
  return downsample(out, 220);
}

function countRate(samples, bucketSec) {
  if (samples.length === 0) return [];
  const lastT = samples[samples.length - 1].t;
  const buckets = [];
  for (let start = 0; start <= lastT; start += bucketSec) {
    const end = start + bucketSec;
    let count = 0;
    for (const p of samples) {
      if (p.t >= start && p.t < end) count += 1;
    }
    buckets.push({ t: start + bucketSec / 2, v: count / bucketSec });
  }
  return buckets;
}

function sumRate(samples, bucketSec) {
  // data_received/sent: 각 Point value가 바이트 증분
  if (samples.length === 0) return [];
  const lastT = samples[samples.length - 1].t;
  const buckets = [];
  for (let start = 0; start <= lastT; start += bucketSec) {
    const end = start + bucketSec;
    let sum = 0;
    for (const p of samples) {
      if (p.t >= start && p.t < end) sum += p.v;
    }
    buckets.push({ t: start + bucketSec / 2, v: sum / bucketSec }); // bytes/sec
  }
  return buckets;
}

function failRateBuckets(samples, bucketSec) {
  if (samples.length === 0) return [];
  const lastT = samples[samples.length - 1].t;
  const out = [];
  for (let start = 0; start <= lastT; start += bucketSec) {
    const end = start + bucketSec;
    let n = 0;
    let fails = 0;
    for (const p of samples) {
      if (p.t >= start && p.t < end) {
        n += 1;
        if (p.v > 0) fails += 1;
      }
    }
    out.push({ t: start + bucketSec / 2, v: n ? (fails / n) * 100 : 0 });
  }
  return out;
}

function checkPassRate(samples, bucketSec) {
  // checks Point: value 1=pass, 0=fail
  if (samples.length === 0) return [];
  const lastT = samples[samples.length - 1].t;
  const out = [];
  for (let start = 0; start <= lastT; start += bucketSec) {
    const end = start + bucketSec;
    let n = 0;
    let ok = 0;
    for (const p of samples) {
      if (p.t >= start && p.t < end) {
        n += 1;
        if (p.v > 0) ok += 1;
      }
    }
    out.push({ t: start + bucketSec / 2, v: n ? (ok / n) * 100 : 100 });
  }
  return out;
}

function sampleEveryForFile(filePath) {
  const size = fs.statSync(filePath).size;
  // sleep=0 JSON은 수 GB → N개 중 1개만 샘플 (그래프 경향은 유지)
  if (size > 2 * 1024 * 1024 * 1024) return 120;
  if (size > 500 * 1024 * 1024) return 40;
  if (size > 150 * 1024 * 1024) return 8;
  return 1;
}

function bumpBucket(map, t, bucketSec, field, amount) {
  const key = Math.floor(t / bucketSec);
  if (!map.has(key)) map.set(key, { n: 0, sum: 0, fail: 0, ok: 0 });
  const b = map.get(key);
  if (field === 'n') b.n += amount;
  else if (field === 'sum') b.sum += amount;
  else if (field === 'fail') b.fail += amount;
  else if (field === 'ok') b.ok += amount;
}

function bucketsToSeries(map, bucketSec, mode) {
  const keys = [...map.keys()].sort((a, b) => a - b);
  return keys.map((key) => {
    const b = map.get(key);
    const t = key * bucketSec + bucketSec / 2;
    if (mode === 'rps') return { t, v: b.n / bucketSec };
    if (mode === 'bytesPerSec') return { t, v: b.sum / bucketSec };
    if (mode === 'failPct') return { t, v: b.n ? (b.fail / b.n) * 100 : 0 };
    if (mode === 'checkPct') return { t, v: b.n ? (b.ok / b.n) * 100 : 100 };
    return { t, v: 0 };
  });
}

/** 대용량 json도 한 줄씩 읽는다 (readFileSync 금지). */
async function parseK6Json(inputPath) {
  const W = 2;
  const sampleEvery = sampleEveryForFile(inputPath);
  const points = Object.fromEntries(TRACK.map((m) => [m, []]));
  const counters = {
    http_reqs: new Map(),
    http_req_failed: new Map(),
    checks: new Map(),
    data_received: new Map(),
    data_sent: new Map(),
  };
  const sampleCount = Object.fromEntries(TRACK.map((m) => [m, 0]));
  let t0 = null;
  let totalReqs = 0;
  let totalIters = 0;
  let failN = 0;
  let failYes = 0;
  let checkN = 0;
  let checkOk = 0;
  const p95Reservoir = [];

  const rl = readline.createInterface({
    input: fs.createReadStream(inputPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type !== 'Point' || !row.metric || !row.data) continue;
    const metric = row.metric;
    if (!TRACK.includes(metric)) continue;

    const ts = new Date(row.data.time).getTime();
    if (t0 === null) t0 = ts;
    const t = (ts - t0) / 1000;
    const value = Number(row.data.value);
    if (Number.isNaN(value)) continue;

    if (metric === 'http_reqs') {
      totalReqs += 1;
      bumpBucket(counters.http_reqs, t, W, 'n', 1);
      continue;
    }
    if (metric === 'iterations') {
      totalIters += 1;
      continue;
    }
    if (metric === 'http_req_failed') {
      failN += 1;
      if (value > 0) failYes += 1;
      bumpBucket(counters.http_req_failed, t, W, 'n', 1);
      if (value > 0) bumpBucket(counters.http_req_failed, t, W, 'fail', 1);
      continue;
    }
    if (metric === 'checks') {
      checkN += 1;
      if (value > 0) checkOk += 1;
      bumpBucket(counters.checks, t, W, 'n', 1);
      if (value > 0) bumpBucket(counters.checks, t, W, 'ok', 1);
      continue;
    }
    if (metric === 'data_received') {
      bumpBucket(counters.data_received, t, W, 'sum', value);
      continue;
    }
    if (metric === 'data_sent') {
      bumpBucket(counters.data_sent, t, W, 'sum', value);
      continue;
    }
    if (metric === 'vus' || metric === 'vus_max') {
      points[metric].push({ t, v: value });
      continue;
    }

    // trend 계열: 샘플링
    sampleCount[metric] += 1;
    if (sampleCount[metric] % sampleEvery !== 0) continue;
    points[metric].push({ t, v: value });
    if (metric === 'http_req_duration' && p95Reservoir.length < 200000) {
      p95Reservoir.push(value);
    }
  }

  const series = {
    vus: downsample(points.vus, 300),
    rps: bucketsToSeries(counters.http_reqs, W, 'rps'),
    durationAvg: rollingAvg(points.http_req_duration, W),
    durationP95: rollingPercentile(points.http_req_duration, W, 0.95),
    durationP99: rollingPercentile(points.http_req_duration, W, 0.99),
    waitingAvg: rollingAvg(points.http_req_waiting, W),
    sendingAvg: rollingAvg(points.http_req_sending, W),
    receivingAvg: rollingAvg(points.http_req_receiving, W),
    connectingAvg: rollingAvg(points.http_req_connecting, W),
    blockedAvg: rollingAvg(points.http_req_blocked, W),
    iterP95: rollingPercentile(points.iteration_duration, W, 0.95),
    listP95: rollingPercentile(points.products_list_duration, W, 0.95),
    detailP95: rollingPercentile(points.products_detail_duration, W, 0.95),
    cartAddP95: rollingPercentile(points.cart_add_duration, W, 0.95),
    cartGetP95: rollingPercentile(points.cart_get_duration, W, 0.95),
    dataRecv: bucketsToSeries(counters.data_received, W, 'bytesPerSec').map((p) => ({
      t: p.t,
      v: p.v / 1024,
    })),
    dataSent: bucketsToSeries(counters.data_sent, W, 'bytesPerSec').map((p) => ({
      t: p.t,
      v: p.v / 1024,
    })),
    fail: bucketsToSeries(counters.http_req_failed, W, 'failPct'),
    checks: bucketsToSeries(counters.checks, W, 'checkPct'),
  };

  const endSec = Math.max(
    0,
    ...Object.values(series).flatMap((s) => (s.length ? [s[s.length - 1].t] : [0]))
  );

  const sortedP95 = p95Reservoir.slice().sort((a, b) => a - b);
  const summary = {
    totalReqs,
    totalIters,
    maxVus: points.vus.reduce((m, p) => Math.max(m, p.v), 0),
    failPct: failN === 0 ? 0 : (failYes / failN) * 100,
    checkPct: checkN === 0 ? 100 : (checkOk / checkN) * 100,
    p95All:
      sortedP95.length === 0
        ? 0
        : sortedP95[Math.min(sortedP95.length - 1, Math.ceil(sortedP95.length * 0.95) - 1)],
    sampled: sampleEvery > 1,
  };

  return { series, endSec, summary };
}

function endLabel(endSec) {
  return endSec >= 60
    ? `${Math.floor(endSec / 60)}분 ${Math.round(endSec % 60)}초`
    : `${Math.round(endSec)}초`;
}

const COLORS = ['#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed'];

function chartBlock(id, title, hint) {
  return `<div class="card">
      <h2>${title}</h2>
      <p class="hint">${hint}</p>
      <canvas id="${id}"></canvas>
    </div>`;
}

function pickSeries(runs, key) {
  return runs.map((r, i) => ({
    label: r.label,
    color: COLORS[i % COLORS.length],
    data: r.series.series[key],
  }));
}

function buildCompareHtml(runs, outEndSec) {
  return wrapHtml(
    `부하 테스트 비교 (요약)`,
    `같은 그래프에 <b>${runs.map((r) => r.label).join(' vs ')}</b> 겹침. 가로축=각 실행 시작 0.`,
    `
    ${chartBlock('vus', '1. 동시 사용자 (VU)', '목표가 다르면 선 높이가 달라진다.')}
    ${chartBlock('rps', '2. 초당 요청 수 (RPS)', 'VU가 큰 실행이 보통 위에 있다.')}
    ${chartBlock('p95', '3. 응답시간 p95 (ms)', '부하가 버거우면 여기서 차이가 난다.')}
    ${chartBlock('fail', '4. 실패율 (%)', '구간 실패 비율.')}
    `,
    outEndSec,
    {
      vus: pickSeries(runs, 'vus'),
      rps: pickSeries(runs, 'rps'),
      p95: pickSeries(runs, 'durationP95'),
      fail: pickSeries(runs, 'fail'),
    },
    true
  );
}

/** 상세 지표까지 VU별로 겹쳐 그림 */
function buildRichCompareHtml(runs, outEndSec) {
  const summaryHtml = `
  <div class="summary">
    ${runs
      .map((r) => {
        const s = r.series.summary;
        return `<div><b>${r.label}</b><span>max ${Math.round(s.maxVus)} · p95 ${s.p95All.toFixed(2)}ms · fail ${s.failPct.toFixed(2)}%</span></div>`;
      })
      .join('')}
  </div>`;

  return wrapHtml(
    `부하 테스트 리포트 (상세 비교)`,
    `상세 그래프에 <b>${runs.map((r) => r.label).join(' / ')}</b> 를 겹침. 가로축=0 → ${endLabel(outEndSec)}.`,
    `
    ${summaryHtml}
    <h3 class="section">실행 / 부하</h3>
    ${chartBlock('vus', '동시 사용자 (VU)', 'VU별 목표만큼 선 높이가 다르다.')}
    ${chartBlock('rps', '초당 요청 수 (RPS)', '동시 사용자가 많을수록 보통 위에.')}
    ${chartBlock('iter', '시나리오 1회 소요 p95 (ms)', 'sleep 포함이라 ~1000ms 근처가 정상.')}

    <h3 class="section">응답 시간</h3>
    ${chartBlock('p95', 'HTTP 응답시간 p95 (ms)', 'VU별 p95 비교.')}
    ${chartBlock('p99', 'HTTP 응답시간 p99 (ms)', '꼬리 지연 비교.')}
    ${chartBlock('avg', 'HTTP 응답시간 avg (ms)', '평균 응답 비교.')}
    ${chartBlock('list', '목록 API p95 (ms)', 'GET /api/products')}
    ${chartBlock('detail', '상세 API p95 (ms)', 'GET /api/products/:id')}
    ${chartBlock('cartAdd', '담기 API p95 (ms)', 'POST /api/cart/items (없으면 선 없음)')}
    ${chartBlock('cartGet', '장바구니 조회 p95 (ms)', 'GET /api/cart (없으면 선 없음)')}

    <h3 class="section">요청 구간 분해 (avg, ms)</h3>
    ${chartBlock('waiting', 'waiting avg (ms)', '서버 대기/처리 구간.')}
    ${chartBlock('receiving', 'receiving avg (ms)', '응답 수신.')}
    ${chartBlock('connecting', 'connecting avg (ms)', '연결 수립.')}

    <h3 class="section">신뢰성 / 트래픽</h3>
    ${chartBlock('fail', 'HTTP 실패율 (%)', '')}
    ${chartBlock('checks', '체크 성공률 (%)', '')}
    ${chartBlock('recv', '수신 (KB/s)', '')}
    ${chartBlock('sent', '송신 (KB/s)', '')}
    `,
    outEndSec,
    {
      vus: pickSeries(runs, 'vus'),
      rps: pickSeries(runs, 'rps'),
      iter: pickSeries(runs, 'iterP95'),
      p95: pickSeries(runs, 'durationP95'),
      p99: pickSeries(runs, 'durationP99'),
      avg: pickSeries(runs, 'durationAvg'),
      list: pickSeries(runs, 'listP95'),
      detail: pickSeries(runs, 'detailP95'),
      cartAdd: pickSeries(runs, 'cartAddP95'),
      cartGet: pickSeries(runs, 'cartGetP95'),
      waiting: pickSeries(runs, 'waitingAvg'),
      receiving: pickSeries(runs, 'receivingAvg'),
      connecting: pickSeries(runs, 'connectingAvg'),
      fail: pickSeries(runs, 'fail'),
      checks: pickSeries(runs, 'checks'),
      recv: pickSeries(runs, 'dataRecv'),
      sent: pickSeries(runs, 'dataSent'),
    },
    true
  );
}

function buildRichHtml(run, outEndSec) {
  const s = run.series.series;
  const sum = run.series.summary;
  const one = (data, color, label) => [{ label, color, data }];

  const summaryHtml = `
  <div class="summary">
    <div><b>최대 VU</b><span>${Math.round(sum.maxVus)}</span></div>
    <div><b>총 요청</b><span>${sum.totalReqs.toLocaleString()}</span></div>
    <div><b>시나리오 반복</b><span>${sum.totalIters.toLocaleString()}</span></div>
    <div><b>전체 p95</b><span>${sum.p95All.toFixed(2)} ms</span></div>
    <div><b>HTTP 실패율</b><span>${sum.failPct.toFixed(2)}%</span></div>
    <div><b>체크 성공률</b><span>${sum.checkPct.toFixed(2)}%</span></div>
  </div>`;

  return wrapHtml(
    `부하 테스트 리포트 (상세)`,
    `k6가 남긴 지표를 한글로 풀어 둔 버전. 가로축=0 → ${endLabel(outEndSec)}.`,
    `
    ${summaryHtml}
    <h3 class="section">실행 / 부하</h3>
    ${chartBlock('vus', '동시 사용자 (VU)', '그 순간 서버에 붙어 시나리오를 도는 가상 사용자 수.')}
    ${chartBlock('rps', '초당 요청 수 (RPS)', '서버가 초당 받은 HTTP 요청 수.')}
    ${chartBlock('iter', '시나리오 1회 소요 p95 (ms)', '목록+상세+sleep 한 바퀴. sleep 1초가 들어 있어 ~1000ms 근처가 정상.')}

    <h3 class="section">응답 시간</h3>
    ${chartBlock('dur', 'HTTP 응답시간 avg / p95 / p99 (ms)', '전체 요청 기준. p99가 튀면 꼬리 지연.')}
    ${chartBlock('custom', '목록 vs 상세 API p95 (ms)', '우리가 스크립트에 넣은 custom 메트릭.')}
    ${chartBlock('cartCustom', '담기 vs 장바구니 조회 p95 (ms)', 'browse-cart 시나리오에만 데이터가 있다.')}

    <h3 class="section">요청 구간 분해 (avg, ms)</h3>
    ${chartBlock('phases', 'waiting / receiving / sending 등', 'waiting=서버 처리+대기, receiving=응답 받기. localhost면 대부분 매우 작음.')}

    <h3 class="section">신뢰성 / 트래픽</h3>
    ${chartBlock('fail', 'HTTP 실패율 (%)', '연결 실패·5xx 등.')}
    ${chartBlock('checks', '체크 성공률 (%)', '스크립트 check() 통과 비율.')}
    ${chartBlock('net', '송수신 (KB/s)', '네트워크 바이트 처리량.')}
    `,
    outEndSec,
    {
      vus: one(s.vus, '#2563eb', 'VU'),
      rps: one(s.rps, '#059669', 'RPS'),
      iter: one(s.iterP95, '#7c3aed', 'iteration p95'),
      dur: [
        { label: 'avg', color: '#64748b', data: s.durationAvg },
        { label: 'p95', color: '#d97706', data: s.durationP95 },
        { label: 'p99', color: '#dc2626', data: s.durationP99 },
      ],
      custom: [
        { label: '목록 p95', color: '#2563eb', data: s.listP95 },
        { label: '상세 p95', color: '#059669', data: s.detailP95 },
      ],
      cartCustom: [
        { label: '담기 p95', color: '#d97706', data: s.cartAddP95 },
        { label: '장바구니 조회 p95', color: '#7c3aed', data: s.cartGetP95 },
      ],
      phases: [
        { label: 'waiting', color: '#2563eb', data: s.waitingAvg },
        { label: 'receiving', color: '#059669', data: s.receivingAvg },
        { label: 'sending', color: '#d97706', data: s.sendingAvg },
        { label: 'connecting', color: '#7c3aed', data: s.connectingAvg },
        { label: 'blocked', color: '#64748b', data: s.blockedAvg },
      ],
      fail: one(s.fail, '#dc2626', '실패 %'),
      checks: one(s.checks, '#059669', '체크 %'),
      net: [
        { label: '수신 KB/s', color: '#2563eb', data: s.dataRecv },
        { label: '송신 KB/s', color: '#d97706', data: s.dataSent },
      ],
    },
    false
  );
}

function wrapHtml(title, subtitle, bodyCards, outEndSec, chartData, isCompare) {
  const chartIds = Object.keys(chartData);
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <style>
    body { font-family: "Malgun Gothic", sans-serif; margin: 24px; color: #222; background: #fafafa; }
    h1 { font-size: 1.4rem; margin-bottom: 4px; }
    h3.section { margin: 28px 0 12px; font-size: 1.05rem; color: #334155; }
    .sub { color: #666; margin-bottom: 16px; max-width: 900px; line-height: 1.5; }
    .why { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 12px 16px; margin-bottom: 20px; font-size: 0.9rem; line-height: 1.55; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 8px; }
    .summary div { background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; padding: 12px; }
    .summary b { display: block; font-size: 0.75rem; color: #64748b; margin-bottom: 4px; }
    .summary span { font-size: 1.15rem; font-weight: 700; }
    .grid { display: grid; gap: 20px; }
    .card { background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; padding: 16px; }
    .card h2 { font-size: 1rem; margin: 0 0 4px; }
    .hint { font-size: 0.85rem; color: #666; margin-bottom: 12px; }
    canvas { max-height: 280px; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <p class="sub">${subtitle}</p>
  ${
    isCompare
      ? ''
      : `<div class="why"><b>왜 예전 한글판은 그래프가 적었나?</b><br/>
    처음에 “경과 시간 축 + VU/RPS/p95/실패”만 남겨 배우기 쉽게 줄였다.
    k6 기본 HTML(<code>load-ramp-read.html</code>)은 대시보드 전체(구간 분해, 네트워크, 체크 등)를 다 보여 줘서 칸이 많아 보인 것.
    아래는 그 지표들을 <b>한글 + 0분→종료</b>로 다시 펼친 상세판이다.</div>`
  }
  <div class="grid">
    ${bodyCards}
  </div>
  <script>
    const elapsedLabel = (sec) => {
      const s = Math.max(0, sec);
      const m = Math.floor(s / 60);
      const r = Math.floor(s % 60);
      return m + ':' + String(r).padStart(2, '0');
    };
    const chartData = ${JSON.stringify(chartData)};
    const xMax = ${JSON.stringify(Math.ceil(outEndSec))};

    function multiLineChart(id, seriesList, yLabel, ySuggestedMax) {
      const el = document.getElementById(id);
      if (!el) return;
      new Chart(el, {
        type: 'line',
        data: {
          datasets: seriesList.map((s) => ({
            label: s.label,
            data: (s.data || []).map((p) => ({ x: p.t, y: p.v })),
            borderColor: s.color,
            backgroundColor: s.color + '22',
            fill: false,
            pointRadius: 0,
            tension: 0.2,
            borderWidth: 2,
          })),
        },
        options: {
          responsive: true,
          parsing: false,
          interaction: { mode: 'index', intersect: false },
          scales: {
            x: {
              type: 'linear',
              min: 0,
              max: xMax,
              title: { display: true, text: '경과 시간 (분:초)' },
              ticks: { callback: (v) => elapsedLabel(v) },
            },
            y: {
              beginAtZero: true,
              suggestedMax: ySuggestedMax,
              title: { display: true, text: yLabel },
            },
          },
          plugins: { legend: { display: true, position: 'top' } },
        },
      });
    }

    ${chartIds
      .map((id) => {
                const y =
          id === 'fail' || id === 'checks'
            ? `'%', 105`
            : id === 'net' || id === 'recv' || id === 'sent'
              ? `'KB/s'`
              : id === 'vus'
                ? `'VU'`
                : id === 'rps'
                  ? `'요청/초'`
                  : `'ms'`;
        return `multiLineChart('${id}', chartData['${id}'], ${y});`;
      })
      .join('\n    ')}
  </script>
</body>
</html>`;
}

// --- CLI ---
async function main() {
  const args = process.argv.slice(2);
  let outputPath;

  if (args[0] === '--overlay' || args[0] === '--overlay-rich') {
    const rich = args[0] === '--overlay-rich';
    const rest = args.slice(1);
    outputPath = rest.pop();
    const runs = [];
    for (const spec of rest) {
      const idx = spec.lastIndexOf(':');
      if (idx < 0) {
        console.error(`형식: path.json:라벨`);
        process.exit(1);
      }
      const file = spec.slice(0, idx);
      const label = spec.slice(idx + 1);
      if (!fs.existsSync(file)) {
        console.error(`JSON 없음: ${file}`);
        process.exit(1);
      }
      const mb = (fs.statSync(file).size / (1024 * 1024)).toFixed(1);
      console.log(`읽는 중: ${file} (${label}, ${mb} MB)`);
      runs.push({ label, series: await parseK6Json(file) });
    }
    const outEndSec = Math.max(...runs.map((r) => r.series.endSec));
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(
      outputPath,
      rich ? buildRichCompareHtml(runs, outEndSec) : buildCompareHtml(runs, outEndSec),
      'utf8'
    );
    console.log(`작성: ${outputPath}`);
    return;
  }

  const inputPath = args[0] || path.join(__dirname, 'results', 'load.json');
  outputPath =
    args[1] ||
    path.join(path.dirname(inputPath), path.basename(inputPath, path.extname(inputPath)) + '-relative.html');
  if (!fs.existsSync(inputPath)) {
    console.error(`JSON 없음: ${inputPath}`);
    process.exit(1);
  }
  console.log(`읽는 중: ${inputPath}`);
  const series = await parseK6Json(inputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(
    outputPath,
    buildRichHtml({ label: '실행', series }, series.endSec),
    'utf8'
  );
  console.log(`작성: ${outputPath}`);
  console.log(`구간: 0초 → ${endLabel(series.endSec)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
