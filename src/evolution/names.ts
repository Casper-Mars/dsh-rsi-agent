/**
 * core 内置固件 SKILL 名 —— 无依赖的叶子模块。
 *
 * 为什么单独成文件：`validate.ts` 需要在**不引入** `evolution/skills.js`
 * （该模块依赖 fs / dsh-skill，且反过来 import `validate.js`）的前提下，
 * 校验领域包 `firmwareSkills[].name` 是否占用了 core 保留名。把常量放进这个
 * 不依赖任何本地模块的小文件，两个方向都能安全引用，避免循环依赖。
 *
 * 真源仍是这里；`evolution/skills.ts` 原样 re-export 以保持既有导入路径。
 */
export const FIRMWARE_SKILL_NAMES = Object.freeze([
  'rsi-evolution',
  'skill-authorship',
  'task-authorship',
] as const)

/** 固件 SKILL 名联合类型。 */
export type FirmwareSkillName = (typeof FIRMWARE_SKILL_NAMES)[number]
