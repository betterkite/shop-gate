import fs from 'fs/promises';
import path from 'path';
import { generatedDevScriptContents } from './scaffold-runtime-scripts';
import {
  retailBaseDashboardPageTemplate,
  retailBaseDashboardCssTemplate,
} from './retail-scaffold-templates';
import { writeRetailDashboardTemplate } from './retail-scaffold-dashboard';
import { ensureGeneratedTsConfig } from './scaffold-config';

function shouldRefreshScaffoldFile(filePath: string, existing: string): boolean {
  const normalizedPath = filePath.replaceAll(path.sep, '/');
  const trimmed = existing.trim();

  if (normalizedPath.endsWith('/app/page.tsx')) {
    const hasDataBinding =
      existing.includes('dashboard-data.json') ||
      existing.includes('data_file/final') ||
      existing.includes('/api/commerce/');
    const hasStandardDataDashboard =
      existing.includes('data-source-file={DATA_FILE}') &&
      existing.includes('function getBars(') &&
      existing.includes('TrendChart') &&
      existing.includes('K 线与量价结构');
    const hasLegacySvgTitleHydrationRisk =
      hasStandardDataDashboard &&
      (
        existing.includes('<title>{String(bar.date') ||
        existing.includes('<title>{String(bar.date ??')
      );
    const isDefaultNextPage =
      existing.includes('Get started by editing') ||
      existing.includes('src/app/page.tsx') ||
      existing.includes('app/page.tsx') ||
      existing.includes('next/font/google') ||
      existing.includes('https://vercel.com/templates');
    const hasUnstableDataDashboard =
      hasDataBinding &&
      (
        existing.includes('0 条样本') ||
        (existing.includes('最新价</span>') && !hasStandardDataDashboard) ||
        (existing.includes('Shop Gate 看板') && !hasStandardDataDashboard) ||
        existing.includes('SAMPLE_DATA') ||
        existing.includes('MOCK_DATA') ||
        existing.includes('STATIC_QUOTES')
      );

    return (isDefaultNextPage && !hasDataBinding) || hasUnstableDataDashboard || hasLegacySvgTitleHydrationRisk;
  }

  if (normalizedPath.endsWith('/app/globals.css')) {
    // Existing styles can be intentionally small. Validation/scaffolding must
    // not replace user-authored CSS merely because it does not use a platform
    // class name; destructive recovery is an explicit repair operation.
    return trimmed.length === 0;
  }

  if (normalizedPath.endsWith('/app/api/commerce/[...path]/route.ts')) {
    const targetsDataBackend =
      existing.includes('127.0.0.1:8000/api/v1') ||
      existing.includes('SHOPGATE_COMMERCE_API') ||
      existing.includes('/api/v1/');

    return !targetsDataBackend && trimmed.length < 1_200;
  }

  if (normalizedPath.endsWith('/scripts/run-dev.js')) {
    return (
      existing.includes("NEXT_RSPACK: process.env.NEXT_RSPACK || 'true'") ||
      existing.includes('const useRspack = process.env.NEXT_RSPACK ===') ||
      existing.includes('Rspack dev mode enabled') ||
      existing.includes('const devEnv =') ||
      existing.includes("commandArgs.push('--turbo')") ||
      existing.includes('delete runtimeEnv.NEXT_RSPACK') ||
      existing.includes('delete runtimeEnv.TURBOPACK') ||
      !existing.includes("defaultBundlerArgs = hasBundlerFlag ? [] : ['--webpack']") ||
      !existing.includes('SHOPGATE_WORKSPACE_ROOT') ||
      !existing.includes("fs.existsSync(path.join(projectRoot, '.next', 'BUILD_ID'))")
    );
  }

  if (normalizedPath.endsWith('/scripts/run-build.js')) {
    return (
      existing.includes('delete buildEnv.NEXT_RSPACK') ||
      existing.includes('delete buildEnv.TURBOPACK') ||
      !existing.includes("NODE_ENV: 'production'") ||
      !existing.includes('SHOPGATE_WORKSPACE_ROOT') ||
      !existing.includes('NEXT_PRIVATE_BUILD_WORKER') ||
      !existing.includes("defaultBundlerArgs = hasBundlerFlag ? [] : ['--webpack']") ||
      !existing.includes("['next', 'build'")
    );
  }

  if (normalizedPath.endsWith('/next-env.d.ts')) {
    return (
      existing.includes('next/navigation-types/navigation') ||
      !existing.includes('import "./.next/types/routes.d.ts";') ||
      !existing.includes('// NOTE: This file should not be edited')
    );
  }

  return false;
}

type PackageJsonShape = {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

export function generatedBuildScriptContents(): string {
  return `#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const isWindows = process.platform === 'win32';
const workspaceRoot =
  process.env.SHOPGATE_WORKSPACE_ROOT || path.resolve(projectRoot, '../../..');

const buildEnv = {
  ...process.env,
  NODE_ENV: 'production',
  SHOPGATE_WORKSPACE_ROOT: workspaceRoot,
  NEXT_PRIVATE_BUILD_WORKER: '1',
  NEXT_TELEMETRY_DISABLED: '1',
};

const passthrough = process.argv.slice(2);
const hasBundlerFlag = passthrough.some((arg) =>
  ['--webpack', '--turbo', '--turbopack'].includes(arg)
);
// Turbopack rejects the generated project's shared node_modules symlink when
// the filesystem root is correctly isolated to this project. Webpack supports
// that layout without widening source discovery into the platform workspace.
const defaultBundlerArgs = hasBundlerFlag ? [] : ['--webpack'];

const child = spawn(
  'npx',
  ['next', 'build', ...defaultBundlerArgs, ...passthrough],
  {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: isWindows,
    env: buildEnv,
  }
);

child.on('exit', (code, signal) => {
  if (code === 0) {
    return;
  }

  console.error(
    \`Next.js build failed with code \${code ?? 'null'}, signal \${signal ?? 'none'}\`
  );
  process.exit(typeof code === 'number' ? code : 1);
});

child.on('error', (error) => {
  console.error('Failed to start Next.js build');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
`;
}

async function mergePackageJson(filePath: string, defaults: PackageJsonShape & Record<string, unknown>) {
  let packageJson = defaults;
  let existingContents: string | null = null;

  try {
    existingContents = await fs.readFile(filePath, 'utf8');
    packageJson = JSON.parse(existingContents);
  } catch {
    // 文件缺失或 JSON 异常时，回写默认配置。
  }

  packageJson.scripts = {
    ...defaults.scripts,
    ...(packageJson.scripts ?? {}),
    build: defaults.scripts.build,
  };
  if (packageJson.scripts.build === 'next build' || packageJson.scripts.build === 'next build --webpack') {
    packageJson.scripts.build = defaults.scripts.build;
  }

  packageJson.dependencies = {
    ...(packageJson.dependencies ?? {}),
    next: packageJson.dependencies?.next ?? defaults.dependencies.next,
    react: packageJson.dependencies?.react ?? defaults.dependencies.react,
    'react-dom':
      packageJson.dependencies?.['react-dom'] ?? defaults.dependencies['react-dom'],
  };
  delete packageJson.dependencies['next-rspack'];

  const existingDevDependencies =
    packageJson.devDependencies &&
    typeof packageJson.devDependencies === 'object' &&
    !Array.isArray(packageJson.devDependencies)
      ? packageJson.devDependencies
      : {};

  packageJson.devDependencies = {
    ...(packageJson.devDependencies ?? {}),
    typescript:
      existingDevDependencies.typescript ?? defaults.devDependencies.typescript,
    '@types/react':
      existingDevDependencies['@types/react'] ?? defaults.devDependencies['@types/react'],
    '@types/node':
      existingDevDependencies['@types/node'] ?? defaults.devDependencies['@types/node'],
    eslint: existingDevDependencies.eslint ?? defaults.devDependencies.eslint,
    'eslint-config-next':
      existingDevDependencies['eslint-config-next'] ?? defaults.devDependencies['eslint-config-next'],
  };
  delete packageJson.devDependencies['next-rspack'];

  const nextContents = `${JSON.stringify(packageJson, null, 2)}\n`;
  if (existingContents === nextContents) {
    return;
  }

  await fs.writeFile(filePath, nextContents, 'utf8');
}

async function ensureNextConfig(filePath: string) {
  const fallback = `/** @type {import('next').NextConfig} */
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = process.env.SHOPGATE_WORKSPACE_ROOT
  ? path.resolve(process.env.SHOPGATE_WORKSPACE_ROOT)
  : path.resolve(projectRoot, '../../..');

const nextConfig = {
  allowedDevOrigins: ['localhost', '127.0.0.1'],
  typedRoutes: true,
  // Next 16 requires the tracing and Turbopack roots to match. Keeping both at
  // the generated project boundary prevents discovery of platform entrypoints
  // such as src/proxy.ts while the node_modules symlink remains resolvable.
  outputFileTracingRoot: projectRoot,
  turbopack: {
    root: projectRoot,
  },
};

module.exports = nextConfig;
`;

  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, fallback, 'utf8');
    return;
  }

  let nextContent = content.replace(
    /(?:const|var|let)\s+withRspack\s*=\s*require\(['"]next-rspack['"]\);\n?/g,
    ''
  );
  nextContent = nextContent.replace(
    /const\s+shouldUseRspack\s*=.*?;\n?/g,
    ''
  );
  nextContent = nextContent.replace(
    /module\.exports\s*=\s*shouldUseRspack\s*\?\s*withRspack\(nextConfig\)\s*:\s*nextConfig\s*;?/g,
    'module.exports = nextConfig;'
  );
  nextContent = nextContent.replace(
    /module\.exports\s*=\s*withRspack\(nextConfig\)\s*;?/g,
    'module.exports = nextConfig;'
  );
  if (!nextContent.includes('const projectRoot = __dirname;')) {
    nextContent = nextContent.replace(
      /\/\*\* @type \{import\('next'\)\.NextConfig\} \*\/\n/,
      "/** @type {import('next').NextConfig} */\nconst projectRoot = __dirname;\n"
    );
  }
  if (!nextContent.includes("const path = require('path');")) {
    nextContent = nextContent.replace(
      /\/\*\* @type \{import\(['"]next['"]\)\.NextConfig\} \*\/\n/,
      "/** @type {import('next').NextConfig} */\nconst path = require('path');\n\n"
    );
  }
  if (!nextContent.includes('const workspaceRoot =')) {
    nextContent = nextContent.replace(
      /const projectRoot = __dirname;\n/,
      `const projectRoot = __dirname;
const workspaceRoot = process.env.SHOPGATE_WORKSPACE_ROOT
  ? path.resolve(process.env.SHOPGATE_WORKSPACE_ROOT)
  : path.resolve(projectRoot, '../../..');
`
    );
  }
  nextContent = nextContent.replace(/outputFileTracingRoot:\s*workspaceRoot/g, 'outputFileTracingRoot: projectRoot');
  nextContent = nextContent.replace(/root:\s*workspaceRoot/g, 'root: projectRoot');
  if (!nextContent.includes('turbopack:')) {
    nextContent = nextContent.replace(
      /const nextConfig = \{\n/,
      `const nextConfig = {
  turbopack: {
    root: projectRoot,
  },
`
    );
  }
  if (!nextContent.includes('allowedDevOrigins')) {
    nextContent = nextContent.replace(
      /const nextConfig = \{\n/,
      `const nextConfig = {
  allowedDevOrigins: ['localhost', '127.0.0.1'],
`
    );
  }

  if (nextContent !== content) {
    await fs.writeFile(filePath, nextContent, 'utf8');
  }
}

async function writeFileIfMissing(filePath: string, contents: string) {
  try {
    const existing = await fs.readFile(filePath, 'utf8');
    if (!shouldRefreshScaffoldFile(filePath, existing)) {
      return;
    }
  } catch {
    // continue
  }
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, contents, 'utf8');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function ensureSharedNodeModules(projectPath: string) {
  const projectNodeModules = path.join(projectPath, 'node_modules');
  const sharedNodeModules = path.join(/*turbopackIgnore: true*/ process.cwd(), 'node_modules');

  if (path.resolve(projectNodeModules) === path.resolve(sharedNodeModules)) {
    return;
  }

  if (!(await fileExists(path.join(sharedNodeModules, 'next', 'package.json')))) {
    return;
  }

  try {
    const existing = await fs.lstat(projectNodeModules);
    if (existing.isSymbolicLink()) {
      const target = await fs.readlink(projectNodeModules);
      const resolvedTarget = path.resolve(projectPath, target);
      if (resolvedTarget === path.resolve(sharedNodeModules)) {
        return;
      }
      await fs.rm(projectNodeModules, { recursive: true, force: true });
    } else if (await directoryExists(path.join(projectNodeModules, 'next'))) {
      return;
    } else {
      return;
    }
  } catch {
    // node_modules 不存在时创建共享依赖桥接。
  }

  const relativeTarget = path.relative(projectPath, sharedNodeModules);
  await fs.symlink(relativeTarget || sharedNodeModules, projectNodeModules, 'dir');
}

export async function ensureRetailDashboardTemplate(projectPath: string) {
  await scaffoldBasicNextApp(projectPath, path.basename(projectPath));
  await writeRetailDashboardTemplate(projectPath);
}

/**
 * Restore a generated dashboard to the platform-owned, validation-safe template.
 * This is intentionally separate from normal scaffolding so Agent enhancements are
 * preserved unless automatic validation proves that the generated page is broken.
 */
export async function restoreRetailDashboardTemplate(projectPath: string) {
  await scaffoldBasicNextApp(projectPath, path.basename(projectPath));
  await fs.writeFile(
    path.join(projectPath, 'app', 'page.tsx'),
    retailBaseDashboardPageTemplate(),
    'utf8'
  );
  await fs.writeFile(
    path.join(projectPath, 'app', 'globals.css'),
    retailBaseDashboardCssTemplate(),
    'utf8'
  );
}

export async function scaffoldBasicNextApp(
  projectPath: string,
  projectId: string
) {
  await fs.mkdir(projectPath, { recursive: true });

  const packageJson = {
    name: projectId,
    private: true,
    version: '0.1.0',
    scripts: {
      dev: 'node scripts/run-dev.js',
      build: 'node scripts/run-build.js',
      start: 'next start',
      lint: 'next lint',
    },
    dependencies: {
      next: '^16.2.6',
      react: '^19.2.6',
      'react-dom': '^19.2.6',
    },
    devDependencies: {
      typescript: '^6.0.3',
      '@types/react': '^19.2.15',
      '@types/node': '^22.19.19',
      eslint: '^9.17.0',
      'eslint-config-next': '^16.2.6',
    },
  };

  await mergePackageJson(
    path.join(projectPath, 'package.json'),
    packageJson
  );
  await ensureSharedNodeModules(projectPath);

  await ensureNextConfig(
    path.join(projectPath, 'next.config.js')
  );

  await writeFileIfMissing(
    path.join(projectPath, 'postcss.config.js'),
    `module.exports = {
  plugins: [],
};
`
  );

  await ensureGeneratedTsConfig(path.join(projectPath, 'tsconfig.json'));

  await writeFileIfMissing(
    path.join(projectPath, 'next-env.d.ts'),
    `/// <reference types="next" />
/// <reference types="next/image-types/global" />
import "./.next/types/routes.d.ts";

// NOTE: This file should not be edited
// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.
`
  );

  await writeFileIfMissing(
    path.join(projectPath, 'app/layout.tsx'),
    `import type { ReactNode } from 'react';
import './globals.css';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
`
  );

  await writeFileIfMissing(
    path.join(projectPath, 'app/api/commerce/[...path]/route.ts'),
    `import { NextRequest, NextResponse } from 'next/server';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  const { path } = await context.params;
  const target = new URL('http://127.0.0.1:8000/api/v1/' + path.join('/'));
  const source = new URL(request.url);
  source.searchParams.forEach((value, key) => target.searchParams.set(key, value));

  const response = await fetch(target, {
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
    },
  });
  const body = await response.text();

  return new NextResponse(body, {
    status: response.status,
    headers: {
      'Content-Type': response.headers.get('Content-Type') ?? 'application/json',
    },
  });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
`
  );

  await writeFileIfMissing(
    path.join(projectPath, 'app/page.tsx'),
    retailBaseDashboardPageTemplate()
  );

  await writeFileIfMissing(
    path.join(projectPath, 'app/globals.css'),
    retailBaseDashboardCssTemplate()
  );

  await writeFileIfMissing(
    path.join(projectPath, 'scripts/run-build.js'),
    generatedBuildScriptContents()
  );

  await writeFileIfMissing(
    path.join(projectPath, 'scripts/run-dev.js'),
    generatedDevScriptContents()
  );
}
