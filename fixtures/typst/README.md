# fixtures/typst

`scripts/test-typst.mjs` 使用的真实 Typst 夹具（无需网络、只用系统 CJK 字体）。
测试会把需要的夹具复制到 `fixtures/typst/_tmp/` 下的临时工程再运行，结束时自动清理
（`KEEP_TMP=1` 可保留现场）。

| 夹具 | 用途 | 对应测试 / 自愈规则 |
|---|---|---|
| `chinese/` | 中文 PDF 基线（含 1×1 PNG 占位图） | `compile: 中文 PDF + PNG 图片` |
| `chinese/multipage.typ` | 三页中文文档 | SVG / PNG 多页导出、页码模板 |
| `bad-font/` | `#set text(font: "宋体")`（系统无此字体族） | `unknown-font` → Microsoft YaHei |
| `bad-cite/` | 引用键 `@zhang2023types` ≠ bib 中的 `zhang2023typst` | `missing-bib-key`（编辑距离 2） |
| `bad-image/` | 引用 `images/diagram.svg`，实际文件在 `assets/diagram.svg` | `missing-file` |
| `bad-bib/` | 引用 `bib/missing-refs.bib`，实际文件为 `refs.bib` | `missing-bib`（优先 bibFiles） |
| `bad-include/` | `#include "chapters/intro.typ"`，实际文件在 `sections/intro.typ` | `missing-include` |
| `bad-variable.typ` | `#undefinedThing` 未知变量 | 不可自愈：结构化诊断、保持原样 |
| `diagnostics-human.txt` | typst 默认 human 诊断文本 | `parseDiagnostics` human 分支 |
| `diagnostics-short.txt` | `--diagnostic-format short` 诊断文本 | `parseDiagnostics` short 分支 |

模板编译夹具直接使用 `templates/*-zh/`，不在此目录重复。
