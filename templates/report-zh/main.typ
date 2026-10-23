// 中文课程论文 / 实验报告模板（dsh-inkstone · typst-brush）
//
// 自包含模板：不依赖任何网络包，仅使用系统 CJK 字体回退链
// （SimSun / Microsoft YaHei / FangSong 系列）。
//
// 占位符由 lib/typst-scaffold.mjs 在脚手架阶段替换；未替换时模板仍可独立编译。

#let title = "{{title}}"
#let authors = "{{authors}}"
#let abstract = "{{abstract}}"
#let bib-path = "{{bibPath}}"
#let citation-style = "{{citationStyle}}"
#let doc-date = "{{date}}"

// 未经脚手架替换时回退到随模板发布的默认值，保证模板本身可独立编译。
#let unscaffolded = bib-path.contains("{{") or citation-style.contains("{{")
#let effective-bib-path = if unscaffolded { "refs.bib" } else { bib-path }
#let effective-citation-style = if unscaffolded { "gb-7714-2015-numeric" } else { citation-style }

#set document(title: title, author: authors)
#set page(
  paper: "a4",
  margin: (top: 2.4cm, bottom: 2.4cm, left: 2.5cm, right: 2.5cm),
  numbering: "1",
  header: align(right, text(size: 8pt, fill: gray)[实验报告模板]),
)
#set text(font: ("SimSun", "Microsoft YaHei"), size: 10.5pt, lang: "zh", region: "cn")
#set par(justify: true, leading: 0.85em, spacing: 1.1em, first-line-indent: 2em)
#set heading(numbering: "1.1")
#set math.equation(numbering: "(1)")
#set table(inset: (x: 6pt, y: 4pt))
#set figure(gap: 0.9em)

// 标题间距用 block 的 above/below 表达；不要用 weak v()，它会在块边界被折叠。
#show heading.where(level: 1): it => block(
  above: 1.5em,
  below: 0.85em,
  {
    set text(font: ("Microsoft YaHei", "SimHei"), size: 14pt, weight: "bold")
    set par(first-line-indent: 0em, leading: 0.55em)
    it
  },
)
#show heading.where(level: 2): it => block(
  above: 1.15em,
  below: 0.55em,
  {
    set text(font: ("Microsoft YaHei", "SimHei"), size: 11.5pt, weight: "bold")
    set par(first-line-indent: 0em, leading: 0.55em)
    it
  },
)
#show figure: set block(above: 0.9em, below: 0.9em)
#show figure.caption: set text(size: 9pt)
#show bibliography: set par(first-line-indent: 0em, leading: 0.62em, spacing: 0.4em)
#show bibliography: set text(size: 9pt)
#show raw.where(block: true): it => block(
  above: 0.8em,
  below: 0.8em,
  width: 100%,
  inset: 8pt,
  fill: rgb("f2f4f6"),
  radius: 3pt,
  stroke: 0.5pt + rgb("d8dde3"),
  text(font: ("Consolas", "Courier New"), size: 9pt, it),
)

// ---- 标题区 -------------------------------------------------------------
#align(center)[
  #set par(justify: false, leading: 0.45em, spacing: 0.45em)
  #text(font: ("Microsoft YaHei", "SimHei"), size: 18pt, weight: "bold")[#title]
  #v(0.6em)
  #text(size: 11.5pt)[#authors]
  #v(0.25em)
  #text(size: 9pt, fill: gray)[#doc-date]
  #v(0.6em)
]

// ---- 摘要 ---------------------------------------------------------------
#if abstract != "" [
  #block(
    width: 100%,
    inset: (x: 12pt, y: 9pt),
    fill: rgb("f7f9fb"),
    radius: 4pt,
  )[
    #text(font: ("Microsoft YaHei", "SimHei"), size: 10pt, weight: "bold")[摘要：]
    #text(size: 9.5pt)[#abstract]
  ]
  #v(0.5em)
]

= 实验目的

#enum(
  [掌握 Typst 的基本排版语法与文档结构；],
  [理解中文论文的版式规范（标题、摘要、图表、公式与参考文献）；],
  [能够使用自愈编译流程完成从写作到 PDF 成稿的全过程。],
)

= 实验原理

Typst 采用“内容即代码”的设计：源文件中的标记语法描述内容，`#set` 规则声明样式，
`#show` 规则定义渲染行为。文档整体排版遵循流式布局模型，标题、段落、图表按顺序参与
断行与分页计算 @example2024。

字号与行距设置可表示为：

$ "行距倍数" = "行距" / "字号" $

= 实验步骤

== 创建工程

```bash
node scripts/test-typst.mjs
```

== 编写正文

正文采用普通标记语法，标题使用 `=` 开头，图表使用内置函数并配合交叉引用标签。
图 @fig:flow 给出了实验流程。

#figure(
  image("figures/example.svg", width: 75%),
  caption: [实验流程图：编写 → 编译 → 自愈 → 导出],
) <fig:flow>

== 记录数据

#figure(
  table(
    columns: (1fr, 1fr, 1fr),
    align: (left, center, center),
    stroke: 0.5pt + rgb("c0c8d0"),
    table.header([测试项], [预期结果], [实测结果]),
    [中文 PDF 编译], [成功], [成功],
    [SVG 多页导出], [每页一个文件], [每页一个文件],
    [坏引用自愈], [自动替换引用键], [自动替换引用键],
  ),
  caption: [自愈编译测试记录],
) <tab:record>

= 结果与分析

编译产物结构清晰、引用编号正确，图表与公式编号连续。自愈流程可在不超过 3 轮内修复
字体族、引用键与文件路径三类常见错误；无法修复时返回包含文件、行号与列号的结构化诊断，
便于快速定位问题。

= 结论

通过本实验可以确认：Typst 适合作为中文实验报告与课程论文的排版工具，配合规则化自愈
与模板脚手架，可以显著降低环境差异带来的排版失败率。

#bibliography(effective-bib-path, style: effective-citation-style)
