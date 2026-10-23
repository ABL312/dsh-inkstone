# dsh-inkstone 设计规格（v1）

> 依据用户 2026-10-23 的 13 项决策落定。后续实现以本文为准；细节变更需 Lead 同意。

## 1. 交付形态

- 交付物：**单个 DSH bundle 包** `dsh-inkstone`，安装进 `desktop` profile，一次安装四行插件。
- 源码目录：`D:\DS TEST\inkstone-suite`；本地 `link:` 安装，修改代码后通过
  `plugin_manager remove_bundle` + `install_bundle` 热更新（实测可行）。
- 只做 **Host 工具 + 系统提示词**，不做 Web UI（用户选择"只做工具"）。
- 实现为免构建纯 ESM JS，**禁止导入 `@deepseek-ai/*` 等外部包**（linked bundle 的
  import 从自身目录解析，装不上）；只用 `node:` 内置模块和包内相对导入。
- 工具定义用普通对象经 `ctx.tools.register` 注册（不依赖 `defineTool`）。
- 插件入口声明 `export const inject = ['tools']`；流水线插件另加 `systemPrompt`。

## 2. 命名

| 软件 | bundle 行 id | 包内插件 id | 显示名 |
|---|---|---|---|
| 插件包 | — | `dsh-inkstone` | 文房四宝 · Inkstone |
| Trilium Notes | `inkstone-trilium` | `trilium-paper` | 纸 · Trilium 笔记 |
| Zotero | `inkstone-zotero` | `zotero-ink` | 墨 · Zotero 文献 |
| Typst | `inkstone-typst` | `typst-brush` | 笔 · Typst 排版 |
| 联合流水线 | `inkstone-flow` | `inkstone-flow` | 砚 · 联合流水线 |

工具前缀：`trilium_*` / `zotero_*` / `typst_*` / `pipeline_*`。

## 3. 用户决策（实现约束）

1. 交付 DSH 插件包。
2. 单 bundle 四行。
3. 工具分层：默认每插件 4–6 个任务级工具，`advancedTools: true` 时追加细粒度工具。
4. 只做工具，不做 UI。
5. Trilium：**混合接入** —— MCP 行（`mcp__trilium__*`，官方工具）+ ETAPI Host 插件补强。
6. Trilium 写入：默认只读语境，写入只发生在显式工具调用；笔记落点固定父笔记下的
   项目子笔记 + `#inkstone/*` 标签约定；流水线 publish 步骤显式执行。
7. Trilium 必须覆盖：检索读取、写入更新、附件上传、属性/结构化查询、历史/回收站/导出。
8. Zotero 数据源：本地 API（127.0.0.1:23119）+ Better BibTeX 导出的 `.bib` 文件。
   另实现可选的 Web API 写回（仅在配置 `ZOTERO_API_KEY` 时启用，默认关闭）。
9. Zotero 必须覆盖：检索筛选、citekey 与 .bib 工程、PDF/全文/批注、写回（可选）、
   在线补全（Crossref/OpenAlex/arXiv）。
10. Typst 自愈：白名单规则自愈，≤3 轮，改前备份，只改工作区文件；修不了输出结构化诊断。
11. Typst 安装：winget 全局安装（已装 0.15.1）；插件仍需支持配置路径与探测。
12. 流水线：确定性步骤引擎 + Agent 技能提示（checkpoint 暂停等待模型写作）。
13. 场景：期刊/会议论文、课程论文/实验报告、文献综述/读书笔记、幻灯片/海报。

## 4. 架构

```
dsh-inkstone/
  package.json            # bundle manifest + subpath exports
  cordis.patch.yml        # MCP 行 + 四插件行
  index.js                # bundle 根入口（no-op）
  locale/{en,zh}.json     # bundle 显示元数据
  icon.svg
  lib/
    tool-kit.mjs          # 工具定义/输出/配置/会话 cwd 辅助（Lead）
    paths.mjs             # 文件系统与 .inkstone 目录约定（Lead）
    http.mjs              # fetch 封装（Lead）
    trilium-client.mjs    # ETAPI 客户端（trilium 实现）
    zotero-client.mjs     # Zotero 本地/Web API 客户端（zotero 实现）
    bib.mjs               # BibTeX/BibLaTeX 解析与工程（zotero 实现）
    typst-runner.mjs      # Typst CLI 探测/编译/导出/诊断解析（typst 实现）
    heal.mjs              # 规则自愈（typst 实现）
    typst-scaffold.mjs    # 模板工程脚手架（typst 实现）
    run-store.mjs         # 流水线运行记录（Lead）
    pipeline-engine.mjs   # 步骤引擎 + 占位符解析 + 步骤注册表（Lead）
  plugins/<id>/{index.js,package.json,locale/*.json,icon.svg}
  templates/              # Typst 模板（typst 实现）
  recipes/                # 内置流水线配方 JSON（Lead）
  scripts/test-*.mjs      # 各自的无 DSH 测试脚本
  fixtures/               # 各插件测试夹具
  docs/
```

## 5. 关键行为

### Trilium
- 认证：ETAPI 用 `Authorization: <token>`（不是 Bearer）；MCP 用
  `Authorization: Bearer <token>`。
- 未设置 token 时工具调用抛出可操作错误（指向 Trilium Options → ETAPI）。
- 写工具显式调用才写；publish 步骤创建/更新项目子笔记并上传附件。
- 内容格式：`html` / `markdown` / `auto`；markdown 由插件做安全的最小 HTML 转换。

### Zotero
- 本地 API 未运行 → 明确错误提示启动 Zotero 并开启本地 API。
- `.bib` 解析自研（BibTeX/BibLaTeX 足够子集），支持索引、合并去重、缺失字段检查、
  citekey 查询；BBT 的 `bibtex` 字段（如 `tex.*`）保留在 entry 中。
- 本地 API 不支持写：写回只走 Web API，且在 `ZOTERO_API_KEY` 存在时才注册写工具。
- PDF 路径解析：由 attachment key 在 `dataDir/storage/<key>/` 下查找文件。
- 全文提取：优先 `pdftotext`（如存在），否则返回路径与提示；批注走本地 API 子条目。

### Typst
- 二进制探测顺序：config.binaryPath → PATH → winget Links → winget Packages 通配 →
  `%USERPROFILE%\.cargo\bin` / scoop shims。记录 version。
- 编译：`typst compile <input> <output> --root <project> [--font-path ...]`；
  诊断格式仅 human/short，解析 `error:`/`warning:` + `file:line:col`。
- 自愈规则白名单（只改工作区内的 .typ/引用路径，改前备份到 `.inkstone/backups/`）：
  1. 引用键缺失：在当前 bib 索引中大小写/近似匹配（编辑距离 ≤2）唯一时替换。
  2. bibliography/include/import/image 路径不存在：按 basename 在工作区唯一匹配时改写相对路径。
  3. 未知字体族：命中配置的 fallback 映射时替换（默认 `SimSun→Microsoft YaHei` 等）。
  4. 常见拼写：`#bibliography` 路径扩展名缺失；`@key` 前后空格等。
  修不了 → 返回结构化 diagnostics（含 file/line/column/message/suggestion）。
- 导出：pdf（单文件）、svg/png（`{p}`/`{0p}`/`{t}` 页码模板，输出到 outDir）。
- 模板：`paper-zh`、`report-zh`、`slides-zh`、`poster-zh`，全部自包含（不依赖网络包），
  用系统 CJK 字体（Microsoft YaHei / SimSun / Noto 系列探测）。

### 流水线
- 运行目录：`<project>/.inkstone/runs/<runId>/`（`run.json`、`report.md`、`artifacts/`）。
- `pipeline_run` 顺序执行步骤；遇到 `checkpoint` 暂停，返回 `status:"awaiting"` 与
  `runId`；模型写完内容后用同一 `runId` 续跑。
- 占位符：`${inputs.x}`、`${run.dir}`、`${steps.<id>.<field>}`（点路径）。
- 内置配方 4 条：`paper-delivery`、`course-report`、`lit-review`、`slides-poster`。
- dryRun 只解析与校验，不产生副作用；publish=false 时跳过 Trilium。
- 系统提示词段落指导模型何时用流水线、checkpoint 后做什么、失败如何自愈升级。

## 6. 安全与凭据

- `TRILIUM_ETAPI_TOKEN` 必需；`TRILIUM_ETAPI_URL` 可选（默认 `http://127.0.0.1:8080`）。
- `ZOTERO_API_KEY`、`ZOTERO_API_USER_ID` 可选（仅 Web API 写回）。
- 任何 token 不写入包、不写入运行记录、不回显到工具输出。
- 工具默认只读语境；写操作只由明确工具/流水线步骤触发。

## 7. 验收

- `plugin_manager install_bundle` 安装成功，四行插件 + MCP 行 `application: applied`。
- 工具出现在 `Tool.listTools`。
- 单测：`node scripts/test-*.mjs` 全部通过（mock 服务 + 真实 typst 编译）。
- 端到端：Typst 样例编译（中文 PDF/SVG/PNG）→ Trilium 发布（需 token）→ 流水线
  checkpoint 续跑。Zotero 本地 API 可用时验证检索与 bib 导出。
- 文档：README、示例工程、recipes 说明、故障排查。
