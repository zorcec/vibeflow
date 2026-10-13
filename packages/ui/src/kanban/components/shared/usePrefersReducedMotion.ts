import React from 'react';

/**
 * Live OS-level `prefers-reduced-motion` signal.
 *
 * The activity feed gates its enter/flash animations on this in JS (rather
 * than a CSS-only media query) so component tests can assert the reduced
 * path by mocking `window.matchMedia`. The keyframes in `kanban.css` carry
 * a matching `@media (prefers-reduced-motion: reduce)` kill-switch as
 * belt-and-braces for any caller that applies the classes directly.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState<boolean>(() => {
    if (
      typeof window === 'undefined' ||
      typeof window.matchMedia !== 'function'
    ) {
      return false;
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  React.useEffect(() => {
    if (
      typeof window === 'undefined' ||
      typeof window.matchMedia !== 'function'
    ) {
      return;
    }
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
