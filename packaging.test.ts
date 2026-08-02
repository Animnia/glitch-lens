import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = dirname(fileURLToPath(import.meta.url));

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("pi package manifest", () => {
  it("declares extension and skill paths that exist", async () => {
    const pkg = await json(join(repoRoot, "package.json"));
    const pi = pkg.pi as { extensions?: string[]; skills?: string[] } | undefined;
    expect(pi, "package.json must declare a pi manifest").toBeTruthy();

    for (const entry of [...(pi?.extensions ?? []), ...(pi?.skills ?? [])]) {
      expect(existsSync(join(repoRoot, entry)), entry).toBe(true);
    }
    expect(pkg.keywords).toContain("pi-package");
  });

  it("ships the pi skill at the declared location with valid frontmatter", async () => {
    const source = await readFile(join(repoRoot, "pi", "skills", "glitch-lens", "SKILL.md"), "utf8");
    const frontmatter = source.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatter).toBeTruthy();
    expect(frontmatter?.[1]).toMatch(/^name:\s*glitch-lens\s*$/m);
    expect(frontmatter?.[1]).toMatch(/^description:\s*.+$/m);
  });
});

describe("hermes tap layout", () => {
  it("keeps the hermes skill at the tap default path skills/<name>/SKILL.md", async () => {
    const skillPath = join(repoRoot, "skills", "glitch-lens", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);

    const source = await readFile(skillPath, "utf8");
    const frontmatter = source.match(/^---\n([\s\S]*?)\n---/)?.[1];
    expect(frontmatter, "SKILL.md must start with frontmatter").toBeTruthy();

    const name = frontmatter?.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const description = frontmatter?.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    expect(name).toBe("glitch-lens");
    expect(description?.length).toBeGreaterThan(20);
    // hermes tap requirement: version plus metadata.hermes tags
    expect(frontmatter).toMatch(/^version:\s*\d+\.\d+\.\d+\s*$/m);
    expect(frontmatter).toMatch(/metadata:\s*\n\s+hermes:/);
    expect(frontmatter).toMatch(/tags:\s*\[.+\]/);
  });

  it("uses only documented hermes CLI commands in the hermes skill", async () => {
    const source = await readFile(join(repoRoot, "skills", "glitch-lens", "SKILL.md"), "utf8");
    const invocations = [...source.matchAll(/hermes (?:chat|config|skills)[^\n`]*/g)].map((match) => match[0]);
    expect(invocations.length).toBeGreaterThan(0);
    for (const invocation of invocations) {
      expect(invocation).toMatch(/^hermes (chat -q|config show)/);
    }
  });
});
