// 中文期刊 / 会议论文模板（dsh-inkstone · typst-brush）
//
// 自包含模板：不依赖任何网络包（不使用 @preview 导入），只使用 Typst 内置
// 功能与系统 CJK 字体回退链（Microsoft YaHei / SimSun 系列）。若本机缺少
// 第一种字体，Typst 会逐字回退；typst_build 的 unknown-font 自愈规则也可
// 依据配置映射替换字体族。
//
// 占位符由 lib/typst-scaffold.mjs 在脚手架阶段替换（{{title}} 等）。
// 未替换时本文件同样可以编译：占位符位于字符串字面量内部。

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
  margin: (top: 2.5cm, bottom: 2.5cm, left: 2.6cm, right: 2.6cm),
  numbering: "1",
)
#set text(font: ("SimSun", "Microsoft YaHei"), size: 10.5pt, lang: "zh", region: "cn")
#set par(justify: true, leading: 0.85em, spacing: 1.15em, first-line-indent: 2em)
#set heading(numbering: "1.1")
#set math.equation(numbering: "(1)")
#set table(inset: (x: 6pt, y: 4pt))
#set figure(gap: 0.9em)

// 标题间距用 block 的 above/below 表达；不要用 weak v()，它会在块边界被折叠，
// 造成标题与正文贴在一起。
#show heading.where(level: 1): it => block(
  above: 1.6em,
  below: 0.9em,
  {
    set text(font: ("Microsoft YaHei", "SimHei"), size: 15pt, weight: "bold")
    set par(first-line-indent: 0em, leading: 0.55em)
    it
  },
)

#show heading.where(level: 2): it => block(
  above: 1.2em,
  below: 0.6em,
  {
    set text(font: ("Microsoft YaHei", "SimHei"), size: 12pt, weight: "bold")
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
  fill: rgb("f5f5f5"),
  radius: 3pt,
  text(font: ("Consolas", "Courier New"), size: 9pt, it),
)

// ---- 标题与作者 -----------------------------------------------------------
#align(center)[
  #set par(justify: false, leading: 0.45em, spacing: 0.45em)
  #v(0.4em)
  #text(font: ("Microsoft YaHei", "SimHei"), size: 19pt, weight: "bold")[#title]
  #v(0.7em)
  #text(size: 12pt)[#authors]
  #v(0.2em)
  #text(size: 9pt, fill: gray)[#doc-date]
  #v(1.0em)
]

// ---- 摘要 ---------------------------------------------------------------
#if abstract != "" [
  #align(center)[#text(font: ("Microsoft YaHei", "SimHei"), size: 10.5pt, weight: "bold")[摘 要]]
  #par(justify: true, first-line-indent: 0em, text(size: 9pt)[#abstract])
  #v(0.9em)
]

// ---- 正文 ---------------------------------------------------------------
= 引言

学术论文的排版质量直接影响阅读体验与成果传播效率。传统工作流依赖办公软件或重量级排版工具，
模板维护成本高、版本协作困难。近年来，轻量级标记语言与现代化排版引擎逐渐受到关注
@example2024，其“内容与样式分离”的理念值得借鉴。

本文以可复现的模板工程为例，说明中文论文从写作到成稿的完整排版流程，并给出插图、表格、
公式与参考文献的示例写法。

= 研究方法

== 总体框架

本文提出的排版流程如图 @fig:pipeline 所示，包括内容撰写、模板套用、自动编译与产物导出四个阶段。

#figure(
  image("figures/example.svg", width: 82%),
  caption: [排版流程示意：撰写 → 套用模板 → 编译 → 导出],
) <fig:pipeline>

== 数据与示例

表 @tab:metrics 给出了模板编译的示例指标。表格标题置于表格上方，正文引用使用交叉引用标签。

#figure(
  table(
    columns: (auto, 1fr, 1fr),
    align: (center, left, left),
    stroke: 0.5pt + rgb("c8c8c8"),
    table.header([序号], [指标], [说明]),
    [1], [编译耗时], [单页中文文档约 1 秒以内],
    [2], [产物格式], [PDF / SVG / PNG 多页导出],
    [3], [字体依赖], [仅系统 CJK 字体，无需网络包],
  ),
  caption: [模板编译示例指标],
) <tab:metrics>

行内公式如 $E = m c^2$，独立编号公式如下：

$ integral_0^1 x^2 dif x = 1/3 $

== 代码示例

```typst
#set text(font: ("SimSun", "Microsoft YaHei"))
#figure(image("figures/example.svg"), caption: [示例插图])
```

= 结果与分析

基于本模板生成的 PDF 在版面、字体与引用编号上保持一致，便于批量生成与版本管理。
编译失败时，`typst_build` 会先执行白名单自愈（字体族、引用键、缺失路径），
仍无法修复时返回结构化诊断，便于继续人工修正。

= 结论

本文给出了一个自包含、可自愈的中文论文 Typst 模板。后续工作将补充更多期刊格式与
自动参考文献样式切换能力。

#bibliography(effective-bib-path, style: effective-citation-style)
