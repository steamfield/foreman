// Writes each logo option as a light and a dark SVG, plus variants.js for preview.html.
// Run: node design/logos/build.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SIGNAL = "#ff5b14";
const themes = {
  light: { ink: "#111311", paper: "#f1f2ee" },
  dark: { ink: "#e4e8e0", paper: "#121412" },
};

const svg = (viewBox, title, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="${title}">\n${body}\n</svg>\n`;

const chevron = (x, fill) =>
  `<path d="M${x} 6h4.5l7 10-7 10H${x}l7-10z" fill="${fill}"/>`;
const smallChevron = (x, fill) =>
  `<path d="M${x} 8h3.5l5.6 8-5.6 8H${x}l5.6-8z" fill="${fill}"/>`;
const stencilChevron = (x, fill) =>
  `<path d="M${x} 6h4.5l6.44 9.2h-4.5zM${+(x + 6.44).toFixed(2)} 16.8h4.5L${+(x + 4.5).toFixed(2)} 26H${x}z" fill="${fill}"/>`;
const tile = (fill) =>
  `<rect x="1" y="1" width="30" height="30" rx="7" fill="${fill}"/>`;

const logos = [
  {
    file: "06a-chevrons",
    name: "Chevrons",
    concept: "Chevrons",
    description:
      "The original: three chevrons moving right, the lead in signal orange pushing the two behind it.",
    draw: ({ ink }) =>
      `  ${chevron(3, SIGNAL)}\n  ${chevron(11, ink)}\n  ${chevron(19, ink)}`,
  },
  {
    file: "06b-chevrons-front",
    name: "Lead in front",
    concept: "Chevrons",
    description:
      "The orange chevron moves to the front, so the lead points the way and the crew follows. The orange lands where the eye ends up.",
    draw: ({ ink }) =>
      `  ${chevron(3, ink)}\n  ${chevron(11, ink)}\n  ${chevron(19, SIGNAL)}`,
  },
  {
    file: "06c-chevrons-tile",
    name: "Tile",
    concept: "Chevrons",
    description:
      "The chevrons inside a dark rounded tile, for app icons, avatars and the favicon, where a bare mark floats.",
    draw: ({ ink, paper }) =>
      `  ${tile(ink)}\n  ${smallChevron(5, SIGNAL)}\n  ${smallChevron(11.5, paper)}\n  ${smallChevron(18, paper)}`,
  },
  {
    file: "06d-chevrons-stencil",
    name: "Stencil",
    concept: "Chevrons",
    description:
      "Each chevron is cut at its point like a stencil, which links this family to Stencil F and gives it an equipment-marking feel.",
    draw: ({ ink }) =>
      `  ${stencilChevron(3, SIGNAL)}\n  ${stencilChevron(11, ink)}\n  ${stencilChevron(19, ink)}`,
  },
  {
    file: "05a-stencil-f",
    name: "Stencil F",
    concept: "Stencil F",
    description:
      "The original: a heavy orange stencil F whose bridges split it into separate parts that still read as one letter.",
    draw: () => `  <g fill="${SIGNAL}">
    <rect x="7" y="4" width="6.5" height="24" rx="0.5"/>
    <rect x="15.5" y="4" width="10.5" height="6.5" rx="0.5"/>
    <rect x="15.5" y="13.5" width="7.5" height="6" rx="0.5"/>
  </g>`,
  },
  {
    file: "05b-stencil-f-arrows",
    name: "Arrow arms",
    concept: "Stencil F",
    description:
      "The arms end in chevron points, so the F's pieces become two dispatches leaving the stem. It merges Stencil F with Chevrons.",
    draw: () => `  <g fill="${SIGNAL}">
    <rect x="7" y="4" width="6.5" height="24" rx="0.5"/>
    <path d="M15.5 4H23l3.25 3.25L23 10.5h-7.5z"/>
    <path d="M15.5 13.5H20l3 3-3 3h-4.5z"/>
  </g>`,
  },
  {
    file: "05c-stencil-f-tile",
    name: "Tile",
    concept: "Stencil F",
    description:
      "The stencil F in signal orange on a dark rounded tile, like a marking on a machine panel. The strongest favicon of this family.",
    draw: ({ ink }) => `  ${tile(ink)}
  <g fill="${SIGNAL}">
    <rect x="8.9" y="7" width="4.9" height="18" rx="0.4"/>
    <rect x="15.25" y="7" width="7.9" height="4.9" rx="0.4"/>
    <rect x="15.25" y="14.1" width="5.6" height="4.5" rx="0.4"/>
  </g>`,
  },
  {
    file: "05d-stencil-f-split",
    name: "Two-tone",
    concept: "Stencil F",
    description:
      "The stem in ink and the arms in orange: the lead holds the structure and hands out the parts. Uses orange more sparingly, as DESIGN.md asks.",
    draw: ({
      ink,
    }) => `  <rect x="7" y="4" width="6.5" height="24" rx="0.5" fill="${ink}"/>
  <g fill="${SIGNAL}">
    <rect x="15.5" y="4" width="10.5" height="6.5" rx="0.5"/>
    <rect x="15.5" y="13.5" width="7.5" height="6" rx="0.5"/>
  </g>`,
  },
  {
    file: "08a-gantry",
    name: "Gantry",
    concept: "Gantry",
    description:
      "The original: an orange beam held over three legs. A scaffold, a lead over a crew, and a blocky m.",
    draw: ({
      ink,
    }) => `  <rect x="3" y="5" width="26" height="6" rx="1" fill="${SIGNAL}"/>
  <g fill="${ink}">
    <rect x="4" y="14" width="5" height="14" rx="1"/>
    <rect x="13.5" y="14" width="5" height="14" rx="1"/>
    <rect x="23" y="14" width="5" height="14" rx="1"/>
  </g>`,
  },
  {
    file: "08b-gantry-runs",
    name: "Runs in progress",
    concept: "Gantry",
    description:
      "The legs hang to different lengths, like three runs at different stages under one supervisor. It adds movement to the static original.",
    draw: ({
      ink,
    }) => `  <rect x="3" y="5" width="26" height="6" rx="1" fill="${SIGNAL}"/>
  <g fill="${ink}">
    <rect x="4" y="14" width="5" height="14" rx="1"/>
    <rect x="13.5" y="14" width="5" height="8" rx="1"/>
    <rect x="23" y="14" width="5" height="11" rx="1"/>
  </g>`,
  },
  {
    file: "08c-gantry-tile",
    name: "Tile",
    concept: "Gantry",
    description:
      "The gantry inside a dark rounded tile, for app icons and the favicon.",
    draw: ({ ink, paper }) => `  ${tile(ink)}
  <rect x="7" y="8" width="18" height="4" rx="0.75" fill="${SIGNAL}"/>
  <g fill="${paper}">
    <rect x="7.5" y="14.5" width="3.5" height="9.5" rx="0.75"/>
    <rect x="14.25" y="14.5" width="3.5" height="9.5" rx="0.75"/>
    <rect x="21" y="14.5" width="3.5" height="9.5" rx="0.75"/>
  </g>`,
  },
  {
    file: "08d-gantry-slant",
    name: "Slanted legs",
    concept: "Gantry",
    description:
      "The legs lean forward like italic strokes, so the structure seems to be moving. This is the closest of the set to Linear's sense of motion.",
    draw: ({
      ink,
    }) => `  <rect x="3" y="5" width="26" height="6" rx="1" fill="${SIGNAL}"/>
  <g fill="${ink}">
    <path d="M7 14h5l-3 14H4z"/>
    <path d="M15.5 14h5l-3 14h-5z"/>
    <path d="M24 14h5l-3 14h-5z"/>
  </g>`,
  },
];

for (const logo of logos) {
  for (const [theme, colors] of Object.entries(themes)) {
    const suffix = theme === "dark" ? "-dark" : "";
    writeFileSync(
      join(here, `${logo.file}${suffix}.svg`),
      svg(
        logo.viewBox ?? "0 0 32 32",
        `forman: ${logo.name}`,
        logo.draw(colors),
      ),
    );
  }
}

const groups = [...new Set(logos.map((l) => l.concept))].map((concept) => ({
  name: concept,
  variants: logos
    .filter((l) => l.concept === concept)
    .map((l) => ({
      id: l.file.slice(0, 3),
      name: l.name,
      description: l.description,
      light: `${l.file}.svg`,
      dark: `${l.file}-dark.svg`,
    })),
}));
writeFileSync(
  join(here, "variants.js"),
  `window.VARIANTS = ${JSON.stringify({ projectName: "forman", brandName: "forman", concepts: groups }, null, 2)};\n`,
);
console.log(`wrote ${logos.length * 2} SVGs`);
