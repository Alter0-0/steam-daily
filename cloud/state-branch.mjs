// Dedicated data branch survives runner replacement and ordinary cache expiry.
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('此脚本仅供 GitHub Actions 保存云端状态');
const mode = process.argv[2];
if (!['load', 'save'].includes(mode)) throw new Error('mode must be load or save');
function git(args, input) {
  const result = spawnSync('git', args, { cwd: root, input, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}
const files = ['state.json', 'status.json', 'detail-cache.json'];
const branch = 'daily-data';
const found = Boolean(git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]));
if (found) git(['fetch', '--depth=1', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
const parent = found ? git(['rev-parse', `origin/${branch}`]) : null;
if (mode === 'load') {
  if (parent) {
    await fs.mkdir(path.join(root, 'data'), { recursive: true });
    const tracked = new Set(git(['ls-tree', '-r', '--name-only', parent]).split('\n'));
    for (const name of files) {
      if (!tracked.has(`data/${name}`)) continue;
      const content = git(['show', `${parent}:data/${name}`]);
      JSON.parse(content); // Corrupted cloud state must never be silently reset.
      await fs.writeFile(path.join(root, 'data', name), content);
    }
    console.log('已恢复持久化日报和请求缓存');
  } else console.log('首次云端运行，使用项目自带的历史日报');
} else {
  const entries = [];
  for (const name of files) {
    try {
      const content = await fs.readFile(path.join(root, 'data', name), 'utf8');
      JSON.parse(content);
      const hash = git(['hash-object', '-w', '--stdin'], content);
      entries.push(`100644 blob ${hash}\t${name}\n`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!entries.length) throw new Error('没有可保存的日报状态');
  const dataTree = git(['mktree'], entries.join(''));
  const tree = git(['mktree'], `040000 tree ${dataTree}\tdata\n`);
  if (parent && tree === git(['rev-parse', `${parent}^{tree}`])) {
    console.log('状态未变，无需保存');
  } else {
    git(['config', 'user.name', 'github-actions[bot]']);
    git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
    const args = ['commit-tree', tree];
    if (parent) args.push('-p', parent);
    const commit = git(args, `Save Steam daily progress ${new Date().toISOString()}\n`);
    git(['push', 'origin', `${commit}:refs/heads/${branch}`]);
    console.log('日报与进度已保存到 daily-data 分支');
  }
}
