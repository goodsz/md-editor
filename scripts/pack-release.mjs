/**
 * 发布产物归档：把本版本的打包产物归入 release/v<version>/，
 * 并压缩为 release/v<version>.zip，便于直接上传到 GitHub Release。
 *
 * 由 `npm run electron:build` 在 electron-builder 完成后调用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const releaseDir = path.join(root, 'release');
const outDir = path.join(releaseDir, `v${version}`);
const zipPath = path.join(releaseDir, `v${version}.zip`);

if (!fs.existsSync(releaseDir)) {
  console.error(`[pack-release] 未找到 release 目录：${releaseDir}（请先执行打包）`);
  process.exit(1);
}

// 本版本产物（缺失的自动跳过）
const files = [
  `md-editor Setup ${version}.exe`,
  `md-editor Setup ${version}.exe.blockmap`,
  `md-editor-${version}-win.zip`, // 免安装压缩包（win.zip 目标）
  'latest.yml',
];
// 兜底：release 根目录下其它含本版本号的压缩包 / 校验文件
// （跳过输出压缩包自身与目录，避免自包含嵌套）
for (const f of fs.readdirSync(releaseDir)) {
  if (f === `v${version}.zip` || files.includes(f)) continue;
  const p = path.join(releaseDir, f);
  if (!fs.statSync(p).isFile()) continue;
  if (f.includes(version) && (f.endsWith('.zip') || f.endsWith('.blockmap'))) files.push(f);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const copied = [];
for (const name of files) {
  const src = path.join(releaseDir, name);
  if (fs.existsSync(src) && fs.statSync(src).isFile()) {
    fs.copyFileSync(src, path.join(outDir, name));
    copied.push(name);
  }
}
if (copied.length === 0) {
  console.error('[pack-release] 未发现可归档的产物');
  process.exit(1);
}

// 压缩为 release/v<version>.zip
fs.rmSync(zipPath, { force: true });
if (process.platform === 'win32') {
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Compress-Archive -Path '${path.join(outDir, '*')}' -DestinationPath '${zipPath}' -Force`,
    ],
    { stdio: 'inherit' },
  );
} else {
  execFileSync('zip', ['-r', '-q', zipPath, '.'], { cwd: outDir, stdio: 'inherit' });
}

console.log(`[pack-release] v${version} → release/v${version}/（${copied.length} 个文件）`);
console.log(`[pack-release] 压缩包 → ${path.relative(root, zipPath)}`);
