// Design tokens and the one inline stylesheet every page shares. The look
// follows brinibruni.com: warm paper, serif ink, monospace small-caps labels,
// one accent color, automatic dark mode.
import { cssColor, cssSafe } from './escape.js';

// WCAG relative luminance and contrast ratio, used by tests and by callers
// that want to warn about a custom theme.
function luminance(hex) {
  let digits = hex.slice(1);
  if (digits.length === 3) digits = [...digits].map((d) => d + d).join('');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(digits.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const tokens = (theme, suffix) =>
  ['paper', 'ink', 'muted', 'accent']
    .map((name) => `--${name}:${cssColor(theme[`${name}${suffix}`])};`)
    .join('');

export function themeCss(theme) {
  return cssSafe(
    [
      `:root{color-scheme:light dark;${tokens(theme, '')}}`,
      `@media (prefers-color-scheme:dark){:root{${tokens(theme, '_dark')}}}`,
      '*,*::before,*::after{box-sizing:border-box}',
      'html{-webkit-text-size-adjust:100%}',
      '@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}a{transition:color .15s}}',
      'body{margin:0;background:var(--paper);color:var(--ink);' +
        'font:1.0625rem/1.6 ui-serif,"Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;overflow-wrap:break-word}',
      '.wrap{max-width:44rem;margin:0 auto;padding:2rem 1rem 3rem}',
      'header{margin-bottom:2rem}',
      'h1,h2{font-weight:normal;line-height:1.2;margin:0 0 .5rem}',
      'h1{font-size:clamp(1.75rem,6vw,2.5rem)}',
      'h2{font-size:1.4rem;margin-top:2.5rem;padding-bottom:.25rem;border-bottom:1px solid var(--muted)}',
      'a{color:var(--accent);text-underline-offset:.15em}',
      'a:hover{color:var(--ink)}',
      'a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
      '.label,time,nav,footer{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;' +
        'font-variant:small-caps;letter-spacing:.04em;font-size:.875rem;color:var(--muted)}',
      '.label{margin:0 0 .5rem}',
      '.site{color:var(--ink);text-decoration:none;font-size:1.1rem}',
      '.intro{color:var(--muted);margin:.25rem 0 0}',
      'nav ul,.feed{list-style:none;margin:0;padding:0}',
      'nav ul{display:flex;flex-wrap:wrap;gap:.25rem 1rem}',
      '.feed li{margin:0}',
      '.feed a{display:flex;gap:.875rem;align-items:center;padding:.5rem 0;color:var(--ink);text-decoration:none}',
      '.feed a:hover .t{color:var(--accent)}',
      '.feed img{flex:none;width:3.5rem;height:3.5rem;object-fit:cover;border-radius:2px;background:var(--muted)}',
      '.feed .t{display:block}',
      'figure{margin:1.5rem 0}',
      'figure img{display:block;max-width:100%;height:auto;border-radius:2px}',
      '.caption{white-space:pre-line}',
      'footer{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--muted)}',
      'footer ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:.25rem 1rem}',
    ].join('\n'),
  );
}
