---
name: platform-ui-product-design
description: Design and review consistent, responsive, accessible Shop Gate platform pages, workspaces, settings, tables, navigation, charts, and interaction states.
---

# Shop Gate 平台 UI 产品设计

本 Skill 面向 Shop Gate 主平台的页面、组件、控制台、设置、列表、详情、弹窗、导航和响应式体验。经营分析工作空间由 `dashboard-visualization` 负责生成，本 Skill 负责平台页面和共同交互质量。

## 资源

- 设计或评审页面前读取 [Shop Gate UI/UX 适配规则](references/ui-ux-pro-max-adapter.md)。
- 定义页面状态、响应式断点和验收证据时读取 [平台 UI 交付契约](references/platform-ui-contract.md)。
- 实现后运行 `python scripts/validate_state_matrix.py --input <state-matrix.json>`。

## 设计流程

1. 判断页面是工作台、数据平台、任务详情、设置还是运营控制台。
2. 确定一个主要动作和信息层级：标题/范围 → 主工作流 → 指标/列表/图表 → 详情和限制。
3. 优先复用现有 UI 组件和设计 token，不新增只服务一个页面的重复 primitive。
4. 明确 loading、empty、error、disabled、pending、long text、权限和连接缺失状态。
5. 列表超过 10 条默认分页；筛选、排序、刷新、导入和导出放入工具栏。
6. 检查 375、768、1440 宽度下的溢出、遮挡、跳动、焦点和可点击区域。

## 交互和视觉规则

- 使用安静、紧凑、可扫描的企业工作台风格，不用巨型宣传区、装饰渐变或空洞口号。
- 中性背景配合蓝色信息、绿色成功、琥珀提醒、红色错误；颜色不能是唯一状态表达。
- 按钮、导航和表单需要可见焦点、键盘操作和清晰的中文标签；图标按钮必须有 `aria-label`。
- 表格列保持稳定宽度，长文本截断或进入详情；宽表格只在自身容器内滚动。
- 异步内容预留稳定空间，动画只使用短时的透明度/位移变化并尊重减少动效设置。

## 验收

页面变更至少通过 `npm run lint` 和 `npm run type-check`；较大变更补充构建、页面 smoke、状态矩阵和桌面/移动视觉检查。页面标题、按钮文案、URL 和返回入口必须描述同一个用户流程。
