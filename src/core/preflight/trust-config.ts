// A reader for Codex's trust tables, not a general TOML parser. Unrelated
// settings may use single-line strings, booleans, decimal integers or flat arrays.
// Unsupported syntax and ambiguous trust entries fail closed.
const quoted = String.raw`"(?:[^"\\\x00-\x1f\x7f]|\\(?:["\\bfnrt]|u[0-9a-fA-F]{4}))*"`;
const trustHeader = new RegExp(`^\\[(projects|hooks\\.state)\\.(${quoted})\\]\\s*(?:#.*)?$`);
const stringSetting = new RegExp(`^([A-Za-z0-9_-]+)\\s*=\\s*(${quoted})\\s*(?:#.*)?$`);
const literal = "'[^'\\x00-\\x1f\\x7f]*'";
const key = `(?:[A-Za-z0-9_-]+|${quoted}|${literal})`;
const otherHeader = new RegExp(`^\\[${key}(?:\\s*\\.\\s*${key})*\\]\\s*(?:#.*)?$`);
const scalar = `(?:${quoted}|${literal}|true|false|[+-]?(?:0|[1-9](?:_?[0-9])*))`;
const array = `\\[\\s*(?:${scalar}(?:\\s*,\\s*${scalar})*\\s*,?)?\\s*\\]`;
const otherSetting = new RegExp(`^${key}\\s*=\\s*(?:${scalar}|${array})\\s*(?:#.*)?$`);

export function readTrustConfig(text: string): Map<string, Map<string, string>> {
  const tables = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    const invalid = () => new Error(`config.toml has unreadable trust syntax at line ${index + 1}`);
    if (line === "" || line.startsWith("#")) continue;
    if (line.includes('"""') || line.includes("'''")) throw invalid();
    const header = trustHeader.exec(line);
    if (header?.[1] !== undefined && header[2] !== undefined) {
      const name: unknown = JSON.parse(header[2]);
      if (typeof name !== "string") throw invalid();
      const tableKey = `${header[1]}:${name}`;
      if (tables.has(tableKey)) throw invalid();
      current = new Map();
      tables.set(tableKey, current);
      continue;
    }
    if (line.startsWith("[")) {
      const parent = /^\[(?:projects|hooks|hooks\.state)\]\s*(?:#.*)?$/.test(line);
      if (!otherHeader.test(line) || (!parent && /^\[\s*(?:projects|hooks)(?:\W|$)/.test(line)))
        throw invalid();
      current = undefined;
      continue;
    }
    if (!otherSetting.test(line)) throw invalid();
    if (current === undefined) continue;
    const setting = stringSetting.exec(line);
    if (setting?.[1] === undefined || setting[2] === undefined) throw invalid();
    if (current.has(setting[1])) throw invalid();
    const value: unknown = JSON.parse(setting[2]);
    if (typeof value !== "string") throw invalid();
    current.set(setting[1], value);
  }
  return tables;
}
