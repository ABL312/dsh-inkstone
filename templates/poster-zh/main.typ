// 中文学术海报模板（dsh-inkstone · typst-brush）
//
// A2 竖版大页（42cm × 59.4cm），自包含，仅使用系统 CJK 字体。
// 占位符由 lib/typst-scaffold.mjs 在脚手架阶段替换；未替换时模板仍可独立编译。

#let title = "{{title}}"
#let authors = "{{authors}}"
#let abstract = "{{abstract}}"
#let doc-date = "{{date}}"
#let bib-path = "{{bibPath}}"
#let citation-style = "{{citationStyle}}"

// 未经脚手架替换时回退到随模板发布的默认值，保证模板本身可独立编译。
#let unscaffolded = bib-path.contains("{{") or citation-style.contains("{{")
#let effective-bib-path = if unscaffolded { "refs.bib" } else { bib-path }
#let effective-citation-style = if unscaffolded { "gb-7714-2015-numeric" } else { citation-style }

#set document(title: title, author: authors)
#set page(
  width: 42cm,
  height: 59.4cm,
  margin: 0pt,
  fill: rgb("f6f2e9"),
)
#set text(
  font: ("Microsoft YaHei", "SimHei", "DengXian"),
  size: 28pt,
  fill: rgb("1d2a32"),
  lang: "zh",
  region: "cn",
)
#set par(justify: true, leading: 0.72em, first-line-indent: 0em, spacing: 0.9em)

#let accent = rgb("2f5d50")
#let soft = rgb("e7dfd0")
#let muted = rgb("5b6b72")

// 海报分栏卡片。
#let section(heading, body) = block(
  width: 100%,
  inset: 1.05cm,
  radius: 0.35cm,
  fill: white,
  stroke: 0.06cm + accent,
  [
    #text(size: 38pt, weight: "bold", fill: accent)[#heading]
    #v(0.4cm, weak: true)
    #rect(width: 100%, height: 0.08cm, fill: soft)
    #v(0.4cm, weak: true)
    #body
  ],
)

#pad(x: 1.7cm, y: 1.3cm)[
  // ---- 页眉 ----
  #block(
    width: 100%,
    inset: (x: 1.3cm, y: 1.0cm),
    radius: 0.35cm,
    fill: accent,
    [
      #set par(justify: false, leading: 0.45em, spacing: 0.6em)
      #text(
        size: if title.len() > 26 { 50pt } else if title.len() > 18 { 56pt } else { 64pt },
        weight: "bold",
        fill: rgb("fdfaf3"),
      )[#title]
      #v(0.7cm, weak: true)
      #text(size: 34pt, fill: rgb("e8e0cf"))[#authors]
      #v(0.3cm, weak: true)
      #text(size: 24pt, fill: rgb("cfd9d3"))[#doc-date]
    ],
  )

  #v(0.7cm, weak: true)

  // ---- 摘要条 ----
  #block(
    width: 100%,
    inset: 0.8cm,
    radius: 0.3cm,
    fill: rgb("ede6d8"),
    [
      #text(size: 28pt, weight: "bold", fill: accent)[摘要]
      #v(0.3cm, weak: true)
      #text(size: 24pt, fill: muted)[#abstract]
    ],
  )

  #v(0.7cm, weak: true)

  // ---- 双栏内容 ----
  #grid(
    columns: (1fr, 1fr),
    column-gutter: 1.0cm,
    row-gutter: 1.0cm,
    section([研究背景], [
      中文排版长期依赖办公软件或重量级排版系统，模板维护成本高、版本协作困难；
      轻量标记语言把内容与样式分离，配合规则化自愈，可显著降低环境差异带来的失败率 @example2024。
    ]),
    section([研究方法], [
      #set list(indent: 0.6em, spacing: 0.7em)
      - 自包含模板：不依赖网络包；
      - 系统 CJK 字体回退链；
      - 白名单自愈：字体族 / 引用键 / 缺失路径；
      - 改前备份，最多 3 轮。
    ]),
    section([结果展示], [
      #figure(
        image("figures/example.svg", width: 100%),
        caption: [不同文档的排版耗时对比],
      )
    ]),
    section([结论与展望], [
      - 编译产物稳定、引用编号连续；
      - 失败时返回文件、行号、列号级诊断；
      - 后续扩展更多期刊样式与协作流程。
    ]),
  )

  #v(0.7cm, weak: true)

  // ---- 核心结论（通栏） ----
  #section([核心结论], [
    #grid(
      columns: (1fr, 1fr, 1fr),
      column-gutter: 0.9cm,
      align(center)[*零依赖*\
      自包含模板，不引用网络包],
      align(center)[*可自愈*\
      字体 / 引用 / 路径，改前备份],
      align(center)[*多产物*\
      PDF / SVG / PNG 一键导出],
    )
  ])

  #v(0.7cm, weak: true)

  // ---- 参考文献（通栏） ----
  #section([参考文献], [
    #set text(size: 19pt)
    #set par(justify: false, spacing: 0.5em)
    #bibliography(effective-bib-path, style: effective-citation-style, title: none)
  ])

  #v(0.6cm, weak: true)
  #align(center)[
    #text(size: 20pt, fill: muted)[dsh-inkstone · typst-brush · 由 Typst 排版生成]
  ]
]
