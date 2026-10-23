#set text(font: ("Microsoft YaHei", "SimSun"), size: 11pt, lang: "zh")
#include "chapters/intro.typ"

= 包含文件自愈样例

本文件故意把 include 路径写成不存在的 chapters/intro.typ，
用于测试 missing-include 自愈规则：工作区内唯一同名文件是 sections/intro.typ。
