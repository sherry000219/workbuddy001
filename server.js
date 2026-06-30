const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const https = require('https');

// ========== CONFIG ==========
const PORT = process.env.PORT || 3000;

// DingTalk OAuth config
const DINGTALK = {
  appKey: 'dingrdgv8ra8guvuj6pm',
  appSecret: 'oo65T3Lew-22gSG_FwLKqSLfqEP9XZv0Kgtpn2r7IjFwG1FliqCSKAzAvcKz7SdJ',
  authUrl: 'https://login.dingtalk.com/oauth2/auth',
  tokenUrl: 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken',
  userInfoUrl: 'https://api.dingtalk.com/v1.0/contact/users/me',
};

// Session store: token → { openId, nick, avatarUrl, createdAt }
const sessions = new Map();
const SESSION_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

function generateSessionToken() {
  return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

function getSession(req) {
  const token = req.cookies && req.cookies.dd_session;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || Date.now() - session.createdAt > SESSION_MAX_AGE) {
    if (session) sessions.delete(token);
    return null;
  }
  return session;
}

// DingTalk API helper: call REST API
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

// Exchange DingTalk auth code for user info
async function exchangeDingTalkCode(code) {
  // Step 1: Get access token
  const tokenResp = await ddApi('POST', DINGTALK.tokenUrl, {
    clientId: DINGTALK.appKey,
    clientSecret: DINGTALK.appSecret,
    code,
    grantType: 'authorization_code',
  });
  if (!tokenResp.accessToken) {
    throw new Error(tokenResp.message || '获取钉钉授权失败');
  }
  // Step 2: Get user info
  const userResp = await ddApi('GET', DINGTALK.userInfoUrl, null, tokenResp.accessToken);
  if (!userResp.nick) {
    throw new Error(userResp.message || '获取用户信息失败');
  }
  return {
    openId: userResp.openId || '',
    unionId: userResp.unionId || '',
    nick: userResp.nick,
    avatarUrl: userResp.avatarUrl || '',
  };
}

// ========== JSON FILE STORAGE ==========
const DB_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DB_FILE = path.join(DB_DIR, 'contest.json');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const DEFAULT_DB = {
  entries: [],
  votes: [],
  judgeScores: [],
  settings: { judgePassword: 'judge2026', adminPassword: 'yzfwb2016' }
};

function loadDB() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const data = JSON.parse(raw);
    return { ...DEFAULT_DB, ...data, settings: { ...DEFAULT_DB.settings, ...(data.settings || {}) } };
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
}

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

const db = loadDB();

// ========== EXPRESS ==========
const app = express();
app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ extended: true, limit: '60mb' }));
app.use(cookieParser());
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
  let entries = db.entries.filter(e => e.status === 'approved');
  if (track) entries = entries.filter(e => e.track === track);
  if (dept) entries = entries.filter(e => e.dept === dept);
  if (search) {
    const kw = search.toLowerCase();
    entries = entries.filter(e => e.title.toLowerCase().includes(kw) || e.name.includes(search) || e.dept.includes(search) || (e.subdept || '').includes(search));
  }
  entries = entries.map(e => {
    const voteCount = db.votes.filter(v => v.entryId === e.id).length;
    const scores = db.judgeScores.filter(s => s.entryId === e.id);
    const avgScore = scores.length > 0 ? Math.round(scores.reduce((s, sc) => s + sc.practicality + sc.innovation + sc.scalability + sc.presentation, 0) / scores.length) : 0;
    return { ...e, voteCount, avgScore, judgeCount: scores.length };
  });
  if (sort === 'score') entries.sort((a, b) => b.avgScore - a.avgScore);
  else if (sort === 'votes') entries.sort((a, b) => b.voteCount - a.voteCount);
  else entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ entries });
});

app.post('/api/entries', upload.single('attachment'), (req, res) => {
  const { name, dept, subdept, track, title, scene, process_text, result_text, extra } = req.body;
  if (!name || !dept || !subdept || !track || !title || !scene || !process_text || !result_text) {
    return res.status(400).json({ error: '请填写所有必填字段' });
  }
  const id = 'entry_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  const entry = {
    id, name, dept, subdept, track, title, scene,
    process_text, result_text, extra: extra || '',
    attachmentName: req.file ? req.file.originalname : null,
    attachmentPath: req.file ? req.file.filename : null,
    status: 'approved',
    createdAt: new Date().toISOString()
  };
  db.entries.unshift(entry);
  saveDB();
  res.json({ success: true, id });
});

app.get('/api/entries/:id', (req, res) => {
  const entry = db.entries.find(e => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: '作品不存在' });
  const votes = db.votes.filter(v => v.entryId === entry.id);
  const scores = db.judgeScores.filter(s => s.entryId === entry.id);
  const avgScore = scores.length > 0 ? Math.round(scores.reduce((s, sc) => s + sc.practicality + sc.innovation + sc.scalability + sc.presentation, 0) / scores.length) : 0;
  res.json({ entry: { ...entry, votes, scores, avgScore, voteCount: votes.length, judgeCount: scores.length } });
});

// ========== API: VOTES ==========
app.post('/api/votes/:entryId', requireAuth, (req, res) => {
  const userId = req.ddUser.openId;
  const entry = db.entries.find(e => e.id === req.params.entryId && e.status === 'approved');
  if (!entry) return res.status(404).json({ error: '作品不存在' });
  if (db.votes.some(v => v.entryId === req.params.entryId && v.voterId === userId)) {
    return res.status(400).json({ error: '你已经投过票了' });
  }
  const userVoteCount = db.votes.filter(v => v.voterId === userId).length;
  if (userVoteCount >= 5) return res.status(400).json({ error: '每人最多投5个作品' });
  db.votes.push({
    entryId: req.params.entryId,
    voterId: userId,
    voterName: req.ddUser.nick,
    createdAt: new Date().toISOString()
  });
  saveDB();
  const remaining = 5 - userVoteCount - 1;
  res.json({ success: true, voteCount: db.votes.filter(v => v.entryId === req.params.entryId).length, remaining });
});

// ========== API: JUDGE ==========
app.post('/api/judge/scores/:entryId', (req, res) => {
  const { judgeName, practicality, innovation, scalability, presentation, judgePassword } = req.body;
  if (!judgeName) return res.status(400).json({ error: '请输入评委姓名' });
  if (judgePassword !== (db.settings.judgePassword || 'judge2026')) {
    return res.status(403).json({ error: '评委密码错误' });
  }
  const entry = db.entries.find(e => e.id === req.params.entryId);
  if (!entry) return res.status(404).json({ error: '作品不存在' });
  const p = parseInt(practicality) || 0, c = parseInt(innovation) || 0, s = parseInt(scalability) || 0, r = parseInt(presentation) || 0;
  if (p > 30 || c > 25 || s > 25 || r > 20) return res.status(400).json({ error: '分数超出上限' });
  const idx = db.judgeScores.findIndex(sc => sc.entryId === req.params.entryId && sc.judgeName === judgeName);
  const scoreData = { entryId: req.params.entryId, judgeName, practicality: p, innovation: c, scalability: s, presentation: r, updatedAt: new Date().toISOString() };
  if (idx >= 0) db.judgeScores[idx] = scoreData;
  else db.judgeScores.push(scoreData);
  saveDB();
  res.json({ success: true, total: p + c + s + r });
});

// ========== API: RANKING ==========
app.get('/api/ranking', (req, res) => {
  const { track } = req.query;
  let entries = db.entries.filter(e => e.status === 'approved');
  if (track) entries = entries.filter(e => e.track === track);
  const maxVotes = Math.max(1, ...entries.map(e => db.votes.filter(v => v.entryId === e.id).length));
  const enriched = entries.map(e => {
    const voteCount = db.votes.filter(v => v.entryId === e.id).length;
    const scores = db.judgeScores.filter(s => s.entryId === e.id);
    const judgeAvg = scores.length > 0 ? Math.round(scores.reduce((s, sc) => s + sc.practicality + sc.innovation + sc.scalability + sc.presentation, 0) / scores.length) : 0;
    const voteScore = Math.round((voteCount / maxVotes) * 100);
    const composite = Math.round(judgeAvg * 0.6 + voteScore * 0.4);
    return { ...e, voteCount, judgeAvg, composite };
  });
  enriched.sort((a, b) => b.composite - a.composite);
  res.json({ ranking: enriched.slice(0, 20) });
});

// ========== API: STATS ==========
app.get('/api/stats', (req, res) => {
  const totalEntries = db.entries.length;
  const approvedEntries = db.entries.filter(e => e.status === 'approved').length;
  const totalVotes = db.votes.length;
  const judgeCount = new Set(db.judgeScores.map(s => s.judgeName)).size;
  const deptCounts = {};
  db.entries.forEach(e => { deptCounts[e.dept] = (deptCounts[e.dept] || 0) + 1; });
  const topDept = Object.entries(deptCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '-';
  res.json({ totalEntries, approvedEntries, totalVotes, judgeCount, topDept, deptStats: Object.entries(deptCounts).map(([dept, c]) => ({ dept, c })) });
});

// ========== API: EXPORT ==========
app.get('/api/export/json', verifyAdminToken, (req, res) => {
  res.json({ entries: db.entries, votes: db.votes, judgeScores: db.judgeScores, settings: db.settings });
});

app.get('/api/export/csv', verifyAdminToken, (req, res) => {
  const trackLabel = { efficiency: '效率提升', creative: '创意应用', business: '业务赋能' };
  let csv = '\uFEFFID,状态,姓名,部门,子部门,赛道,标题,场景描述,使用过程,效果呈现,作品链接/附加信息,附件名称,提交时间,投票数,评委均分,综合分\n';
  const maxVotes = Math.max(1, ...db.entries.map(e => db.votes.filter(v => v.entryId === e.id).length));
  db.entries.forEach(e => {
    const voteCount = db.votes.filter(v => v.entryId === e.id).length;
    const scores = db.judgeScores.filter(s => s.entryId === e.id);
    const avgScore = scores.length > 0 ? Math.round(scores.reduce((s, sc) => s + sc.practicality + sc.innovation + sc.scalability + sc.presentation, 0) / scores.length) : 0;
    const voteScore = Math.round((voteCount / maxVotes) * 100);
    const composite = Math.round(avgScore * 0.6 + voteScore * 0.4);
    const esc = (v) => `"${String(v || '').replace(/"/g, '""')}"`
    csv += `${esc(e.id)},${esc(e.status === 'approved' ? '已收录' : '待审核')},${esc(e.name)},${esc(e.dept)},${esc(e.subdept)},${esc(trackLabel[e.track] || e.track)},${esc(e.title)},${esc(e.scene)},${esc(e.process_text)},${esc(e.result_text)},${esc(e.extra)},${esc(e.attachmentName)},${esc(e.createdAt)},${voteCount},${avgScore},${composite}\n`;
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="WorkBuddy-entries.csv"; filename*=UTF-8\'\'WorkBuddy%E5%A4%A7%E8%B5%9B%E4%BD%9C%E5%93%81.csv');
  res.send(csv);
});

// ========== API: SETTINGS ==========
app.get('/api/settings', verifyAdminToken, (req, res) => {
  res.json({ settings: db.settings });
});

app.post('/api/settings', verifyAdminToken, (req, res) => {
  if (req.body.judgePassword !== undefined) {
    db.settings.judgePassword = req.body.judgePassword;
  }
  if (req.body.adminPassword !== undefined) {
    db.settings.adminPassword = req.body.adminPassword;
  }
  saveDB();
  res.json({ success: true });
});

// ========== ADMIN TOKEN STORE (in-memory, cleared on server restart) ==========
const adminTokens = new Map(); // token -> expiry timestamp

function generateAdminToken() {
  const token = 'adm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  adminTokens.set(token, Date.now() + 2 * 60 * 60 * 1000); // 2-hour expiry
  // Clean expired tokens
  for (const [t, exp] of adminTokens) { if (Date.now() > exp) adminTokens.delete(t); }
  return token;
}

function verifyAdminToken(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.adminToken;
  if (!token || !adminTokens.has(token) || Date.now() > adminTokens.get(token)) {
    if (token) adminTokens.delete(token);
    return res.status(401).json({ error: '未授权，请先登录管理后台' });
  }
  // Extend session on use
  adminTokens.set(token, Date.now() + 2 * 60 * 60 * 1000);
  next();
}

// ========== API: DINGTALK AUTH ==========
// POST /api/auth/dd-code — exchange DingTalk JSAPI auth code for session
app.post('/api/auth/dd-code', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: '缺少授权码' });
  try {
    const userInfo = await exchangeDingTalkCode(code);
    const token = generateSessionToken();
    sessions.set(token, {
      openId: userInfo.openId,
      unionId: userInfo.unionId,
      nick: userInfo.nick,
      avatarUrl: userInfo.avatarUrl,
      createdAt: Date.now(),
    });
    res.cookie('dd_session', token, {
      maxAge: SESSION_MAX_AGE,
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
    });
    res.json({ success: true, user: { nick: userInfo.nick, openId: userInfo.openId, avatarUrl: userInfo.avatarUrl } });
  } catch (e) {
    console.error('DingTalk auth error:', e.message);
    res.status(400).json({ error: e.message || '钉钉授权失败' });
  }
});

// GET /api/auth/me — get current logged-in user (or null)
app.get('/api/auth/me', (req, res) => {
  const session = getSession(req);
  if (!session) return res.json({ user: null });
  // Count votes for this user
  const voteCount = db.votes.filter(v => v.voterId === session.openId).length;
  res.json({
    user: { nick: session.nick, openId: session.openId, avatarUrl: session.avatarUrl },
    remainingVotes: Math.max(0, 5 - voteCount),
    totalVotes: 5,
  });
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies && req.cookies.dd_session;
  if (token) sessions.delete(token);
  res.clearCookie('dd_session');
  res.json({ success: true });
});

// ========== API: ADMIN ==========
app.post('/api/admin/auth', (req, res) => {
  const { password } = req.body;
  const adminPw = db.settings.adminPassword || 'yzfwb2016';
  if (!password || password !== adminPw) {
    return res.status(403).json({ error: '管理员密码错误' });
  }
  const token = generateAdminToken();
  res.json({ success: true, token, message: '管理员已验证' });
});

app.get('/api/admin/scores', verifyAdminToken, (req, res) => {
  // Build a per-entry view with all judge scores
  const entries = db.entries.filter(e => e.status === 'approved');
  const allJudges = [...new Set(db.judgeScores.map(s => s.judgeName))].sort();
  
  const entryScores = entries.map(e => {
    const scores = db.judgeScores
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
    
    return {
      id: e.id,
      title: e.title,
      name: e.name,
      dept: e.dept,
      subdept: e.subdept || '',
      track: e.track,
      createdAt: e.createdAt,
      scores,
      avgScore: avg,
      judgeCount: scores.length
    };
  });

  const summary = {
    totalEntries: entries.length,
    totalJudges: allJudges.length,
    totalScores: db.judgeScores.length,
    scoredEntries: entryScores.filter(e => e.scores.length > 0).length,
    unscoredEntries: entryScores.filter(e => e.scores.length === 0).length,
    judges: allJudges
  };

  res.json({ entryScores, allJudges, summary });
});

app.get('/api/admin/export/csv', verifyAdminToken, (req, res) => {
  const entries = db.entries.filter(e => e.status === 'approved');
  const allJudges = [...new Set(db.judgeScores.map(s => s.judgeName))].sort();
  const trackLabel = { efficiency: '效率提升', creative: '创意应用', business: '业务赋能' };
  const esc = (v) => `"${String(v || '').replace(/"/g, '""')}"`;

  // Build comprehensive CSV with all judge scores
  // Headers: ID,标题,姓名,部门,子部门,赛道,提交时间,评委数,均分, | 评委A-总分,评委A-实用性,评委A-创新性,评委A-可推广性,评委A-效果呈现, 评委B-...
  let csv = '\uFEFF';
  let headers = ['作品ID', '标题', '姓名', '部门', '子部门', '赛道', '提交时间', '投票数', '评委数', '评委均分'];
  allJudges.forEach(j => {
    headers.push(`${j}-总分`, `${j}-实用性(/30)`, `${j}-创新性(/25)`, `${j}-可推广性(/25)`, `${j}-效果呈现(/20)`);
  });
  csv += headers.map(esc).join(',') + '\n';

  entries.forEach(e => {
    const voteCount = db.votes.filter(v => v.entryId === e.id).length;
    const scores = db.judgeScores.filter(s => s.entryId === e.id);
    const avg = scores.length > 0
      ? Math.round(scores.reduce((sum, s) => sum + s.practicality + s.innovation + s.scalability + s.presentation, 0) / scores.length)
      : 0;

    let row = [
      e.id, e.title, e.name, e.dept, e.subdept || '',
      trackLabel[e.track] || e.track, e.createdAt,
      voteCount, scores.length, avg
    ];

    // Add per-judge columns
    allJudges.forEach(judge => {
      const s = scores.find(sc => sc.judgeName === judge);
      if (s) {
        row.push(
          s.practicality + s.innovation + s.scalability + s.presentation,
          s.practicality, s.innovation, s.scalability, s.presentation
        );
      } else {
        row.push('', '', '', '', '');
      }
    });

    csv += row.map(esc).join(',') + '\n';
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="WorkBuddy-contest-scores.csv"; filename*=UTF-8\'\'WorkBuddy%E5%A4%A7%E8%B5%9B-%E8%AF%84%E5%A7%94%E6%89%93%E5%88%86%E6%B1%87%E6%80%BB.csv');
  res.send(csv);
});

app.post('/api/admin/clear', verifyAdminToken, (req, res) => {
  const { type } = req.body;
  if (type === 'all') { db.entries = []; db.votes = []; db.judgeScores = []; }
  else if (type === 'scores') { db.judgeScores = []; }
  saveDB();
  res.json({ success: true });
});

// ========== START ==========
app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  WorkBuddy Contest Platform running!`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Database: ${DB_FILE}`);
  console.log(`========================================\n`);
});
