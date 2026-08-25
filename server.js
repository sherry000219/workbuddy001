const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const https = require('https');

// ========== CONFIG ==========
const PORT = process.env.PORT || 3000;
const DEPLOY_VERSION = 'v4.3';

// DingTalk OAuth config
const DINGTALK = {
  appKey: 'dingrdgv8ra8guvuj6pm',
  appSecret: 'oo65T3Lew-22gSG_FwLKqSLfqEP9XZv0Kgtpn2r7IjFwG1FliqCSKAzAvcKz7SdJ',
  authUrl: 'https://login.dingtalk.com/oauth2/auth',
  tokenUrl: 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken',
  userInfoUrl: 'https://api.dingtalk.com/v1.0/contact/users/me',
};

// Session store
const DB_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const SESSION_MAX_AGE = 24 * 60 * 60 * 1000;
const SESSION_FILE = path.join(DB_DIR, 'sessions.json');
const sessions = loadSessions();

function loadSessions() {
  try {
    const raw = fs.readFileSync(SESSION_FILE, 'utf8');
    const data = JSON.parse(raw);
    const map = new Map();
    const now = Date.now();
    Object.entries(data).forEach(([token, session]) => {
      if (session && session.createdAt && (now - session.createdAt <= SESSION_MAX_AGE)) {
        map.set(token, session);
      }
    });
    return map;
  } catch (e) {
    return new Map();
  }
}

// 保存 session 时同步到 GitHub
function saveSessions() {
  try {
    const obj = {};
    sessions.forEach((session, token) => { obj[token] = session; });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(obj, null, 2), 'utf8');
    ghPushSessionsSchedule();
  } catch (e) {
    console.error('[session] save failed:', e.message);
  }
}

function setSession(token, session) {
  sessions.set(token, session);
  saveSessions();
}

function deleteSession(token) {
  sessions.delete(token);
  saveSessions();
}

function generateSessionToken() {
  return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

function getSession(req) {
  const token = req.cookies && req.cookies.dd_session;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || Date.now() - session.createdAt > SESSION_MAX_AGE) {
    if (session) deleteSession(token);
    return null;
  }
  return session;
}

// DingTalk API helper
function ddApi(method, url, body, accessToken) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (accessToken) {
      options.headers['x-acs-dingtalk-access-token'] = accessToken;
    }
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(data)); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Exchange DingTalk auth code for basic user info
async function exchangeDingTalkCode(code) {
  const tokenResp = await ddApi('POST', DINGTALK.tokenUrl, {
    clientId: DINGTALK.appKey,
    clientSecret: DINGTALK.appSecret,
    code,
    grantType: 'authorization_code',
  });
  console.log('[dd] token resp:', JSON.stringify(tokenResp));
  if (!tokenResp.accessToken) {
    throw new Error('获取accessToken失败');
  }

  // 仅获取用户通讯录个人信息（昵称、头像、手机号、openId、unionId、邮箱）
  // GET https://api.dingtalk.com/v1.0/contact/users/me
  // Header: x-acs-dingtalk-access-token
  const userResp = await ddApi('GET', DINGTALK.userInfoUrl, null, tokenResp.accessToken);
  console.log('[dd] users/me resp:', JSON.stringify(userResp).substring(0, 400));

  const openId = userResp.openId || '';
  const unionId = userResp.unionId || '';
  const nick = userResp.nick || '';
  const mobile = userResp.mobile || '';
  const avatarUrl = userResp.avatarUrl || '';
  const email = userResp.email || '';

  if (!openId) throw new Error('授权失败：未能获取用户身份');
  if (!nick) throw new Error('授权失败：未能获取用户姓名');

  return { openId, unionId, nick, name: nick, mobile, avatarUrl, email };
}

// ========== JSON FILE STORAGE ==========
const DB_FILE = path.join(DB_DIR, 'contest.json');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = 'sherry000219/workbuddy001';
const GITHUB_DATA_BRANCH = 'data';
const GITHUB_API_BASE = 'https://api.github.com';

const DEFAULT_DB = {
  entries: [],
  votes: [],
  judgeScores: [],
  bets: [],       // 决赛押宝：每人限押 1 个作品，预测其为某赛道冠军
  drawRecords: [],
  settings: {
    judgePassword: 'wb2026',
    adminPassword: 'yzfwb2016',
    votingEnabled: false,
    currentStage: 'preliminary',
    luckyListEnabled: false,
    drawConfig: {
      enabled: false,
      rules: '1. 每赛程每位用户最多投 5 票。\n2. 赛程结算后，押中晋级/获奖作品即可获得抽奖次数（押中 1 个作品 = 1 次抽奖机会）。\n3. 点击抽奖后按剩余奖品数与剩余抽奖次数自动计算中奖概率，奖品库存为 0 时不再抽中。\n4. 中奖后请联系管理员兑奖。',
      contact: '刘相丞（刘木目）'
    },
    prizes: {
      preliminary: [],
      semi_final: [],
      final: []
    },
    judges: [],  // 旧字段，兼容保留，新数据使用 judgesByStage
    judgesByStage: { preliminary: [], semi_final: [], final: [] }  // 按赛段评委名单
  }
};

function loadDB() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const data = JSON.parse(raw);
    const merged = { ...DEFAULT_DB, ...data, settings: { ...DEFAULT_DB.settings, ...(data.settings || {}) } };
    // Auto-migrate: ensure stage fields exist
    (merged.entries || []).forEach(e => {
      if (!e.roundStatus) e.roundStatus = 'approved';
      if (!e.award) e.award = null;
      // Migrate old dept/subdept to dept1/dept2/dept3
      if (!e.dept1) e.dept1 = e.dept || '';
      if (!e.dept2) e.dept2 = e.subdept || '';
      if (!e.dept3) e.dept3 = '';
      if (!e.mobile) e.mobile = '';
      if (!e.entryType) e.entryType = 'individual';
      if (!e.teamName) e.teamName = '';
      if (!e.teamMembers) e.teamMembers = '';
    });
    (merged.votes || []).forEach(v => {
      if (!v.stage) v.stage = 'preliminary';
    });
    // 投票去重：同一用户对同一作品在同一赛段只能投一次
    const voteSet = new Set();
    merged.votes = merged.votes.filter(v => {
      const key = v.voterId + '|' + v.entryId + '|' + (v.stage || 'preliminary');
      if (voteSet.has(key)) return false;
      voteSet.add(key);
      return true;
    });
    (merged.judgeScores || []).forEach(s => {
      if (!s.stage) s.stage = 'preliminary';
    });
    // 押宝记录保留完整历史（含撤销），用于统计撤销次数；由 getActiveBet 取当前有效押宝
    merged.bets = (merged.bets || []).map(b => ({ ...b, stage: b.stage || 'semi_final', revoked: !!b.revoked })).filter(b => b.voterId && b.id);
    // 迁移：旧版 judges 是全局数组，新版改为按赛段 judgesByStage
    if (!merged.settings.judgesByStage) {
      const oldJudges = merged.settings.judges || [];
      merged.settings.judgesByStage = {
        preliminary: [...oldJudges],
        semi_final: [...oldJudges],
        final: [...oldJudges]
      };
    } else {
      // 确保三个赛段键都存在
      if (!merged.settings.judgesByStage.preliminary) merged.settings.judgesByStage.preliminary = [];
      if (!merged.settings.judgesByStage.semi_final) merged.settings.judgesByStage.semi_final = [];
      if (!merged.settings.judgesByStage.final) merged.settings.judgesByStage.final = [];
    }
    // 迁移：确保抽奖配置、奖品池、抽奖记录存在
    if (!merged.settings.drawConfig) {
      merged.settings.drawConfig = { ...DEFAULT_DB.settings.drawConfig };
    } else {
      const dc = merged.settings.drawConfig;
      if (dc.enabled === undefined) dc.enabled = false;
      if (!dc.rules) dc.rules = DEFAULT_DB.settings.drawConfig.rules;
      if (!dc.contact) dc.contact = DEFAULT_DB.settings.drawConfig.contact;
      // 旧版 noWinWeight 已废弃：概率改为按剩余奖品/剩余抽奖次数动态计算
      delete dc.noWinWeight;
    }
    // 迁移：旧版 prizes 是全局数组，新版改为按赛段映射
    if (Array.isArray(merged.settings.prizes)) {
      const old = merged.settings.prizes || [];
      merged.settings.prizes = {
        preliminary: old,
        semi_final: [],
        final: [],
        awarded: []
      };
    } else if (!merged.settings.prizes || typeof merged.settings.prizes !== 'object') {
      merged.settings.prizes = { ...DEFAULT_DB.settings.prizes };
    } else {
      // 确保三个抽奖赛段键都存在
      for (const s of DRAW_STAGE_ORDER) {
        if (!Array.isArray(merged.settings.prizes[s])) merged.settings.prizes[s] = [];
      }
    }
    if (!merged.drawRecords) merged.drawRecords = [];
    return merged;
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
}

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

// 清理旧内联 base64 附件字段，让 contest.json 瘦身，避免 ghPush 因体积超限失败
function migrateLegacyAttachments() {
  let changed = false;
  for (const e of db.entries) {
    if ('attachmentBase64' in e || 'attachmentName' in e || 'attachmentPath' in e || 'attachmentMime' in e) {
      delete e.attachmentBase64;
      delete e.attachmentName;
      delete e.attachmentPath;
      delete e.attachmentMime;
      changed = true;
    }
  }
  return changed;
}

const db = loadDB();

// 启动闸门：GitHub 同步 + 本地数据载入完成前为 false，期间拒绝一切写入请求，
// 避免启动窗口内提交的报名被 ghPull 用旧快照整体覆盖而静默丢失
let _ready = false;

// ========== STAGE SYSTEM ==========
const STAGE_LABELS = {
  preliminary: '初赛',
  semi_final: '复赛',
  final: '决赛',
  awarded: '已结算'
};

function getCurrentStage() {
  return db.settings.currentStage || 'preliminary';
}

// 获取指定赛段的评委名单（空数组表示不限制）
function getStageJudges(stage) {
  const jbs = db.settings.judgesByStage;
  if (!jbs) return db.settings.judges || []; // 旧数据兼容
  return jbs[stage] || [];
}

// 判断评委是否在指定赛段的名单中（支持前后空格、大小写差异）
function isJudgeInList(judgeName, stage) {
  const list = getStageJudges(stage);
  if (list.length === 0) return true; // 名单为空时任何人都可以打分
  const normalized = String(judgeName || '').trim().toLowerCase();
  return list.some(n => String(n || '').trim().toLowerCase() === normalized);
}

function isVotingStage(stage) {
  return stage === 'preliminary' || stage === 'semi_final';
}

// Entries eligible for voting in a given stage
function getVotableEntries(stage) {
  if (stage === 'preliminary') {
    // 展示所有已过审作品，不过滤 roundStatus（保证晋级后初赛视图不变空）
    return db.entries.filter(e => e.status === 'approved');
  }
  if (stage === 'semi_final') {
    // 复赛投票分分母：所有复赛参与者（含已晋级决赛的 finalist/awarded/eliminated_final），
    // 避免晋级决赛后 semi_finalist 集合变空导致投票分全部虚高为满分
    return db.entries.filter(e => ['semi_finalist', 'finalist', 'awarded', 'eliminated_final'].includes(e.roundStatus));
  }
  return [];
}

// Entries eligible for judging in a given stage
function getJudgableEntries(stage) {
  if (stage === 'preliminary') {
    // 展示所有已过审作品，不过滤 roundStatus（保证晋级后初赛视图不变空）
    return db.entries.filter(e => e.status === 'approved');
  }
  if (stage === 'semi_final') {
    return db.entries.filter(e => e.roundStatus === 'semi_finalist');
  }
  if (stage === 'final') {
    return db.entries.filter(e => e.roundStatus === 'finalist');
  }
  return [];
}

// Calculate stage-specific scores for an entry
function getEntryStageScores(entryId, stage) {
  const scores = db.judgeScores.filter(s => s.entryId === entryId && (s.stage || 'preliminary') === stage);
  const voteCount = db.votes.filter(v => v.entryId === entryId && (v.stage || 'preliminary') === stage).length;
  const avgScore = scores.length > 0
    ? Math.round(scores.reduce((sum, s) => sum + s.practicality + s.innovation + s.scalability + s.presentation, 0) / scores.length)
    : 0;
  return { scores, voteCount, avgScore, judgeCount: scores.length };
}

// ========== 统一晋级规则（管理后台勾选面板与排名页共用） ==========
// 部门归属键：中小微事业群下钻二级部门，其余用一级部门
function deptKeyOf(e) {
  const d1 = (e.dept1 || e.dept || '').trim();
  if (!d1) return '__none__';
  if (d1.indexOf('中小微') !== -1) {
    const d2 = (e.dept2 || e.subdept || '').trim();
    if (d2) return d1 + '/' + d2;
  }
  return d1;
}

// 晋级规则：个人 TOP10 / 团队 TOP3 直晋级；其余各部门（按 deptKeyOf）前 1 部门维度晋级。
// 去重：个人部门维度——TOP10 中该部门已超过 2 个不录、该部门已有团队作品入围不录；
//       团队部门维度——TOP3 中已有该部门不录。
function computePromotePlan(annotated) {
  const sorted = annotated.slice().sort((a, b) => (b.composite || 0) - (a.composite || 0));
  const personal = sorted.filter(e => e.entryType !== 'team');
  const team = sorted.filter(e => e.entryType === 'team');
  const directP = personal.slice(0, 10);
  const directT = team.slice(0, 3);
  const directIds = new Set([...directP, ...directT].map(e => e.id));
  const pdc = {}; directP.forEach(e => { const d = deptKeyOf(e); pdc[d] = (pdc[d] || 0) + 1; });
  const tdc = {}; directT.forEach(e => { const d = deptKeyOf(e); tdc[d] = (tdc[d] || 0) + 1; });
  // 团队部门维度：TOP3 已有该部门则不录
  const deptT = []; const seenT = new Set();
  for (const e of team) {
    if (directIds.has(e.id)) continue;
    const d = deptKeyOf(e);
    if (seenT.has(d) || tdc[d]) continue;
    deptT.push(e); seenT.add(d);
  }
  // 已有团队作品入围的部门集合（团队直晋级 ∪ 团队部门维度）
  const teamAdvancedDepts = new Set([...directT, ...deptT].map(e => deptKeyOf(e)));
  // 个人部门维度：TOP10 中该部门 >2 个不录；团队已入围该部门不录
  const deptP = []; const seenP = new Set();
  for (const e of personal) {
    if (directIds.has(e.id)) continue;
    const d = deptKeyOf(e);
    if (seenP.has(d)) continue;
    if ((pdc[d] || 0) > 2) continue;
    if (teamAdvancedDepts.has(d)) continue;
    deptP.push(e); seenP.add(d);
  }
  const deptIds = new Set([...deptP, ...deptT].map(e => e.id));
  // 标注每个作品
  const result = new Map();
  annotated.forEach(e => {
    let t = 'none';
    if (directIds.has(e.id)) t = 'direct';
    else if (deptIds.has(e.id)) t = 'dept';
    result.set(e.id, { promoteType: t, promoteDept: deptKeyOf(e) });
  });
  return result;
}

// Calculate composite score for an entry in a specific stage
function getCompositeScore(entryId, stage) {
  const { avgScore, voteCount } = getEntryStageScores(entryId, stage);
  let currentComposite;
  if (stage === 'final' || stage === 'awarded') {
    currentComposite = avgScore; // 100% judge score, no voting
  } else {
    // For preliminary and semi_final: 80% judge + 20% votes（保留 2 位小数）
    const votable = getVotableEntries(stage);
    const allVoteCounts = votable.map(e => getEntryStageScores(e.id, stage).voteCount);
    const maxVotes = Math.max(1, ...allVoteCounts, voteCount);
    const voteScore = (voteCount / maxVotes) * 100;
    currentComposite = Math.round((avgScore * 0.8 + voteScore * 0.2) * 100) / 100;
  }

  // 赛段晋级时，上一赛段综合分按 40% 权重继承到本赛段（当前赛段 60%），保留 2 位小数
  if (stage === 'semi_final') {
    const prevComposite = getCompositeScore(entryId, 'preliminary');
    return Math.round((prevComposite * 0.4 + currentComposite * 0.6) * 100) / 100;
  }
  if (stage === 'final' || stage === 'awarded') {
    const prevComposite = getCompositeScore(entryId, 'semi_final');
    return Math.round((prevComposite * 0.4 + currentComposite * 0.6) * 100) / 100;
  }
  return currentComposite;
}

// Count user's votes in current stage
function getUserStageVoteCount(userId, stage) {
  return db.votes.filter(v => v.voterId === userId && (v.stage || 'preliminary') === stage).length;
}

const VOTE_LIMIT_BY_STAGE = { preliminary: 5, semi_final: 4, final: 0, awarded: 0 };
function getVoteLimit(stage) {
  return VOTE_LIMIT_BY_STAGE[stage] ?? 5;
}

// ========== GITHUB SYNC ==========
let _ghSha = null;
let _ghTimer = null;
// 互斥改为 Promise 去重：并发调用共享同一个在途 Promise，
// 进程退出前的 forceSync 因此能真正「等待」在途 push 完成而不是放弃（防止 exit 杀掉 push 丢数据）
let _ghPushPromise = null;
const GH_TIMEOUT = 10000; // 10s timeout for GitHub API calls

function ghReq(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(GITHUB_API_BASE + apiPath);
    const opts = {
      hostname: url.hostname, path: url.pathname + url.search, method,
      timeout: GH_TIMEOUT,
      headers: {
        'Authorization': 'Bearer ' + GITHUB_TOKEN,
        'User-Agent': 'WorkBuddy-Contest',
        'Accept': 'application/vnd.github.v3+json',
      },
    };
    if (body) {
      const p = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(p);
    }
    const r = https.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { const j = JSON.parse(d); resolve({ status: res.statusCode, data: j }); }
        catch { reject(new Error(d)); }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('GitHub API timeout after ' + GH_TIMEOUT + 'ms')); });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function ghPull() {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN not set');
  // Ensure data branch exists; if not, create it from an empty orphan branch
  try {
    const branchResp = await ghReq('GET', `/repos/${GITHUB_REPO}/git/ref/heads/${GITHUB_DATA_BRANCH}`);
    if (branchResp.status === 404) {
      console.log('[gh] data branch not found, trying to create it...');
      // Get default branch latest commit
      const repoResp = await ghReq('GET', `/repos/${GITHUB_REPO}`);
      if (repoResp.status >= 400) throw new Error(repoResp.data.message || 'Cannot fetch repo info');
      const defaultBranch = repoResp.data.default_branch;
      const baseRef = await ghReq('GET', `/repos/${GITHUB_REPO}/git/ref/heads/${defaultBranch}`);
      if (baseRef.status >= 400) throw new Error(baseRef.data.message || 'Cannot fetch default branch');
      const baseSha = baseRef.data.object.sha;
      // Create data branch pointing to default branch commit
      const createRef = await ghReq('POST', `/repos/${GITHUB_REPO}/git/refs`, {
        ref: `refs/heads/${GITHUB_DATA_BRANCH}`,
        sha: baseSha
      });
      if (createRef.status >= 400) throw new Error(createRef.data.message || 'Cannot create data branch');
      console.log('[gh] created data branch:', GITHUB_DATA_BRANCH);
    }
  } catch (e) {
    console.log('[gh] branch check/create error:', e.message);
  }

  const { status, data } = await ghReq('GET', `/repos/${GITHUB_REPO}/contents/data/contest.json?ref=${GITHUB_DATA_BRANCH}`);
  _syncStatus.lastStatus = status;
  _syncStatus.lastResponse = data && data.message ? data.message : null;
  if (status === 404) {
    // File doesn't exist yet — use current in-memory data (not empty DEFAULT_DB)
    // 这样即使 Render 重启，内存中的 db（已 loadDB）也不会被空数据覆盖
    console.log('[gh] data/contest.json not found, creating with current data...');
    const currentData = JSON.stringify(db, null, 2);
    const body = { message: 'auto: init data file', content: Buffer.from(currentData).toString('base64'), branch: GITHUB_DATA_BRANCH };
    const createResp = await ghReq('PUT', `/repos/${GITHUB_REPO}/contents/data/contest.json`, body);
    if (createResp.status >= 400) throw new Error(createResp.data.message || 'Failed to create data file');
    _ghSha = createResp.data.content.sha;
    // 不覆盖本地文件！本地已经是正确的数据（loadDB 加载的）
    console.log('[gh] Created remote data file from current memory — entries:', (db.entries||[]).length, 'sha:', _ghSha.slice(0, 7));
    return;
  }
  if (status >= 400) throw new Error(data.message || `GitHub API error ${status}`);
  _ghSha = data.sha;
  const buf = Buffer.from(data.content, data.encoding || 'base64');
  const remoteData = JSON.parse(buf.toString('utf8'));
  const remoteCount = (remoteData.entries || []).length;
  const remoteVotes = (remoteData.votes || []).length;
  const remoteScores = (remoteData.judgeScores || []).length;
  _syncStatus.githubEntries = remoteCount;

  // ===== 合并策略（替代旧的全量替换策略）=====
  // 旧方案：比较 entries+votes+scores 总量，总量大的覆盖小的 → 仍有掉票风险
  // 新方案：合并本地和远程数据，取两者并集，任何数据都不会丢失
  const localExists = fs.existsSync(DB_FILE);
  if (localExists) {
    const localData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

    // 1. 合并 entries：按 id 去重，重复的保留较新的
    const localEntries = localData.entries || [];
    const remoteEntries = remoteData.entries || [];
    const entryMap = new Map();
    for (const e of localEntries) entryMap.set(e.id, e);
    for (const e of remoteEntries) {
      if (!entryMap.has(e.id)) {
        entryMap.set(e.id, e);
      } else {
        // 保留 updatedAt 更新的
        const existing = entryMap.get(e.id);
        const existingTime = existing.updatedAt || existing.createdAt || '';
        const remoteTime = e.updatedAt || e.createdAt || '';
        if (remoteTime > existingTime) entryMap.set(e.id, e);
      }
    }
    const mergedEntries = [...entryMap.values()];

    // 2. 合并 votes：按 voterId+entryId+stage 去重，重复的保留较新的
    const localVotes = localData.votes || [];
    const remoteVotesArr = remoteData.votes || [];
    const voteMap = new Map();
    for (const v of localVotes) {
      const key = v.voterId + '|' + v.entryId + '|' + (v.stage || 'preliminary');
      if (!voteMap.has(key)) voteMap.set(key, v);
    }
    for (const v of remoteVotesArr) {
      const key = v.voterId + '|' + v.entryId + '|' + (v.stage || 'preliminary');
      if (!voteMap.has(key)) {
        voteMap.set(key, v);
      } else {
        // 保留 createdAt 更新的
        const existing = voteMap.get(key);
        if ((v.createdAt || '') > (existing.createdAt || '')) voteMap.set(key, v);
      }
    }
    const mergedVotes = [...voteMap.values()];

    // 3. 合并 judgeScores：按 entryId+judgeName+stage 去重
    const localScores = localData.judgeScores || [];
    const remoteScoresArr = remoteData.judgeScores || [];
    const scoreMap = new Map();
    for (const s of localScores) {
      const key = s.entryId + '|' + s.judgeName + '|' + (s.stage || 'preliminary');
      if (!scoreMap.has(key)) scoreMap.set(key, s);
    }
    for (const s of remoteScoresArr) {
      const key = s.entryId + '|' + s.judgeName + '|' + (s.stage || 'preliminary');
      if (!scoreMap.has(key)) {
        scoreMap.set(key, s);
      } else {
        const existing = scoreMap.get(key);
        if ((s.updatedAt || '') > (existing.updatedAt || '')) scoreMap.set(key, s);
      }
    }
    const mergedScores = [...scoreMap.values()];

    // 4. settings：标量字段远程优先，数组字段（judges/prizes）取并集
    const localSettings = localData.settings || {};
    const remoteSettings = remoteData.settings || {};
    const mergedSettings = { ...localSettings, ...remoteSettings };
    // judgesByStage 按赛段合并：每个赛段本地优先，补充远程独有的新增评委
    if (localSettings.judgesByStage || remoteSettings.judgesByStage) {
      const localJbs = localSettings.judgesByStage || {};
      const remoteJbs = remoteSettings.judgesByStage || {};
      const mergedJbs = {};
      const localScoreNames = new Set((localData.judgeScores || []).map(s => s.judgeName));
      for (const st of ['preliminary', 'semi_final', 'final']) {
        const localList = localJbs[st] || [];
        const remoteList = remoteJbs[st] || [];
        if (localList.length > 0) {
          // 本地有名单 → 以本地为准，补充远程独有的新增评委
          const localSet = new Set(localList);
          for (const j of remoteList) {
            if (!localSet.has(j) && !localScoreNames.has(j)) {
              localList.push(j); // 远程新增，本地没有打分记录 → 保留
            }
          }
          mergedJbs[st] = localList;
        } else {
          mergedJbs[st] = remoteList; // 本地为空 → 使用远程
        }
      }
      mergedSettings.judgesByStage = mergedJbs;
    }
    // 旧 judges 字段兼容保留
    if (localSettings.judges || remoteSettings.judges) {
      mergedSettings.judges = localSettings.judges && localSettings.judges.length > 0
        ? localSettings.judges : (remoteSettings.judges || []);
    }
    // prizes 数组：按赛段取并集（每个赛段内的奖品按 name 去重）
    if (localSettings.prizes || remoteSettings.prizes) {
      const lp = localSettings.prizes || {};
      const rp = remoteSettings.prizes || {};
      const mergedPrizes = {};
      const stages = new Set([...Object.keys(lp), ...Object.keys(rp)]);
      for (const st of stages) {
        const localItems = lp[st] || [];
        const remoteItems = rp[st] || [];
        const seen = new Set();
        mergedPrizes[st] = [];
        for (const item of [...localItems, ...remoteItems]) {
          const key = item.name || item.label || JSON.stringify(item);
          if (!seen.has(key)) { seen.add(key); mergedPrizes[st].push(item); }
        }
      }
      mergedSettings.prizes = mergedPrizes;
    }

    // 5. 合并 drawRecords：按 id 去重，保留较新的（按 drawnAt）
    const localDrawRecords = localData.drawRecords || [];
    const remoteDrawRecords = remoteData.drawRecords || [];
    const drawRecordMap = new Map();
    for (const r of localDrawRecords) {
      if (r.id) drawRecordMap.set(r.id, r);
    }
    for (const r of remoteDrawRecords) {
      if (!r.id) continue;
      if (!drawRecordMap.has(r.id)) {
        drawRecordMap.set(r.id, r);
      } else {
        const existing = drawRecordMap.get(r.id);
        if ((r.drawnAt || '') > (existing.drawnAt || '')) drawRecordMap.set(r.id, r);
      }
    }
    const mergedDrawRecords = [...drawRecordMap.values()];

    // 6. 合并 bets：按 id 去重，保留 createdAt 最新的；保留撤销记录用于统计
    const localBets = localData.bets || [];
    const remoteBets = remoteData.bets || [];
    const betMap = new Map();
    for (const b of localBets) { if (b.id && b.voterId) betMap.set(b.id, b); }
    for (const b of remoteBets) {
      if (!b.id || !b.voterId) continue;
      if (!betMap.has(b.id)) {
        betMap.set(b.id, b);
      } else {
        const existing = betMap.get(b.id);
        if ((b.createdAt || '') > (existing.createdAt || '')) betMap.set(b.id, b);
      }
    }
    const mergedBets = [...betMap.values()];

    // 7. 构建合并后的数据
    const mergedData = {
      ...localData,
      entries: mergedEntries,
      votes: mergedVotes,
      judgeScores: mergedScores,
      drawRecords: mergedDrawRecords,
      bets: mergedBets,
      settings: mergedSettings
    };

    const localCount = localEntries.length;
    const localVoteCount = localVotes.length;
    const localScoreCount = localScores.length;
    const localDrawCount = localDrawRecords.length;
    const localBetCount = localBets.length;
    const hadChanges = mergedEntries.length !== localCount
      || mergedVotes.length !== localVoteCount
      || mergedScores.length !== localScoreCount
      || mergedDrawRecords.length !== localDrawCount
      || mergedBets.length !== localBetCount;

    if (hadChanges) {
      fs.writeFileSync(DB_FILE, JSON.stringify(mergedData, null, 2), 'utf8');
      console.log('[gh] Merged data — entries:', localCount, '→', mergedEntries.length,
        '| votes:', localVoteCount, '→', mergedVotes.length,
        '| scores:', localScoreCount, '→', mergedScores.length,
        '| draws:', localDrawCount, '→', mergedDrawRecords.length,
        '| bets:', localBetCount, '→', mergedBets.length,
        'sha:', _ghSha.slice(0, 7));
    } else {
      console.log('[gh] Data in sync — entries:', localCount, 'votes:', localVoteCount, 'scores:', localScoreCount, 'draws:', localDrawCount, 'bets:', localBetCount, 'sha:', _ghSha.slice(0, 7));
    }
  } else {
    fs.writeFileSync(DB_FILE, buf, 'utf8');
    console.log('[gh] Pulled data (no local file) — entries:', remoteCount, 'votes:', remoteVotes, 'sha:', _ghSha.slice(0, 7));
  }
}

function ghPushSchedule() {
  if (!GITHUB_TOKEN) return;
  if (_ghTimer) clearTimeout(_ghTimer);
  _ghTimer = setTimeout(() => { ghPush().catch(() => {}); }, 1000);
}

// 进程退出前强制同步一次（Render 休眠/重启时触发）
let _shuttingDown = false;
async function forceSyncBeforeExit() {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log('[gh] Force sync before exit...');
  try {
    // 先确保内存中的最新数据写入磁盘
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    // 第一次 await：若恰有在途 push，会等它做完（Promise 去重），不会中途放弃
    // 即使失败也继续第二次，尽力把磁盘上的最新数据全部推上 GitHub
    await ghPush().catch(e => console.error('[gh] exit push #1 failed:', e.message));
    await ghPush().catch(e => console.error('[gh] exit push #2 failed:', e.message));
    await ghPushSessions();
    console.log('[gh] Force sync complete');
  } catch (e) {
    console.error('[gh] Force sync failed:', e.message);
  }
}
process.on('SIGTERM', () => { forceSyncBeforeExit().then(() => process.exit(0)); });
process.on('SIGINT', () => { forceSyncBeforeExit().then(() => process.exit(0)); });

function ghPush() {
  if (!_ghPushPromise) {
    _ghPushPromise = doGhPush().finally(() => { _ghPushPromise = null; });
  }
  return _ghPushPromise;
}

async function doGhPush() {
  if (!GITHUB_TOKEN) return;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const buf = fs.readFileSync(DB_FILE);
      const body = { message: 'auto: sync data', content: buf.toString('base64'), branch: GITHUB_DATA_BRANCH };
      if (_ghSha) body.sha = _ghSha;
      const { status, data } = await ghReq('PUT', `/repos/${GITHUB_REPO}/contents/data/contest.json`, body);
      if (status === 409 || (status === 422 && data.message && data.message.includes('SHA'))) {
        // 409 Conflict / 422 SHA mismatch：远程数据被其他人更新了
        // 先 pull 合并最新数据，再 push
        console.log(`[gh] Push conflict (attempt ${attempt}), pulling latest before retry...`);
        await ghPull();
        // 重新 loadDB 到内存，确保合并后的数据写入磁盘
        const refreshed = loadDB();
        db.entries = refreshed.entries;
        db.votes = refreshed.votes;
        db.judgeScores = refreshed.judgeScores;
        db.settings = refreshed.settings;
        db.drawRecords = refreshed.drawRecords || [];
        db.bets = refreshed.bets || [];
        // 重新写入磁盘（合并后的数据）
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
        continue; // 重试 push
      }
      if (status >= 400) throw new Error(data.message || status);
      _ghSha = data.content.sha;
      console.log('[gh] Pushed data — sha:', _ghSha.slice(0, 7));
      return;
    } catch (e) {
      console.error(`[gh] Push attempt ${attempt}/${maxAttempts} failed:`, e.message);
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  // 三次全部失败：安排 30 秒后后台重试，防止数据只留在本地 ephemeral 磁盘上
  console.error('[gh] Push data FAILED after retries — will retry in 30s to avoid local-only data loss');
  if (!_shuttingDown) {
    setTimeout(() => { ghPush().catch(() => {}); }, 30 * 1000);
  }
  throw new Error('ghPush failed after retries');
}

// ===== SESSIONS GITHUB SYNC =====let _ghSessionSha = null;
let _ghSessionTimer = null;

async function ghPushSessions() {
  if (!GITHUB_TOKEN || sessions.size === 0) return;
  try {
    const obj = {}; sessions.forEach((s, t) => { obj[t] = s; });
    const buf = Buffer.from(JSON.stringify(obj));
    const body = { message: 'auto: sync sessions', content: buf.toString('base64'), branch: GITHUB_DATA_BRANCH };
    if (_ghSessionSha) body.sha = _ghSessionSha;
    const { status, data } = await ghReq('PUT', `/repos/${GITHUB_REPO}/contents/data/sessions.json`, body);
    if (status >= 400) {
      // 文件不存在时先创建
      if (status === 404) { _ghSessionSha = null; const body2 = { message: 'auto: init sessions', content: buf.toString('base64'), branch: GITHUB_DATA_BRANCH };
        const r2 = await ghReq('PUT', `/repos/${GITHUB_REPO}/contents/data/sessions.json`, body2);
        if (r2.status < 400) _ghSessionSha = r2.data.content.sha; }
      return;
    }
    _ghSessionSha = data.content.sha;
  } catch (e) { /* silent */ }
}

function ghPushSessionsSchedule() {
  if (!GITHUB_TOKEN) return;
  if (_ghSessionTimer) clearTimeout(_ghSessionTimer);
  _ghSessionTimer = setTimeout(ghPushSessions, 2000);
}

async function ghPullSessions() {
  if (!GITHUB_TOKEN) return;
  try {
    const { status, data } = await ghReq('GET', `/repos/${GITHUB_REPO}/contents/data/sessions.json?ref=${GITHUB_DATA_BRANCH}`);
    if (status >= 400) return;
    _ghSessionSha = data.sha;
    const buf = Buffer.from(data.content, data.encoding || 'base64');
    const remote = JSON.parse(buf.toString('utf8'));
    for (const [token, s] of Object.entries(remote)) {
      if (s && s.createdAt && (Date.now() - s.createdAt <= SESSION_MAX_AGE)) {
        if (!sessions.has(token)) sessions.set(token, s);
      }
    }
    console.log('[gh] Pulled sessions — count:', sessions.size);
  } catch (e) { /* silent */ }
}

const _realSaveDB = saveDB;
saveDB = function() {
  _realSaveDB();
  ghPushSchedule();
};

// ========== PASSWORD HELPERS (设置 Render 环境变量 JUDGE_PASSWORD / ADMIN_PASSWORD) ==========
function getJudgePassword() {
  return process.env.JUDGE_PASSWORD || db.settings.judgePassword || '';
}

function getAdminPassword() {
  return process.env.ADMIN_PASSWORD || db.settings.adminPassword || '';
}

// ========== EXPRESS ==========
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ extended: true, limit: '60mb' }));
app.use(cookieParser());

// 启动闸门：同步未完成前拒绝写入（GET/HEAD 放行），防止启动窗口内提交被旧快照覆盖
app.use((req, res, next) => {
  if (!_ready && req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(503).json({ error: '服务器正在启动同步数据，请 3 秒后重试' });
  }
  next();
});

// Explicit routes for app pages (no trailing-slash redirect)
app.get(['/app', '/app/'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'app', 'index.html')));
app.get('/app/submit.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app', 'submit.html')));
app.get('/app/browse.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app', 'browse.html')));
app.get('/app/judge.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app', 'judge.html')));
app.get('/app/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app', 'admin.html')));

app.use(express.static('public'));

// ========== AUTH MIDDLEWARE ==========
function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: '请先通过钉钉登录', needAuth: true });
  }
  req.ddUser = session;
  next();
}

// ========== API: ENTRIES ==========
app.get('/api/entries', requireAuth, (req, res) => {
  const { track, dept, search, sort } = req.query;
  const stage = getCurrentStage();
  let entries = db.entries.filter(e => e.status === 'approved');
  if (track) entries = entries.filter(e => e.track === track);
  if (dept) entries = entries.filter(e => e.dept === dept);
  if (search) {
    const kw = search.toLowerCase();
    entries = entries.filter(e => e.title.toLowerCase().includes(kw) || e.name.includes(search) || e.dept.includes(search) || (e.subdept || '').includes(search));
  }
  entries = entries.map(e => {
    const sd = getEntryStageScores(e.id, stage);
    const composite = getCompositeScore(e.id, stage);
    return { ...e, roundStatus: e.roundStatus || 'approved', award: e.award || null, voteCount: sd.voteCount, avgScore: sd.avgScore, judgeCount: sd.judgeCount, composite };
  });
  if (sort === 'score') entries.sort((a, b) => b.composite - a.composite);
  else if (sort === 'votes') entries.sort((a, b) => b.voteCount - a.voteCount);
  else entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ entries, currentStage: stage });
});

app.post('/api/entries', requireAuth, (req, res) => {
  let { name, mobile, dept, dept1, dept2, dept3, subdept, track, title, scene, process_text, process_link, result_text, result_link, extra, posterUrl, docUrl, entryType, teamName, teamMembers } = req.body;
  // Auto-fill name and mobile from DingTalk session if not provided
  if (!name && req.ddUser.nick) name = req.ddUser.nick;
  if (!mobile && req.ddUser.mobile) mobile = req.ddUser.mobile;
  // Backward compat: map old dept/subdept to dept1/dept2 if new fields missing
  if (!dept1 && dept) dept1 = dept;
  if (!dept2 && subdept) dept2 = subdept;
  // dept for backward compat
  if (!dept && dept1) dept = dept1;
  if (!name) return res.status(400).json({ error: '未获取到姓名，请重新登录钉钉' });
  if (!mobile) return res.status(400).json({ error: '未获取到手机号，请重新登录钉钉' });
  if (!dept1) return res.status(400).json({ error: '请选择一级部门' });
  // 参赛范围：全员可参与（已取消产研中心/研发部限制，作品由评委/观众自行识别）
  if (!track || !title || !scene || !process_text || !process_link || !result_text || !result_link) {
    return res.status(400).json({ error: '请填写所有必填字段' });
  }
  // 字数限制
  if (String(scene).length > 200) {
    return res.status(400).json({ error: '场景描述请控制在 200 字以内' });
  }
  // 链接格式校验
  if (!/^https?:\/\//.test(process_link) || !/^https?:\/\//.test(result_link)) {
    return res.status(400).json({ error: '使用过程、效果呈现链接必须以 http/https 开头' });
  }
  // 海报链接 + 文档链接必填
  if (!posterUrl || !/^https?:\/\//.test(posterUrl)) {
    return res.status(400).json({ error: '请填写有效的作品海报链接（http/https 图片链接）' });
  }
  if (!docUrl || !/^https?:\/\//.test(docUrl)) {
    return res.status(400).json({ error: '请填写有效的作品详情文档链接（http/https）' });
  }
  // 团队校验（团队名称由部门信息自动拼接）
  if (entryType === 'team' && (!teamName || !teamName.trim())) {
    teamName = dept1 + (dept2 ? ' / ' + dept2 : '') + (dept3 ? ' / ' + dept3 : '');
  }
  const id = 'entry_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  const entry = {
    id, name, mobile: mobile || '', dept: dept1, dept1, dept2: dept2 || '', dept3: dept3 || '',
    subdept: subdept || dept2 || '', // backward compat
    entryType: entryType || 'individual',
    teamName: teamName || '',
    teamMembers: teamMembers || '',
    track, title, scene,
    process_text, process_link,
    result_text, result_link,
    extra: extra || '',
    posterUrl: posterUrl.trim(),
    docUrl: docUrl.trim(),
    status: 'approved',
    roundStatus: 'approved',
    award: null,
    createdAt: new Date().toISOString()
  };
  db.entries.unshift(entry);
  saveDB();
  res.json({ success: true, id });
});

// ========== API: UPDATE OWN ENTRY ==========
// 本人可编辑本人作品；已获奖(awarded)锁定；附件可选替换；编辑后标记 editNotice 提醒评委
app.put('/api/entries/:id', requireAuth, (req, res) => {
  const entry = db.entries.find(e => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: '作品不存在' });
  // 仅本人可改（按钉钉手机号匹配）
  if (entry.mobile && req.ddUser.mobile && entry.mobile !== req.ddUser.mobile) {
    return res.status(403).json({ error: '只能修改本人提交的作品' });
  }
  // 已获奖锁定
  if (entry.roundStatus === 'awarded') {
    return res.status(403).json({ error: '作品已获奖，内容已锁定不可修改' });
  }
  let { track, title, scene, process_text, process_link, result_text, result_link, extra, posterUrl, docUrl } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: '请填写作品标题' });
  if (!scene || !scene.trim()) return res.status(400).json({ error: '请填写场景描述' });
  if (!process_text || !process_text.trim()) return res.status(400).json({ error: '请填写使用过程' });
  if (!result_text || !result_text.trim()) return res.status(400).json({ error: '请填写效果呈现' });
  if (String(scene).length > 200) return res.status(400).json({ error: '场景描述请控制在 200 字以内' });
  if (process_link && !/^https?:\/\//.test(process_link)) return res.status(400).json({ error: '使用过程链接必须以 http/https 开头' });
  if (result_link && !/^https?:\/\//.test(result_link)) return res.status(400).json({ error: '效果呈现链接必须以 http/https 开头' });
  if (posterUrl && !/^https?:\/\//.test(posterUrl)) return res.status(400).json({ error: '海报链接必须以 http/https 开头' });
  if (docUrl && !/^https?:\/\//.test(docUrl)) return res.status(400).json({ error: '详情文档链接必须以 http/https 开头' });

  entry.track = track || entry.track;
  entry.title = title.trim();
  entry.scene = scene;
  entry.process_text = process_text;
  entry.process_link = process_link || '';
  entry.result_text = result_text;
  entry.result_link = result_link || '';
  entry.extra = extra || entry.extra || '';
  if (posterUrl) entry.posterUrl = posterUrl.trim();
  if (docUrl) entry.docUrl = docUrl.trim();
  // 冻结字段不动：entryType / teamName / teamMembers / name / dept* / mobile / roundStatus / award
  entry.updatedAt = new Date().toISOString();
  entry.lastEditedAt = entry.updatedAt;
  entry.editNotice = true;
  saveDB();
  res.json({ success: true, id: entry.id });
});

// ========== API: ACK EDIT NOTICE (评委/管理员标记已读) ==========
app.post('/api/entries/:id/ack-edit', (req, res) => {
  const entry = db.entries.find(e => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: '作品不存在' });
  const { judgeName, judgePassword, adminPassword } = req.body;
  const judgeOk = judgePassword && judgePassword === getJudgePassword();
  const adminOk = adminPassword && adminPassword === getAdminPassword();
  if (!judgeOk && !adminOk) return res.status(403).json({ error: '仅评委或管理员可标记已读' });
  entry.editNotice = false;
  entry.editNoticeAckBy = judgeName || '管理员';
  entry.editNoticeAckAt = new Date().toISOString();
  saveDB();
  res.json({ success: true });
});

// ========== API: MY ENTRIES (本人投稿列表) ==========
// 按钉钉会话手机号匹配本人作品，用于「我的投稿」入口
// 注意：必须注册在 GET /api/entries/:id 之前，否则 'mine' 会被当作 :id 捕获
app.get('/api/entries/mine', requireAuth, (req, res) => {
  const mobile = req.ddUser.mobile;
  if (!mobile) return res.json({ entries: [] });
  const entries = db.entries
    .filter(e => e.mobile && e.mobile === mobile)
    .map(e => {
      return {
        ...e,
        roundStatus: e.roundStatus || 'approved',
        award: e.award || null,
        editable: e.roundStatus !== 'awarded',
        editNoticeAckBy: e.editNoticeAckBy || null,
        editNoticeAckAt: e.editNoticeAckAt || null
      };
    })
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
  res.json({ entries });
});

app.get('/api/entries/:id', requireAuth, (req, res) => {
  const entry = db.entries.find(e => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: '作品不存在' });
  const stage = getCurrentStage();
  const sd = getEntryStageScores(entry.id, stage);
  // Also include all-stage data for reference
  const allVotes = db.votes.filter(v => v.entryId === entry.id);
  const allScores = db.judgeScores.filter(s => s.entryId === entry.id);
  res.json({
    entry: {
      ...entry,
      roundStatus: entry.roundStatus || 'approved',
      award: entry.award || null,
      votes: allVotes,
      scores: allScores,
      avgScore: sd.avgScore,
      voteCount: sd.voteCount,
      judgeCount: sd.judgeCount,
      composite: getCompositeScore(entry.id, stage),
      currentStage: stage
    }
  });
});

// ========== API: ATTACHMENTS ==========
app.get('/api/attachments/:entryId', requireAuth, (req, res) => {
  const entry = db.entries.find(e => e.id === req.params.entryId);
  if (!entry) return res.status(404).json({ error: '作品不存在' });
  if (entry.docUrl) return res.redirect(entry.docUrl);
  res.status(404).json({ error: '该作品未填写文档链接' });
});

// ========== API: VOTES ==========
const _voteRL = new Map(); // 投票频率限制: userId -> lastVoteTimestamp
const VOTE_COOLDOWN_MS = 3000;

app.get('/api/voting/status', (req, res) => {
  res.json({ votingEnabled: !!db.settings.votingEnabled, currentStage: getCurrentStage() });
});

app.post('/api/votes/:entryId', requireAuth, (req, res) => {
  const stage = getCurrentStage();
  if (!isVotingStage(stage)) {
    return res.status(403).json({ error: '当前阶段不支持投票' });
  }
  if (!db.settings.votingEnabled) return res.status(403).json({ error: '投票暂未开启，请等待管理员开启后再投票' });

  const userId = req.ddUser.openId;
  // 频率限制：两次投票之间至少间隔 3 秒
  const lastVote = _voteRL.get(userId);
  if (lastVote && Date.now() - lastVote < VOTE_COOLDOWN_MS) {
    return res.status(429).json({ error: '操作过快，请稍后再试' });
  }

  // Check entry is votable in current stage
  const votable = getVotableEntries(stage);
  const entry = votable.find(e => e.id === req.params.entryId);
  if (!entry) return res.status(404).json({ error: '该作品在当前阶段不可投票' });
  // Check duplicate vote in this stage
  if (db.votes.some(v => v.entryId === req.params.entryId && v.voterId === userId && (v.stage || 'preliminary') === stage)) {
    return res.status(400).json({ error: '你在本阶段已经投过这个作品了' });
  }
  const userVoteCount = getUserStageVoteCount(userId, stage);
  const voteLimit = getVoteLimit(stage);
  if (userVoteCount >= voteLimit) return res.status(400).json({ error: '本阶段每人最多投' + voteLimit + '个作品' });
  db.votes.push({
    entryId: req.params.entryId,
    voterId: userId,
    voterName: req.ddUser.nick,
    voterMobile: req.ddUser.mobile || '',
    voterAvatar: req.ddUser.avatarUrl || '',
    stage,
    createdAt: new Date().toISOString()
  });
  saveDB();
  _voteRL.set(userId, Date.now()); // 记录本次投票时间用于频率限制
  const remaining = voteLimit - userVoteCount - 1;
  // 投票后立即 push，不等延迟，确保数据不丢失
  ghPush().catch(e => console.error('[vote] Immediate push failed:', e.message));
  res.json({ success: true, voteCount: db.votes.filter(v => v.entryId === req.params.entryId && (v.stage || 'preliminary') === stage).length, remaining });
});

// ========== API: MY VOTES ==========
app.get('/api/my-votes', requireAuth, (req, res) => {
  const userId = req.ddUser.openId;
  const stage = getCurrentStage();
  const myVotes = db.votes.filter(v => v.voterId === userId);
  // 按赛段分组
  const byStage = {};
  const STAGE_LABELS = { preliminary: '初赛', semi_final: '复赛', final: '决赛', awarded: '结算' };
  for (const v of myVotes) {
    const s = v.stage || 'preliminary';
    if (!byStage[s]) byStage[s] = [];
    const entry = db.entries.find(e => e.id === v.entryId);
    byStage[s].push({
      entryId: v.entryId,
      entryTitle: entry ? entry.title : '（已删除）',
      entryDept: entry ? (entry.dept1 || entry.dept || '') : '',
      entryTrack: entry ? (entry.track || '') : '',
      votedAt: v.createdAt
    });
  }
  // 汇总
  const summary = {};
  for (const [s, votes] of Object.entries(byStage)) {
    const stageLimit = getVoteLimit(s);
    summary[s] = {
      count: votes.length,
      limit: stageLimit,
      remaining: Math.max(0, stageLimit - votes.length),
      label: STAGE_LABELS[s] || s
    };
  }
  res.json({ byStage, summary, currentStage: stage });
});

// ========== API: FINAL BET（决赛押宝）==========
const BET_TRACK_LABEL = {
  efficiency: '效率提升',
  creative: '创意应用',
  business: '业务赋能',
  team: '团队赛道'
};

function getEntryBetTrack(entry) {
  if (entry.entryType === 'team') return 'team';
  return entry.track || 'efficiency';
}

// 押宝开放赛段：复赛押宝、决赛押宝都可开（投票仅在初赛/复赛，押宝可延伸到决赛）
const BETTING_STAGES = ['semi_final', 'final'];
function isBettingOpen() {
  return BETTING_STAGES.includes(getCurrentStage());
}
function getBettingStage() {
  return isBettingOpen() ? getCurrentStage() : null;
}

// 当前有效押宝（未撤销，限定赛段）
function getActiveBet(userId, stage) {
  const s = stage || getBettingStage();
  return db.bets.find(b => b.voterId === userId && !b.revoked && (b.stage || 'semi_final') === s) || null;
}

// 用户历史撤销次数（限定赛段）
function getRevokeCount(userId, stage) {
  const s = stage || getBettingStage();
  return db.bets.filter(b => b.voterId === userId && b.revoked && (b.stage || 'semi_final') === s).length;
}

// 是否还能撤销（仅允许撤销 1 次）
function canRevokeBet(userId, stage) {
  return isBettingOpen() && !!getActiveBet(userId, stage) && getRevokeCount(userId, stage) < 1;
}

// 用户在某赛段的历史押宝（不论是否撤销）
function getStageBets(userId, stage) {
  return db.bets.filter(b => b.voterId === userId && (b.stage || 'semi_final') === stage);
}

function getBettableEntries() {
  // 决赛阶段押宝：仅决赛作品（finalist/awarded）；复赛阶段：所有复赛作品
  const cur = getCurrentStage();
  if (cur === 'final' || cur === 'awarded') {
    return db.entries.filter(e => e.roundStatus === 'finalist' || e.roundStatus === 'awarded');
  }
  return db.entries.filter(e => e.roundStatus === 'semi_finalist' || e.roundStatus === 'finalist' || e.roundStatus === 'awarded');
}

// POST /api/bet/:entryId — 押宝某个作品
app.post('/api/bet/:entryId', requireAuth, (req, res) => {
  if (!isBettingOpen()) {
    return res.status(400).json({ error: '当前赛段未开放押宝' });
  }
  const stage = getBettingStage();
  const userId = req.ddUser.openId;
  const existing = getActiveBet(userId, stage);
  if (existing) {
    return res.status(400).json({ error: '每人每赛段仅限押宝 1 个作品，您已押宝「' + existing.entryTitle + '」' });
  }
  const entry = getBettableEntries().find(e => e.id === req.params.entryId);
  if (!entry) return res.status(404).json({ error: '该作品不可押宝' });
  const track = getEntryBetTrack(entry);
  const bet = {
    id: 'bet_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    voterId: userId,
    voterName: req.ddUser.nick,
    voterMobile: req.ddUser.mobile || '',
    voterAvatar: req.ddUser.avatarUrl || '',
    stage,
    entryId: entry.id,
    entryTitle: entry.title,
    entryDept: entry.dept1 || entry.dept || '',
    track,
    trackLabel: BET_TRACK_LABEL[track] || track,
    revoked: false,
    createdAt: new Date().toISOString()
  };
  db.bets.push(bet);
  saveDB();
  ghPush().catch(e => console.error('[bet] Immediate push failed:', e.message));
  res.json({ success: true, bet });
});

// POST /api/bet/revoke — 撤销当前押宝（每人每赛段限 1 次）
app.post('/api/bet/revoke', requireAuth, (req, res) => {
  if (!isBettingOpen()) {
    return res.status(400).json({ error: '当前赛段未开放押宝，无法撤销' });
  }
  const stage = getBettingStage();
  const userId = req.ddUser.openId;
  const activeBet = getActiveBet(userId, stage);
  if (!activeBet) {
    return res.status(400).json({ error: '您当前没有押宝记录' });
  }
  if (getRevokeCount(userId, stage) >= 1) {
    return res.status(400).json({ error: '每人每赛段仅限撤销 1 次押宝' });
  }
  activeBet.revoked = true;
  activeBet.revokedAt = new Date().toISOString();
  saveDB();
  ghPush().catch(e => console.error('[bet revoke] Immediate push failed:', e.message));
  res.json({ success: true, message: '已撤销押宝，可重新选择 1 个作品' });
});

// GET /api/my-bet — 当前用户押宝记录（含跨赛段历史）
app.get('/api/my-bet', requireAuth, (req, res) => {
  const userId = req.ddUser.openId;
  const currentStage = getBettingStage();
  const bet = currentStage ? getActiveBet(userId, currentStage) : null;
  // 跨赛段历史：用户的所有押宝（含撤销、含复赛和决赛）
  const allBets = getStageBets(userId, 'semi_final')
    .concat(getStageBets(userId, 'final'))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({
    bet,
    isBettingOpen: isBettingOpen(),
    currentStage: getCurrentStage(),
    bettingStage: currentStage,
    canRevoke: canRevokeBet(userId, currentStage),
    hasRevoked: currentStage ? getRevokeCount(userId, currentStage) >= 1 : false,
    history: allBets
  });
});

// GET /api/bets/summary — 押宝统计（公开）
app.get('/api/bets/summary', (req, res) => {
  const stage = getBettingStage();
  const bettable = getBettableEntries();
  const activeBets = db.bets.filter(b => !b.revoked && (b.stage || 'semi_final') === stage);
  const summary = bettable.map(e => {
    const track = getEntryBetTrack(e);
    const count = activeBets.filter(b => b.entryId === e.id).length;
    return {
      entryId: e.id,
      title: e.title,
      name: e.name,
      track,
      trackLabel: BET_TRACK_LABEL[track] || track,
      betCount: count
    };
  }).filter(s => s.betCount > 0).sort((a, b) => b.betCount - a.betCount);
  const totalBettors = new Set(activeBets.map(b => b.voterId)).size;
  res.json({ summary, totalBettors, isBettingOpen: isBettingOpen(), currentStage: getCurrentStage(), bettingStage: stage });
});

// ========== API: JUDGE ==========
app.post('/api/judge/scores/:entryId', (req, res) => {
  const { judgeName, practicality, innovation, scalability, presentation, judgePassword } = req.body;
  if (!judgeName) return res.status(400).json({ error: '请输入评委姓名' });
  if (judgePassword !== getJudgePassword()) {
    return res.status(403).json({ error: '评委密码错误' });
  }
  const stage = getCurrentStage();
  // 评委名单校验：按当前赛段校验
  if (!isJudgeInList(judgeName, stage)) {
    return res.status(403).json({ error: '您不在当前赛段评委名单中，请联系管理员添加' });
  }
  // Check entry is judgable in current stage
  const judgable = getJudgableEntries(stage);
  const entry = judgable.find(e => e.id === req.params.entryId);
  if (!entry) return res.status(404).json({ error: '该作品在当前阶段不可打分' });
  // 评委回避：不能给自己的作品打分
  if (entry.name === judgeName || (entry.teamMembers && entry.teamMembers.includes(judgeName))) {
    return res.status(403).json({ error: '评委不能给自己的作品打分，已自动回避' });
  }
  const p = parseInt(practicality) || 0, c = parseInt(innovation) || 0, s = parseInt(scalability) || 0, r = parseInt(presentation) || 0;
  if (p > 50 || c > 20 || s > 15 || r > 15) return res.status(400).json({ error: '分数超出上限' });
  const idx = db.judgeScores.findIndex(sc => sc.entryId === req.params.entryId && sc.judgeName === judgeName && (sc.stage || 'preliminary') === stage);
  const scoreData = { entryId: req.params.entryId, judgeName, practicality: p, innovation: c, scalability: s, presentation: r, stage, updatedAt: new Date().toISOString() };
  if (idx >= 0) db.judgeScores[idx] = scoreData;
  else db.judgeScores.push(scoreData);
  saveDB();
  res.json({ success: true, total: p + c + s + r, stage });
});

// GET /api/judge/my-scores — return this judge's existing scores for current stage
app.get('/api/judge/my-scores', (req, res) => {
  const { judgeName, judgePassword } = req.query;
  if (!judgeName) return res.status(400).json({ error: '缺少评委姓名' });
  if (judgePassword !== getJudgePassword()) {
    return res.status(403).json({ error: '评委密码错误' });
  }
  // 评委名单校验：按当前赛段校验
  const stage = getCurrentStage();
  if (!isJudgeInList(judgeName, stage)) {
    return res.status(403).json({ error: '您不在当前赛段评委名单中，请联系管理员添加' });
  }
  const scores = db.judgeScores
    .filter(s => s.judgeName === judgeName && (s.stage || 'preliminary') === stage)
    .map(s => ({ entryId: s.entryId, practicality: s.practicality, innovation: s.innovation, scalability: s.scalability, presentation: s.presentation, total: s.practicality + s.innovation + s.scalability + s.presentation }));

  // 赛段晋级时，若同一位评委在上个赛段已打分且本赛段尚未打分，默认继承上一赛段分数
  const inherited = [];
  if (stage === 'semi_final' || stage === 'final') {
    const prevStage = stage === 'semi_final' ? 'preliminary' : 'semi_final';
    const judgable = getJudgableEntries(stage);
    const judgableIds = new Set(judgable.map(e => e.id));
    const existingIds = new Set(scores.map(s => s.entryId));
    const prevScores = db.judgeScores.filter(s => s.judgeName === judgeName && (s.stage || 'preliminary') === prevStage);
    prevScores.forEach(s => {
      if (!existingIds.has(s.entryId) && judgableIds.has(s.entryId)) {
        inherited.push({
          entryId: s.entryId,
          practicality: s.practicality,
          innovation: s.innovation,
          scalability: s.scalability,
          presentation: s.presentation,
          total: s.practicality + s.innovation + s.scalability + s.presentation,
          inheritedFrom: prevStage
        });
      }
    });
  }

  res.json({ scores, inherited, stage });
});

// ========== API: RANKING ==========
app.get('/api/ranking', requireAuth, (req, res) => {
  const { track, stage } = req.query;
  const currentStage = getCurrentStage();
  const allowedStages = ['preliminary', 'semi_final', 'final', 'awarded'];
  const stageOrder = { preliminary: 0, semi_final: 1, final: 2, awarded: 3 };
  let targetStage = stage || currentStage;
  if (!allowedStages.includes(targetStage)) {
    return res.status(400).json({ error: '无效的赛段参数' });
  }
  // 不允许查看超过当前赛段的历史（未来赛段）
  if (stageOrder[targetStage] > stageOrder[currentStage]) {
    targetStage = currentStage;
  }

  // Determine which entries to rank based on targetStage
  let entries;
  if (targetStage === 'preliminary') {
    entries = db.entries.filter(e => e.status === 'approved');
  } else if (targetStage === 'semi_final') {
    entries = db.entries.filter(e => e.roundStatus === 'semi_finalist' || e.roundStatus === 'finalist' || e.roundStatus === 'awarded' || e.roundStatus === 'eliminated_final');
  } else if (targetStage === 'final' || targetStage === 'awarded') {
    entries = db.entries.filter(e => e.roundStatus === 'finalist' || e.roundStatus === 'awarded' || e.roundStatus === 'eliminated_final');
  } else {
    entries = db.entries.filter(e => e.status === 'approved');
  }
  if (track) entries = entries.filter(e => e.track === track);
  const enrich = (list) => {
    const annotated = list.map(e => {
      const sd = getEntryStageScores(e.id, targetStage);
      const composite = getCompositeScore(e.id, targetStage);
      return { ...e, roundStatus: e.roundStatus || 'approved', award: e.award || null, voteCount: sd.voteCount, judgeAvg: sd.avgScore, composite };
    });
    // 晋级标注只对实际已晋级的作品生效（管理后台勾选了才显示）：
    // 已晋级 ∧ 算法直晋级 → direct；已晋级 ∧ 其余 → dept；未晋级 → none
    const advancedStatus = targetStage === 'semi_final'
      ? ['semi_finalist', 'finalist', 'awarded']
      : (targetStage === 'final' || targetStage === 'awarded') ? ['finalist', 'awarded'] : [];
    // 晋级算法只基于已晋级作品计算（避免 eliminated_final 抢占前 10 名位置）
    const eligible = annotated.filter(e => advancedStatus.includes(e.roundStatus || 'approved'));
    const typeMap = computePromotePlan(eligible);
    return annotated.map(e => {
      const t = typeMap.get(e.id) || {};
      let pt = 'none';
      if (advancedStatus.includes(e.roundStatus || 'approved')) {
        pt = t.promoteType === 'direct' ? 'direct' : 'dept';
      }
      return { ...e, promoteType: pt, promoteDept: deptKeyOf(e) };
    }).sort((a, b) => (b.composite || 0) - (a.composite || 0)).slice(0, 30);
  };
  const individual = enrich(entries.filter(e => e.entryType !== 'team'));
  const team = enrich(entries.filter(e => e.entryType === 'team'));
  res.json({ individual, team, currentStage: targetStage });
});

// ========== API: STATS ==========
app.get('/api/stats', requireAuth, (req, res) => {
  const stage = getCurrentStage();
  const totalEntries = db.entries.length;
  const approvedEntries = db.entries.filter(e => e.status === 'approved').length;
  const stageVotes = db.votes.filter(v => (v.stage || 'preliminary') === stage).length;
  const stageScores = db.judgeScores.filter(s => (s.stage || 'preliminary') === stage);
  const judgeCount = new Set(stageScores.map(s => s.judgeName)).size;
  // 复赛晋级总数：曾进入过复赛阶段的作品（含晋级决赛的、决赛淘汰的、复赛进行中的）
  const semiFinalists = db.entries.filter(e => e.roundStatus === 'semi_finalist' || e.roundStatus === 'finalist' || e.roundStatus === 'awarded' || e.roundStatus === 'eliminated_final').length;
  const finalists = db.entries.filter(e => e.roundStatus === 'finalist').length;
  const awarded = db.entries.filter(e => e.award).length;
  const deptCounts = {};
  db.entries.forEach(e => { deptCounts[e.dept] = (deptCounts[e.dept] || 0) + 1; });
  const topDept = Object.entries(deptCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '-';
  res.json({ totalEntries, approvedEntries, totalVotes: stageVotes, judgeCount, topDept, currentStage: stage, semiFinalists, finalists, awarded, deptStats: Object.entries(deptCounts).map(([dept, c]) => ({ dept, c })) });
});

// ========== API: EXPORT ==========
app.get('/api/export/json', verifyAdminToken, (req, res) => {
  res.json({ entries: db.entries, votes: db.votes, judgeScores: db.judgeScores, settings: db.settings });
});

app.get('/api/export/csv', verifyAdminToken, (req, res) => {
  try {
    const trackLabel = { efficiency: '效率提升', creative: '创意应用', business: '业务赋能' };
    const stage = getCurrentStage();
    let csv = '\uFEFFID,状态,轮次状态,姓名,部门,子部门,赛道,标题,场景描述,使用过程简介,使用过程链接,效果呈现简介,效果呈现链接,作品链接,海报链接,详情文档链接,提交时间,当前阶段投票数,当前阶段评委均分,当前阶段综合分\n';
    const votable = getVotableEntries(stage);
    const allVoteCounts = votable.map(e => getEntryStageScores(e.id, stage).voteCount);
    const maxVotes = Math.max(1, ...allVoteCounts);
    db.entries.forEach(e => {
      const sd = getEntryStageScores(e.id, stage);
      const voteScore = Math.round((sd.voteCount / maxVotes) * 100);
      const composite = (stage === 'final' || stage === 'awarded') ? sd.avgScore : Math.round((sd.avgScore * 0.8 + voteScore * 0.2) * 100) / 100;
      const roundLabel = { approved: '初赛', semi_finalist: '复赛晋级', eliminated_semi: '复赛淘汰', finalist: '决赛晋级', eliminated_final: '决赛淘汰', awarded: '已获奖' }[e.roundStatus] || '初赛';
      const esc = (v) => `"${String(v || '').replace(/"/g, '""')}"`;
      csv += `${esc(e.id)},${esc(e.status === 'approved' ? '已收录' : '待审核')},${esc(roundLabel)},${esc(e.name)},${esc(e.dept)},${esc(e.subdep)},${esc(trackLabel[e.track] || e.track)},${esc(e.title)},${esc(e.scene)},${esc(e.process_text)},${esc(e.process_link || '')},${esc(e.result_text)},${esc(e.result_link || '')},${esc(e.extra)},${esc(e.posterUrl || '')},${esc(e.docUrl || '')},${esc(e.createdAt)},${sd.voteCount},${sd.avgScore},${composite}\n`;
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="WorkBuddy-entries.csv"');
    res.send(csv);
  } catch (err) {
    console.error('[export/csv] Error:', err);
    res.status(500).json({ error: '导出失败：' + err.message });
  }
});

// ========== API: ADMIN VOTES（实名制投票详情） ==========
app.get('/api/admin/votes', verifyAdminToken, (req, res) => {
  const stage = req.query.stage || getCurrentStage();
  const entryMap = {};
  db.entries.forEach(e => { entryMap[e.id] = e; });

  // 按投票人聚合
  const voterMap = {};
  db.votes.forEach(v => {
    const vStage = v.stage || 'preliminary';
    if (stage !== 'all' && vStage !== stage) return;
    const key = v.voterId || v.voterName || '?';
    if (!voterMap[key]) {
      voterMap[key] = {
        voterId: v.voterId,
        voterName: v.voterName,
        voterMobile: v.voterMobile || '',
        votes: []
      };
    }
    const entry = entryMap[v.entryId];
    voterMap[key].votes.push({
      entryId: v.entryId,
      entryTitle: entry ? entry.title : '(已删除)',
      entryName: entry ? entry.name : '',
      stage: vStage,
      stageLabel: STAGE_LABELS[vStage] || vStage,
      createdAt: v.createdAt
    });
  });

  // 转为数组并排序
  const voters = Object.values(voterMap).map(v => ({
    voterId: v.voterId,
    voterName: v.voterName,
    voterMobile: v.voterMobile,
    voteCount: v.votes.length,
    votes: v.votes.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
  })).sort((a, b) => b.voteCount - a.voteCount);

  // 按作品聚合
  const entryVoteMap = {};
  db.votes.forEach(v => {
    const vStage = v.stage || 'preliminary';
    if (stage !== 'all' && vStage !== stage) return;
    if (!entryVoteMap[v.entryId]) {
      const entry = entryMap[v.entryId];
      entryVoteMap[v.entryId] = {
        entryId: v.entryId,
        entryTitle: entry ? entry.title : '(已删除)',
        entryName: entry ? entry.name : '',
        voters: []
      };
    }
    entryVoteMap[v.entryId].voters.push({
      voterName: v.voterName,
      voterMobile: v.voterMobile || '',
      stage: vStage,
      stageLabel: STAGE_LABELS[vStage] || vStage,
      createdAt: v.createdAt
    });
  });
  const entryVotes = Object.values(entryVoteMap).map(e => ({
    ...e,
    voteCount: e.voters.length,
    voters: e.voters.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
  })).sort((a, b) => b.voteCount - a.voteCount);

  // 统计
  const stageVotes = stage === 'all' ? db.votes : db.votes.filter(v => (v.stage || 'preliminary') === stage);
  const uniqueVoters = new Set(stageVotes.map(v => v.voterId)).size;

  res.json({
    currentStage: getCurrentStage(),
    filterStage: stage,
    totalVotes: stageVotes.length,
    uniqueVoters,
    voters,
    entryVotes
  });
});

// 导出投票详情 CSV
app.get('/api/admin/votes/export/csv', verifyAdminToken, (req, res) => {
  try {
    const stage = req.query.stage || getCurrentStage();
    const entryMap = {};
    db.entries.forEach(e => { entryMap[e.id] = e; });
    const esc = (v) => `"${String(v || '').replace(/"/g, '""')}"`;

    let csv = '\uFEFF';
    // 按投票人维度
    csv += '=== 按投票人统计 ===\n';
    csv += '投票人,手机号,投票数,投给作品(赛段)\n';
    const voterMap = {};
    db.votes.forEach(v => {
      const vStage = v.stage || 'preliminary';
      if (stage !== 'all' && vStage !== stage) return;
      const key = v.voterId || v.voterName;
      if (!voterMap[key]) voterMap[key] = { name: v.voterName, mobile: v.voterMobile || '', votes: [] };
      const entry = entryMap[v.entryId];
      voterMap[key].votes.push((entry ? entry.title : '(已删除)') + '(' + (STAGE_LABELS[vStage] || vStage) + ')');
    });
    Object.values(voterMap).forEach(v => {
      csv += `${esc(v.name)},${esc(v.mobile)},${v.votes.length},${esc(v.votes.join('、'))}\n`;
    });

    csv += '\n=== 按作品统计 ===\n';
    csv += '作品标题,作者,投票数,投票人\n';
    const entryVoteMap = {};
    db.votes.forEach(v => {
      const vStage = v.stage || 'preliminary';
      if (stage !== 'all' && vStage !== stage) return;
      if (!entryVoteMap[v.entryId]) {
        const entry = entryMap[v.entryId];
        entryVoteMap[v.entryId] = { title: entry ? entry.title : '(已删除)', name: entry ? entry.name : '', voters: [] };
      }
      entryVoteMap[v.entryId].voters.push(v.voterName + (v.voterMobile ? '(尾号' + v.voterMobile.slice(-4) + ')' : ''));
    });
    Object.values(entryVoteMap).forEach(e => {
      csv += `${esc(e.title)},${esc(e.name)},${e.voters.length},${esc(e.voters.join('、'))}\n`;
    });

    const stageLabel = stage === 'all' ? '全部' : (STAGE_LABELS[stage] || stage);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="WorkBuddy-${stageLabel}-投票详情.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('[export/votes/csv] Error:', err);
    res.status(500).json({ error: '导出失败：' + err.message });
  }
});

// ========== API: ADMIN VOTES（实名制投票详情） END ==========

// ========== API: SETTINGS ==========
app.get('/api/settings', verifyAdminToken, (req, res) => {
  res.json({ settings: db.settings });
});

app.post('/api/settings', verifyAdminToken, async (req, res) => {
  if (req.body.votingEnabled !== undefined) {
    db.settings.votingEnabled = Boolean(req.body.votingEnabled);
  }
  if (req.body.currentStage !== undefined) {
    const validStages = ['preliminary', 'semi_final', 'final', 'awarded'];
    if (validStages.includes(req.body.currentStage)) {
      db.settings.currentStage = req.body.currentStage;
    }
  }
  // Password changes (still saved to db but getJudgePassword/getAdminPassword ignore it)
  if (req.body.judgePassword !== undefined) {
    db.settings.judgePassword = req.body.judgePassword;
  }
  if (req.body.adminPassword !== undefined) {
    db.settings.adminPassword = req.body.adminPassword;
  }
  if (req.body.luckyListEnabled !== undefined) {
    db.settings.luckyListEnabled = Boolean(req.body.luckyListEnabled);
  }
  saveDB();
  ghPush().catch(e => console.error('[settings] GitHub push failed:', e.message));
  res.json({ success: true, currentStage: getCurrentStage() });
});

// ========== API: JUDGES（评委名单管理 — 按赛段） ==========
// 评委名单由管理员设置，按赛段管理，只有名单内的人才能打分
app.get('/api/admin/judges', verifyAdminToken, (req, res) => {
  res.json({ judgesByStage: db.settings.judgesByStage || { preliminary: [], semi_final: [], final: [] } });
});

app.post('/api/admin/judges', verifyAdminToken, (req, res) => {
  const { name, stage } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '请输入评委姓名' });
  const validStages = ['preliminary', 'semi_final', 'final'];
  if (!stage || !validStages.includes(stage)) return res.status(400).json({ error: '请指定赛段：preliminary/semi_final/final' });
  if (!db.settings.judgesByStage) db.settings.judgesByStage = { preliminary: [], semi_final: [], final: [] };
  const trimmed = name.trim();
  const list = db.settings.judgesByStage[stage];
  if (list.includes(trimmed)) return res.status(400).json({ error: `该评委已在${STAGE_LABELS[stage]}名单中` });
  list.push(trimmed);
  saveDB();
  ghPush().catch(e => console.error('[judges] GitHub push failed:', e.message));
  res.json({ success: true, judgesByStage: db.settings.judgesByStage });
});

app.delete('/api/admin/judges/:stage/:name', verifyAdminToken, (req, res) => {
  const { stage } = req.params;
  const name = decodeURIComponent(req.params.name);
  const validStages = ['preliminary', 'semi_final', 'final'];
  if (!validStages.includes(stage)) return res.status(400).json({ error: '无效赛段' });
  if (!db.settings.judgesByStage) db.settings.judgesByStage = { preliminary: [], semi_final: [], final: [] };
  const list = db.settings.judgesByStage[stage];
  const idx = list.indexOf(name);
  if (idx === -1) return res.status(404).json({ error: `该评委不在${STAGE_LABELS[stage]}名单中` });
  list.splice(idx, 1);
  saveDB();
  ghPush().catch(e => console.error('[judges] GitHub push failed:', e.message));
  res.json({ success: true, judgesByStage: db.settings.judgesByStage });
});

// 公开接口：前端校验评委是否在名单中
// 公开接口：前端校验评委是否在当前赛段名单中
app.get('/api/judges', (req, res) => {
  const stage = getCurrentStage();
  const list = getStageJudges(stage);
  res.json({ judges: list, stage, judgesByStage: db.settings.judgesByStage || {} });
});

// ========== API: LUCKY VOTER LIST（幸运投票人名单 / 各赛程抽奖资格） ==========
// 按赛程分轮：作品从某赛程晋级/获奖 → 该赛程投票支持它的人，获得本赛程 1 张抽奖票
// 名单动态计算，不落库；luckyListEnabled 仅控制是否公开公示
const LUCKY_STAGE_ADV = {
  preliminary: ['semi_finalist', 'finalist', 'eliminated_final', 'awarded'],
  semi_final: ['finalist', 'eliminated_final', 'awarded'],
  final:       ['awarded']
};
const LUCKY_STAGE_LABEL = { preliminary: '初赛', semi_final: '复赛', final: '决赛' };
const LUCKY_ROUND_LABEL = { preliminary: '初赛轮', semi_final: '复赛轮', final: '决赛轮' };
const ROUND_LABEL = { approved: '初赛', semi_finalist: '复赛晋级', eliminated_semi: '复赛淘汰', finalist: '决赛晋级', eliminated_final: '决赛淘汰', awarded: '已获奖' };

function getLuckyRounds() {
  const idMap = {};
  db.entries.forEach(e => { idMap[e.id] = e; });
  const stageData = [];
  for (const S of ['preliminary', 'semi_final', 'final']) {
    const qualIds = new Set(
      db.entries.filter(e => LUCKY_STAGE_ADV[S].includes(e.roundStatus)).map(e => e.id)
    );
    if (qualIds.size === 0) continue;
    // 支持者：在赛程 S 投过票，且作品属于 qualIds；去重主键用手机号（缺则回退 openId）
    const bucket = new Map(); // dupKey -> {mobile, name, avatar, entries:Set(id)}
    for (const v of db.votes) {
      if ((v.stage || 'preliminary') !== S) continue;
      if (!qualIds.has(v.entryId)) continue;
      const dupKey = v.voterMobile || v.voterId || v.voterName || '?';
      if (!bucket.has(dupKey)) bucket.set(dupKey, { mobile: v.voterMobile || '', name: v.voterName, avatar: v.voterAvatar || '', entries: new Set() });
      bucket.get(dupKey).entries.add(v.entryId);
    }
    if (bucket.size === 0) continue;
    const voters = [...bucket.values()].map(b => ({
      voterName: b.name,
      voterAvatar: b.avatar,
      _mobile: b.mobile, // 内部用于跨轮重名判定，不返回前端
      mobileLast4: b.mobile ? b.mobile.slice(-4) : null,
      tickets: b.entries.size, // 抽奖次数 = 本赛程命中作品数
      entries: [...b.entries].map(eid => {
        const e = idMap[eid] || {};
        return { title: e.title || eid, result: (ROUND_LABEL[e.roundStatus] || e.roundStatus || ''), award: e.award || null };
      })
    }));
    stageData.push({ stage: S, label: LUCKY_STAGE_LABEL[S], roundLabel: LUCKY_ROUND_LABEL[S], voters });
  }
  // 跨轮统计「重名」：同一份名单内，不同手机号却同昵称 → 需展示后四位区分
  const nameMobiles = {};
  stageData.forEach(r => r.voters.forEach(v => {
    const nm = v.voterName || '';
    if (!nameMobiles[nm]) nameMobiles[nm] = new Set();
    nameMobiles[nm].add(v._mobile || '__no_mobile__');
  }));
  const dupNames = {};
  Object.keys(nameMobiles).forEach(nm => { dupNames[nm] = nameMobiles[nm].size > 1; });
  // 组装返回：仅重名者带 mobileLast4（用于前端展示），其余置 null；不返回完整手机号/openId
  return stageData.map(r => {
    const voters = r.voters.map(v => ({
      voterName: v.voterName,
      voterAvatar: v.voterAvatar,
      mobileLast4: (dupNames[v.voterName] && v.mobileLast4) ? v.mobileLast4 : null,
      tickets: v.tickets,
      entries: v.entries
    }));
    return { stage: r.stage, label: r.label, roundLabel: r.roundLabel, total: voters.length, voters };
  });
}

app.get('/api/lucky/list', (req, res) => {
  const rounds = getLuckyRounds();
  // 幸运投票人 = 全局去重后的人数；总抽奖次数 = 各轮 tickets 之和
  const globalVoterKeys = new Set();
  let totalTickets = 0;
  rounds.forEach(r => {
    totalTickets += r.voters.reduce((s, v) => s + (v.tickets || 1), 0);
    r.voters.forEach(v => {
      const key = v.mobileLast4 ? v.voterName + '|' + v.mobileLast4 : v.voterName;
      globalVoterKeys.add(key);
    });
  });
  const totalVoters = globalVoterKeys.size;
  res.json({
    enabled: !!db.settings.luckyListEnabled,
    summary: { rounds: rounds.length, totalVoters, totalTickets },
    // 隐私脱敏：仅返回昵称/头像/支持作品/结果，不含 openId/手机号
    rounds
  });
});

// ========== API: DRAW（投票抽奖） ==========
// 每赛程结算后开放抽奖：用户在已结算赛程中投过的票，押中晋级/获奖作品即获得抽奖次数
const DRAW_STAGE_ADV = {
  preliminary: ['semi_finalist', 'finalist', 'eliminated_final', 'awarded'],
  semi_final: ['finalist', 'eliminated_final', 'awarded'],
  final: ['awarded']
};
const DRAW_STAGE_LABEL = { preliminary: '初赛', semi_final: '复赛', final: '决赛' };
const DRAW_STAGE_ORDER = ['preliminary', 'semi_final', 'final'];

// 根据当前赛程返回已开放抽奖的历史赛程
function getOpenDrawStages() {
  const current = getCurrentStage();
  if (current === 'preliminary') return [];
  if (current === 'semi_final') return ['preliminary'];
  if (current === 'final') return ['preliminary', 'semi_final'];
  if (current === 'awarded') return ['preliminary', 'semi_final', 'final'];
  return [];
}

function getUserStageVotes(userId, stage) {
  return db.votes.filter(v => v.voterId === userId && (v.stage || 'preliminary') === stage);
}

// 计算某用户在指定赛程的押中次数（投过的票中，作品最终进入更高轮次的数量）
function getUserStageHits(userId, stage) {
  const votes = getUserStageVotes(userId, stage);
  const advanced = DRAW_STAGE_ADV[stage] || [];
  let hits = 0;
  const hitEntryIds = new Set();
  for (const v of votes) {
    const e = db.entries.find(x => x.id === v.entryId);
    if (e && advanced.includes(e.roundStatus) && !hitEntryIds.has(e.id)) {
      hits++;
      hitEntryIds.add(e.id);
    }
  }
  return { hits, hitEntryIds: [...hitEntryIds] };
}

function getUserStageDrawRecords(userId, stage) {
  return db.drawRecords.filter(r => r.userId === userId && r.stage === stage);
}

function getUserStageRemainingDraws(userId, stage) {
  const { hits } = getUserStageHits(userId, stage);
  const used = getUserStageDrawRecords(userId, stage).length;
  return Math.max(0, hits - used);
}

// 计算某赛段全部用户可抽奖次数之和（即押中总次数）
function getStageTotalAllowedDraws(stage) {
  const advanced = DRAW_STAGE_ADV[stage] || [];
  let total = 0;
  for (const e of db.entries) {
    if (!advanced.includes(e.roundStatus)) continue;
    const voters = new Set();
    for (const v of db.votes) {
      if ((v.stage || 'preliminary') === stage && v.entryId === e.id) voters.add(v.voterId);
    }
    total += voters.size;
  }
  return total;
}

function getStageUsedDraws(stage) {
  return db.drawRecords.filter(r => r.stage === stage).length;
}

function getStagePrizes(stage) {
  const map = db.settings.prizes || {};
  return Array.isArray(map[stage]) ? map[stage] : [];
}

// 按赛段库存抽奖：动态概率 = 剩余奖品数 / 剩余抽奖次数；中奖后按库存权重挑选具体奖品
function drawPrize(stage) {
  const prizes = getStagePrizes(stage).filter(p => p.stock > 0);
  const totalAllowed = getStageTotalAllowedDraws(stage);
  const usedDraws = getStageUsedDraws(stage);
  const remainingDraws = Math.max(0, totalAllowed - usedDraws);
  const remainingPrizes = prizes.reduce((s, p) => s + p.stock, 0);

  if (remainingDraws <= 0 || remainingPrizes <= 0) {
    return { isWin: false, name: '谢谢参与' };
  }

  const winProb = Math.min(1, remainingPrizes / remainingDraws);
  if (Math.random() > winProb) {
    return { isWin: false, name: '谢谢参与' };
  }

  // 已中奖，按库存数量权重挑选具体奖品
  const totalStock = prizes.reduce((s, p) => s + p.stock, 0);
  const rnd = Math.random() * totalStock;
  let acc = 0;
  for (const p of prizes) {
    acc += p.stock;
    if (rnd <= acc) {
      p.stock = Math.max(0, p.stock - 1);
      return { isWin: true, id: p.id, name: p.name };
    }
  }
  return { isWin: false, name: '谢谢参与' };
}

app.get('/api/draw/status', requireAuth, (req, res) => {
  const userId = req.ddUser.openId;
  const config = db.settings.drawConfig || DEFAULT_DB.settings.drawConfig;
  const openStages = getOpenDrawStages();
  const stages = {};
  let totalRemaining = 0;
  for (const stage of DRAW_STAGE_ORDER) {
    const votes = getUserStageVotes(userId, stage);
    const { hits, hitEntryIds } = getUserStageHits(userId, stage);
    const records = getUserStageDrawRecords(userId, stage).map(r => ({
      prizeName: r.prizeName,
      isWin: r.isWin,
      drawnAt: r.drawnAt
    }));
    const stagePrizes = getStagePrizes(stage).filter(p => p.stock > 0);
    const remainingPrizes = stagePrizes.reduce((s, p) => s + p.stock, 0);
    const totalAllowed = getStageTotalAllowedDraws(stage);
    const usedDraws = getStageUsedDraws(stage);
    const remainingDraws = Math.max(0, totalAllowed - usedDraws);
    const winProb = remainingDraws > 0 ? Math.min(1, remainingPrizes / remainingDraws) : 0;
    stages[stage] = {
      label: DRAW_STAGE_LABEL[stage],
      isOpen: openStages.includes(stage),
      voted: votes.length,
      hits,
      hitEntryIds,
      remaining: getUserStageRemainingDraws(userId, stage),
      records,
      prizes: stagePrizes.map(p => ({ id: p.id, name: p.name, stock: p.stock })),
      totalPrizes: remainingPrizes,
      totalAllowed,
      usedDraws,
      remainingDraws,
      winProbability: Number(winProb.toFixed(4))
    };
    if (openStages.includes(stage)) totalRemaining += stages[stage].remaining;
  }
  res.json({
    enabled: !!config.enabled,
    currentStage: getCurrentStage(),
    openStages,
    totalRemaining,
    stages,
    config: {
      rules: config.rules,
      contact: config.contact
    }
  });
});

// GET /api/draw/recent-wins — 公开：最近中奖滚动公告
// prizeStats：各奖品累计中奖次数（越小越稀有，前端据此加权展示）
app.get('/api/draw/recent-wins', (req, res) => {
  const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);
  const allWins = (db.drawRecords || []).filter(r => r.isWin);
  const wins = [...allWins]
    .sort((a, b) => new Date(b.drawnAt) - new Date(a.drawnAt))
    .slice(0, limit)
    .map(r => {
      const name = r.userName || '匿名';
      const masked = name.length > 2 ? name[0] + '*'.repeat(name.length - 1) : name;
      return {
        userName: masked,
        prizeName: r.prizeName,
        stage: r.stage,
        stageLabel: DRAW_STAGE_LABEL[r.stage] || r.stage,
        drawnAt: r.drawnAt
      };
    });
  const prizeStats = {};
  for (const r of allWins) {
    if (!r.prizeName || r.prizeName === '谢谢参与') continue;
    prizeStats[r.prizeName] = (prizeStats[r.prizeName] || 0) + 1;
  }
  res.json({ wins, prizeStats });
});

app.post('/api/draw', requireAuth, (req, res) => {
  const config = db.settings.drawConfig || DEFAULT_DB.settings.drawConfig;
  if (!config.enabled) return res.status(403).json({ error: '抽奖尚未开启' });
  const userId = req.ddUser.openId;
  const stage = req.body.stage;
  if (!DRAW_STAGE_ORDER.includes(stage)) return res.status(400).json({ error: '无效的赛程' });
  const openStages = getOpenDrawStages();
  if (!openStages.includes(stage)) return res.status(403).json({ error: '该赛程抽奖尚未开放' });
  const remaining = getUserStageRemainingDraws(userId, stage);
  if (remaining <= 0) return res.status(403).json({ error: '本赛程抽奖次数已用完' });

  const result = drawPrize(stage);
  const record = {
    id: 'dr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    userId,
    userName: req.ddUser.nick || '',
    stage,
    prizeId: result.id || null,
    prizeName: result.name,
    isWin: result.isWin,
    drawnAt: new Date().toISOString()
  };
  db.drawRecords.push(record);
  saveDB();
  ghPush().catch(e => console.error('[draw] GitHub push failed:', e.message));
  res.json({ success: true, result, remaining: remaining - 1, record: { prizeName: record.prizeName, isWin: record.isWin, drawnAt: record.drawnAt } });
});

// ========== ADMIN TOKEN STORE ==========
const adminTokens = new Map();

function generateAdminToken() {
  const token = 'adm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  adminTokens.set(token, Date.now() + 2 * 60 * 60 * 1000);
  for (const [t, exp] of adminTokens) { if (Date.now() > exp) adminTokens.delete(t); }
  return token;
}

function verifyAdminToken(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.adminToken;
  if (!token || !adminTokens.has(token) || Date.now() > adminTokens.get(token)) {
    if (token) adminTokens.delete(token);
    return res.status(401).json({ error: '未授权，请先登录管理后台' });
  }
  adminTokens.set(token, Date.now() + 2 * 60 * 60 * 1000);
  next();
}

// ========== API: DINGTALK AUTH ==========
// state -> redirect URL 映射（OAuth 登录后跳回原页面）
const loginRedirects = new Map();
const LOGIN_REDIRECT_TTL = 10 * 60 * 1000; // 10分钟过期

app.post('/api/auth/dd-code', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: '缺少授权码' });
  try {
    const userInfo = await exchangeDingTalkCode(code);
    const token = generateSessionToken();
    setSession(token, {
      openId: userInfo.openId,
      unionId: userInfo.unionId,
      nick: userInfo.nick,
      mobile: userInfo.mobile || '',
      avatarUrl: userInfo.avatarUrl,
      createdAt: Date.now(),
    });
    res.cookie('dd_session', token, {
      maxAge: SESSION_MAX_AGE,
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      path: '/',
    });
    const stage = getCurrentStage();
    const voteCount = getUserStageVoteCount(userInfo.openId, stage);
    const ddCodeLimit = getVoteLimit(stage);
    const myBet = getActiveBet(userInfo.openId, getBettingStage());
    res.json({ success: true, user: { nick: userInfo.nick, openId: userInfo.openId, mobile: userInfo.mobile, avatarUrl: userInfo.avatarUrl }, remainingVotes: Math.max(0, ddCodeLimit - voteCount), totalVotes: ddCodeLimit, currentStage: stage, bettingStage: getBettingStage(), myBet, isBettingOpen: isBettingOpen() });
  } catch (e) {
    console.error('DingTalk auth error:', e.message);
    res.status(400).json({ error: e.message || '钉钉授权失败' });
  }
});

app.get('/auth/dingtalk/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send('Missing authorization code');
  try {
    const userInfo = await exchangeDingTalkCode(code);
    const token = generateSessionToken();
    setSession(token, {
      openId: userInfo.openId,
      unionId: userInfo.unionId,
      nick: userInfo.nick,
      mobile: userInfo.mobile || '',
      avatarUrl: userInfo.avatarUrl,
      createdAt: Date.now(),
    });
    res.cookie('dd_session', token, {
      maxAge: SESSION_MAX_AGE,
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      path: '/',
    });
    // 回到登录前所在页面
    const redirect = (state && loginRedirects.get(state)) || '/';
    if (state) loginRedirects.delete(state);
    res.redirect(redirect);
  } catch (e) {
    console.error('DingTalk callback error:', e.message);
    res.status(400).send('DingTalk login failed: ' + (e.message || 'unknown error'));
  }
});

app.get('/api/auth/dd-url', (req, res) => {
  const redirectUri = `https://${req.hostname}/auth/dingtalk/callback`;
  const state = Math.random().toString(36).slice(2, 12);
  // 前端可传 redirect 参数指定登录后跳回哪个页面
  const redirect = req.query.redirect || '/';
  loginRedirects.set(state, redirect);
  // 定期清理过期映射
  const now = Date.now();
  for (const [k, v] of loginRedirects) {
    if (now - v.time > LOGIN_REDIRECT_TTL) loginRedirects.delete(k);
  }
  const authUrl = `${DINGTALK.authUrl}?redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&client_id=${DINGTALK.appKey}&scope=openid+profile&state=${state}&prompt=consent`;
  res.json({ url: authUrl, state });
});

app.get('/api/auth/me', (req, res) => {
  const session = getSession(req);
  if (!session) {
    return res.json({ user: null });
  }
  const stage = getCurrentStage();
  const voteCount = getUserStageVoteCount(session.openId, stage);
  const authLimit = getVoteLimit(stage);
  const myBet = getActiveBet(session.openId);
  res.json({
    user: { nick: session.nick, openId: session.openId, mobile: session.mobile || '', avatarUrl: session.avatarUrl },
    remainingVotes: Math.max(0, authLimit - voteCount),
    totalVotes: authLimit,
    currentStage: stage,
    isVotingStage: isVotingStage(stage),
    myBet,
    isBettingOpen: isBettingOpen()
  });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies && req.cookies.dd_session;
  if (token) deleteSession(token);
  res.clearCookie('dd_session');
  res.json({ success: true });
});

// ========== API: ADMIN ==========
app.post('/api/admin/auth', (req, res) => {
  const { password } = req.body;
  if (!password || password !== getAdminPassword()) {
    return res.status(403).json({ error: '管理员密码错误' });
  }
  const token = generateAdminToken();
  res.json({ success: true, token, message: '管理员已验证' });
});

// 抽奖配置与奖品管理
app.get('/api/admin/draw-config', verifyAdminToken, (req, res) => {
  const config = db.settings.drawConfig || DEFAULT_DB.settings.drawConfig;
  const stageStats = {};
  for (const stage of DRAW_STAGE_ORDER) {
    const prizes = getStagePrizes(stage);
    const remainingPrizes = prizes.reduce((s, p) => s + p.stock, 0);
    const totalAllowed = getStageTotalAllowedDraws(stage);
    const usedDraws = getStageUsedDraws(stage);
    stageStats[stage] = {
      label: DRAW_STAGE_LABEL[stage],
      prizeCount: prizes.length,
      remainingPrizes,
      totalAllowed,
      usedDraws,
      remainingDraws: Math.max(0, totalAllowed - usedDraws)
    };
  }
  res.json({
    enabled: !!config.enabled,
    rules: config.rules,
    contact: config.contact,
    prizes: db.settings.prizes || DEFAULT_DB.settings.prizes,
    stageStats
  });
});

app.post('/api/admin/draw-config', verifyAdminToken, (req, res) => {
  const config = db.settings.drawConfig || DEFAULT_DB.settings.drawConfig;
  if (req.body.enabled !== undefined) config.enabled = Boolean(req.body.enabled);
  if (req.body.rules !== undefined) config.rules = String(req.body.rules || '');
  if (req.body.contact !== undefined) config.contact = String(req.body.contact || '');
  delete config.noWinWeight;
  db.settings.drawConfig = config;
  saveDB();
  ghPush().catch(e => console.error('[admin draw-config] GitHub push failed:', e.message));
  res.json({ success: true, config: { enabled: config.enabled, rules: config.rules, contact: config.contact } });
});

app.post('/api/admin/prizes', verifyAdminToken, (req, res) => {
  const { stage, id, name, stock } = req.body;
  if (!DRAW_STAGE_ORDER.includes(stage)) return res.status(400).json({ error: '无效的赛段' });
  if (!name || String(name).trim() === '') return res.status(400).json({ error: '奖品名称不能为空' });
  const prizeMap = db.settings.prizes || DEFAULT_DB.settings.prizes;
  const prizes = Array.isArray(prizeMap[stage]) ? prizeMap[stage] : [];
  const stockNum = Math.max(0, Number(stock) || 0);
  if (id) {
    const idx = prizes.findIndex(p => p.id === id);
    if (idx === -1) return res.status(404).json({ error: '奖品不存在' });
    prizes[idx] = { ...prizes[idx], name: String(name).trim(), stock: stockNum };
  } else {
    prizes.push({
      id: 'prize_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      name: String(name).trim(),
      stock: stockNum,
      total: stockNum,
      createdAt: new Date().toISOString()
    });
  }
  prizeMap[stage] = prizes;
  db.settings.prizes = prizeMap;
  saveDB();
  ghPush().catch(e => console.error('[admin prizes] GitHub push failed:', e.message));
  res.json({ success: true, prizes: prizeMap });
});

app.delete('/api/admin/prizes/:id', verifyAdminToken, (req, res) => {
  const stage = req.query.stage;
  if (!DRAW_STAGE_ORDER.includes(stage)) return res.status(400).json({ error: '无效的赛段' });
  const prizeMap = db.settings.prizes || DEFAULT_DB.settings.prizes;
  prizeMap[stage] = (prizeMap[stage] || []).filter(p => p.id !== req.params.id);
  db.settings.prizes = prizeMap;
  saveDB();
  ghPush().catch(e => console.error('[admin prizes] GitHub push failed:', e.message));
  res.json({ success: true, prizes: prizeMap });
});

app.get('/api/admin/draw-records', verifyAdminToken, (req, res) => {
  res.json({ records: db.drawRecords || [] });
});

app.get('/api/admin/scores', verifyAdminToken, (req, res) => {
  const stage = getCurrentStage();
  const entries = getJudgableEntries(stage);
  const stageScores = db.judgeScores.filter(s => (s.stage || 'preliminary') === stage);
  const allJudges = [...new Set(stageScores.map(s => s.judgeName))].sort();

  const entryScoresRaw = entries.map(e => {
    const scores = stageScores
      .filter(s => s.entryId === e.id)
      .map(s => ({
        judgeName: s.judgeName,
        practicality: s.practicality,
        innovation: s.innovation,
        scalability: s.scalability,
        presentation: s.presentation,
        total: s.practicality + s.innovation + s.scalability + s.presentation,
        updatedAt: s.updatedAt
      }));
    const avg = scores.length > 0
      ? Math.round(scores.reduce((sum, s) => sum + s.total, 0) / scores.length)
      : 0;
    const sd = getEntryStageScores(e.id, stage);
    const composite = getCompositeScore(e.id, stage);
    return {
      id: e.id,
      title: e.title,
      name: e.name,
      entryType: e.entryType || 'individual',
      teamName: e.teamName || '',
      teamMembers: e.teamMembers || '',
      dept: e.dept || e.dept1 || '',
      dept1: e.dept1 || e.dept || '',
      dept2: e.dept2 || e.subdept || '',
      dept3: e.dept3 || '',
      subdept: e.subdept || e.dept2 || '',
      track: e.track,
      createdAt: e.createdAt,
      roundStatus: e.roundStatus || 'approved',
      award: e.award || null,
      scores,
      avgScore: avg,
      judgeCount: scores.length,
      voteCount: sd.voteCount,
      composite
    };
  });
  // 统一晋级规则标注（与排名页 /api/ranking 同一函数，保证展示与勾选建议一致）
  const promoteMap = computePromotePlan(entryScoresRaw);
  const entryScores = entryScoresRaw.map(e => ({ ...e, ...promoteMap.get(e.id) }));

  const summary = {
    totalEntries: entries.length,
    totalJudges: allJudges.length,
    totalScores: stageScores.length,
    scoredEntries: entryScores.filter(e => e.scores.length > 0).length,
    unscoredEntries: entryScores.filter(e => e.scores.length === 0).length,
    judges: allJudges,
    currentStage: stage
  };

  res.json({ entryScores, allJudges, summary });
});

app.get('/api/admin/export/csv', verifyAdminToken, (req, res) => {
  try {
    const stage = getCurrentStage();
    const entries = getJudgableEntries(stage);
    const stageScores = db.judgeScores.filter(s => (s.stage || 'preliminary') === stage);
    const allJudges = [...new Set(stageScores.map(s => s.judgeName))].sort();
    const trackLabel = { efficiency: '效率提升', creative: '创意应用', business: '业务赋能' };
    const esc = (v) => `"${String(v || '').replace(/"/g, '""')}"`;

    let csv = '\uFEFF';
    let headers = ['作品ID', '标题', '姓名', '部门', '子部门', '赛道', '轮次', '提交时间', '投票数', '评委数', '评委均分', '综合分'];
    if (stage === 'awarded') headers.push('获奖等级');
    allJudges.forEach(j => {
      headers.push(`${j}-总分`, `${j}-实用性(/50)`, `${j}-创新性(/20)`, `${j}-可推广性(/15)`, `${j}-效果呈现(/15)`);
    });
    csv += headers.map(esc).join(',') + '\n';

    entries.forEach(e => {
      const scores = stageScores.filter(s => s.entryId === e.id);
      const avg = scores.length > 0
        ? Math.round(scores.reduce((sum, s) => sum + s.practicality + s.innovation + s.scalability + s.presentation, 0) / scores.length)
        : 0;
      const sd = getEntryStageScores(e.id, stage);
      const composite = getCompositeScore(e.id, stage);
      const roundLabel = { approved: '初赛', semi_finalist: '复赛', finalist: '决赛', awarded: '获奖' }[e.roundStatus] || '初赛';

      let row = [
        e.id, e.title, e.name, e.dept, e.subdept || '',
        trackLabel[e.track] || e.track, roundLabel, e.createdAt,
        sd.voteCount, scores.length, avg, composite
      ];
      if (stage === 'awarded') {
        const awardLabel = { first: '一等奖', second: '二等奖', third: '三等奖', excellence: '优秀奖' }[e.award] || '';
        row.push(awardLabel);
      }
      allJudges.forEach(judge => {
        const s = scores.find(sc => sc.judgeName === judge);
        if (s) {
          row.push(s.practicality + s.innovation + s.scalability + s.presentation, s.practicality, s.innovation, s.scalability, s.presentation);
        } else {
          row.push('', '', '', '', '');
        }
      });
      csv += row.map(esc).join(',') + '\n';
    });

    const stageLabel = STAGE_LABELS[stage] || 'contest';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="WorkBuddy-${stageLabel}-scores.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('[export/csv] Error:', err);
    res.status(500).json({ error: '导出失败：' + err.message });
  }
});

app.post('/api/admin/clear', verifyAdminToken, (req, res) => {
  const { type } = req.body;
  if (type === 'all') { db.entries = []; db.votes = []; db.judgeScores = []; }
  else if (type === 'scores') { db.judgeScores = []; }
  saveDB();
  res.json({ success: true });
});

// DELETE single entry
app.delete('/api/admin/entries/:id', verifyAdminToken, (req, res) => {
  const { id } = req.params;
  const idx = db.entries.findIndex(e => e.id === id);
  if (idx === -1) return res.status(404).json({ error: '作品不存在' });
  const entry = db.entries[idx];
  db.entries.splice(idx, 1);
  db.votes = db.votes.filter(v => v.entryId !== id);
  db.judgeScores = db.judgeScores.filter(s => s.entryId !== id);
  saveDB();
  res.json({ success: true, title: entry.title });
});

// ========== API: ADMIN PROMOTE (晋级管理) ==========
// POST /api/admin/promote
// body: { stage: 'semi_final' | 'final', entryIds: ['id1', 'id2', ...] }
// Promotes selected entries to next stage, marks others as eliminated
app.post('/api/admin/promote', verifyAdminToken, (req, res) => {
  const { stage, entryIds } = req.body;
  if (!stage || !Array.isArray(entryIds)) {
    return res.status(400).json({ error: '参数错误' });
  }

  if (stage === 'semi_final') {
    // Promote to semi_final: all approved entries, selected ones become semi_finalist
    db.entries.forEach(e => {
      if (e.status === 'approved' && (e.roundStatus === 'approved' || !e.roundStatus)) {
        if (entryIds.includes(e.id)) {
          e.roundStatus = 'semi_finalist';
        } else {
          e.roundStatus = 'eliminated_semi';
        }
      }
    });
    db.settings.currentStage = 'semi_final';
    db.settings.votingEnabled = false; // Reset voting, admin must re-enable
  } else if (stage === 'final') {
    // Promote to final: only semi_finalists, selected ones become finalist
    db.entries.forEach(e => {
      if (e.roundStatus === 'semi_finalist') {
        if (entryIds.includes(e.id)) {
          e.roundStatus = 'finalist';
        } else {
          e.roundStatus = 'eliminated_final';
        }
      }
    });
    db.settings.currentStage = 'final';
    db.settings.votingEnabled = false;
  } else {
    return res.status(400).json({ error: '无效的阶段' });
  }

  saveDB();
  ghPush().catch(e => console.error('[promote] GitHub push failed:', e.message));
  const promoted = db.entries.filter(e => entryIds.includes(e.id)).length;
  res.json({ success: true, currentStage: db.settings.currentStage, promoted });
});

// ========== API: ADMIN RESTORE-STAGE（撤销晋级，退回上一赛段勾选之前的状态） ==========
// POST /api/admin/restore-stage
// body: { to: 'semi_final' }
// 把 finalist/eliminated_final/awarded 全部还原为 semi_finalist（回到勾选晋级决赛之前），
// 打分、投票、抽奖、押宝数据全部保留不动。
app.post('/api/admin/restore-stage', verifyAdminToken, (req, res) => {
  const { to } = req.body;
  if (to !== 'semi_final') {
    return res.status(400).json({ error: '目前仅支持 to: semi_final（撤销晋级决赛）' });
  }
  let restored = 0;
  db.entries.forEach(e => {
    if (e.roundStatus === 'finalist' || e.roundStatus === 'eliminated_final' || e.roundStatus === 'awarded') {
      e.roundStatus = 'semi_finalist';
      e.award = null;
      restored++;
    }
  });
  db.settings.currentStage = 'semi_final';
  saveDB();
  ghPush().catch(e => console.error('[restore-stage] GitHub push failed:', e.message));
  res.json({ success: true, currentStage: db.settings.currentStage, restored, semiFinalists: db.entries.filter(e => e.roundStatus === 'semi_finalist' || e.roundStatus === 'finalist' || e.roundStatus === 'awarded' || e.roundStatus === 'eliminated_final').length });
});

// ========== API: ADMIN SETTLE (结算获奖) ==========
// POST /api/admin/settle
// body: { awards: { 'entry_id': 'first'|'second'|'third'|'excellence', ... } }
app.post('/api/admin/settle', verifyAdminToken, (req, res) => {
  const { awards } = req.body;
  if (!awards || typeof awards !== 'object') {
    return res.status(400).json({ error: '参数错误' });
  }

  // Mark awards on finalists
  db.entries.forEach(e => {
    if (e.roundStatus === 'finalist') {
      if (awards[e.id]) {
        e.award = awards[e.id];
        e.roundStatus = 'awarded';
      } else {
        e.award = null;
      }
    }
  });

  db.settings.currentStage = 'awarded';
  saveDB();
  ghPush().catch(e => console.error('[settle] GitHub push failed:', e.message));

  const awardedCount = db.entries.filter(e => e.award).length;
  res.json({ success: true, currentStage: 'awarded', awardedCount });
});

// ========== API: ADMIN RESET (重置数据) ==========
// POST /api/admin/reset
// body: { mode: 'stage' | 'full' }
//   'stage': 重置阶段回初赛，清空 roundStatus/award，保留投票和打分
//   'full':  以上全部 + 清空所有投票和评委打分
app.post('/api/admin/reset', verifyAdminToken, (req, res) => {
  const { mode } = req.body;
  let cleared = {};

  if (mode === 'stage') {
    // 重置阶段：清空晋级标记和获奖标记，回退到初赛
    db.entries.forEach(e => {
      e.roundStatus = 'approved';
      e.award = null;
    });
    db.settings.currentStage = 'preliminary';
    db.settings.votingEnabled = false;
    cleared = { entries: db.entries.length, stage: true };
  } else if (mode === 'full') {
    // 完全重置：清空晋级标记 + 清空所有投票和打分
    db.entries.forEach(e => {
      e.roundStatus = 'approved';
      e.award = null;
    });
    db.settings.currentStage = 'preliminary';
    db.settings.votingEnabled = false;
    const voteCount = db.votes.length;
    const scoreCount = db.judgeScores.length;
    db.votes = [];
    db.judgeScores = [];
    cleared = { entries: db.entries.length, votes: voteCount, scores: scoreCount, stage: true };
  } else {
    return res.status(400).json({ error: 'mode 必须是 stage 或 full' });
  }

  saveDB();
  ghPush().catch(e => console.error('[reset] GitHub push failed:', e.message));
  res.json({ success: true, currentStage: 'preliminary', cleared });
});

// ========== START ==========
let _syncStatus = { pulling: false, pulled: false, error: null, lastAttempt: null, lastStatus: null, lastResponse: null, githubEntries: 0 };

async function tryPullWithRetry(maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    _syncStatus.pulling = true;
    _syncStatus.lastAttempt = new Date().toISOString();
    try {
      await ghPull();
      _syncStatus.pulled = true;
      _syncStatus.error = null;
      _syncStatus.pulling = false;
      return true;
    } catch (e) {
      _syncStatus.error = e.message;
      console.error(`[gh] Pull attempt ${i + 1}/${maxRetries} failed:`, e.message);
      if (i < maxRetries - 1) {
        const delay = Math.pow(2, i) * 3000; // 3s, 6s, 12s backoff
        console.log(`[gh] Retrying in ${delay/1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  _syncStatus.pulling = false;
  console.error('[gh] All pull attempts failed. Using local data only.');
  return false;
}

app.get('/api/sync-status', (req, res) => {
  const localExists = fs.existsSync(DB_FILE);
  let localCount = 0;
  if (localExists) {
    try { localCount = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).entries?.length || 0; } catch {}
  }
  res.json({
    githubRepo: GITHUB_REPO,
    dataBranch: GITHUB_DATA_BRANCH,
    githubToken: GITHUB_TOKEN ? `ghp_...${GITHUB_TOKEN.slice(-4)}` : 'NOT SET',
    syncStatus: _syncStatus,
    localFile: localExists ? `exists (${localCount} entries)` : 'not found',
    dbEntries: db.entries.length,
    dbVotes: db.votes.length,
    dbScores: db.judgeScores.length
  });
});

app.post('/api/force-sync', async (req, res) => {
  try {
    const pulled = await tryPullWithRetry(2);
    if (pulled) {
      const refreshed = loadDB();
      db.entries = refreshed.entries;
      db.votes = refreshed.votes;
      db.judgeScores = refreshed.judgeScores;
      db.settings = refreshed.settings;
      _syncStatus.githubEntries = db.entries.length;
    }
    await ghPush();
    res.json({ success: true, pulled, syncStatus: _syncStatus, dbEntries: db.entries.length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, syncStatus: _syncStatus });
  }
});

(async () => {
  // Start server immediately, don't wait for GitHub sync
  app.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`  云帐房头号玩家第三季 — WorkBuddy 实战应用大赛`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  Stage: ${getCurrentStage()}`);
    console.log(`  GitHub sync: ${GITHUB_TOKEN ? 'ENABLED' : 'DISABLED'}`);
    if (!process.env.JUDGE_PASSWORD) console.log(`  ⚠️  JUDGE_PASSWORD not set via env — passwords only editable via admin panel`);
    if (!process.env.ADMIN_PASSWORD) console.log(`  ⚠️  ADMIN_PASSWORD not set via env — passwords only editable via admin panel`);
    if (!GITHUB_TOKEN) console.log(`  ⚠️  GITHUB_TOKEN not set — data WILL be lost on restart!`);
    console.log(`========================================\n`);
  });

  // Try GitHub sync with retries
  if (GITHUB_TOKEN) {
    console.log('[gh] Starting GitHub sync with retry...');
    await tryPullWithRetry(3);
  } else {
    console.log('[gh] No GITHUB_TOKEN — using local file only');
  }

  // ===== 等待数据稳定：防止蓝绿部署时旧容器还没 push，新容器拿到旧快照 =====
  // 原理：连续两次 pull 结果一致，说明旧容器已退出且 push 完毕，数据稳定
  if (GITHUB_TOKEN) {
    const STABLE_ROUNDS = 2;       // 连续 2 次一致即认为稳定
    const MAX_WAIT_ROUNDS = 12;     // 最多等 12 轮（约 2 分钟）
    const POLL_INTERVAL = 10000;    // 每 10 秒拉一次

    let stableCount = 0;
    let lastSnapshot = '';

    for (let round = 1; round <= MAX_WAIT_ROUNDS; round++) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      try {
        await ghPull();
        const refreshed = loadDB();
        const snapshot = `e:${refreshed.entries.length}|v:${refreshed.votes.length}|s:${refreshed.judgeScores.length}|d:${(refreshed.drawRecords || []).length}|b:${(refreshed.bets || []).length}`;

        if (snapshot === lastSnapshot) {
          stableCount++;
          console.log(`[gh-stable] Round ${round}/${MAX_WAIT_ROUNDS}: data stable (${stableCount}/${STABLE_ROUNDS}) — ${snapshot}`);
          if (stableCount >= STABLE_ROUNDS) {
            console.log('[gh-stable] ✅ Data is stable, safe to accept writes');
            break;
          }
        } else {
          stableCount = 0;
          console.log(`[gh-stable] Round ${round}/${MAX_WAIT_ROUNDS}: data changed — ${lastSnapshot || '(first)'} → ${snapshot}`);
          lastSnapshot = snapshot;
        }
      } catch (e) {
        console.error(`[gh-stable] Round ${round} pull failed:`, e.message);
      }

      if (round === MAX_WAIT_ROUNDS) {
        console.warn('[gh-stable] ⚠️ Max wait rounds reached, opening writes with current data (may not be latest)');
      }
    }

    // 用最终稳定的数据更新内存
    const refreshed = loadDB();
    db.entries = refreshed.entries;
    db.votes = refreshed.votes;
    db.judgeScores = refreshed.judgeScores;
    db.settings = refreshed.settings;
    db.drawRecords = refreshed.drawRecords || [];
    db.bets = refreshed.bets || [];
  } else {
    // 无 GitHub 同步，直接用本地数据
    const refreshed = loadDB();
    db.entries = refreshed.entries;
    db.votes = refreshed.votes;
    db.judgeScores = refreshed.judgeScores;
    db.settings = refreshed.settings;
    db.drawRecords = refreshed.drawRecords || [];
    db.bets = refreshed.bets || [];
  }

  _syncStatus.githubEntries = db.entries.length;
  _ready = true; // 数据载入完成，开放写入
  console.log('[db] Loaded — entries:', db.entries.length, 'votes:', db.votes.length, 'scores:', db.judgeScores.length, 'stage:', getCurrentStage());

  // 清理旧内联附件字段并立即同步到 GitHub，防止大文件导致 ghPush 持续失败
  if (migrateLegacyAttachments()) {
    console.log('[migrate] Legacy inline attachments cleared, shrinking contest.json');
    saveDB();
    if (GITHUB_TOKEN) {
      try { await ghPush(); console.log('[gh] Pushed shrunken contest.json'); }
      catch (e) { console.error('[gh] Push after migration failed:', e.message); }
    }
  }

  // Pull sessions from GitHub
  if (GITHUB_TOKEN) await ghPullSessions().catch(() => {});
  console.log('[session] Loaded — count:', sessions.size);

  // 定期 pull 合并（每 5 分钟），防止数据漂移
  // 确保 Render 休眠唤醒后、或多个实例时数据不会丢失
  if (GITHUB_TOKEN) {
    setInterval(async () => {
      try {
        await ghPull();
        const refreshed = loadDB();
        // 只在远程有新数据时更新内存
        const drawRecordsRefreshed = refreshed.drawRecords || [];
        const betsRefreshed = refreshed.bets || [];
        const hasNewer = refreshed.votes.length > db.votes.length
          || refreshed.entries.length > db.entries.length
          || refreshed.judgeScores.length > db.judgeScores.length
          || drawRecordsRefreshed.length > (db.drawRecords || []).length
          || betsRefreshed.length > (db.bets || []).length;
        if (hasNewer) {
          console.log('[gh-periodic] Remote has newer data, updating memory — votes:', db.votes.length, '→', refreshed.votes.length, 'entries:', db.entries.length, '→', refreshed.entries.length, 'draws:', (db.drawRecords || []).length, '→', drawRecordsRefreshed.length, 'bets:', (db.bets || []).length, '→', betsRefreshed.length);
          db.entries = refreshed.entries;
          db.votes = refreshed.votes;
          db.judgeScores = refreshed.judgeScores;
          db.settings = refreshed.settings;
          db.drawRecords = drawRecordsRefreshed;
          db.bets = betsRefreshed;
        }
      } catch (e) {
        console.error('[gh-periodic] Pull failed:', e.message);
      }
    }, 5 * 60 * 1000); // 5 分钟
  }
})().catch(e => { console.error('[fatal]', e); process.exit(1); });
