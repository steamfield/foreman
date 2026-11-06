import type { APIRoute } from "astro";
import satori from "satori";
import sharp from "sharp";
import { site } from "../../config";
import { hero } from "../../data/landing";
import { ogCard, ogFonts, ogLogo } from "../../lib/og";

// /og/index.webp: the social card every page uses (site.image).
export const GET: APIRoute = async () => {
  const card = {
    title: hero.title,
    description: hero.card,
    siteName: site.title,
  };
  const svg = await satori(ogCard(card, await ogLogo()) as never, {
    width: 1200,
    height: 630,
    fonts: await ogFonts(),
  });
  const webp = await sharp(Buffer.from(svg)).webp({ quality: 90 }).toBuffer();
  return new Response(new Uint8Array(webp), {
    headers: { "Content-Type": "image/webp" },
  });
};
