// Every piece of caption or config text reaches HTML through these functions.

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Safe in text content and in double- or single-quoted attribute values.
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

// Only absolute https URLs become links; anything else (javascript:, data:,
// relative paths) is refused. Returns the escaped URL or null.
export function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' ? escapeHtml(url.href) : null;
  } catch {
    return null;
  }
}

// Config validation already enforces this; checking again keeps the CSS
// context safe even if a caller skips validation.
const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
export function cssColor(value) {
  if (!COLOR.test(String(value))) throw new Error(`Refusing unsafe CSS color ${JSON.stringify(value)}.`);
  return String(value).toLowerCase();
}

// Text inside <style> must not be able to close the element.
export function cssSafe(text) {
  if (/<\/style/i.test(text)) throw new Error('Refusing CSS that closes the style element.');
  return text;
}
