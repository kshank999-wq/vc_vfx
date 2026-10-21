import { beforeEach } from 'vitest';

/**
 * Renderer tests start as a returning user: the first-run tour (addendum 08)
 * is already dismissed. The tour's own tests clear this.
 */
beforeEach(() => {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem('vcvfx.tour.done', '1');
  } catch {
    // not a DOM test
  }
});
