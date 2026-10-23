# Changelog

## v0.1.1 — 2026-10-23

排版修复：解决标题与正文贴连、英文标题被两端对齐拉散、幻灯片封面长标题与分隔线相撞的问题。

- `paper-zh` / `report-zh`：标题间距改用 `block(above:, below:)`（不再使用会在块边界折叠的
  `weak v()`）；正文行距与段距加大；表格内边距、图表间距、参考文献行距统一调优；
  标题区关闭两端对齐并收紧行距，避免英文标题单词间距被拉开。
- `report-zh`：二级标题编号从 `3.1.` 改为 `3.1`。
- `slides-zh`：封面标题按长度自适应字号，非 weak 间距，长标题不再压到分隔线/作者区。
- `poster-zh`：标题区关闭两端对齐，长标题按长度自适应字号（保持单页）。
- 4 套模板重新真实编译验证；`node scripts/test-typst.mjs` 46 项通过。

## v0.1.0 — 2026-10-23

首个可用版本：一个 bundle 四个插件。

### Added

- `trilium-paper`：ETAPI 客户端 + MCP 行，`trilium_search/read/write/attach/history`，
  `advancedTools` 下的 `trilium_attributes`/`trilium_delete`。
- `zotero-ink`：本地 API 检索、条目/附件/批注、`zotero_bib`（index/export/validate/merge）、
  `zotero_pdf`（pdftotext）、`zotero_enrich`（Crossref/OpenAlex/arXiv），自研 BibTeX 解析器。
- `typst-brush`：Typst CLI 探测、编译 PDF/SVG/PNG、规则化自愈（字体/引用键/缺失路径）、
  `paper-zh`、`report-zh`、`slides-zh`、`poster-zh` 四套自包含中文模板。
- `inkstone-flow`：配方引擎、检查点暂停/续跑、运行记录；内置 `paper-delivery`、
  `course-report`、`lit-review`、`slides-poster` 四条流水线。
- 凭据解析（环境变量 / `~/.dsh-inkstone/` secret 文件）、诊断与错误文案。
- 四套测试（182 项）与 `scripts/live-check.mjs` 环境体检。

### Verified

- Windows + DeepSeek Harness desktop profile 实机安装与端到端验证：Typst 中文 PDF/SVG/PNG、
  真实 Zotero 库检索与 `.bib` 导出、Trilium ETAPI 写入/发布、MCP 端点 23 个工具。
