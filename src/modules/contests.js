import express from 'express';
import { store } from '../store.js';

const router = express.Router();

router.get('/', async (req, res) => res.json(await store.get('contests', { items: [] })));

router.post('/', async (req, res) => {
  const data = await store.get('contests', { items: [] });
  const item = {
    id: 'c_' + Date.now(),
    participant_scope: req.body.participant_scope || 'internal_only',
    external_review: !!req.body.external_review,
    ...req.body,
  };
  data.items.push(item);
  await store.set('contests', data);
  res.json(item);
});

export { router as contestsRouter };
