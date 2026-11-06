// Renders the raster half of the brand pack from the SVGs in public/brand/: WebP icons
// at the sizes browsers, home screens and app stores ask for, the marks and lockups, a
// GitHub social preview and a standalone social card. Run `make brand` after changing an SVG.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import satori from "satori";
import sharp from "sharp";
import { site } from "../src/config";
import { hero } from "../src/data/landing";
import { ogCard, ogFonts, ogLogo } from "../src/lib/og";

const dir = join(process.cwd(), "public/brand");
const svg = (name: string) => readFile(join(dir, `${name}.svg`));
const written: string[] = [];

async function render(
  name: string,
  out: string,
  size: { width?: number; height?: number },
) {
  // A high density keeps the chevron points sharp before the downscale.
  await sharp(await svg(name), { density: 2400 })
    .resize(size)
    .webp({ quality: 92, alphaQuality: 100 })
    .toFile(join(dir, out));
  written.push(out);
}

// The tile: favicon fallbacks, apple-touch-icon (180), manifest (192, 512), store-size (1024).
for (const px of [16, 32, 48, 64, 128, 180, 192, 256, 512, 1024]) {
  await render("foreman-icon", `foreman-icon-${px}.webp`, {
    width: px,
    height: px,
  });
}
for (const tone of ["dark", "light"]) {
  await render(`foreman-mark-${tone}`, `foreman-mark-${tone}-512.webp`, {
    height: 512,
  });
  await render(`foreman-lockup-${tone}`, `foreman-lockup-${tone}-1200.webp`, {
    width: 1200,
  });
  await render(
    `foreman-lockup-stacked-${tone}`,
    `foreman-lockup-stacked-${tone}-800.webp`,
    { height: 800 },
  );
}

// Social cards: the landing page's card, standalone, and GitHub's 1280x640 social preview.
const card = {
  title: hero.title,
  description: hero.card,
  siteName: site.title,
};
const logo = await ogLogo();
const fonts = await ogFonts();
for (const [out, width, height] of [
  ["foreman-og-1200x630.webp", 1200, 630],
  ["foreman-social-1280x640.webp", 1280, 640],
] as const) {
  const drawn = await satori(ogCard(card, logo) as never, {
    width,
    height,
    fonts,
  });
  await sharp(Buffer.from(drawn)).webp({ quality: 90 }).toFile(join(dir, out));
  written.push(out);
}

// The web app manifest points at the tile renders above.
const manifest = {
  name: "foreman",
  short_name: "foreman",
  description: hero.title,
  start_url: "/",
  display: "browser",
  background_color: "#f1f2ee",
  theme_color: "#f1f2ee",
  icons: [192, 512].map((px) => ({
    src: `/brand/foreman-icon-${px}.webp`,
    sizes: `${px}x${px}`,
    type: "image/webp",
  })),
};
await writeFile(
  join(process.cwd(), "public/site.webmanifest"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
written.push("../site.webmanifest");

console.log(
  `brand: wrote ${written.length} files to public/brand/\n  ${written.join("\n  ")}`,
);
