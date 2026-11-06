import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GET } from "../src/pages/llms.txt";
import {
  commands,
  exitCodes,
  guardrails,
  install,
  waitOutcomes,
} from "../src/data/landing";

const readme = readFileSync("../README.md", "utf8");
const normalize = (text: string) =>
  text.replaceAll("`", "").replace(/\s+/g, " ").trim();

function readTable(header: string, source = readme) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) =>
    normalize(line).startsWith(`| ${header} |`),
  );
  expect(start, `README table: ${header}`).toBeGreaterThanOrEqual(0);
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    rows.push(line.split("|").slice(1, -1).map(normalize));
  }
  return rows;
}

function codexVersion(text: string) {
  return normalize(text)
    .replaceAll("**", "")
    .match(/Codex (?:CLI )?(\d+\.\d+\.\d+)/)?.[1];
}

// The README's Install section names the Codex version foreman is checked against.
const installation = readme.split("## Install\n")[1]?.split("\n## ")[0] ?? "";

describe("landing copy agrees with the repository README", () => {
  it("keeps the llms command reference aligned with README without claiming to replay recordings", async () => {
    const text = await GET().text();
    expect(readTable("Command", text)).toEqual(readTable("Command"));
    expect(text).toContain(commands.lede);
    expect(text).not.toContain(commands.recorded);
  });

  it("compares the Codex version through Markdown and line-wrap changes", () => {
    const version = codexVersion(installation);
    expect(version).toBeDefined();
    const formatted = installation.replace(
      /(Codex) \*\*(\d+\.\d+\.\d+)\*\*/,
      "$1\n`$2`",
    );
    expect(formatted).not.toBe(installation);
    expect(codexVersion(formatted)).toBe(version);
  });

  it("matches every exit code and meaning, with no omitted README rows", () => {
    expect(exitCodes.map((row) => row.map(normalize))).toEqual(
      readTable("Code"),
    );
  });

  it("matches every wait outcome and meaning, with no omitted README rows", () => {
    expect(waitOutcomes.map((row) => row.map(normalize))).toEqual(
      readTable("Outcome"),
    );
  });

  it.each(install.options)(
    "documents the $id install command",
    ({ command }) => {
      expect(normalize(readme)).toContain(normalize(command));
    },
  );

  it("uses the Codex version from the README Install section", () => {
    const documentedVersion = codexVersion(installation);
    const pageVersion = codexVersion(install.requirements.join("\n"));
    expect(documentedVersion).toBeDefined();
    expect(pageVersion).toBe(documentedVersion);
  });

  it("quotes the README's budget, question timeout and private-state mode", () => {
    const page = normalize(guardrails.rows.map((row) => row[1]).join(" "));
    const source = normalize(readme);
    const budget = page.match(/budget defaults to (.+?)\./)?.[1];
    const timeout = page.match(/question times out after (.+?) and Codex/)?.[1];
    const mode = page.match(/mode (\d{4})/)?.[1];
    expect(budget).toBeDefined();
    expect(timeout).toBeDefined();
    expect(mode).toBeDefined();
    expect(source).toContain(`--budget defaults to ${budget} per working turn`);
    expect(source).toContain(`after ${timeout} by default`);
    expect(source).toContain(`mode ${mode}`);
  });
});
