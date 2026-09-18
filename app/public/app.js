// Progressive enhancement only — every action works without JavaScript.
(() => {
  'use strict';

  // Confirmation for consequential or hard-to-reverse submissions.
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    const message = form.dataset.confirm;
    if (message && !window.confirm(message)) {
      e.preventDefault();
      return;
    }
    // Guard against double submission (the server is idempotent, this just avoids confusion).
    const submitter = e.submitter;
    if (submitter && submitter.tagName === 'BUTTON') {
      window.setTimeout(() => {
        submitter.setAttribute('aria-disabled', 'true');
        submitter.dataset.label = submitter.textContent;
        submitter.textContent = 'Working…';
      }, 0);
      window.setTimeout(() => {
        submitter.removeAttribute('aria-disabled');
        if (submitter.dataset.label) submitter.textContent = submitter.dataset.label;
      }, 8000);
    }
  });

  // Copy an AI suggestion (or any block) to the clipboard.
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const source = document.getElementById(btn.dataset.copy);
    if (!source) return;
    try {
      await navigator.clipboard.writeText(source.innerText);
      const original = btn.textContent;
      btn.textContent = 'Copied';
      window.setTimeout(() => (btn.textContent = original), 1500);
    } catch {
      /* clipboard unavailable — the text is on screen to select manually */
    }
  });

  // Filter bars submit on change so lists feel immediate.
  for (const el of document.querySelectorAll('[data-autosubmit] select, [data-autosubmit] input[type="date"]')) {
    el.addEventListener('change', () => el.form && el.form.submit());
  }

  // Reveal dependent fieldsets (e.g. temporary-restoration detail) when an option needs them.
  const syncReveals = () => {
    for (const target of document.querySelectorAll('[data-show-when]')) {
      const [name, values] = target.dataset.showWhen.split(':');
      const field = document.querySelector(`[name="${name}"]`);
      if (!field) continue;
      const current = field.type === 'checkbox' ? (field.checked ? 'on' : '') : field.value;
      const show = values.split('|').includes(current);
      target.hidden = !show;
      for (const input of target.querySelectorAll('input, select, textarea')) {
        if (input.dataset.optional === 'true') continue;
        input.required = show && input.dataset.required === 'true';
      }
    }
  };
  document.addEventListener('change', syncReveals);
  syncReveals();

  // Keep the schedule board scrolled to the working day when it opens.
  const board = document.querySelector('[data-scroll-to]');
  if (board) {
    const target = Number(board.dataset.scrollTo);
    if (Number.isFinite(target)) board.scrollLeft = Math.max(0, target - 120);
  }
})();
