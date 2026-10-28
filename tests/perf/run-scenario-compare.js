/**
 * 시나리오 비교: 목록+상세 vs 목록+상세+담기+장바구니조회
 * VU·sleep·시간은 동일 (기본 VU300, sleep 0.5)
 *
 *   npm run test:perf:scenario-compare
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

function run(scriptName, jsonName) {
  const scriptPath = path.join(__dirname, scriptName);
  const jsonPath = path.join(resultsDir, jsonName);
  fs.mkdirSync(resultsDir, { recursive: true });
  if (fs.existsSync(jsonPath) && process.env.FORCE_RERUN !== '1') {
    // browse-only: 기존 t050 재사용 가능
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
      scriptPath,
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

// 읽기 전용: 예전에 만든 load-vus300-t050.json 있으면 재사용
const browseLegacy = path.join(resultsDir, `load-vus${targetVus}-${thinkTag}.json`);
const browseJson = path.join(resultsDir, `load-scenario-browse-vus${targetVus}-${thinkTag}.json`);
if (!fs.existsSync(browseJson) && fs.existsSync(browseLegacy) && thinkTime === 0.5) {
  fs.copyFileSync(browseLegacy, browseJson);
  console.log(`기존 ${path.basename(browseLegacy)} → browse 시나리오용으로 복사`);
} else {
  run('load-ramp-read.js', path.basename(browseJson));
}

const cartJson = run(
  'load-ramp-browse-cart.js',
  `load-scenario-browse-cart-vus${targetVus}-${thinkTag}.json`
);

const htmlPath = path.join(
  resultsDir,
  `load-scenario-compare-rich-vus${targetVus}-${thinkTag}.html`
);

console.log('\n리포트 생성 중...\n');
const report = spawnSync(
  'node',
  [
    path.join(__dirname, 'make-relative-report.js'),
    '--overlay-rich',
    `${browseJson}:목록+상세`,
    `${cartJson}:목록+상세+담기+조회`,
    htmlPath,
  ],
  { cwd: root, stdio: 'inherit', shell: true }
);
if (report.status !== 0 && report.status !== null) process.exit(report.status);

console.log(`\n브라우저: ${htmlPath}`);
if (process.platform === 'win32') {
  spawnSync('cmd', ['/c', 'start', '', htmlPath], { stdio: 'ignore' });
}
