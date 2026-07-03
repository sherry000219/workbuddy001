const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const https = require('https');

// ========== CONFIG ==========
const PORT = process.env.PORT || 3000;
const DEPLOY_VERSION = 'v4-stage';

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
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
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

function saveSessions() {
  try {
    const obj = {};
    sessions.forEach((session, token) => { obj[token] = session; });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(obj, null, 2), 'utf8');
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
  settings: { judgePassword: 'wb2026', adminPassword: 'yzfwb2016', votingEnabled: false, currentStage: 'preliminary' }
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
    });
    (merged.votes || []).forEach(v => {
      if (!v.stage) v.stage = 'preliminary';
    });
    (merged.judgeScores || []).forEach(s => {
      if (!s.stage) s.stage = 'preliminary';
    });
    return merged;
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
}

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

const db = loadDB();

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
    return db.entries.filter(e => e.roundStatus === 'semi_finalist');
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

// Calculate composite score for an entry in a specific stage
function getCompositeScore(entryId, stage) {
  const { avgScore, voteCount } = getEntryStageScores(entryId, stage);
  if (stage === 'final') {
    return avgScore; // 100% judge score, no voting
  }
  // For preliminary and semi_final: 80% judge + 20% votes
  const votable = getVotableEntries(stage);
  const allVoteCounts = votable.map(e => getEntryStageScores(e.id, stage).voteCount);
  const maxVotes = Math.max(1, ...allVoteCounts, voteCount);
  const voteScore = Math.round((voteCount / maxVotes) * 100);
  return Math.round(avgScore * 0.8 + voteScore * 0.2);
}

// Count user's votes in current stage
function getUserStageVoteCount(userId, stage) {
  return db.votes.filter(v => v.voterId === userId && (v.stage || 'preliminary') === stage).length;
}

const VOTE_LIMIT_PER_STAGE = 5;

// ========== GITHUB SYNC ==========
let _ghSha = null;
let _ghTimer = null;
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
  _syncStatus.githubEntries = remoteCount;
  const localExists = fs.existsSync(DB_FILE);
  if (localExists) {
    const localData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const localCount = (localData.entries || []).length;
    if (remoteCount > localCount || (remoteCount === localCount && remoteCount === 0 && localCount === 0)) {
      fs.writeFileSync(DB_FILE, buf, 'utf8');
      console.log('[gh] Pulled data (GitHub newer) — entries:', remoteCount, '> local:', localCount, 'sha:', _ghSha.slice(0, 7));
    } else if (localCount > remoteCount) {
      console.log('[gh] Local data newer — entries:', localCount, '> GitHub:', remoteCount, '— will push on next save');
      _ghSha = data.sha;
    } else {
      console.log('[gh] Data in sync — entries:', localCount, 'sha:', _ghSha.slice(0, 7));
    }
  } else {
    fs.writeFileSync(DB_FILE, buf, 'utf8');
    console.log('[gh] Pulled data (no local file) — entries:', remoteCount, 'sha:', _ghSha.slice(0, 7));
  }
}

function ghPushSchedule() {
  if (!GITHUB_TOKEN) return;
  if (_ghTimer) clearTimeout(_ghTimer);
  _ghTimer = setTimeout(ghPush, 5000);
}

async function ghPush() {
  try {
    const buf = fs.readFileSync(DB_FILE);
    const body = { message: 'auto: sync data', content: buf.toString('base64'), branch: GITHUB_DATA_BRANCH };
    if (_ghSha) body.sha = _ghSha;
    const { status, data } = await ghReq('PUT', `/repos/${GITHUB_REPO}/contents/data/contest.json`, body);
    if (status >= 400) throw new Error(data.message || status);
    _ghSha = data.content.sha;
    console.log('[gh] Pushed data — sha:', _ghSha.slice(0, 7));
  } catch (e) { console.error('[gh] Push failed:', e.message); }
}

const _realSaveDB = saveDB;
saveDB = function() {
  _realSaveDB();
  ghPushSchedule();
};

// ========== PASSWORD HELPERS ==========
function getJudgePassword() {
  return process.env.JUDGE_PASSWORD || 'wb2026';
}

function getAdminPassword() {
  return process.env.ADMIN_PASSWORD || 'yzfwb2026';
}

// ========== EXPRESS ==========
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ extended: true, limit: '60mb' }));
app.use(cookieParser());

// Explicit routes for app pages (no trailing-slash redirect)
app.get(['/app', '/app/'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'app', 'index.html')));
app.get('/app/submit.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app', 'submit.html')));
app.get('/app/browse.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app', 'browse.html')));
app.get('/app/judge.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app', 'judge.html')));
app.get('/app/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app', 'admin.html')));

app.use(express.static('public'));
app.use('/uploads', express.static(UPLOAD_DIR));

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 50 * 1024 * 1024 } });

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
app.get('/api/entries', (req, res) => {
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

app.post('/api/entries', requireAuth, upload.single('attachment'), (req, res) => {
  let { name, mobile, dept, dept1, dept2, dept3, subdept, track, title, scene, process_text, result_text, extra } = req.body;
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
  // 参赛范围限制：非研发序列人员可参赛
  if (dept1 === '产研中心' || dept2 === '研发部') {
    return res.status(403).json({ error: '本次参赛范围仅限云帐房非研发序列人员，研发序列同事欢迎参与投票' });
  }
  if (!track || !title || !scene || !process_text || !result_text) {
    return res.status(400).json({ error: '请填写所有必填字段' });
  }
  const id = 'entry_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  const entry = {
    id, name, mobile: mobile || '', dept: dept1, dept1, dept2: dept2 || '', dept3: dept3 || '',
    subdept: subdept || dept2 || '', // backward compat
    track, title, scene,
    process_text, result_text, extra: extra || '',
    attachmentName: req.file ? req.file.originalname : null,
    attachmentPath: req.file ? req.file.filename : null,
    status: 'approved',
    roundStatus: 'approved',
    award: null,
    createdAt: new Date().toISOString()
  };
  db.entries.unshift(entry);
  saveDB();
  res.json({ success: true, id });
});

app.get('/api/entries/:id', (req, res) => {
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

// ========== API: VOTES ==========
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
  // Check entry is votable in current stage
  const votable = getVotableEntries(stage);
  const entry = votable.find(e => e.id === req.params.entryId);
  if (!entry) return res.status(404).json({ error: '该作品在当前阶段不可投票' });
  // Check duplicate vote in this stage
  if (db.votes.some(v => v.entryId === req.params.entryId && v.voterId === userId && (v.stage || 'preliminary') === stage)) {
    return res.status(400).json({ error: '你在本阶段已经投过这个作品了' });
  }
  const userVoteCount = getUserStageVoteCount(userId, stage);
  if (userVoteCount >= VOTE_LIMIT_PER_STAGE) return res.status(400).json({ error: '本阶段每人最多投5个作品' });
  db.votes.push({
    entryId: req.params.entryId,
    voterId: userId,
    voterName: req.ddUser.nick,
    stage,
    createdAt: new Date().toISOString()
  });
  saveDB();
  const remaining = VOTE_LIMIT_PER_STAGE - userVoteCount - 1;
  res.json({ success: true, voteCount: db.votes.filter(v => v.entryId === req.params.entryId && (v.stage || 'preliminary') === stage).length, remaining });
});

// ========== API: JUDGE ==========
app.post('/api/judge/scores/:entryId', (req, res) => {
  const { judgeName, practicality, innovation, scalability, presentation, judgePassword } = req.body;
  if (!judgeName) return res.status(400).json({ error: '请输入评委姓名' });
  if (judgePassword !== getJudgePassword()) {
    return res.status(403).json({ error: '评委密码错误' });
  }
  const stage = getCurrentStage();
  // Check entry is judgable in current stage
  const judgable = getJudgableEntries(stage);
  const entry = judgable.find(e => e.id === req.params.entryId);
  if (!entry) return res.status(404).json({ error: '该作品在当前阶段不可打分' });
  const p = parseInt(practicality) || 0, c = parseInt(innovation) || 0, s = parseInt(scalability) || 0, r = parseInt(presentation) || 0;
  if (p > 30 || c > 25 || s > 25 || r > 20) return res.status(400).json({ error: '分数超出上限' });
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
  const stage = getCurrentStage();
  const scores = db.judgeScores
    .filter(s => s.judgeName === judgeName && (s.stage || 'preliminary') === stage)
    .map(s => ({ entryId: s.entryId, practicality: s.practicality, innovation: s.innovation, scalability: s.scalability, presentation: s.presentation, total: s.practicality + s.innovation + s.scalability + s.presentation }));
  res.json({ scores, stage });
});

// ========== API: RANKING ==========
app.get('/api/ranking', (req, res) => {
  const { track } = req.query;
  const stage = getCurrentStage();
  // Determine which entries to rank based on stage
  let entries;
  if (stage === 'preliminary') {
    entries = db.entries.filter(e => e.status === 'approved');
  } else if (stage === 'semi_final') {
    entries = db.entries.filter(e => e.roundStatus === 'semi_finalist');
  } else if (stage === 'final' || stage === 'awarded') {
    entries = db.entries.filter(e => e.roundStatus === 'finalist' || e.roundStatus === 'awarded');
  } else {
    entries = db.entries.filter(e => e.status === 'approved');
  }
  if (track) entries = entries.filter(e => e.track === track);
  const enriched = entries.map(e => {
    const sd = getEntryStageScores(e.id, stage);
    const composite = getCompositeScore(e.id, stage);
    return { ...e, roundStatus: e.roundStatus || 'approved', award: e.award || null, voteCount: sd.voteCount, judgeAvg: sd.avgScore, composite };
  });
  enriched.sort((a, b) => b.composite - a.composite);
  res.json({ ranking: enriched.slice(0, 30), currentStage: stage });
});

// ========== API: STATS ==========
app.get('/api/stats', (req, res) => {
  const stage = getCurrentStage();
  const totalEntries = db.entries.length;
  const approvedEntries = db.entries.filter(e => e.status === 'approved').length;
  const stageVotes = db.votes.filter(v => (v.stage || 'preliminary') === stage).length;
  const stageScores = db.judgeScores.filter(s => (s.stage || 'preliminary') === stage);
  const judgeCount = new Set(stageScores.map(s => s.judgeName)).size;
  const semiFinalists = db.entries.filter(e => e.roundStatus === 'semi_finalist').length;
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
  const trackLabel = { efficiency: '效率提升', creative: '创意应用', business: '业务赋能' };
  const stage = getCurrentStage();
  let csv = '\uFEFFID,状态,轮次状态,姓名,部门,子部门,赛道,标题,场景描述,使用过程,效果呈现,作品链接,附件名称,提交时间,当前阶段投票数,当前阶段评委均分,当前阶段综合分\n';
  const votable = getVotableEntries(stage);
  const allVoteCounts = votable.map(e => getEntryStageScores(e.id, stage).voteCount);
  const maxVotes = Math.max(1, ...allVoteCounts);
  db.entries.forEach(e => {
    const sd = getEntryStageScores(e.id, stage);
    const voteScore = Math.round((sd.voteCount / maxVotes) * 100);
    const composite = stage === 'final' ? sd.avgScore : Math.round(sd.avgScore * 0.8 + voteScore * 0.2);
    const roundLabel = { approved: '初赛', semi_finalist: '复赛晋级', eliminated_semi: '复赛淘汰', finalist: '决赛晋级', eliminated_final: '决赛淘汰', awarded: '已获奖' }[e.roundStatus] || '初赛';
    const esc = (v) => `"${String(v || '').replace(/"/g, '""')}"`;
    csv += `${esc(e.id)},${esc(e.status === 'approved' ? '已收录' : '待审核')},${esc(roundLabel)},${esc(e.name)},${esc(e.dept)},${esc(e.subdept)},${esc(trackLabel[e.track] || e.track)},${esc(e.title)},${esc(e.scene)},${esc(e.process_text)},${esc(e.result_text)},${esc(e.extra)},${esc(e.attachmentName)},${esc(e.createdAt)},${sd.voteCount},${sd.avgScore},${composite}\n`;
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="WorkBuddy-entries.csv"');
  res.send(csv);
});

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
  saveDB();
  ghPush().catch(e => console.error('[settings] GitHub push failed:', e.message));
  res.json({ success: true, currentStage: getCurrentStage() });
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
    res.json({ success: true, user: { nick: userInfo.nick, openId: userInfo.openId, mobile: userInfo.mobile, avatarUrl: userInfo.avatarUrl }, remainingVotes: Math.max(0, VOTE_LIMIT_PER_STAGE - voteCount), currentStage: stage });
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
  res.json({
    user: { nick: session.nick, openId: session.openId, mobile: session.mobile || '', avatarUrl: session.avatarUrl },
    remainingVotes: Math.max(0, VOTE_LIMIT_PER_STAGE - voteCount),
    totalVotes: VOTE_LIMIT_PER_STAGE,
    currentStage: stage,
    isVotingStage: isVotingStage(stage),
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

app.get('/api/admin/scores', verifyAdminToken, (req, res) => {
  const stage = getCurrentStage();
  const entries = getJudgableEntries(stage);
  const stageScores = db.judgeScores.filter(s => (s.stage || 'preliminary') === stage);
  const allJudges = [...new Set(stageScores.map(s => s.judgeName))].sort();

  const entryScores = entries.map(e => {
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
    headers.push(`${j}-总分`, `${j}-实用性(/30)`, `${j}-创新性(/25)`, `${j}-可推广性(/25)`, `${j}-效果呈现(/20)`);
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
    console.log(`  云帐房头号玩家第二季 — WorkBuddy 实战应用大赛`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  Stage: ${getCurrentStage()}`);
    console.log(`  GitHub sync: ${GITHUB_TOKEN ? 'ENABLED' : 'DISABLED'}`);
    console.log(`========================================\n`);
  });

  // Try GitHub sync with retries
  if (GITHUB_TOKEN) {
    console.log('[gh] Starting GitHub sync with retry...');
    await tryPullWithRetry(3);
  } else {
    console.log('[gh] No GITHUB_TOKEN — using local file only');
  }

  // Load DB (either from GitHub sync or local file)
  const refreshed = loadDB();
  db.entries = refreshed.entries;
  db.votes = refreshed.votes;
  db.judgeScores = refreshed.judgeScores;
  db.settings = refreshed.settings;
  _syncStatus.githubEntries = db.entries.length;
  console.log('[db] Loaded — entries:', db.entries.length, 'votes:', db.votes.length, 'scores:', db.judgeScores.length, 'stage:', getCurrentStage());
})().catch(e => { console.error('[fatal]', e); process.exit(1); });
