import { state } from './state.js';
import { el } from './dom.js';
import type { ReactQualityLevel } from './react-detect.js';

// Storage key for "shown once" behavior.
const SHOWN_KEY = 'vibeflow-react-quality-shown';

export function hasShownQualityModal(): boolean {
  try { return !!localStorage.getItem(SHOWN_KEY); } catch { return false; }
}

export function markQualityModalShown(): void {
  try { localStorage.setItem(SHOWN_KEY, '1'); } catch { /* ignore */ }
}

/**
 * Shows the React quality educational modal (option C).
 * Explains the 3 annotation context quality levels and how to improve them.
 * Marks as shown so it only auto-appears once.
 */
export function showReactQualityModal(quality: ReactQualityLevel): void {
  if (!state.root) return;
  closeReactQualityModal();
  markQualityModalShown();

  const levels = [
    {
      icon: '🟢',
      label: 'Full context',
      color: '#4ade80',
      desc: 'React dev mode + source maps. Component name + source file + line.',
      active: quality === 'full',
    },
    {
      icon: '🟡',
      label: 'Partial',
      color: '#fbbf24',
      desc: 'React dev mode, but no debug stack found. Component name only.',
      active: quality === 'partial',
    },
    {
      icon: '🔴',
      label: 'No context',
      color: '#f87171',
      desc: 'Production build. DOM selectors only — no component or source info.',
      active: quality === 'none',
    },
  ];

  // Level cards row
  const levelCards = levels.map(lv => {
    const card = el('div', {
      className: 'rq-level' + (lv.active ? ' rq-level--active' : ''),
    });
    card.appendChild(el('div', { className: 'rq-level-icon' }, lv.icon));
    card.appendChild(Object.assign(el('div', { className: 'rq-level-label' }, lv.label), { style: `color:${lv.color}` }));
    card.appendChild(el('div', { className: 'rq-level-desc' }, lv.desc));
    return card;
  });

  const levelRow = el('div', { className: 'rq-levels' }, ...levelCards);

  // Current status heading
  const currentLabel: Record<ReactQualityLevel, string> = {
    full: 'You have full context',
    partial: 'You have partial context',
    none: 'No React context available',
    'not-react': 'React not detected',
  };
  const heading = el('div', { className: 'rq-heading' }, currentLabel[quality] ?? 'React context');

  // Feature rows
  const features = buildFeatureRows(quality);

  // Modal structure
  const header = el('div', { className: 'rq-header' }, heading, levelRow);
  const body = el('div', { className: 'rq-body' }, ...features);
  const closeBtn = el('button', { className: 'rq-close', title: 'Close', 'aria-label': 'Close' }, '✕');

  const btnContinue = el('button', { className: 'rq-btn rq-btn-secondary' }, 'Continue annotating');
  const footer = el('div', { className: 'rq-footer' }, btnContinue);

  const modal = el('div', { className: 'vibeflow-rq-modal', id: 'vibeflow-rq-modal' },
    closeBtn, header, body, footer
  );

  const overlay = el('div', { className: 'vibeflow-rq-overlay', id: 'vibeflow-rq-overlay' }, modal);

  function close() { overlay.remove(); }
  closeBtn.addEventListener('click', close);
  btnContinue.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  state.root.appendChild(overlay);
}

export function closeReactQualityModal(): void {
  state.root?.querySelector('#vibeflow-rq-overlay')?.remove();
}

function featureRow(icon: string, text: string, detail: string): HTMLElement {
  const row = el('div', { className: 'rq-feature' });
  row.appendChild(el('span', { className: 'rq-feature-icon' }, icon));
  const textEl = el('div', { className: 'rq-feature-text' });
  textEl.appendChild(el('strong', null, text));
  textEl.appendChild(el('span', null, ' — ' + detail));
  row.appendChild(textEl);
  return row;
}

function codeBlock(code: string): HTMLElement {
  const pre = el('pre', { className: 'rq-codeblock' });
  pre.appendChild(el('code', null, code));
  return pre;
}

function sectionTitle(title: string): HTMLElement {
  return el('div', { className: 'rq-section-title' }, title);
}

function buildFeatureRows(quality: ReactQualityLevel): HTMLElement[] {
  const rows: HTMLElement[] = [];

  rows.push(sectionTitle('What is captured now'));

  rows.push(featureRow('✅', 'CSS selector', 'always available — stable element targeting'));

  if (quality === 'full') {
    rows.push(featureRow('✅', 'Component name', 'from React fiber (_debugOwner)'));
    rows.push(featureRow('✅', 'Source file + line', 'resolved via source maps (React 18.3+ _debugStack or legacy _debugSource)'));
    rows.push(el('div', { className: 'rq-note rq-note--success' },
      'You have the best possible context. Your agent receives component name, source file, and line number for each annotation.'
    ));
    return rows;
  }

  if (quality === 'partial') {
    rows.push(featureRow('✅', 'Component name', 'from React fiber (_debugOwner)'));
    rows.push(featureRow('❌', 'Source file + line', 'no debug stack found on React fibers'));
    rows.push(sectionTitle('How to get source file + line'));
    rows.push(el('div', { className: 'rq-note rq-note--amber' },
      'Source file resolution requires React dev mode with debug stacks (_debugStack / _debugSource) ' +
      'and source maps served by your bundler. Both are enabled by default when running in development mode.'
    ));
    rows.push(codeBlock('# Next.js\nnext dev   (or: npm run dev)\n\n# Vite\nnpm run dev   (NODE_ENV=development)\n\n# Ensure source maps are not disabled in your config'));
    rows.push(el('div', { className: 'rq-note' },
      'No Babel plugins or additional setup needed — source maps shipped by your dev server are sufficient.'
    ));
  }

  if (quality === 'none') {
    rows.push(featureRow('❌', 'Component name', 'not available — production build strips React dev info'));
    rows.push(featureRow('❌', 'Source file + line', 'not available — requires dev mode with source maps'));
    rows.push(sectionTitle('How to fix'));
    rows.push(el('div', { className: 'rq-note rq-note--amber' },
      'Restart your app in development mode:'
    ));
    rows.push(codeBlock('# Next.js\nnext dev   (or: npm run dev)\n\n# Vite\nnpm run dev   (NODE_ENV=development)'));
    rows.push(el('div', { className: 'rq-note' },
      'Dev mode enables React debug stacks (_debugStack) and source maps. ' +
      'No Babel plugins or extra config required — file + line are resolved automatically via source maps.'
    ));
  }

  return rows;
}
