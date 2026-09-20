/** 原子写 JSON 存储：数据量在几千条量级，JSON 足够，且用户可以直接打开检查/手改。 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export const DATA_DIR = process.env.BILI_STATION_DIR || join(homedir(), '.bili-station');

function ensure(p) { mkdirSync(dirname(p), { recursive: true }); }

export function read(name, fallback = null) {
  const p = join(DATA_DIR, name);
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch { return fallback; }
}

export function write(name, data) {
  const p = join(DATA_DIR, name);
  ensure(p);
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, p);   // 原子替换，避免写一半断电留下半截文件
  return p;
}

/** 破坏性操作前的快照备份。命名带时间戳，永不覆盖。 */
export function backup(kind, payload) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = join('backups', `${kind}-${stamp}.json`);
  const p = write(name, { kind, at: new Date().toISOString(), payload });
  return p;
}

export function listBackups() {
  const dir = join(DATA_DIR, 'backups');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort().reverse()
    .map((f) => ({ file: f, path: join(dir, f) }));
}
