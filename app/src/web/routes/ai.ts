import { DomainError } from '../../lib/errors.ts';
import { AI_TASKS, type AiEntity, type AiTask } from '../../ai/assistant.ts';
import { actorOf, back, h, ok, type RouteModule, redirectWithFlash } from '../kit.ts';

const ENTITIES: AiEntity[] = ['customer', 'site', 'asset', 'job', 'attendance'];

/**
 * The assistant's only endpoints. They produce text and a provenance record; they never
 * mutate an operational record. Applying a suggestion goes through the normal, permission
 * checked route for that change, submitted by the person (RULE-011, AC-071-03).
 */
const register: RouteModule = (app, { ai }) => {
  app.post(
    '/ai/suggest',
    h(async (req, res) => {
      const actor = actorOf(req);
      const task = String(req.body?.task ?? '') as AiTask;
      const entity = String(req.body?.entity ?? '') as AiEntity;
      const id = parseInt(String(req.body?.id ?? ''), 10);
      if (!(task in AI_TASKS)) throw new DomainError('Unknown assistant task.');
      if (!ENTITIES.includes(entity) || !Number.isInteger(id)) throw new DomainError('Unknown record for the assistant.');

      const suggestion = await ai.suggest(actor, task, entity, id);
      const target = back(req);
      const sep = target.includes('?') ? '&' : '?';
      redirectWithFlash(res, `${target}${sep}ai=${suggestion.interactionId}#ai`, 'info', `${AI_TASKS[task]}: suggestion ready for you to check.`);
    }),
  );

  app.post(
    '/ai/decide',
    h((req, res) => {
      const actor = actorOf(req);
      const id = parseInt(String(req.body?.id ?? ''), 10);
      const status = String(req.body?.status ?? '');
      if (!Number.isInteger(id) || (status !== 'copied' && status !== 'rejected')) throw new DomainError('Unknown decision.');
      ai.decide(actor, id, status);
      ok(res, back(req).replace(/[?&]ai=\d+/, '').replace(/#ai$/, ''), status === 'copied' ? 'Recorded that you used the suggestion.' : 'Suggestion discarded.');
    }),
  );
};

export default register;
