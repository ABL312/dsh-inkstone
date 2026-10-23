#set text(font: ("Microsoft YaHei", "SimSun"), size: 11pt, lang: "zh")
= 缺失参考文献自愈样例

本文件故意引用不存在的 bib 路径 bib/missing-refs.bib，用于测试 missing-bib 自愈规则：
healCompile 收到 bibFiles=[refs.bib] 后，应把路径改写为 refs.bib 并重新编译通过。

#bibliography("bib/missing-refs.bib", style: "gb-7714-2015-numeric")
