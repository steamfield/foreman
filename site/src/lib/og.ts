// The landing page's social card, rendered by satori. satori lays out flexbox only
// (no grid) and reads TTF, OTF or WOFF fonts, never WOFF2, so the card uses the static
// Archivo package rather than the variable one the page loads.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

export type Card = { title: string; description: string; siteName: string };
/** The brand lockup as a data URI with the size it draws at on the card. */
export type Logo = { src: string; width: number; height: number };
type Node = {
  type: string;
  props: { style?: Record<string, unknown>; children?: unknown };
};

const div = (style: Record<string, unknown>, children: unknown): Node => ({
  type: "div",
  props: { style, children },
});

/** Clips text to `max` characters on a word boundary so long text never overflows the card. */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > 0 ? cut.slice(0, space) : cut}…`;
}

// Colors are the console tokens from DESIGN.md (satori cannot read CSS variables).
export function ogCard(
  { title, description, siteName }: Card,
  logo: Logo,
): Node {
  return div(
    {
      width: "100%",
      height: "100%",
      // Without it the padding is added to the canvas size and the text runs off the card.
      boxSizing: "border-box",
      display: "flex",
      flexDirection: "column",
      justifyContent: "space-between",
      padding: "72px",
      background: "#121412",
      color: "#e4e8e0",
      fontFamily: "Archivo",
    },
    [
      {
        type: "img",
        props: {
          src: logo.src,
          alt: siteName,
          width: logo.width,
          height: logo.height,
        },
      },
      div({ display: "flex", flexDirection: "column", gap: "24px" }, [
        div(
          { fontSize: 68, fontWeight: 700, lineHeight: 1.1 },
          clip(title, 80),
        ),
        div(
          { fontSize: 30, color: "#9aa294", lineHeight: 1.4 },
          clip(description, 160),
        ),
      ]),
    ],
  );
}

/**
 * The dark horizontal lockup from public/brand/, sized from its viewBox to `height`.
 * Read from the project root: the build bundles this module, so import.meta.url moves.
 */
export async function ogLogo(height = 64): Promise<Logo> {
  const svg = await readFile(
    join(process.cwd(), "public/brand/foreman-lockup-dark.svg"),
  );
  const box = /viewBox="[\d.]+ [\d.]+ ([\d.]+) ([\d.]+)"/.exec(svg.toString());
  if (!box) throw new Error("foreman-lockup-dark.svg is missing its viewBox");
  return {
    src: `data:image/svg+xml;base64,${svg.toString("base64")}`,
    width: Math.round((Number(box[1]) / Number(box[2])) * height),
    height,
  };
}

/** Archivo from the installed @fontsource package, read at build time; nothing is fetched. */
export async function ogFonts() {
  const require = createRequire(import.meta.url);
  const load = (weight: 400 | 700) =>
    readFile(
      require.resolve(
        `@fontsource/archivo/files/archivo-latin-${weight}-normal.woff`,
      ),
    );
  const [regular, bold] = await Promise.all([load(400), load(700)]);
  return [
    {
      name: "Archivo",
      data: regular,
      weight: 400 as const,
      style: "normal" as const,
    },
    {
      name: "Archivo",
      data: bold,
      weight: 700 as const,
      style: "normal" as const,
    },
  ];
}
