#set text(font: ("Microsoft YaHei", "SimSun"), size: 12pt, lang: "zh")
#set page(paper: "a4", margin: 2cm)

= 第一页：多页导出

此文档共三页，用于验证 SVG / PNG 多页导出与页码模板（page-{0p}）。
第一页正文包含中文标点：“测试”、（一）、《示例》。

#pagebreak()

= 第二页：图表

#figure(
  image("pixel.png", width: 1cm),
  caption: [第二页的 1×1 PNG 占位图],
)

#pagebreak()

= 第三页：公式

行内公式 $a^2 + b^2 = c^2$，独立公式：

$ integral_0^1 x^2 dif x = 1/3 $
