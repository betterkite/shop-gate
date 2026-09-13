# P33 依赖安全升级验收

## 范围

本切片处理开源上传前的 npm 依赖安全风险，覆盖生产依赖和开发/桌面打包链。升级以兼容性和可回滚为前提，不执行未经评估的 `npm audit fix --force`，也不为了清除审计结果降级 Prisma。

## 处理结果

- 升级 Next.js `16.3.5`、PostCSS `8.5.28`、Sharp `0.35.4`、js-yaml `4.3.2`、Vitest `4.1.11`。
- 升级 Electron `44.3.0`、Electron Builder `26.15.3`、eslint-config-next `16.3.5`，同步 Electron 打包依赖。
- Prisma 保持 `6.19.3`；对 `@prisma/config` 使用的 `deepmerge-ts` 固定到 `^8.0.2`。npm 给出的 Prisma `6.12.0` 降级建议未采纳。
- 对已确认兼容的间接依赖增加限定 override：浏览器映射、brace-expansion、minimatch、undici、ESLint humanfs、xmldom，以及 Tailwind 的 postcss-selector-parser。
- Next 生成的 `next-env.d.ts` 新增 root params 类型引用，作为 Next 16.3.5 的构建产物一并保留。

## 验收证据

- `npm audit --json`：`0 vulnerabilities`。
- `npm ls`：关键升级包均解析到目标版本，无 invalid 依赖。
- `npm run type-check`：通过。
- `npm run lint -- --quiet`：通过。
- `npx vitest run src/lib/agent/skills/compiler.test.ts`：18/18 通过。
- `npm run test:unit`：187 个测试文件通过、2 个跳过；1039 个测试通过、25 个跳过。
- `npm run build`：Next.js 生产构建通过，路由生成和 TypeScript 构建通过。
- `git diff --check`：通过。

## 仍需在发布前验证

P33 本身已完成。发布前仍需在合并后的最终分支执行 standalone/Electron 运行回归、零售 E2E 和 RepoSteward 全套发布门禁；这些验证属于 P34/P35 的最终发布门，不在本次依赖切片中重复宣告完成。
