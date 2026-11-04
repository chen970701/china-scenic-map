/**
 * 发布静态站点到 GitHub Pages。
 *
 * 做法：以 origin 的仓库名作为子路径 base（https://<user>.github.io/<repo>/）重新构建，
 * 再把 dist 复制到一个临时 git 仓库、推成 gh-pages 分支。
 * 主分支保持「只有代码」，gh-pages 只放构建产物，两边互不影响。
 *
 * 用法：
 *   npm run deploy:pages                 构建 + 推送
 *   npm run deploy:pages -- --skip-build 复用现有 dist（只推）
 *   npm run deploy:pages -- --dry-run    只构建，不推送
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(ROOT, 'tmpdata', 'pages-deploy');
const args = process.argv.slice(2);
const SKIP_BUILD = args.includes('--skip-build');
const DRY_RUN = args.includes('--dry-run');

const run = (cmd, cwd = ROOT, env = {}) =>
  execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });

/** 从 origin 解析 owner/repo，决定 Pages 的子路径 */
function resolveRepo() {
  const remote = execSync('git remote get-url origin', { cwd: ROOT, encoding: 'utf8' }).trim();
  const hit = remote.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (!hit) throw new Error(`无法从 origin 解析仓库名：${remote}`);
  return { owner: hit[1], repo: hit[2], remote };
}

const { owner, repo, remote } = resolveRepo();
const base = `/${repo}/`;
const siteUrl = `https://${owner.toLowerCase()}.github.io/${repo}/`;

if (!SKIP_BUILD) {
  console.log(`\n[1/3] 构建（base=${base}）`);
  run('npx tsc --noEmit');
  run(`npx vite build --base=${base}`);
} else {
  console.log('\n[1/3] 跳过构建，复用 dist');
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    throw new Error('dist 不存在，先去掉 --skip-build 跑一次完整构建');
  }
}

// 产物里必须带 .nojekyll，否则 GitHub Pages 会走 Jekyll 处理
fs.writeFileSync(path.join(DIST, '.nojekyll'), '');

if (DRY_RUN) {
  console.log(`\n--dry-run：构建完成，未推送。本地预览： npx vite preview --base=${base}`);
  console.log(`最终地址会是 ${siteUrl}`);
  process.exit(0);
}

console.log('\n[2/3] 准备 gh-pages 目录');
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
fs.cpSync(DIST, STAGE, { recursive: true });

const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
run('git init -q', STAGE);
run('git checkout -q -B gh-pages', STAGE);
run('git add -A', STAGE);
run(`git commit -q -m "deploy: ${stamp}"`, STAGE);
run(`git remote add origin ${remote}`, STAGE);

const files = execSync('git ls-files | wc -l', { cwd: STAGE, encoding: 'utf8' }).trim();
console.log(`  产物 ${files} 个文件`);

console.log('\n[3/3] 推送 gh-pages');
run('git push -f origin gh-pages', STAGE);

console.log(`\n已推送。仓库如果还没开 Pages：Settings → Pages → Source 选 “Deploy from a branch”，
分支选 gh-pages / 目录选 / (root)，保存后等 1–2 分钟。
站点地址：${siteUrl}`);
