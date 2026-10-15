import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import picomatch from 'picomatch';

/**
 * Skills say HOW. They are owned centrally (this folder, not the reviewed repo) and use the
 * Agent Skills layout: skills/<name>/SKILL.md with YAML frontmatter.
 * `metadata.paths` decides which changed files load the skill, so a TypeScript PR never
 * carries the Terraform checklist. `metadata.version` is pinned in the review record.
 */
export interface Skill {
  name: string;
  description: string;
  version: string;
  owner: string;
  paths: string[];
  /** Load only when the project depends on one of these packages (e.g. ["next"]). Empty = always. */
  requires: string[];
  body: string;
}

export function loadSkills(dir: string, disabled: string[] = []): Skill[] {
  if (!fs.existsSync(dir)) return [];
  const skills: Skill[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name, 'SKILL.md');
    if (!fs.existsSync(file) || disabled.includes(name)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    const fm = m ? (YAML.parse(m[1]) ?? {}) : {};
    const meta = fm.metadata ?? {};
    skills.push({
      name: fm.name ?? name,
      description: fm.description ?? '',
      version: String(meta.version ?? '0'),
      owner: String(meta.owner ?? 'platform'),
      paths: Array.isArray(meta.paths) ? meta.paths : ['**'],
      requires: Array.isArray(meta.requires) ? meta.requires : [],
      body: (m ? m[2] : raw).trim(),
    });
  }
  return skills;
}

/** Drops framework skills the project does not use (deps from the base branch's package.json). */
export function skillsForProject(skills: Skill[], deps: Set<string>): Skill[] {
  return skills.filter((s) => !s.requires.length || s.requires.some((d) => deps.has(d)));
}

export function skillsForFile(skills: Skill[], filePath: string): Skill[] {
  return skills.filter((s) => picomatch.isMatch(filePath, s.paths, { dot: true }));
}
