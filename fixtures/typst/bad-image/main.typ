#set text(font: ("Microsoft YaHei", "SimSun"), size: 11pt, lang: "zh")
= 图片路径自愈样例

本文件故意把图片路径写成不存在的 images/diagram.svg，用于测试 missing-file 自愈规则：
工作区内唯一同名文件是 assets/diagram.svg，自愈后图片引用路径应被改写并重新编译通过。

#figure(
  image("images/diagram.svg", width: 60%),
  caption: [自愈后的示例插图],
)
