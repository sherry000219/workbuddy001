import express from 'express';
import crypto from 'crypto';
import { config } from './config.js';
import { store } from './store.js';

const router = express.Router();

function sign(payload) {
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', config.jwtSecret).update(body).digest('hex');
  return Buffer.from(JSON.stringify({ p: payload, s: sig })).toString('base64url');
}
function verify(token) {
  try {
    const obj = JSON.parse(Buffer.from(token, 'base64url').toString());
    const body = JSON.stringify(obj.p);
    const sig = crypto.createHmac('sha256', config.jwtSecret).update(body).digest('hex');
    if (sig !== obj.s) return null;
    return obj.p;
  } catch {
    return null;
  }
}

// 钉钉免登（内部员工）；无配置时返回 dev 员工
router.post('/dingtalk/exchange', async (req, res) => {
  const { code } = req.body || {};
  if (!config.dingtalkAppKey) {
    let users = await store.get('users', { items: [] });
    let u = users.items.find((x) => x.dev);
    if (!u) {
      u = { id: 'u_dev', name: '开发员工', type: 'employee', dev: true };
      users.items.push(u);
      await store.set('users', users);
    }
    return res.json({ token: sign({ uid: u.id, type: 'employee' }), user: u });
  }
  return res.status(501).json({ error: 'dingtalk not configured' });
});

// 管理员登录
router.post('/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== config.adminPassword) return res.status(401).json({ error: 'unauthorized' });
  return res.json({ token: sign({ uid: 'admin', type: 'admin', role: 'super' }) });
});

// 外部学生：发送验证码（原型期直接回显开发码；生产期走 M10 短信通道）
const codes = new Map();
router.post('/external/send-code', (req, res) => {
  const { phone } = req.body || {};
  if (!/^1\d{10}$/.test(phone)) return res.status(400).json({ error: 'invalid phone' });
  codes.set(phone, { code: config.devSmsCode, exp: Date.now() + 300000 });
  return res.json({ ok: true, devCode: config.devSmsCode });
});

router.post('/external/verify', async (req, res) => {
  const { phone, code, profile } = req.body || {};
  const rec = codes.get(phone);
  if (!rec || rec.code !== code || rec.exp < Date.now()) return res.status(400).json({ error: 'invalid or expired code' });
  codes.delete(phone);
  let users = await store.get('users', { items: [] });
  let u = users.items.find((x) => x.type === 'external_student' && x.phone === phone);
  if (!u) {
    u = { id: 'ext_' + phone, name: profile?.realName || '外部学生', type: 'external_student', phone, school: profile?.school, verified: true };
    users.items.push(u);
    await store.set('users', users);
    const ext = await store.get('external_users', { items: [] });
    ext.items.push({ userId: u.id, realName: u.name, school: u.school, phone, verified: true, consentAt: new Date().toISOString() });
    await store.set('external_users', ext);
  }
  return res.json({ token: sign({ uid: u.id, type: 'external_student' }), user: u });
});

export function requireUser(req, res, next) {
  const t = req.headers.authorization?.replace('Bearer ', '');
  const p = t && verify(t);
  if (!p) return res.status(401).json({ error: 'unauthorized' });
  req.user = p;
  next();
}
export function requireAdmin(req, res, next) {
  const t = req.headers.authorization?.replace('Bearer ', '');
  const p = t && verify(t);
  if (!p || p.type !== 'admin') return res.status(401).json({ error: 'forbidden' });
  req.user = p;
  next();
}
export function requireExternal(req, res, next) {
  const t = req.headers.authorization?.replace('Bearer ', '');
  const p = t && verify(t);
  if (!p || p.type !== 'external_student') return res.status(401).json({ error: 'forbidden' });
  req.user = p;
  next();
}
export { router as authRouter, sign };
