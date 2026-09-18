import express from 'express';
import { store } from '../store.js';

const router = express.Router();

router.get('/', async (req, res) => res.json(await store.get('activities', { items: [] })));

// 两类活动：signup（报名类） / selection（评选类）
router.post('/', async (req, res) => {
  const data = await store.get('activities', { items: [] });
  const item = { id: 'a_' + Date.now(), type: req.body.type || 'signup', ...req.body };
  data.items.push(item);
  await store.set('activities', data);
  res.json(item);
});

// 评选类：材料提交
router.post('/:id/submissions', async (req, res) => {
  const data = await store.get('activity_submissions', { items: [] });
  const sub = { id: 's_' + Date.now(), activityId: req.params.id, ...req.body };
  data.items.push(sub);
  await store.set('activity_submissions', data);
  res.json(sub);
});

// 评选类：投票/评选
router.post('/:id/votes', async (req, res) => {
  const data = await store.get('activity_votes', { items: [] });
  const v = { id: 'v_' + Date.now(), activityId: req.params.id, ...req.body };
  data.items.push(v);
  await store.set('activity_votes', data);
  res.json(v);
});

export { router as activitiesRouter };
