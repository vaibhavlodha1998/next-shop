import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import picomatch from 'picomatch';

/**
 * Deterministic project scan: no model calls. Reads the checked-out default branch
 * and works out the stack, frameworks, layout and the modules worth summarising.
 */

export interface Module {
  /** Directory prefix, e.g. "src/app/api" ("." for the repo root). */
  dir: string;
  globs: string[];
  files: string[];
}

export interface ScanResult {
  root: string;
  fileCount: number;
  languages: { name: string; files: number }[];
  packageManager: string | null;
  frameworks: string[];
  deps: Record<string, string>;
  facts: string[];
  lintConfigs: string[];
  readme: string;
  modules: Module[];
}

const CODE_EXT: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript (TSX)', '.js': 'JavaScript', '.jsx': 'JavaScript (JSX)', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.java': 'Java', '.kt': 'Kotlin', '.kts': 'Kotlin script', '.go': 'Go', '.rb': 'Ruby', '.php': 'PHP', '.cs': 'C#',
  '.rs': 'Rust', '.swift': 'Swift', '.scala': 'Scala', '.sql': 'SQL', '.vue': 'Vue', '.svelte': 'Svelte', '.css': 'CSS', '.scss': 'SCSS',
  '.tf': 'Terraform', '.prisma': 'Prisma schema', '.graphql': 'GraphQL', '.proto': 'Protobuf',
};
const NON_CODE = new Set(['CSS', 'SCSS']);

const FRAMEWORKS: [string, string][] = [
  ['next', 'Next.js'], ['react', 'React'], ['express', 'Express'], ['fastify', 'Fastify'], ['@nestjs/core', 'NestJS'], ['hono', 'Hono'],
  ['@remix-run/react', 'Remix'], ['vue', 'Vue'], ['nuxt', 'Nuxt'], ['svelte', 'Svelte'], ['@angular/core', 'Angular'],
  ['prisma', 'Prisma'], ['@prisma/client', 'Prisma'], ['drizzle-orm', 'Drizzle ORM'], ['mongoose', 'Mongoose'], ['typeorm', 'TypeORM'], ['sequelize', 'Sequelize'],
  ['tailwindcss', 'Tailwind CSS'], ['zod', 'Zod'], ['next-auth', 'Auth.js (next-auth)'], ['@auth/core', 'Auth.js'], ['iron-session', 'iron-session'], ['@clerk/nextjs', 'Clerk'],
  ['@trpc/server', 'tRPC'], ['@tanstack/react-query', 'TanStack Query'], ['swr', 'SWR'], ['redux', 'Redux'], ['@reduxjs/toolkit', 'Redux Toolkit'], ['zustand', 'Zustand'],
  ['jest', 'Jest'], ['vitest', 'Vitest'], ['@playwright/test', 'Playwright'], ['cypress', 'Cypress'], ['@testing-library/react', 'Testing Library'],
  ['server-only', 'server-only'], ['@mastra/core', 'Mastra'], ['ai', 'Vercel AI SDK'], ['stripe', 'Stripe'],
];

const LINT_FILES = [
  'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json',
  '.prettierrc', '.prettierrc.json', '.prettierrc.js', 'prettier.config.js', 'prettier.config.mjs', 'biome.json', 'biome.jsonc', '.editorconfig',
  'detekt.yml', 'config/detekt/detekt.yml', 'checkstyle.xml', 'config/checkstyle/checkstyle.xml', '.golangci.yml', 'ruff.toml', '.flake8', 'pyproject.toml',
];

const ALWAYS_SKIP = ['**/node_modules/**', '.git/**', '**/.next/**', '**/dist/**', '**/build/**', '**/out/**', '**/coverage/**', '.ai-review/**', '**/target/**', '**/.gradle/**'];

export function listFiles(root: string, excludeGlobs: string[]): string[] {
  const skip = picomatch([...ALWAYS_SKIP, ...excludeGlobs], { dot: true });
  let files: string[];
  const git = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  if (git.status === 0 && git.stdout) files = git.stdout.split('\0').filter(Boolean);
  else files = walk(root, '');
  return files.filter((f) => !skip(f) && fs.existsSync(path.join(root, f))).sort();
}

function walk(root: string, rel: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (['node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', 'target', '.gradle'].includes(e.name)) continue;
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(root, p));
    else out.push(p);
  }
  return out;
}

const read = (root: string, f: string, max = 200_000) => {
  try {
    const p = path.join(root, f);
    if (!fs.existsSync(p) || fs.statSync(p).size > max) return '';
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

export const isCode = (f: string) => {
  const lang = CODE_EXT[path.extname(f)];
  return Boolean(lang && !NON_CODE.has(lang));
};

export function scanProject(root: string, excludeGlobs: string[]): ScanResult {
  const files = listFiles(root, excludeGlobs);
  const facts: string[] = [];

  // Languages
  const langCount = new Map<string, number>();
  for (const f of files) {
    const l = CODE_EXT[path.extname(f)];
    if (l) langCount.set(l, (langCount.get(l) ?? 0) + 1);
  }
  const languages = [...langCount.entries()].map(([name, n]) => ({ name, files: n })).sort((a, b) => b.files - a.files);

  // JS/TS packages
  const pkg = safeJson(read(root, 'package.json'));
  const deps: Record<string, string> = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const packageManager = fs.existsSync(path.join(root, 'pnpm-lock.yaml')) ? 'pnpm'
    : fs.existsSync(path.join(root, 'yarn.lock')) ? 'yarn'
    : fs.existsSync(path.join(root, 'bun.lockb')) || fs.existsSync(path.join(root, 'bun.lock')) ? 'bun'
    : fs.existsSync(path.join(root, 'package-lock.json')) ? 'npm'
    : fs.existsSync(path.join(root, 'pom.xml')) ? 'maven'
    : files.some((f) => /(^|\/)build\.gradle(\.kts)?$/.test(f)) ? 'gradle'
    : fs.existsSync(path.join(root, 'pyproject.toml')) ? 'python (pyproject)' : null;

  const frameworks = [...new Set(FRAMEWORKS.filter(([d]) => d in deps).map(([d, n]) => `${n} ${clean(deps[d])}`.trim()))];

  // JVM / Python frameworks from build files
  const buildText = ['pom.xml', 'build.gradle', 'build.gradle.kts', 'pyproject.toml', 'requirements.txt'].map((f) => read(root, f)).join('\n');
  for (const [re, name] of [[/spring-boot/, 'Spring Boot'], [/io\.ktor/, 'Ktor'], [/micronaut/, 'Micronaut'], [/quarkus/, 'Quarkus'], [/django/i, 'Django'], [/fastapi/i, 'FastAPI'], [/flask/i, 'Flask']] as const)
    if (re.test(buildText)) frameworks.push(name);

  // TypeScript config
  const tsconfig = safeJson(stripJsonComments(read(root, 'tsconfig.json')));
  if (tsconfig) {
    const co = tsconfig.compilerOptions ?? {};
    facts.push(`TypeScript${co.strict ? ' with strict mode on' : ' (strict mode OFF)'}`);
    if (co.paths) facts.push(`Path aliases: ${Object.entries(co.paths).map(([k, v]) => `${k} -> ${(v as string[]).join(', ')}`).join('; ')}`);
  }

  // Next.js specifics
  if ('next' in deps) {
    const appDir = ['src/app', 'app'].find((d) => files.some((f) => f.startsWith(d + '/')));
    const pagesDir = ['src/pages', 'pages'].find((d) => files.some((f) => f.startsWith(d + '/')));
    const nextConfig = ['next.config.ts', 'next.config.mjs', 'next.config.js'].map((f) => read(root, f)).join('\n');
    facts.push(`Next.js ${clean(deps.next)}: ${appDir ? `App Router in ${appDir}/` : ''}${appDir && pagesDir ? ' and ' : ''}${pagesDir ? `Pages Router in ${pagesDir}/` : ''}`);
    if (/cacheComponents:\s*true/.test(nextConfig))
      facts.push('cacheComponents is ON: request-time data (cookies(), headers(), params, searchParams, uncached fetch) must be read inside <Suspense> or cached with "use cache"');
    const routes = files.filter((f) => /(^|\/)route\.(ts|js)$/.test(f));
    if (routes.length) facts.push(`Route handlers (${routes.length}): ${routes.slice(0, 8).join(', ')}${routes.length > 8 ? ', ...' : ''}`);
    const code = files.filter((f) => /\.(t|j)sx?$/.test(f));
    const serverActionFiles = code.filter((f) => /^\s*['"]use server['"]/.test(read(root, f, 100_000)));
    if (serverActionFiles.length) facts.push(`Server Action files ("use server"): ${serverActionFiles.slice(0, 8).join(', ')}`);
    const client = code.filter((f) => /^\s*['"]use client['"]/.test(read(root, f, 100_000)));
    facts.push(`Client components ("use client"): ${client.length}${client.length ? ` (e.g. ${client.slice(0, 4).join(', ')})` : ''}`);
    const serverOnly = code.filter((f) => /import\s+['"]server-only['"]/.test(read(root, f, 100_000)));
    if (serverOnly.length) facts.push(`Server-only modules (import "server-only"): ${serverOnly.slice(0, 8).join(', ')}`);
    const proxy = files.find((f) => /^(src\/)?proxy\.(ts|js)$/.test(f));
    const mw = files.find((f) => /^(src\/)?middleware\.(ts|js)$/.test(f));
    if (proxy) facts.push(`Proxy (formerly middleware): ${proxy}`);
    if (mw) facts.push(`middleware file present (${mw}); Next 16 renamed this convention to proxy`);
  }

  // Workspaces / multi-module builds
  const workspaces = workspaceDirs(root, pkg, files);
  if (workspaces.length) facts.push(`Workspaces / modules: ${workspaces.join(', ')}`);
  const tests = files.filter((f) => /(\.|_)(test|spec)\.[a-z]+$|(^|\/)(test|tests|__tests__)\//.test(f));
  facts.push(tests.length ? `Tests: ${tests.length} test files (e.g. ${tests.slice(0, 3).join(', ')})` : 'Tests: none found');
  if (fs.existsSync(path.join(root, '.github/workflows'))) facts.push(`CI workflows: ${fs.readdirSync(path.join(root, '.github/workflows')).filter((f) => !f.startsWith('ai-review')).join(', ') || 'only ai-review'}`);

  const lintConfigs = LINT_FILES.filter((f) => fs.existsSync(path.join(root, f)));
  const readme = read(root, 'README.md').split('\n').slice(0, 60).join('\n');

  return { root, fileCount: files.length, languages, packageManager, frameworks, deps, facts, lintConfigs, readme, modules: findModules(files, workspaces) };
}

function workspaceDirs(root: string, pkg: any, files: string[]): string[] {
  const globs: string[] = [];
  if (Array.isArray(pkg?.workspaces)) globs.push(...pkg.workspaces);
  else if (Array.isArray(pkg?.workspaces?.packages)) globs.push(...pkg.workspaces.packages);
  const pnpm = read(root, 'pnpm-workspace.yaml');
  for (const m of pnpm.matchAll(/^\s*-\s*['"]?([^'"\n]+)['"]?\s*$/gm)) globs.push(m[1]);
  const dirs = new Set<string>();
  if (globs.length) {
    const isWs = picomatch(globs.map((g) => g.replace(/\/$/, '')));
    for (const f of files) if (f.endsWith('package.json') && f.includes('/') && isWs(path.dirname(f))) dirs.add(path.dirname(f));
  }
  // Gradle / Maven modules
  const settings = read(root, 'settings.gradle.kts') + read(root, 'settings.gradle');
  for (const m of settings.matchAll(/include\s*\(?([^)\n]+)\)?/g))
    for (const name of m[1].split(',')) {
      const d = name.trim().replace(/['":]/g, '').replace(/^:/, '').replace(/:/g, '/');
      if (d) dirs.add(d);
    }
  for (const m of read(root, 'pom.xml').matchAll(/<module>([^<]+)<\/module>/g)) dirs.add(m[1].trim());
  return [...dirs].filter((d) => files.some((f) => f.startsWith(d + '/'))).sort();
}

/**
 * Splits the code into modules worth one summary each: workspaces first, then directories,
 * recursively splitting any directory with more than SPLIT_AT code files.
 */
const SPLIT_AT = 35;
function findModules(files: string[], workspaces: string[]): Module[] {
  const code = files.filter(isCode);
  const roots = workspaces.length ? workspaces : topDirs(code);
  const out: Module[] = [];
  const claimed = new Set<string>();

  const split = (dir: string, depth: number) => {
    const inDir = code.filter((f) => f.startsWith(dir + '/') && !claimed.has(f));
    if (!inDir.length) return;
    if (inDir.length > SPLIT_AT && depth < 3) {
      const children = new Map<string, number>();
      for (const f of inDir) {
        const rest = f.slice(dir.length + 1);
        if (rest.includes('/')) children.set(rest.split('/')[0], (children.get(rest.split('/')[0]) ?? 0) + 1);
      }
      if (children.size > 1) {
        for (const c of [...children.keys()].sort()) split(`${dir}/${c}`, depth + 1);
        const loose = inDir.filter((f) => !claimed.has(f));
        if (loose.length) push(dir, loose, [`${dir}/*`]);
        return;
      }
    }
    push(dir, inDir, [`${dir}/**`]);
  };
  const push = (dir: string, fs_: string[], globs: string[]) => {
    fs_.forEach((f) => claimed.add(f));
    out.push({ dir, globs, files: fs_ });
  };

  for (const r of roots) split(r, 0);
  // Loose files directly in src/ (proxy.ts, instrumentation.ts ...)
  const srcLoose = code.filter((f) => !claimed.has(f) && /^src\/[^/]+$/.test(f));
  if (srcLoose.length) push('src', srcLoose, ['src/*']);
  const rootFiles = code.filter((f) => !claimed.has(f));
  if (rootFiles.length) out.push({ dir: '.', globs: rootFiles, files: rootFiles });
  return mergeTiny(out);
}

/** Tiny sibling modules (1 or 2 files) are merged so each model call has enough code to learn from. */
const MIN_FILES = 3;
function mergeTiny(mods: Module[]): Module[] {
  // A "dir/*" module (loose files) sits at the same level as dir's subfolders.
  const parentOf = (m: Module) => (m.globs[0] === `${m.dir}/*` ? m.dir : path.dirname(m.dir));
  const keep: Module[] = [];
  const small = new Map<string, Module[]>();
  for (const m of mods) {
    if (m.dir !== '.' && m.files.length < MIN_FILES) small.set(parentOf(m), [...(small.get(parentOf(m)) ?? []), m]);
    else keep.push(m);
  }
  for (const group of small.values()) {
    if (group.length === 1) keep.push(group[0]);
    else keep.push({ dir: group.map((g) => g.dir).join(' + '), globs: group.flatMap((g) => g.globs), files: group.flatMap((g) => g.files) });
  }
  return keep.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** Root-level files that are only tool config carry no conventions worth a model call; the facts already cover them. */
export const isConfigOnly = (m: Module) =>
  m.files.every((f) => /(^|\/)[^/]*\.config\.[a-z]+$|\.d\.ts$|(^|\/)(postcss|tailwind|jest|vitest|vite|webpack|babel|eslint|prettier)\.|^\.?[a-z]+rc(\.[a-z]+)?$/i.test(f));

function topDirs(code: string[]): string[] {
  const dirs = new Set<string>();
  for (const f of code) {
    const parts = f.split('/');
    if (parts.length < 2) continue;
    // Treat src/ as a container, not a module: src/app, src/lib ... become the modules.
    if (parts[0] === 'src') {
      if (parts.length > 2) dirs.add(`src/${parts[1]}`);
    } else dirs.add(parts[0]);
  }
  return [...dirs].sort();
}

const clean = (v: string | undefined) => (v ?? '').replace(/^[\^~]/, '');
function safeJson(s: string): any {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}
/** JSONC to JSON: drops comments outside strings and trailing commas (tsconfig allows both). */
function stripJsonComments(s: string) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += s[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Picks the files that best show how a module works, within a token budget.
 * Entry points and conventional names first, then mid-sized files.
 */
const PRIORITY = /(^|\/)(layout|page|route|actions?|proxy|middleware|index|main|app|server|schema|config|types?|auth|db|client|api|handler|controller|service|repository|router|store)\.[a-z]+$|Controller\.|Service\.|Repository\.|Application\./i;
export function sampleFiles(root: string, mod: Module, budgetChars: number): { path: string; text: string }[] {
  const scored = mod.files
    .map((f) => ({ f, size: (() => { try { return fs.statSync(path.join(root, f)).size; } catch { return 0; } })() }))
    .filter((x) => x.size > 0 && x.size < 60_000)
    .sort((a, b) => Number(PRIORITY.test(b.f)) - Number(PRIORITY.test(a.f)) || Math.abs(a.size - 2500) - Math.abs(b.size - 2500));
  const out: { path: string; text: string }[] = [];
  let used = 0;
  const perFile = Math.max(1200, Math.floor(budgetChars / 3));
  for (const { f } of scored) {
    if (used >= budgetChars) break;
    let text = read(root, f);
    if (text.length > perFile) text = text.slice(0, perFile) + '\n/* ...truncated */';
    if (used + text.length > budgetChars && out.length) continue;
    out.push({ path: f, text });
    used += text.length;
  }
  return out;
}
