// 中文幻灯片模板（dsh-inkstone · typst-brush）
//
// 16:9 页面（160mm × 90mm，比例恰为 16:9），深色主题，自包含。
// 字体回退链：Microsoft YaHei → SimHei → DengXian，全部为系统字体。
//
// 占位符由 lib/typst-scaffold.mjs 在脚手架阶段替换；未替换时模板仍可独立编译。

#let title = "{{title}}"
#let authors = "{{authors}}"
#let doc-date = "{{date}}"
#let bib-path = "{{bibPath}}"
#let citation-style = "{{citationStyle}}"

// 未经脚手架替换时回退到随模板发布的默认值，保证模板本身可独立编译。
#let unscaffolded = bib-path.contains("{{") or citation-style.contains("{{")
#let effective-bib-path = if unscaffolded { "refs.bib" } else { bib-path }
#let effective-citation-style = if unscaffolded { "gb-7714-2015-numeric" } else { citation-style }

#set document(title: title, author: authors)
#set page(
  width: 160mm,
  height: 90mm,
  margin: 0pt,
  fill: rgb("0e1c2b"),
)
#set text(
  font: ("Microsoft YaHei", "SimHei", "DengXian"),
  size: 16pt,
  fill: rgb("f2f5f8"),
  lang: "zh",
  region: "cn",
)
#set par(justify: true, leading: 0.78em, first-line-indent: 0em, spacing: 0.85em)
#set list(marker: text(fill: rgb("e8c07d"))[•], indent: 0.7em, spacing: 0.9em)
#show figure.caption: set text(fill: rgb("9db4c8"), size: 10pt)

#let accent = rgb("e8c07d")
#let muted = rgb("9db4c8")

// 内容页骨架：左侧强调色标题 + 细分隔线 + 正文。
#let slide(heading: none, body) = {
  pagebreak(weak: true)
  pad(left: 12mm, right: 12mm, top: 9mm, bottom: 7mm)[
    #if heading != none [
      #text(size: 23pt, weight: "bold", fill: accent)[#heading]
      #v(2mm)
      #rect(width: 100%, height: 0.7pt, fill: accent)
      #v(4mm)
    ]
    #body
  ]
}

// ---- 封面 ---------------------------------------------------------------
// 标题按长度自适应字号；间距不使用 weak，避免长标题换行后与分隔线相撞。
#pad(left: 16mm, right: 16mm, top: 16mm)[
  #set par(justify: false, leading: 0.45em, spacing: 0.6em)
  #text(
    size: if title.len() > 24 { 26pt } else if title.len() > 16 { 29pt } else { 32pt },
    weight: "bold",
  )[#title]
  #v(6mm)
  #rect(width: 46%, height: 1.4pt, fill: accent)
  #v(6mm)
  #text(size: 14pt, fill: muted)[#authors]
  #v(2mm)
  #text(size: 11pt, fill: muted)[#doc-date]
]

// ---- 目录 ---------------------------------------------------------------
#slide(heading: [提纲])[
  #set enum(spacing: 0.9em)
  + 研究背景
  + 方法概览
  + 结果展示
  + 结论与展望
]

// ---- 背景 ---------------------------------------------------------------
#slide(heading: [研究背景])[
  - 中文排版长期依赖办公软件或重量级排版系统，模板维护成本高；
  - 轻量标记语言把“内容”和“样式”分离，便于版本管理与批量生成 @example2024；
  - 现有工具链对系统字体、环境差异较敏感，需要规则化自愈兜底。
]

// ---- 方法 ---------------------------------------------------------------
#slide(heading: [方法概览])[
  #grid(
    columns: (1fr, 1fr),
    column-gutter: 8mm,
    [
      #text(size: 13pt, fill: accent)[流程]
      #v(1.5mm)
      #set list(spacing: 0.6em)
      - 撰写源文件
      - 套用中文模板
      - 编译并自愈
      - 导出 PDF / SVG
    ],
    [
      #text(size: 13pt, fill: accent)[保障]
      #v(1.5mm)
      #set list(spacing: 0.6em)
      - 仅用系统 CJK 字体
      - 改前自动备份
      - 最多 3 轮自愈
      - 失败返回结构化诊断
    ],
  )
]

// ---- 结果 ---------------------------------------------------------------
#slide(heading: [结果展示])[
  #grid(
    columns: (1.25fr, 1fr),
    column-gutter: 8mm,
    [
      #figure(
        image("figures/example.svg", width: 100%),
        caption: [不同文档的排版耗时对比],
      )
    ],
    [
      #set text(size: 14pt)
      #set list(spacing: 0.6em)
      - 单页中文文档编译在 1 秒内；
      - 多页导出自动补零编号；
      - 字体 / 引用 / 路径错误可自愈。
    ],
  )
]

// ---- 结论 ---------------------------------------------------------------
#slide(heading: [结论与展望])[
  - 自包含模板 + 规则化自愈，可显著降低排版环境差异带来的失败率；
  - 后续将支持更多期刊格式、参考文献样式与在线协作；
  - 欢迎在项目中直接扩展模板与自愈规则。
  #v(4mm, weak: true)
  #text(size: 11pt, fill: muted)[感谢观看 · dsh-inkstone / typst-brush]
]

// ---- 参考文献 -----------------------------------------------------------
#slide(heading: [参考文献])[
  #set text(size: 12pt, fill: rgb("dbe4ec"))
  #set par(justify: false)
  #bibliography(effective-bib-path, style: effective-citation-style, title: none)
]
