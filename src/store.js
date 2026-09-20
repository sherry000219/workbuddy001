import fs from 'fs/promises';
import path from 'path';
import { Buffer } from 'buffer';
import { config } from './config.js';

const dir = config.dataDir;
await fs.mkdir(dir, { recursive: true });

// 已知集合：启动时按需尝试从 GitHub 远端恢复（M1-4）
const COLLECTIONS = ['contests', 'activities', 'posts', 'users', 'external_users'];

const githubEnabled = Boolean(config.githubToken && config.githubRepo);

// ---------- 本地读写 ----------

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

// ---------- GitHub 远端（与现有 workbuddy001 同思路：拿 GitHub 当存储） ----------

function ghUrl(collection) {
  return `https://api.github.com/repos/${config.githubRepo}/contents/data/${collection}.json?ref=${config.githubBranch}`;
}

const ghHeaders = {
  Authorization: `Bearer ${config.githubToken}`,
  Accept: 'application/vnd.github+json',
};

async function ghGet(collection) {
  const res = await fetch(ghUrl(collection), { headers: ghHeaders });
  if (res.status === 404) return { exists: false, sha: null, content: null };
  if (!res.ok) throw new Error(`GET ${res.status}`);
  const json = await res.json();
  return {
    exists: true,
    sha: json.sha,
    content: JSON.parse(Buffer.from(json.content, 'base64').toString('utf8')),
  };
}

// 远端状态缓存：避免每次推送前都 GET（省 API 配额）
const remoteState = new Map();

// 空数据判定：数组空 / { items: [] } / null 视为空
function isEmpty(data) {
  if (data == null) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data === 'object' && Array.isArray(data.items)) return data.items.length === 0;
  return false;
}

// 推送同步到 GitHub。三条守卫：
//   1) 空数据守卫——远端有数据时，绝不允许用空数据覆盖（防 Render 重启后丢盘空推）；
//   2) 409 冲突重试——last-write-wins 场景下 sha 过期时重新拉 sha 重试一次；
//   3) 失败只告警不抛错，不影响本地写入与接口响应。
async function syncToGithub(collection, data) {
  if (!githubEnabled) return;
  try {
    let st = remoteState.get(collection);
    if (!st) {
      st = await ghGet(collection).catch(() => ({ exists: false, sha: null }));
      remoteState.set(collection, st);
    }
    if (st.exists && isEmpty(data)) {
      console.warn(`[store] 空数据守卫：已阻止把空 ${collection} 推送到 GitHub（远端有数据，疑似本地数据丢失）`);
      return;
    }
    const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(ghUrl(collection), {
        method: 'PUT',
        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `sync ${collection}`,
          content,
          sha: st.sha ?? undefined,
          branch: config.githubBranch,
        }),
      });
      if (res.status === 409 && attempt === 0) {
        // sha 过期（远端被别人改过）：刷新 sha 后重试一次
        const fresh = await ghGet(collection).catch(() => null);
        if (fresh) {
          st = { exists: fresh.exists, sha: fresh.sha };
          remoteState.set(collection, st);
        }
        continue;
      }
      if (!res.ok) {
        console.warn(`[store] github sync failed ${collection}: ${res.status}`);
      } else {
        const json = await res.json().catch(() => null);
        if (json?.content?.sha) st.sha = json.content.sha;
        st.exists = true;
      }
      break;
    }
  } catch (e) {
    console.warn(`[store] github sync error ${collection}:`, e.message);
  }
}

// ---------- 启动恢复（M1-4 核心） ----------
// Render 免费实例磁盘是临时的：休眠/重启/重新部署后本地 data/ 可能为空。
// 启动时：本地缺哪个集合，就从 GitHub 拉哪个；本地有的以本地为准（运行期本地是事实源）。
if (githubEnabled) {
  for (const c of COLLECTIONS) {
    const local = await readLocal(c);
    if (local !== null) continue;
    try {
      const remote = await ghGet(c);
      if (remote.exists) {
        await writeLocal(c, remote.content);
        remoteState.set(c, { exists: true, sha: remote.sha });
        console.log(`[store] 启动恢复：已从 GitHub 拉取 ${c}.json`);
      }
    } catch (e) {
      console.warn(`[store] 启动恢复失败 ${c}: ${e.message}`);
    }
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
