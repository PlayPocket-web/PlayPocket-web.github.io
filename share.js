(function () {
  const prefix = 'PLAYPOCKET_SHARE_V1:';
  const maxCodeBytes = 500 * 1024;

  function encode(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function decode(value) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const binary = atob(padded);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0))));
  }

  function createCode(payload) {
    const code = `${prefix}${encode(payload)}`;
    if (new Blob([code]).size > maxCodeBytes) throw new Error('share-code-too-large');
    return code;
  }

  function parseCode(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text.startsWith(prefix) || new Blob([text]).size > maxCodeBytes) throw new Error('invalid-share-code');
    return decode(text.slice(prefix.length));
  }

  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {}
    const field = document.createElement('textarea');
    field.value = value;
    field.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(field);
    field.select();
    const copied = document.execCommand('copy');
    field.remove();
    if (!copied) throw new Error('copy-failed');
  }

  window.PlayPocketShare = { createCode, parseCode, copyText };
}());
