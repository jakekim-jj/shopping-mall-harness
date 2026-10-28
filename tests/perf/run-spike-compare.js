/**
 * ramp(부하) vs spike 비교 — 목표 VU·sleep·시나리오(목록+상세) 동일
 *
 *   npm run test:perf:spike-compare
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..', '..');
const resultsDir = path.join(__dirname, 'results');
const targetVus = Number(process.env.TARGET_VUS || 300);
const thinkTime = Number(process.env.THINK_TIME !== undefined ? process.env.THINK_TIME : 0.5);
const thinkTag = `t${String(Math.round(thinkTime * 100)).padStart(3, '0')}`;

function runK6(scriptName, jsonName) {
  const jsonPath = path.join(resultsDir, jsonName);
  fs.mkdirSync(resultsDir, { recursive: true });

  if (fs.existsSync(jsonPath) && process.env.FORCE_RERUN !== '1') {
    console.log(`재사용: ${jsonPath}`);
    return jsonPath;
  }
  if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);

  console.log(`\n=== ${scriptName} VU=${targetVus} sleep=${thinkTime} ===\n`);
  const r = spawnSync(
    'k6',
    [
      'run',
      '-e',
      `TARGET_VUS=${targetVus}`,
      '-e',
      `THINK_TIME=${thinkTime}`,
      '--out',
      `json=${jsonPath}`,
      path.join(__dirname, scriptName),
    ],
    {
      cwd: root,
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, K6_WEB_DASHBOARD: 'false' },
    }
  );
  if (r.status !== 0 && r.status !== null) process.exit(r.status);
  return jsonPath;
}

// ramp: 기존 browse/t050 재사용 가능
const rampLegacy = path.join(resultsDir, `load-vus${targetVus}-${thinkTag}.json`);
const rampJson = path.join(resultsDir, `load-ramp-vus${targetVus}-${thinkTag}.json`);
if (!fs.existsSync(rampJson) && fs.existsSync(rampLegacy) && thinkTime === 0.5) {
  fs.copyFileSync(rampLegacy, rampJson);
  console.log(`기존 ${path.basename(rampLegacy)} → ramp용 복사`);
} else {
  runK6('load-ramp-read.js', path.basename(rampJson));
}

const spikeJson = runK6(
  'load-spike-read.js',
  `load-spike-vus${targetVus}-${thinkTag}.json`
);

const htmlPath = path.join(
  resultsDir,
  `load-ramp-vs-spike-rich-vus${targetVus}-${thinkTag}.html`
);

console.log('\n리포트 생성 중...\n');
const report = spawnSync(
  'node',
  [
    path.join(__dirname, 'make-relative-report.js'),
    '--overlay-rich',
    `${rampJson}:부하(ramp)`,
    `${spikeJson}:스파이크`,
    htmlPath,
  ],
  { cwd: root, stdio: 'inherit', shell: true }
);
if (report.status !== 0 && report.status !== null) process.exit(report.status);

console.log(`\n브라우저: ${htmlPath}`);
if (process.platform === 'win32') {
  spawnSync('cmd', ['/c', 'start', '', htmlPath], { stdio: 'ignore' });
}
