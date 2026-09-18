import type { DB } from '../db/db.ts';
import { html, type SafeHtml } from '../lib/html.ts';
import { AI_TASKS, type AiTask } from '../ai/assistant.ts';
import { fmtDT } from '../lib/clock.ts';
import { can } from '../auth/policy.ts';
import { chip, csrfInput, type Ctx, textarea } from './ui.ts';

export interface Interaction {
  id: number;
  task: AiTask;
  entity_type: string;
  entity_id: number;
  provider: string;
  model: string | null;
  source_refs: string | null;
  output: string;
  status: string;
  created_at: string;
}

export function loadInteraction(db: DB, id: number, actorId: number): Interaction | null {
  return (db.prepare('SELECT * FROM ai_interactions WHERE id = ? AND actor_id = ?').get(id, actorId) as Interaction | undefined) ?? null;
}

/** Buttons that ask the assistant for help. They never change a record themselves. */
export function aiButtons(ctx: Ctx, o: { entity: 'job' | 'customer' | 'site' | 'asset' | 'attendance'; id: number; tasks: AiTask[]; back: string }): SafeHtml {
  if (!can(ctx.user, 'ai.use')) return html``;
  return html`<form method="post" action="/ai/suggest" class="aibuttons">
    ${csrfInput(ctx)}
    <input type="hidden" name="entity" value="${o.entity}">
    <input type="hidden" name="id" value="${String(o.id)}">
    <input type="hidden" name="__back" value="${o.back}">
    ${o.tasks.map((t) => html`<button class="btn small" type="submit" name="task" value="${t}">${AI_TASKS[t]}</button>`)}
  </form>`;
}

/**
 * Renders a suggestion as a suggestion: labelled, sourced, and inert. Applying it means
 * submitting a normal, permission-checked form that the person can edit first (AC-071-02).
 */
export function aiPanel(ctx: Ctx, o: { interaction: Interaction; jobId?: number; back: string; findings?: string[] }): SafeHtml {
  const i = o.interaction;
  const sources = (() => {
    try {
      return JSON.parse(i.source_refs ?? '[]') as { label: string; href: string }[];
    } catch {
      return [];
    }
  })();
  const applyable = o.jobId && (i.task === 'draft_customer_update' || i.task === 'summarise_history' || i.task === 'check_handoff');
  const noteKind = i.task === 'draft_customer_update' ? 'customer_update' : 'note';
  return html`<section class="ai" id="ai">
    <header>
      <h3>${AI_TASKS[i.task]}</h3>
      ${chip('AI suggestion — not a decision', 'info')}
      ${chip(i.provider === 'mock' ? 'deterministic assistant (no API key)' : `${i.provider}${i.model ? ` · ${i.model}` : ''}`, 'neutral')}
      <span class="tiny subtle">${fmtDT(i.created_at)}</span>
    </header>
    <div class="body">
      <div class="suggestion" id="aitext">${i.output}</div>
      ${sources.length ? html`<div class="sources">Built from: ${sources.map((s) => html`<a href="${s.href}">${s.label}</a>`)}</div>` : ''}
      <p class="note">
        Drafted from the records above. Check it before use — the assistant cannot authorise spend or liability, change SLA clocks, confirm a diagnosis or make safety decisions, and
        nothing is recorded against the job until you submit it yourself.
      </p>
      <div class="btnrow mt1">
        <button class="btn small" type="button" data-copy="aitext">Copy</button>
        <form method="post" action="/ai/decide" class="btnrow">
          ${csrfInput(ctx)}
          <input type="hidden" name="id" value="${String(i.id)}">
          <input type="hidden" name="__back" value="${o.back}">
          <button class="btn small" type="submit" name="status" value="copied">Mark as used</button>
          <button class="btn small danger" type="submit" name="status" value="rejected">Discard</button>
        </form>
      </div>
      ${
        applyable
          ? html`<details class="drawer mt2" open>
              <summary>Edit and save as ${noteKind === 'customer_update' ? 'a customer update' : 'a job note'}</summary>
              <div class="drawerbody">
                <form method="post" action="/jobs/${String(o.jobId)}/notes" class="stack">
                  ${csrfInput(ctx)}
                  <input type="hidden" name="kind" value="${noteKind}">
                  <input type="hidden" name="ai_interaction_id" value="${String(i.id)}">
                  <input type="hidden" name="__back" value="/jobs/${String(o.jobId)}">
                  ${textarea({ name: 'body', label: 'Your text (edit as needed — you are the author)', value: i.output, rows: 8, required: true })}
                  <div class="btnrow"><button class="btn primary" type="submit">Save to job</button></div>
                </form>
              </div>
            </details>`
          : ''
      }
    </div>
  </section>`;
}
