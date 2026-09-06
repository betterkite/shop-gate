# 08. Agent 设计思想路线图（v2 · Agent 主线）

目标：吃透 Shop Gate **作为一个 Agent 系统的设计思想**——它的每个关键机制解决什么问题、不做的代价是什么、为什么这样实现而不是那样——最终能自己设计并讲清一个同类项目。

> **版本说明**：v1（量化优先）见 git 历史（`37e5d36` 之前）。按陪学共识，市场数据线已降级为**案例库**：它学到的所有事实（provider→ingestion→stock_bars→freshness）在新路线里作为"Agent 输出凭什么可信"的活体证据反复调用，不再是独立主线。

读完本篇你应该知道：Agent 方向接下来 5~6 周每一场学什么、每个机制要产出什么取舍卡、毕业设计长什么样。

## 使用约定

1. **节奏**：每周 5~10 小时，按阶段顺序推进。
2. **分支**：继续在 `learning/stage-N` 分支上做实验与提交。
3. **阶段制验收**：每阶段完成向陪学者汇报，出题验收、讲透、布置下一阶段。
4. **现象先行（铁律）**：每个概念先在页面、日志、数据上看到现象，再挖机制；讲解：动手 ≤ 3:7。
5. **设计取舍卡（本路线的核心作业）**：每学一个机制，强制回答三问——

   ```
   【取舍卡】<机制名>
   解决什么问题：
   不做的代价（找项目里的历史伤疤/文档警示）：
   为什么这样实现而不是那样（对比至少一个替代方案）：
   参照实现：<文件路径>
   ```

6. **毕业产物**：一份《我的类 Shop Gate Agent 项目设计》文档（架构图＋每个决策的 why＋本项目参照实现）＋ 脱稿讲述达标。

## 主线排序（已共识）

```
① 生成-验证-修复-评测闭环  ← 产品心脏，故事主轴
② Agent 内核与治理        ← 企业级 Agent 的"不裸奔"哲学
③ Skills 与 Domain Pack   ← 知识注入的设计
④ 数据契约与可信度        ← 案例库复用，最快的一站
⑤ 毕业设计
```

## 路线总览

| 阶段 | 主题 | 参考时长 | 核心产出 |
| --- | --- | --- | --- |
| 0 | 模型接入与第一次生成 | 1~2 天 | 一句话在工作台变成一个工作空间页面 |
| 1 | 生成-验证-修复-评测闭环 | 1~1.5 周 | 一次提问的完整生命周期图 ＋ 3 张取舍卡 |
| 2 | Agent 内核与治理 | 1~1.5 周 | 治理机制清单 ＋ 4 张取舍卡 |
| 3 | Skills 与 Domain Pack | 约 1 周 | 一次 skill 小改动＋生成质量前后对比 ＋ 2 张取舍卡 |
| 4 | 数据契约与可信度（案例库） | 半周 | evidence/契约/evidence 链讲解 ＋ 2 张取舍卡 |
| 5 | 毕业设计 | 1 周 | 设计文档 ＋ 白板讲述 |

---

## 阶段 0：模型接入与第一次生成（1~2 天）

对应教材：[01 本地启动](01-quick-start.md)、[配置指南](../configuration.md)。

### 现象（先看到，再理解）

在工作台输入一个研究问题（如「贵州茅台近一年走势如何」），几十秒后得到一个**可交互的数据页面**——这是后续所有课程的原材料。本阶段目标：亲手让这个现象发生一次。

### 动手清单

1. 到 [platform.deepseek.com](https://platform.deepseek.com) 充值并创建 `DEEPSEEK_API_KEY`（几块钱够用很久）。
2. 写入本地密钥（该文件已被 git 忽略，永不提交）：

   ```bash
   echo 'DEEPSEEK_API_KEY=sk-你的key' >> .env.local
   ```

3. **显式切换模型**——⚠️ 关键一步，别跳过：项目代码级默认是本地 Qwen（走 ModelPort `127.0.0.1:38082`），而 ModelPort 没运行时生成会失败。按 [configuration.md](../configuration.md) 指引在界面/项目设置里把模型改成官方直连 `deepseek-v4-flash`。
4. 重启全栈并验证模型连通：

   ```bash
   npm run db:up
   npm run dev
   npm run check:models
   ```

5. 在工作台发出第一次提问，等生成完成，打开生成的页面。

### 验收

- [ ] `npm run check:models` 通过；`npm run doctor` 中模型项不再告警
- [ ] 工作台完成一次完整生成，页面能打开、数据能看
- [ ] 能说出：这次生成消耗了什么（模型 Token、行情接口调用、数据库写入）？

---

## 阶段 1：生成-验证-修复-评测闭环（1~1.5 周）

对应教材：[02 AI 工作空间生成链路](02-ai-workspace-generation.md)、[05 评测、运维与质量门](05-evaluation-and-operations.md)。

### 现象

同一天提两个问题：一个好问题生成出漂亮页面；一个模糊问题可能验证失败、页面被拦截。**为什么系统敢拦截自己生成的东西？**

### 挖掘路径

`src/lib/commerce/generation-*.ts`（队列/状态/执行器）→ `generation-validation.ts`（验证分类：代码验证/视觉检查/产物契约）→ `artifact-contracts.ts`（产物长什么样才合格）→ `src/lib/eval/`（评测平台怎么判分）。

### 动手清单

1. 画「一次提问的完整生命周期图」：提问 → job 队列 → Agent 生成 → 验证三类 → 修复收敛 → 预览/评测。
2. 制造一次失败：提交一个会触发验证失败的请求，观察 repair plan 如何收敛。
3. 跑一次评测命令：`npm run eval:ci`，读懂它检查了什么。

### 设计取舍卡（3 张）

- 为什么生成结果要过**三类验证**而不是只查代码能不能跑？
- 为什么要有**产物契约**（artifact contracts）？
- 为什么需要**评测平台**而不是人眼看两眼就算了？

### 验收

- [ ] 生命周期图完整且每个箭头有源码出处
- [ ] 3 张取舍卡 + 能说出至少一次系统"拦截自己"的真实案例

---

## 阶段 2：Agent 内核与治理（1~1.5 周）

对应教材：[内部组件学习指南](../internal-components.md)、[PI Agent 采用与治理边界](../pi-agent-migration.md)、[运行治理中心](../ops-platform-guide.md)。

### 现象

打开运行治理中心 `/ops-platform`：进程、槽位、队列、健康分——**为什么一个"调大模型的程序"需要这么多仪表？**

### 挖掘路径

`src/lib/agent/pi/**`：loop 驱动、治理约束（审批/受信副作用工具/预算/取消）、Worker registry（持久身份＋心跳）、PostgreSQL 事务 outbox、AgentRun 的 `waiting` 原子切换与 checkpoint、lease/fencing。

### 动手清单

1. 整理「治理机制清单」：每个机制一行——它防的是哪种事故？
2. 打开 `/ops-platform` 对照真实运行状态，找到清单里每个机制的"仪表读数"。
3. 杀掉一个 Worker 进程再观察恢复行为（如条件允许），记录系统如何处理 Worker 丢失。

### 设计取舍卡（4 张）

- 为什么受信副作用工具要**人工批准/编辑/拒绝**？
- 为什么审批要把 AgentRun **原子切到 waiting** 并写公开 checkpoint？
- 为什么 Worker 要持久注册身份与心跳、拒绝加入配置不一致的集群？
- 为什么用 PostgreSQL **事务 outbox** 而不是内存队列？

### 验收

- [ ] 4 张取舍卡 + 治理机制清单能在 `/ops-platform` 上一一对上仪表

---

## 阶段 3：Skills 与 Domain Pack（约 1 周）

对应教材：[04 Skills 与可视化看板](04-skills-and-visual-dashboard.md)、[07 Skills 编写与迭代教程](07-skills-authoring.md)、[Skills 治理规范](../skills-governance.md)。

### 现象

同一个问题，改动一个 skill 后生成的页面审美/结构/用词发生变化——**markdown 文件凭什么能改变 Agent 的行为？**

### 挖掘路径

`.pi/skills/`（12 个 skill 权威源：SKILL.md＋references＋scripts）→ `src/lib/agent/skills/compiler.ts`（编译进工作空间）→ registry/lock 与 SHA-256 完整性校验 → `src/lib/domains/finance/`（intent 解析、query-rewrite、symbol-aliases、mission-definition）。

### 动手清单

1. 按 07 教程对某个 skill 做一次小改动，`npm run check:skills` 验证。
2. 用同一个提问在改动前后各生成一次，**对比产物差异**并记录。
3. 读 `query-rewrite.ts` 与 `symbol-aliases.ts`：自然语言"贵州茅台"如何变成标准代码 `600519.SH`（案例库复用！你查过这张表）。

### 设计取舍卡（2 张）

- 为什么领域知识做成 **markdown skill** 而不是硬编码进 Agent 代码？
- 为什么 skills 需要 **registry/lock/SHA-256** 这么重的治理？

### 验收

- [ ] skill 小改动被质量门放行，且生成对比笔记完成
- [ ] 2 张取舍卡

---

## 阶段 4：数据契约与可信度（半周，案例库主场）

对应教材：[03 市场数据与策略平台](03-commerce-data-and-strategy-platform.md)、`src/lib/commerce/artifact-contracts.ts`、`evidence.ts`。

### 现象

生成的页面敢引用**真实行情**（你亲手灌的 3278 行），报告里附带 evidence 文件——**AI 幻觉横行的时代，它凭什么敢对外承诺数字？**

### 挖掘路径

`evidence.ts`（证据文件：数据出处可追溯）→ `artifact-contracts.ts`（字段级契约）→ 案例库调用：`禁止回填` 校验闸、freshness 口径、缓存 TTL（你全部亲手验过）。

### 动手清单

1. 打开一个生成的工作空间目录 `data/projects/`，找到 `.data-agent`、`data_file`、evidence 文件，弄清三者分工。
2. 追一个页面数字：从页面 → 接口 → 表 → provider（案例库技能直接复用）。

### 设计取舍卡（2 张）

- 为什么每个结论都要有 **evidence 文件**而不是让模型口头保证？
- 为什么数据接口要做**字段级契约**而不仅是"能返回就行"？

### 验收

- [ ] 2 张取舍卡 + 能向别人讲清"这个项目如何对抗 AI 幻觉"

---

## 阶段 5：毕业设计（1 周）

**产物**：《我的类 Shop Gate Agent 项目设计》文档，必须包含：

1. 架构图（Agent loop、Skills 注入、验证闭环、治理约束、数据契约五个板块）
2. 每个设计决策的 why，且**每条都能引用本项目对应实现作参照**（取舍卡复用）
3. 至少一处「我不会照抄的决策」及理由（批判性对比是吃透的标志）

**讲述**：脱稿把设计讲 10 分钟，陪学者扮演面试官连续追问（设计面试模拟）。

---

## 常见误区与排障入口

- **模型不通先查三件套**：`npm run check:models`、`npm run doctor`、`.env.local` 的 key 是否写对。默认 Qwen 走 ModelPort，本机没跑 ModelPort 就必须显式切官方直连。
- **生成的页面打不开**：先看运行治理中心的工作空间健康与验证报告，再回到阶段 1 的生命周期图定位卡在哪一环。
- **改了 skill 没生效**：检查是否通过 `check:skills`、lock 是否更新、工作空间是否需要重新生成。
- **别在 offline 模式下做正式检查**：它会连带关闭行情/Memory/Redis 探测。
- **Python 版本与依赖**：一律 `uv run`/`uv sync`，不要手动 pip 装进系统 Python。

## 学完之后

- 真想动手写 mini 实现：从「agent loop ＋ 一个 skill ＋ 一个验证器」骨架开始，把毕业设计文档当蓝图。
- 深入评测体系：`scripts/evals/`、`benchmark:quant:contract`。
- 参与真实开发：严格走 [06 开发者协作手册](06-developer-playbook.md)，提交前跑 `npm run release:check`。
