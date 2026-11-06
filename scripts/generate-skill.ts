import { writeFile } from "node:fs/promises";
import { skillText } from "../src/guide/skill";

await writeFile(new URL("../skills/foreman/SKILL.md", import.meta.url), skillText);
