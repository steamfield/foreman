/**
 * The Astro content loader for the repository guide in ../docs/guide. It reads each `*.md`
 * file, derives its metadata with guide.ts and renders the Markdown with its h1 removed (the
 * docs layout renders the title) and its guide links rewritten to site routes, so a broken
 * guide link fails the build. In dev it reloads when a guide file changes.
 */
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Loader, LoaderContext } from "astro/loaders";
import { guideBody, guideData, guideId, guideMarkdown } from "./guide";

/** The guide source, relative to the site root. Subdirectories and other files are ignored. */
const GUIDE_DIR = "../docs/guide";

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Loads one guide file into the docs store.
 * @throws When the file has no h1, no summary, no sidebar place or a broken link, naming the file.
 */
async function loadGuideFile(context: LoaderContext, file: string) {
  const filePath = `${GUIDE_DIR}/${file}`;
  const fileURL = new URL(filePath, context.config.root);
  const source = readFileSync(fileURL, "utf8");
  const id = guideId(file);
  try {
    const data = await context.parseData({
      id,
      filePath,
      data: guideData(id, source),
    });
    const rendered = await context.renderMarkdown(
      guideMarkdown(guideBody(source)),
      { fileURL },
    );
    const digest = context.generateDigest(source);
    context.store.set({ id, data, body: source, filePath, digest, rendered });
  } catch (error) {
    throw new Error(`docs/guide/${file}: ${messageOf(error)}`, {
      cause: error,
    });
  }
}

/**
 * Every `*.md` file directly in the guide directory as a docs entry.
 * @throws From the build when any guide file fails to load (see loadGuideFile).
 */
export const repositoryGuide: Loader = {
  name: "repository-guide",
  load: async (context) => {
    const guideRoot = fileURLToPath(
      new URL(`${GUIDE_DIR}/`, context.config.root),
    );
    const reload = async () => {
      context.store.clear();
      for (const file of globSync("*.md", { cwd: guideRoot }))
        await loadGuideFile(context, file);
    };
    await reload();
    // Dev only: a broken edit is reported and the next save reloads again.
    context.watcher?.add(guideRoot);
    context.watcher?.on("all", (_event, path) => {
      if (!path.startsWith(guideRoot)) return;
      reload().catch((error: unknown) =>
        context.logger.error(messageOf(error)),
      );
    });
  },
};
