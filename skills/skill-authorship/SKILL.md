---
name: skill-authorship
description: 编写或修改可进化 SKILL.md 的合规规范：frontmatter 契约、kebab-case 命名、正文骨架、边界与验收。
whenToUse: 即将创建或修改任一可进化 SKILL.md 时。
---

# 可进化 Skill 创作规范（skill-authorship）

本规范约束「怎么写一个能被进化循环安全改写的 skill」。它是固件：只读，不参与自身进化。

## frontmatter 契约

文件必须以 YAML frontmatter 开头，且三字段齐全：

```yaml
---
name: kebab-case-name
description: 面向模型的路由描述，说清提供什么能力
whenToUse: 可判定的触发条件
---
```

- `name`：kebab-case，必须与所在目录名一致。
- `description`：一句话说清能力边界，不写实现细节。
- `whenToUse`：写可判定的场景，让模型能据输入自行判断是否命中。

## 命名

- 小写字母与数字，单词之间用单个连字符（kebab-case）。
- 目录名 = frontmatter 的 `name`。
- 不得与固件 skill 重名。

## 正文骨架

正文至少包含四块，缺一不可：

1. **触发条件**：什么情况下使用本 skill。
2. **步骤**：可执行的顺序，每步有明确产出。
3. **边界**：明确不做什么，避免越权与误用。
4. **验收**：怎样判定这次执行合格。

## 边界

- 不写死具体数值、具体对象或环境路径——这些属于运行期参数。
- 不把注册、装配等固件实现细节写进可进化 skill。
- 不写散文：没有步骤与边界的文本无法被验证，也无法被安全改写。
- 不在 `whenToUse` 里枚举其他 skill 或资产名：路由描述一旦枚举就会随资产增删而漂移。

## 验收清单

- [ ] frontmatter 三字段齐全且非空
- [ ] `name` 为 kebab-case，且与目录名一致
- [ ] `whenToUse` 可判定、不含具体数值或具体对象
- [ ] 正文含触发条件、步骤、边界、验收四块
- [ ] 无固件实现细节、无运行期参数
- [ ] 全文通过「删掉领域词后仍然成立」的通用性检查
