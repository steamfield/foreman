export const secretKey = /secret|password|token|authorization|cookie|api[_-]?key|access[_-]?key/i;

export function redactDiagnosticText(text: string): string {
  return text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[redacted]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g,
      "[redacted]",
    )
    .replace(
      /(?<![\w.-])(["']?)([A-Za-z_][\w.-]*)\1(\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/g,
      (match, keyQuote: string, key: string, separator: string, value: string) => {
        if (!secretKey.test(key)) return match;
        const quote = value[0];
        const replacement =
          quote === '"' || quote === "'" ? `${quote}[redacted]${quote}` : "[redacted]";
        return `${keyQuote}${key}${keyQuote}${separator}${replacement}`;
      },
    )
    .replace(/(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/_-])/g, (value) =>
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value) ? value : "[redacted]",
    );
}
