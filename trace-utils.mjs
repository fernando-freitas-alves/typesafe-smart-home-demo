// Diagnostics are data, never authorization. Keep usage counts such as
// input_tokens, while removing credential fields and known runtime secrets.
export function redactDiagnostics(value, secrets = []) {
  const hidden = secrets.filter(secret => typeof secret === 'string' && secret.length >= 8);
  const credential = /^(?:authorization|proxy[-_]authorization|cookie|set[-_]cookie|(?:x[-_])?api[-_]?key|access[-_]?token|refresh[-_]?token|ha[-_]?token|bridge[-_]?token|password|secret|client[-_]?secret)$/i;
  function clean(item, key = '') {
    if (credential.test(key)) return '[redacted]';
    if (typeof item === 'string') {
      let text = item;
      for (const secret of hidden) text = text.replaceAll(secret, '[redacted]');
      return text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]').replace(/\bsk-ant-[A-Za-z0-9_-]+/g, '[redacted]');
    }
    if (Array.isArray(item)) return item.map(value => clean(value));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([name, value]) => [name, clean(value, name)]));
    return item;
  }
  return clean(value);
}

export function diagnosticError(message, diagnostics) {
  const error = new Error(message); error.diagnostics = { ...diagnostics, error: message }; return error;
}
