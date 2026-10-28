'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..', '..');
const resultsDir = path.join(__dirname, 'results');
const jsonPath = path.join(resultsDir, 'load-fail-demo.json');
const htmlPath = path.join(resultsDir, 'load-fail-demo-rich.html');
const scriptPath = path.join(__dirname, 'load-fail-demo.js');

fs.mkdirSync(resultsDir, { recursive: true });
if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);

const env = { ...process.env, K6_WEB_DASHBOARD: 'false' };
console.log('\n=== 실패 체험 부하 (simulate=error ~70%) ===\n');

const k6 = spawnSync('k6', ['run', '--out', `json=${jsonPath}`, scriptPath], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env,
});

// threshold 실패로 exit != 0 이어도 리포트는 만든다
const report = spawnSync(
  'node',
  [path.join(__dirname, 'make-relative-report.js'), jsonPath, htmlPath],
  { cwd: root, stdio: 'inherit', shell: true }
);

console.log(`\n브라우저: ${htmlPath}`);
if (process.platform === 'win32') {
  spawnSync('cmd', ['/c', 'start', '', htmlPath], { stdio: 'ignore' });
}

process.exit(report.status === 0 || report.status === null ? 0 : report.status);
