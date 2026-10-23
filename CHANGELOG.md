# Changelog

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
