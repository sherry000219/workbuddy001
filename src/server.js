import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { store } from './store.js';
import { authRouter, requireAdmin } from './auth.js';
import { contestsRouter } from './modules/contests.js';
import { activitiesRouter } from './modules/activities.js';
import { communityRouter } from './modules/community.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now(), base: config.baseUrl }));

app.use('/api/auth', authRouter);

// 模块编排配置（受后台控制，原型默认全开）
app.get('/api/modules', (req, res) =>
  res.json({ modules: { contest: true, activity: true, community: true } })
);

app.use('/api/contests', contestsRouter);
app.use('/api/activities', activitiesRouter);
app.use('/api/community', communityRouter);

// 管理后台示例（受保护）
app.get('/api/admin/overview', requireAdmin, async (req, res) => {
  const users = await store.get('users', { items: [] });
  const contests = await store.get('contests', { items: [] });
  const activities = await store.get('activities', { items: [] });
  res.json({
    users: users.items.length,
    contests: contests.items.length,
    activities: activities.items.length,
    modules: ['contest', 'activity', 'community'],
  });
});

const port = config.port;
app.listen(port, () => console.log(`YZF Activity Hub listening on ${port}`));
