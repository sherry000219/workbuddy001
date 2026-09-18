import express from 'express';
import { store } from '../store.js';

const router = express.Router();

router.get('/boards', async (req, res) => res.json(await store.get('boards', { items: [] })));
router.get('/posts', async (req, res) => res.json(await store.get('posts', { items: [] })));

router.post('/posts', async (req, res) => {
  const data = await store.get('posts', { items: [] });
  const p = { id: 'p_' + Date.now(), createdAt: new Date().toISOString(), ...req.body };
  data.items.push(p);
  await store.set('posts', data);
  res.json(p);
});

export { router as communityRouter };
