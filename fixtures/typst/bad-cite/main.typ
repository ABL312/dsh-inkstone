#set text(font: ("Microsoft YaHei", "SimSun"), size: 11pt, lang: "zh")
= 引用键自愈样例

本文件故意把引用键拼错（@zhang2023types），用于测试 missing-bib-key 自愈规则：
在 refs.bib 中按大小写不敏感 / 编辑距离 ≤2 唯一匹配到 @zhang2023typst 后替换并重编译。

#bibliography("refs.bib", style: "gb-7714-2015-numeric")
