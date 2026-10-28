/**
 * 부하 테스트 실행 + 경과시간 HTML 리포트
 *
 *   npm run test:perf:load:report
 *   npm run test:perf:load:compare
 *   npm run test:perf:think-compare   # VU 고정, THINK_TIME만 0.5 / 0.1 / 0 비교
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..', '..');
const resultsDir = path.join(__dirname, 'results');
const scriptPath = path.join(__dirname, 'load-ramp-read.js');

function thinkTag(thinkTime) {
  // 0.5 → t050, 0.1 → t010, 0 → t000
  return `t${String(Math.round(Number(thinkTime) * 100)).padStart(3, '0')}`;
}

function runK6(targetVus, thinkTime, jsonPath) {
  fs.mkdirSync(resultsDir, { recursive: true });
  if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);

  const env = {
    ...process.env,
    TARGET_VUS: String(targetVus),
    THINK_TIME: String(thinkTime),
    K6_WEB_DASHBOARD: 'false',
  };

  console.log(
    `\n=== k6: TARGET_VUS=${targetVus} THINK_TIME=${thinkTime}s → ${path.basename(jsonPath)} ===\n`
  );
  const result = spawnSync(
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
    { cwd: root, stdio: 'inherit', shell: true, env }
  );
  return result.status === 0 || result.status === null;
}

function makeReport(args) {
  const report = spawnSync('node', [path.join(__dirname, 'make-relative-report.js'), ...args], {
    cwd: root,
    stdio: 'inherit',
    shell: true,
  });
  return report.status === 0 || report.status === null;
}

function openHtml(htmlPath) {
  console.log(`\n브라우저에서 열기: ${htmlPath}`);
  if (process.platform === 'win32') {
    spawnSync('cmd', ['/c', 'start', '', htmlPath], { stdio: 'ignore' });
  }
}

const mode = process.argv[2] || 'single';

if (mode === 'think-compare') {
  // VU·시간은 같고 Think Time만 줄인다 (공정 비교)
  const targetVus = Number(process.env.TARGET_VUS || 300);
  const thinks = (process.env.COMPARE_THINK || '0.5,0.1,0')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => !Number.isNaN(n) && n >= 0);

  const fileSpecs = [];
  for (const think of thinks) {
    const tag = thinkTag(think);
    const jsonPath = path.join(resultsDir, `load-vus${targetVus}-${tag}.json`);
    // 기존 load-vus300.json 은 think 0.5 시절 결과 → t050으로 재사용 가능
    const legacy = path.join(resultsDir, `load-vus${targetVus}.json`);
    if (think === 0.5 && !fs.existsSync(jsonPath) && fs.existsSync(legacy)) {
      fs.copyFileSync(legacy, jsonPath);
      console.log(`기존 load-vus${targetVus}.json → ${path.basename(jsonPath)} 복사 (think 0.5 가정)`);
    } else if (fs.existsSync(jsonPath) && process.env.FORCE_RERUN !== '1') {
      console.log(`재사용: ${jsonPath}`);
    } else if (!runK6(targetVus, think, jsonPath)) {
      process.exit(1);
    }
    const label = think === 0 ? `VU${targetVus}/sleep0` : `VU${targetVus}/sleep${think}`;
    fileSpecs.push(`${jsonPath}:${label}`);
  }

  const richHtml = path.join(
    resultsDir,
    `load-think-rich-vus${targetVus}-${thinks.map(thinkTag).join('-vs-')}.html`
  );
  if (!makeReport(['--overlay-rich', ...fileSpecs, richHtml])) process.exit(1);
  openHtml(richHtml);
} else if (mode === 'compare' || mode === 'compare-rich') {
  const targets = (process.env.COMPARE_VUS || '150,200,300,500,800')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => n > 0);
  const fileSpecs = [];

  const legacy = path.join(resultsDir, 'load.json');
  const json150 = path.join(resultsDir, 'load-vus150.json');
  if (!fs.existsSync(json150) && fs.existsSync(legacy) && targets.includes(150)) {
    fs.copyFileSync(legacy, json150);
    console.log(`기존 load.json → load-vus150.json 복사`);
  }

  for (const target of targets) {
    const jsonPath = path.join(resultsDir, `load-vus${target}.json`);
    if (fs.existsSync(jsonPath)) {
      console.log(`${target} VU JSON 재사용: ${jsonPath}`);
    } else if (!runK6(target, 0.5, jsonPath)) {
      process.exit(1);
    }
    fileSpecs.push(`${jsonPath}:VU${target}`);
  }

  const tag = targets.join('-vs-');
  const summaryHtml = path.join(resultsDir, `load-compare-${tag}.html`);
  const richHtml = path.join(resultsDir, `load-compare-rich-${tag}.html`);

  if (!makeReport(['--overlay', ...fileSpecs, summaryHtml])) process.exit(1);
  if (!makeReport(['--overlay-rich', ...fileSpecs, richHtml])) process.exit(1);
  openHtml(richHtml);
} else {
  const target = Number(process.env.TARGET_VUS || 150);
  const think = Number(process.env.THINK_TIME !== undefined ? process.env.THINK_TIME : 0.5);
  const jsonPath = path.join(resultsDir, `load-vus${target}-${thinkTag(think)}.json`);
  const htmlPath = path.join(resultsDir, `load-vus${target}-${thinkTag(think)}-rich.html`);
  if (!runK6(target, think, jsonPath)) process.exit(1);
  if (!makeReport([jsonPath, htmlPath])) process.exit(1);
  openHtml(htmlPath);
}
