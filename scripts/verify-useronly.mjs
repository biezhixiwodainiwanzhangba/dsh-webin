#!/usr/bin/env node
/**
 * ## 「只发我的原话」—— 守住 userOnly 这条短路
 *
 * ## 用户原话
 *
 * > 把我输入的生成一首诗直接输入进去不就行了，为什么每次都要接一堆额外的提示词？
 *
 * ## 病在哪
 *
 * 首轮 diffPrompt() 会把三样东西拼成一次发送：system（约 6k 字符，DSH 整段
 * 系统提示词）+ toolSection（约 5k，工具协议 + 目录）+ serializeMessages(全部历史)。
 * 页面上看得见这一大坨，模型还被它带跑：实测「生成一首诗」被答成历史里的
 * 「分入保险」正文。
 *
 * ## 修法
 *
 * userOnly（默认开）⇒ 只取最后一条 user 消息的纯文本，一字不加。
 * 取不到（空内容 / 纯图）时退回全量路径 —— 不能发空消息。
 *
 * ## 本脚本守四件事
 *
 *   1. 配置层确有 userOnly 且默认 true（含 checkConfig 的真实行为）
 *   2. adapter 里这条短路真的在拼装之前 return（结构上不可能带 system）
 *   3. 调用点真的把 cfg.userOnly 传了下去（否则开关是死的）
 *   4. 设置页有开关、面板条有「新对话」（旧对话上下文甩不掉时换干净对话）
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const configSrc = readFileSync(join(ROOT, 'src', 'shared', 'config.ts'), 'utf8')
const adapterSrc = readFileSync(join(ROOT, 'src', 'host', 'adapter.ts'), 'utf8')
const clientSrc = readFileSync(join(ROOT, 'src', 'client', 'index.ts'), 'utf8')
const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

let pass = 0
let fail = 0
const check = function (name, actual, expected) {
  if (arguments.length < 3) expected = true
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass += 1
    console.log('  OK   ' + name)
  } else {
    fail += 1
    console.log('  FAIL ' + name + '\n       期望 ' + e + '\n       实际 ' + a)
  }
}

console.log('=== 只发用户原话（userOnly）===\n')

console.log('[1] 配置层：字段 + 默认值')
{
  check('WebinConfig 声明了 userOnly: boolean', /userOnly: boolean/.test(configSrc))
  check('DEFAULT_CONFIG 里 userOnly: true', /userOnly: true,/.test(configSrc))
  check('注释记下了用户原话（可追溯）', /为什么每次都要接一堆额外的提示词/.test(configSrc))
}

console.log('[2] 配置层：checkConfig 的真实行为（transpile 后真跑）')
{
  let ts
  try {
    ts = (await import('typescript')).default
  } catch {
    ts = undefined
  }
  if (ts === undefined) {
    check('typescript 可加载（否则本段无法验证真实行为）', false)
  } else {
    const js = ts.transpileModule(configSrc, { compilerOptions: { target: 99, module: 1 } }).outputText
    const mod = { exports: {} }
    vm.runInNewContext(js, { module: mod, exports: mod.exports, console })
    const checkConfig = mod.exports.checkConfig
    const DEFAULT_CONFIG = mod.exports.DEFAULT_CONFIG
    check('默认配置 userOnly === true', DEFAULT_CONFIG.userOnly, true)
    check('不传该字段 ⇒ 仍是 true', checkConfig({}).config.userOnly, true)
    check('显式 false 生效（老用户能关）', checkConfig({ userOnly: false }).config.userOnly, false)
    const bad = checkConfig({ userOnly: 'yes' })
    check('类型错 ⇒ 回退 true', bad.config.userOnly, true)
    check('类型错 ⇒ 报了 problem（不静默吞掉）', bad.problems.some((p) => p.field === 'userOnly'), true)
  }
}

console.log('[3] adapter：短路必须在拼装之前 return')
{
  check('options 收了 userOnly?: boolean', /userOnly\?: boolean/.test(adapterSrc))
  check('分支条件就是 options.userOnly === true', /if \(options\.userOnly === true\) \{/.test(adapterSrc))
  check("取最后一条 user 消息", /m\.role === 'user'/.test(adapterSrc))
  check('原文走 normalizeNewlines + contentToText', /normalizeNewlines\(contentToText\(lastUser\.content\)\)\.trim\(\)/.test(adapterSrc))
  check('返回体 text 就是 raw（不加前后缀）', /text: raw,/.test(adapterSrc))
  const iBranch = adapterSrc.indexOf('if (options.userOnly === true) {')
  const iParts = adapterSrc.indexOf('const parts: string[] = []')
  check('短路块位于系统提示词拼装之前', iBranch > 0 && iParts > iBranch, true)
  const between = iBranch > 0 && iParts > iBranch ? adapterSrc.slice(iBranch, iParts) : ''
  check('短路块与拼装之间没有 system/toolSection 混入', /parts\.push|toolSection/.test(between), false)
  check('短路块里真的 return 了', /return \{/.test(between), true)
  check('注释写清了「宁可多带也不能发空」的取舍', /宁可多带/.test(adapterSrc))
}

console.log('[4] 调用点：开关真的传下去了')
{
  check('diffPrompt 调用带 userOnly: cfg.userOnly', /userOnly: cfg\.userOnly,/.test(adapterSrc))
  check('cfg 来自 config()', /const cfg = config\(\)/.test(adapterSrc))
}

console.log('[5] 设置页 + 面板条')
{
  check("设置页有 key: 'userOnly' 开关", /key: 'userOnly'/.test(clientSrc))
  check('开关是布尔渲染', /key: 'userOnly',\n\s+label: '只发我的原话',\n\s+bool: true/.test(clientSrc))
  check('面板条有「新对话」按钮', /'新对话',/.test(clientSrc))
  check('新对话 = 导航回 homeUrl', /element_loadURL\(el, provider\.homeUrl\)/.test(clientSrc))
  check('新对话同时清整段快照基线', /baselinePageRef\.current = ''\n\s+baselinePageOkRef\.current = false/.test(clientSrc))
  check('产物里也有这个按钮（构建没漏）', bundle.indexOf('新对话') !== -1)
}

console.log('\n' + (fail === 0 ? '全部通过' : fail + ' 项失败') + '（' + pass + ' 通过 / ' + fail + ' 失败）')
process.exit(fail === 0 ? 0 : 1)
