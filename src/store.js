import fs from 'fs/promises';
import path from 'path';
import { Buffer } from 'buffer';
import { config } from './config.js';

const dir = config.dataDir;
await fs.mkdir(dir, { recursive: true });

async function readLocal(collection) {
  try {
    const raw = await fs.readFile(path.join(dir, `${collection}.json`), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeLocal(collection, data) {
  await fs.writeFile(path.join(dir, `${collection}.json`), JSON.stringify(data, null, 2));
}

// 可选：同步到 GitHub（与现有 workbuddy001 一致）。失败不影响本地。
async function syncToGithub(collection, data) {
  if (!config.githubToken || !config.githubRepo) return;
  const url = `https://api.github.com/repos/${config.githubRepo}/contents/data/${collection}.json?ref=${config.githubBranch}`;
  try {
    const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
    const head = await fetch(url, {
      headers: { Authorization: `Bearer ${config.githubToken}`, Accept: 'application/vnd.github+json' },
    });
    let sha;
    if (head.status === 200) sha = (await head.json()).sha;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${config.githubToken}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `sync ${collection}`, content, sha, branch: config.githubBranch }),
    });
    if (!res.ok) console.warn(`[store] github sync failed ${collection}: ${res.status}`);
  } catch (e) {
    console.warn(`[store] github sync error ${collection}:`, e.message);
  }
}

export const store = {
  async get(collection, fallback = { items: [] }) {
    return (await readLocal(collection)) ?? fallback;
  },
  async set(collection, data) {
    await writeLocal(collection, data);
    await syncToGithub(collection, data);
    return data;
  },
};
