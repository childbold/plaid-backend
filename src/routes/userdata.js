// Your own data for frontends: budget, transaction edits and goals (see ../userdata.js).
// GET returns the whole area; PATCH sends only what changed, { section: { id: value | null } }.
import { Router } from 'express';
import { readBudget, patchBudget, readEdits, patchEdits, readGoals, patchGoals, importLegacy } from '../userdata.js';

export const userdata = Router();

const areas = { budget: [readBudget, patchBudget], edits: [readEdits, patchEdits], goals: [readGoals, patchGoals] };
for (const [area, [read, patch]] of Object.entries(areas)) {
  userdata.get(`/${area}`, (req, res) => res.json(read()));
  userdata.patch(`/${area}`, (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ error: 'send application/json' });
    res.json(patch(req.body));
  });
}

// One-time move of the dashboard's old budget.json / edits.json / goals.json. Areas that already
// hold data here are skipped, so this is safe to call more than once.
userdata.post('/import', (req, res) => {
  if (!req.is('application/json')) return res.status(415).json({ error: 'send application/json' });
  res.json(importLegacy(req.body));
});
