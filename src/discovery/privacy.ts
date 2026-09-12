/** Known-value protection, not arbitrary PII detection. Decode only for detection, never execution. */
export function createSecretGuard(values: readonly string[]) {
  // An ambiguous 2,000-character goal can contain more than 100 candidate member IDs.
  if (values.length > 500 || values.some((value) => typeof value !== 'string' || value.length > 4096)
    || values.reduce((size, value) => size + value.length, 0) > 16_384) throw new Error('Invalid sensitive values.');
  const forms = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const bytes = Buffer.from(value);
    const unicode = value.split('').map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    for (const variant of [value, bytes.toString('utf8'), bytes.toString('base64'), bytes.toString('base64url'),
      bytes.toString('hex'), bytes.toString('hex').toUpperCase(), encodeURIComponent(bytes.toString('utf8')),
      new URLSearchParams({ v: value }).toString().slice(2), unicode]) {
      forms.add(variant);
      forms.add(JSON.stringify(variant).slice(1, -1));
    }
  }
  const contains = (text: string): boolean => {
    for (const formEncoded of [false, true]) {
      let current = text;
      for (let depth = 0; depth < 8; depth++) {
        if ([...forms].some((secret) => current.includes(secret))) return true;
        const form = formEncoded ? current.replaceAll('+', ' ') : current;
        const url = form.replace(/(?:%[0-9a-f]{2})+/gi, (encoded) => {
          try { return decodeURIComponent(encoded); } catch { return encoded; }
        });
        const decoded = url.replace(/\\(?:u[0-9a-f]{4}|["\\/bfnrt])/gi, (encoded) => {
          try { return JSON.parse(`"${encoded}"`) as string; } catch { return encoded; }
        });
        if (decoded === current) break;
        current = decoded;
      }
      if ([...forms].some((secret) => current.includes(secret))) return true;
    }
    return false;
  };
  return { contains, redact: (text: string) => contains(text) ? '[REDACTED]' : text };
}
