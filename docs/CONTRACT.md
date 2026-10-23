# dsh-inkstone 实现契约（CONTRACT）

本文是并行实现的**唯一接口约定**。Lead 与三个实现者都按此编码；需要改接口先给 Lead 发消息，
不要单方面改共享文件。

## 0. 硬性规则

1. 包内只能用 `node:` 内置模块和**相对导入**。禁止 `@deepseek-ai/*`、`zod`、`yaml` 等外部包。
2. 插件入口文件：`export const name`、`export const inject = ['tools']`（流水线加
   `'systemPrompt'`）、`export function apply(ctx, config)`。不要导出 `Config`。
3. 工具用普通对象注册：
   ```js
   ctx.tools.register({
     name: 'trilium_search',
     description: '...',
     parameters: { type: 'object', properties: { ... }, required: [...], additionalProperties: false },
     output: { schema: {...}, render: (_args, value) => [{ type: 'text', text: '...' }] },
     async execute(args, exec) { return { ...json... }; },
   });
   ```
   `output.schema` 必须是受支持子集：`type`（单值）、`properties`、`required`、
   `additionalProperties`（布尔）、`items`、`enum`/`const`、`oneOf`、注解。
   **不要用 type 数组、format、$ref**。返回值必须能通过该 schema 校验。
4. 参数校验失败/业务失败一律 `throw new Error('可操作的说明')`；不要静默返回空结果。
5. 工具输出倾向于「短摘要 + 结构化 JSON」，用 `lib/tool-kit.mjs` 的 `renderSummary()`。
6. 长文本一律 `truncate()`；单次工具输出 ≤ 30k 字符。
7. 时间/超时：HTTP 15s；Typst 编译默认 120s；工具可带 `timeoutMs` 字段。
8. 不得调用 `plugin_manager`、不得安装/卸载 bundle、不得写 profile。测试用普通 `node`。
9. 不修改不属于你的文件（见 §7 所有权）。不改 `package.json`/`cordis.patch.yml`/`index.js`。
10. 每个插件目录都要有可用的显示元数据：`package.json`（name/description/icon/type）、
    `locale/en.json`、`locale/zh.json`（`meta.title`/`meta.description`）、`icon.svg`。

## 1. 共享模块（Lead 已实现，可直接用）

### `lib/tool-kit.mjs`
- `defineTool({ name, description, parameters?, schema?, render?, execute, timeoutMs? })`
- `textBlocks(text)`、`renderSummary(summary, data?)`、`truncate(text, max?)`
- `normalizeConfig(config)`、`requireString(args,name)`、`optionalString(args,name)`、
  `optionalInteger(args,name,fallback,max?)`
- `sessionCwd(exec)`：会话工作目录（Host cwd 不可用）
- `envValue(name)`、`configured(config,key,envName,fallback)`、`errorMessage(error)`
- `INKSTONE_VERSION`

### `lib/paths.mjs`
- 常量 `INKSTONE_DIR`；`resolveProjectDir(explicit, cwd)`、`inkstoneRoot(project)`、
  `runsRoot(project)`、`backupsRoot(project)`
- `ensureDir(dir)`、`stamp()`、`readJson(file, fallback?)`、`writeJson(file, value)`
- `readTextBounded(file, maxBytes?)`、`listFiles(dir, {extensions?, recursive?, limit?})`、
  `findByName(root, basename, {maxDepth?, limit?})`、`isInside(child, parent)`、
  `displayPath(base, target)`、`copyFile(source, destination)`

### `lib/http.mjs`
- `httpRequest(url, { method?, headers?, body?, timeoutMs?, signal?, expect?, maxErrorBody? })`
  → 解析后的 JSON / string / Uint8Array；失败抛 `HttpError`（`message` 可直接给模型）
- `query(params)`、`joinUrl(base, suffix)`、`HttpError`

### `lib/secrets.mjs`（凭据解析，必须使用）
- `resolveSecret({ config, configKey, envName, fileName, explicitFile })`
- `triliumToken(config)`：config.token → env（默认 `TRILIUM_ETAPI_TOKEN`）→
  `~/.dsh-inkstone/trilium-etapi-token.txt` 首行。
- `zoteroApiKey(config)`：config.apiKey → `ZOTERO_API_KEY` → `~/.dsh-inkstone/zotero-api-key.txt`。
- `secretHint('trilium' | 'zotero')`：可操作的缺失凭据提示。
- 原因：Host 进程的环境在启动时固定，用户之后 export 的变量不可见；secret 文件必须
  在工具调用时读取（不要模块加载时缓存）。Trilium/Zotero 插件**必须**通过本模块解析
  凭据，不要只读 `process.env`。

## 2. Trilium（实现者：trilium）

### 文件
- `lib/trilium-client.mjs`
- `plugins/trilium-paper/index.js` + `package.json` + `locale/{en,zh}.json` + `icon.svg`
- `scripts/test-trilium.mjs`、`fixtures/trilium/**`（mock ETAPI 服务）

### `lib/trilium-client.mjs` 导出
```js
export function createTriliumClient({ baseUrl, token, timeoutMs = 15000, allowWrites = true })
```
返回对象（全部 async，返回 JSON；失败抛错）：
- `appInfo()` → `{ appVersion, dbVersion, syncVersion, utcDate }`
- `search({ query, ancestorNoteId, limit = 20, orderBy = 'dateModified', orderDirection = 'desc' })`
  → `[{ noteId, title, type, dateModified, dateCreated, parentNoteIds, labels? }]`
- `getNote(noteId)` → ETAPI note JSON
- `getContent(noteId)` → `string`（HTML）
- `getPath(noteId)` → `{ noteId, title, path }`（根到该笔记标题数组或字符串）
- `getChildren(noteId)` → note 数组（ETAPI `GET /notes/{id}/children`，若不可用用 search 兜底）
- `getAttributes(noteId)`、`setAttribute({ noteId, type, name, value, isInheritable })`、
  `deleteAttribute(attributeId)`、`getAttribute(attributeId)`
- `createNote({ parentNoteId, title, type = 'text', content = '' })`
- `updateNote(noteId, { title?, type?, mime? })`（`PATCH /etapi/notes/{id}`）
- `setContent(noteId, content)`（`PUT /etapi/notes/{id}/content`，纯文本 body）
- `deleteNote(noteId)`、`restoreNote(noteId)`（若端点可用；不可用时抛明确错误）
- `getAttachments(noteId)`、`getAttachment(id)`、`uploadAttachment({ noteId, filePath, title, role = 'file', mime })`
  （multipart：字段 `file`、`noteId`、`title`、`role`、`mime`）、
  `downloadAttachment(id, destPath)`、`deleteAttachment(id)`
- `getRevisions(noteId)`、`getRevisionContent(noteId, revisionId)`、`createRevision(noteId)`
- `exportNote(noteId, format = 'markdown')` → 文本（`GET /etapi/notes/{id}/export?format=...`）
- `health()` → `{ connected: boolean, version?, error? }`

实现细节：
- 认证头：`Authorization: <token>`（ETAPI 约定，无 Bearer）。
- 路径前缀：`/etapi`。
- `token` 为空时，客户端方法直接抛
  `"TRILIUM_ETAPI_TOKEN is not set. Create a token in Trilium Options → ETAPI and set it as an environment variable."`
- 端点在实现时以 mock 测试为准；若真实实例返回 404，记录并在插件错误中说明。
- 建议把每个端点集中在文件顶部常量表，便于后续实测校正。

### 插件工具（默认 5 个）
1. `trilium_search` — `{ query: string, ancestorNoteId?, limit? }`；
   摘要列出 `noteId | title | dateModified`。
2. `trilium_read` — `{ noteId: string, includeChildren?: boolean, includeAttachments?: boolean,
   maxChars?: number }`；返回标题/路径/标签/正文（截断）/子笔记/附件列表。
3. `trilium_write` — `{ action: 'create'|'append'|'replace'|'title', parentNoteId?, noteId?,
   title?, content?, format?: 'auto'|'html'|'markdown' }`；
   `allowWrites:false` 时抛权限错误；markdown 做最小安全 HTML 转换（标题/粗斜体/代码/列表/
   段落/链接），HTML 原样写入；create 默认 `type:'text'`。
4. `trilium_attach` — `{ action: 'upload'|'list'|'download', noteId?, path?, attachmentId?,
   title?, role?: 'file'|'image' }`；upload 读取工作区文件。
5. `trilium_history` — `{ action: 'revisions'|'export', noteId, format?: 'markdown'|'html',
   outputPath?, limit? }`；export 可写文件到工作区并返回路径。

高级（`config.advancedTools: true`）：`trilium_attributes`（get/set/delete）、
`trilium_delete`（trash/restore）、`trilium_branch`（若实现）。可只做前两个。

### 配置
`{ baseUrl='http://127.0.0.1:8080', tokenEnv='TRILIUM_ETAPI_TOKEN', tokenFile?, defaultParentNoteId=null,
allowWrites=true, advancedTools=false, timeoutMs=15000 }`
token 解析：`triliumToken(config)`（`lib/secrets.mjs`），不要只读 `process.env`。

### 测试
- 用 `node:http` 起 mock ETAPI（记录请求、返回夹具），覆盖 search/read/write/attach/history。
- 若 `process.env.TRILIUM_ETAPI_TOKEN` 存在则额外跑真实 health/appInfo（可跳过）。
- 运行：`node scripts/test-trilium.mjs`，退出码 0 表示通过。

## 3. Zotero（实现者：zotero）

### 文件
- `lib/zotero-client.mjs`、`lib/bib.mjs`
- `plugins/zotero-ink/index.js` + `package.json` + `locale/{en,zh}.json` + `icon.svg`
- `scripts/test-zotero.mjs`、`fixtures/zotero/**`

### `lib/bib.mjs` 导出
```js
export function parseBib(text) -> { entries: Entry[], errors: string[] }
// Entry = { type: string, key: string, fields: Record<string,string>, raw?: string }
export function serializeBib(entries) -> string
export function loadBibFiles(files) -> { entries, files, errors, duplicates }
// files: string[]（.bib 文件或目录），目录递归找 *.bib
export function indexByCitekey(entries) -> Map<string, Entry>
export function findMissingFields(entry) -> string[]   // 按条目类型检查必要字段
export function dedupeEntries(entries) -> { entries, duplicates }
export function mergeEntries(base, extra) -> { entries, added, updated, duplicates }
export function buildBibFromItems(items) -> { entries, skipped }  // Zotero item → BibLaTeX entry
export function formatAuthors(creators) -> string
export function citekeyOf(entry) -> string
```
- BibTeX 支持：`@type{key, field = {value}, ...}`、引号值、`#` 拼接可降级、注释、`@string`
  宏可忽略但报 warnings；字段名小写化；`crossref` 保留。
- 缺失字段规则：article→author,title,journal,year；book→author|editor,title,publisher,year；
  inproceedings→author,title,booktitle,year；misc 只要求 title。
- 编码 UTF-8；输出稳定排序（按 key）。

### `lib/zotero-client.mjs` 导出
```js
export function createZoteroClient({ localApiUrl='http://127.0.0.1:23119', dataDir, timeoutMs=15000, apiKey, userId='0' })
```
方法：
- `search({ q, title, author, year, tag, collection, itemType, limit = 20, sort, direction })`
  → item 数组（本地 API：`/api/users/0/items?...` 或 `/api/users/0/collections/{key}/items`）
- `getItem(key)` → 原始 item JSON；`getChildren(key)` → 子条目（附件/批注）
- `listCollections()` → `[{ key, name, parentCollection }]`
- `getAttachmentPath(attachmentItem)` → 绝对路径（`dataDir/storage/<key>/<filename>`；文件名取
  item.data.filename，或目录内唯一文件）
- `exportBibtex({ collection?, itemKeys?, limit? })` → `{ text, source: 'local-api'|'generated' }`
  先试本地 API `format=bibtex&limit=...`（`/api/users/0/items?format=bibtex` 或
  `/collections/{key}/items?format=bibtex`），失败则用 `buildBibFromItems` 生成。
- `readPdfText(path)` → `{ text, method: 'pdftotext'|'none' }`（`pdftotext -layout - -`，
  不可用则 `text:null`）
- `enrich({ query, doi, title, source='auto' })` → 候选数组
  （Crossref `https://api.crossref.org/works?query.bibliographic=...&rows=5`、
   OpenAlex `https://api.openalex.org/works?search=...`、arXiv `http://export.arxiv.org/api/query`；
   只读、15s 超时、失败降级并说明）
- `webApiAvailable()`、`webApiRequest(path, init)`（有 apiKey 时；`Zotero-API-Version: 3`）
- `health()` → `{ localApi: boolean, zoteroRunning: boolean, error? }`

错误文案要点：本地 API 连不上时提示「启动 Zotero 并在 设置→高级 中允许本机应用通信」。

### 插件工具（默认 5 个）
1. `zotero_search` — `{ q?, title?, author?, year?, tag?, collection?, itemType?, limit?, sort? }`
   摘要：`key | 作者 年份 | 标题 | 类型`。
2. `zotero_item` — `{ key: string, includeAttachments?: boolean, includeAnnotations?: boolean }`
   返回元数据、citekey（若 bib 索引命中）、附件路径、批注文本。
3. `zotero_bib` — `{ action: 'index'|'export'|'validate'|'merge', bibPaths?: string[],
   collection?, itemKeys?: string[], outPath?, mergeFrom?: string[], refresh?: boolean }`
   - index：解析配置 + 参数里的 bib 文件，建索引，返回条目数/重复/缺字段。
   - export：从 Zotero 导出 bib 文本，写 outPath（默认 `<cwd>/refs.bib`），返回 citekey 列表。
   - validate：检查索引条目缺失字段与重复 key。
   - merge：合并多个 bib 到 outPath，去重。
   配置 `bibFiles` 参与所有 action 的索引。
4. `zotero_pdf` — `{ itemKey?, attachmentKey?, action: 'path'|'text'|'annotations', maxChars? }`
   text 调 `pdftotext`；annotations 走本地 API 子条目（`itemType === 'annotation'`，
   返回 annotationText/annotationComment/annotationPageLabel）。
5. `zotero_enrich` — `{ query?, doi?, title?, source?: 'auto'|'crossref'|'openalex'|'arxiv' }`
   返回最多 5 个候选（title/authors/year/doi/venue/url）；可选 `asBibtex?: boolean` 输出 BibTeX 片段。

高级（`advancedTools: true`）：`zotero_write` — `{ action:'add-item'|'add-tag'|'add-note', ... }`
（仅 `ZOTERO_API_KEY` 存在时注册；否则不注册该工具）。

### 配置
`{ localApiUrl='http://127.0.0.1:23119', dataDir, bibFiles=[], citationStyle='gb-7714-2015-numeric',
advancedTools=false, timeoutMs=15000 }`；Web API 的 key 用 `zoteroApiKey(config)` 解析
（`lib/secrets.mjs`），`ZOTERO_API_USER_ID` 读环境变量。

### 测试
- mock 本地 API（node:http）：search/item/collections/children/export bibtex。
- bib 夹具覆盖：常规条目、嵌套花括号、引号值、UTF-8 作者、重复 key、缺字段、BBT 字段。
- 真实数据仅在 Zotero 运行时可选跑（连不上自动 skip 并打印 SKIP）。
- `node scripts/test-zotero.mjs` 退出码 0。

## 4. Typst（实现者：typst）

### 文件
- `lib/typst-runner.mjs`、`lib/heal.mjs`、`lib/typst-scaffold.mjs`
- `plugins/typst-brush/index.js` + `package.json` + `locale/{en,zh}.json` + `icon.svg`
- `templates/{paper-zh,report-zh,slides-zh,poster-zh}/**`（自包含 .typ 模板，含 `refs.bib` 占位）
- `scripts/test-typst.mjs`、`fixtures/typst/**`

### `lib/typst-runner.mjs` 导出
```js
export function detectTypstBinary({ binaryPath, env = process.env } = {})
  -> { path, version, source: 'config'|'path'|'winget-link'|'winget-package'|'cargo'|'scoop' }
  // 找不到抛错，错误信息列出已尝试位置和 winget 安装命令
export function runTypst(args, { cwd, timeoutMs = 120000, signal, env } = {})
  -> { exitCode, stdout, stderr, timedOut, durationMs }
export function parseDiagnostics(stderr) -> Diagnostic[]
  // Diagnostic = { severity:'error'|'warning', message, file?, line?, column?, raw }
export function compile({ input, output?, root?, fontPaths?, ppi?, timeoutMs?, signal?, binaryPath? })
  -> { ok, outputPath, exitCode, stderr, diagnostics, durationMs }
export function exportPages({ input, format:'svg'|'png', outDir, pages?, ppi?, root?, fontPaths?, timeoutMs?, signal? })
  -> { ok, files: string[], diagnostics, exitCode }
export function probe({ binaryPath, fontPaths } = {})
  -> { binary, version, fonts: { total, cjkFamilies: string[] }, packageCache?, ok }
```
实现要点：
- Windows 路径用 `spawnSync`/`spawn`（`node:child_process`）且 `shell:false`；参数数组传。
- winget 探测：`%LOCALAPPDATA%/Microsoft/WinGet/Packages/Typst.Typst_*/typst-*/typst.exe`、
  `.../WinGet/Links/typst.exe`；再加 PATH。
- `typst fonts` 输出每个 family 一行；CJK 判断匹配 `YaHei|SimSun|Song|Hei|Kai|FangSong|Noto.*CJK|Source Han|思源`。
- 诊断行形如 `error: unknown variable: foo` + `  ┌─ main.typ:3:5`；也支持 `main.typ:3:5: error: ...`。
- 导出多页必须给页码模板（`page-{0p}.svg`）；输出目录不存在先创建。
- 所有命令用 `--root <project>` 限定；工作目录 project。

### `lib/heal.mjs` 导出
```js
export function backupFile(projectDir, file) -> backupPath
export function healRound({ projectDir, input, diagnostics, bibFiles = [], options = {} })
  -> { applied: Fix[], changed: boolean, notes: string[] }
  // Fix = { rule, file, message, before, after }
export function healCompile({ projectDir, input, compileOptions, maxRounds = 3, bibFiles = [], signal })
  -> { ok, rounds, fixes: Fix[], finalDiagnostics, outputPath, stderr }
```
规则（白名单，只改工作区内的文本文件）：
1. `unknown-font`：诊断含未知字体族 → 用 `options.fontFallbacks`（默认
   `{ SimSun: 'Microsoft YaHei', '宋体': 'Microsoft YaHei' }`）替换 `#set text(font: "...")` 中的族名。
2. `missing-bib-key`：诊断 `unknown citation key` / `citation key ... not found` → 在 bib 索引里
   大小写不敏感/编辑距离≤2 唯一匹配时替换 `@old` → `@new`。
3. `missing-file`：诊断 `file not found` / `failed to load` → 取引号内路径 basename，在
   projectDir 内 `findByName` 唯一命中时把路径改写为相对 input 的相对路径。
4. `missing-bib`：`empty bibliography`/找不到 bib 文件 → 若配置/参数给了唯一 .bib 则改写路径。
5. `missing-include`：`#include`/`#import` 目标不存在 → 唯一 basename 匹配时改写。
每轮结束重新编译；无修复或达到上限停止。每个修复前调用 `backupFile`。

### `lib/typst-scaffold.mjs` 导出
```js
export function scaffoldProject({ targetDir, template = 'paper-zh', title, authors = [], abstract = '',
  bibPath = 'refs.bib', citationStyle = 'gb-7714-2015-numeric', metadata = {} })
  -> { mainFile, files: string[] }
```
- 从包内 `templates/<template>/` 复制到 targetDir（不覆盖已存在的 main.typ，除非 `force`）。
- 模板占位符 `{{title}}`、`{{authors}}`、`{{abstract}}`、`{{bibPath}}`、`{{citationStyle}}`、
  `{{date}}` 简单替换；写 `metadata.json`。
- 模板必须能在无网络、只有系统字体时编译出中文 PDF。

### 插件工具（默认 3 个）
1. `typst_build` — `{ input: string, root?, output?, heal?: boolean=true, maxRounds?: number,
   fontPaths?: string[], ppi?: number }` → 摘要（成功/失败、轮数、修复列表、输出路径）。
2. `typst_export` — `{ input: string, format: 'svg'|'png', outDir?, pages?, ppi?, root? }`
   → 文件列表。
3. `typst_probe` — `{}` → 二进制路径/版本、CJK 字体、模板列表、可用性。
高级（`advancedTools: true`）：`typst_compile_raw`（不自动修复）、`typst_clean`（清理 .inkstone/backups 与导出目录）。

### 配置
`{ binaryPath=null, fontPaths=[], maxHealRounds=3, timeoutMs=120000, advancedTools=false }`

### 测试
- 真实 typst 已安装在 winget（0.15.1）；测试直接跑真实编译。
- 覆盖：中文 PDF、SVG/PNG 多页导出、诊断解析、自愈规则（构造坏引用/字体/路径）、模板脚手架。
- `node scripts/test-typst.mjs` 退出码 0；临时产物写 `fixtures/typst/_tmp/` 并清理。

## 5. 流水线（实现者：Lead，其他人的模块要按上面签名供调用）

### 配方 JSON 模式（`recipes/*.json`）
```json
{
  "id": "paper-delivery",
  "title": "期刊/会议论文交付",
  "description": "...",
  "scenario": "paper",
  "inputs": { "topic": { "type": "string", "required": true, "description": "论文题目" } },
  "steps": [
    { "id": "bib", "uses": "zotero.bib.export", "args": { "outPath": "${run.dir}/refs.bib" } },
    { "id": "scaffold", "uses": "typst.scaffold", "args": { "targetDir": "${run.dir}", "title": "${inputs.topic}" } },
    { "id": "write", "uses": "checkpoint", "args": { "message": "请撰写正文..." } },
    { "id": "build", "uses": "typst.build", "args": { "input": "${run.dir}/main.typ" } }
  ]
}
```
- 步骤 `uses` 由引擎注册表解析：`zotero.select`、`zotero.bib.export`、`zotero.bib.index`、
  `typst.scaffold`、`typst.build`、`typst.export`、`trilium.publish`、`checkpoint`、
  `report.write`。
- 步骤可带 `optional: true`（失败不终止）、`when: "${...}"`（truthy 判断，暂不做）。
- 参数值字符串支持 `${inputs.x}` / `${run.dir}` / `${steps.<id>.<path>}` 替换；非字符串递归处理。

### 运行记录
`run.json`：`{ runId, recipeId, status:'running'|'awaiting'|'completed'|'failed'|'cancelled',
projectDir, inputs, steps:[{id,uses,status,startedAt,endedAt,output?,error?}], artifacts:[], createdAt, updatedAt }`
`report.md`：人读摘要（步骤表 + 产物清单 + 失败诊断）。

### 工具
1. `pipeline_list` — `{ projectDir?, includeRuns?: boolean }`
2. `pipeline_run` — `{ recipe?: string, runId?: string, projectDir?: string, inputs?: object,
   options?: { dryRun?, heal?, publish?, fromStep?, maxSteps? } }`
3. `pipeline_status` — `{ runId?, projectDir?, limit? }`
高级：`pipeline_validate` — `{ recipe: string }`。

### 内置配方
`paper-delivery`、`course-report`、`lit-review`、`slides-poster`（见 DESIGN.md 场景）。

## 6. 环境变量

| 变量 | 用途 |
|---|---|
| `TRILIUM_ETAPI_TOKEN` | ETAPI/MCP 令牌（必需；也可写 `~/.dsh-inkstone/trilium-etapi-token.txt`） |
| `TRILIUM_ETAPI_URL` | 实例地址，默认 `http://127.0.0.1:8080` |
| `ZOTERO_API_KEY` / `ZOTERO_API_USER_ID` | Web API 写回（可选；key 也可写 `~/.dsh-inkstone/zotero-api-key.txt`） |
| `ZOTERO_LOCAL_API_URL` | 本地 API 地址，默认 `http://127.0.0.1:23119` |
| `ZOTERO_DATA_DIR` | Zotero 数据目录（默认 `~/Zotero`） |
| `INKSTONE_PROJECT_DIR` | 流水线默认项目目录（可选） |
| `TYPST_BIN` | Typst 可执行文件路径（可选，覆盖探测） |

## 7. 文件所有权

| 路径 | 所有者 |
|---|---|
| `package.json`、`cordis.patch.yml`、`index.js`、`locale/`、`icon.svg`、`docs/` | Lead |
| `lib/tool-kit.mjs`、`lib/paths.mjs`、`lib/http.mjs`、`lib/run-store.mjs`、`lib/pipeline-engine.mjs` | Lead |
| `plugins/inkstone-flow/**`、`recipes/**`、`README.md` | Lead |
| `lib/trilium-client.mjs`、`plugins/trilium-paper/**`、`scripts/test-trilium.mjs`、`fixtures/trilium/**` | trilium |
| `lib/zotero-client.mjs`、`lib/bib.mjs`、`plugins/zotero-ink/**`、`scripts/test-zotero.mjs`、`fixtures/zotero/**` | zotero |
| `lib/typst-runner.mjs`、`lib/heal.mjs`、`lib/typst-scaffold.mjs`、`plugins/typst-brush/**`、`templates/**`、`scripts/test-typst.mjs`、`fixtures/typst/**` | typst |

跨所有权改动 → 给 Lead 发消息，等确认。

## 8. 完成标准（每个实现者自检）

- [ ] `node scripts/test-<plugin>.mjs` 退出码 0，覆盖关键分支与错误文案。
- [ ] 模块可在纯 Node（无 DSH）下导入运行；无外部依赖。
- [ ] 插件 `index.js` 的每个工具都有参数 schema、输出 schema、render，并实际跑通至少一次
  （在测试脚本里直接构造假 `ctx` 调用 `apply` 注册的 execute 也可）。
- [ ] 元数据（package.json + locale + icon）完整，标题/描述与实际能力一致。
- [ ] 已知限制写进模块头部注释与 `notes` 输出，不静默降级。
- [ ] 回报：改动的文件、测试命令与结果、契约偏差、需要 Lead 决策的点。
