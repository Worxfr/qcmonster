import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  window.location.hash = '';
});

if (!URL.createObjectURL) {
  URL.createObjectURL = () => 'blob:test';
  URL.revokeObjectURL = () => undefined;
}

// jsdom plante sur getComputedStyle d'un element MathML (formules KaTeX): on retombe sur un style visible.
const realComputedStyle = window.getComputedStyle.bind(window);
window.getComputedStyle = ((el: Element, pseudo?: string | null) => {
  try {
    return realComputedStyle(el, pseudo);
  } catch {
    return realComputedStyle(document.documentElement);
  }
}) as typeof window.getComputedStyle;
