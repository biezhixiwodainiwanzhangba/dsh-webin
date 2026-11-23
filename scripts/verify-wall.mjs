#!/usr/bin/env node
/**
 * ## 验证墙（captcha）识别 + 拟人键入 —— 守住两处补丁
 *
 * ## 用户报的现象
 *
 *     LDW · 豆包 · 已登录 · 10:21:07 已发送(click)（已确认发出，等待页面回复）· 收到 0 条
 *     页面中央弹出「请选择所有符合上文描述的图片，并拖拽到下方」
 *
 * 插件当时对验证墙**零处理**：不检测、不暂停，照旧按 replyTimeoutMs（默认
 * 10 分钟）干等，bar 一直「收到 0 条」。根因之一是「确认发送」只探
 * **输入框是否被清空** —— 而验证墙弹出时输入框也会被清空，于是误判成功。
 *
 * 现在三处闸门：
 *   1. `buildFillScript` 填字前 —— 有墙就 `stage:'captcha'`，一个字都不填
 *   2. `buildTriggerScript` 点火前 / 探针里 —— 有墙就 `reason:'captcha'`
 *   3. 客户端等回复的 tick 每 6 秒轻量探一次（`buildWallCheckScript`）
 *
 * ## ⚠️ 为什么三份内联而不是模块级常量
 *
 * `verify-scripts-parse.mjs` 会把 `build*Script` 的**函数体单独抠出来 eval**。
 * 函数体一旦引用外部标识符（当初写的 `WALL_HELPER_SRC`）就 `ReferenceError`，
 * 三个生成器全部失败。所以 helper 在三个模板里**各内联一份**，用
 * `WALL-HELPER:BEGIN/END` 标记包住 —— 本脚本逐字节比较三份，防漂移。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const chatSrc = readFileSync(join(ROOT, 'src', 'client', 'chat.ts'), 'utf8')
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
    console.log(`  OK   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}\n       期望 ${e}\n       实际 ${a}`)
  }
}

/** 抠出所有 `/* WALL-HELPER:BEGIN *\/ ... /* WALL-HELPER:END *\/` 之间的正文。 */
function helperBlocks(text) {
  const out = []
  const re = /\/\* WALL-HELPER:BEGIN \*\/([\s\S]*?)\/\* WALL-HELPER:END \*\//g
  let m
  while ((m = re.exec(text)) !== null) out.push(m[1])
  return out
}

/** 一个反斜杠（避免在源码里数转义层）。 */
const BS_ = String.fromCharCode(92)
console.log('=== 验证墙识别 + 拟人键入 ===\n')

console.log('[1] 源码：helper 三份内联（不得引用模块级常量）')
{
  const blocks = helperBlocks(chatSrc)
  check('源码里有 3 份 helper（填充 / 触发 / 轻量检查）', blocks.length, 3)
  check('⭐ 源码里不再有 WALL_HELPER_SRC 引用', /WALL_HELPER_SRC/.test(chatSrc), false)
  check('⭐ 三份逐字节一致（防漂移）', new Set(blocks.map((x) => x.trim())).size, 1)
  const one = blocks[0] ?? ''
  check('有 wall() 检测函数', /function wall\(\)/.test(one), true)
  check('强特征覆盖 geetest', /geetest/.test(one), true)
  check('强特征覆盖 captcha iframe', /iframe\[src\*="captcha"\]/.test(one), true)
  check('⭐ 文案判据含豆包那句', /请选择所有符合/.test(one), true)
  check('⭐ 文案判据含拖拽引导', /拖拽到下方/.test(one), true)
  /** 只看够大的可见元素 —— 否则页面上的小图标/说明文案会误判成验证墙。 */
  check('尺寸门槛 >=200x90', /r\.width >= 200 && r\.height >= 90/.test(one), true)
}

console.log('\n[2] 产物：三个生成脚本各自自包含且一致')
{
  /**
   * 复用 verify-scripts-parse 的抠取思路：跳过字符串/模板/注释后配花括号。
   * 这里只测三个函数，参数用能跑通的最小实参。
   */
  function extract(name) {
    const re = new RegExp(`function ${name}\\(([^)]*)\\)\\s*\\{`)
    const m = re.exec(bundle)
    if (m === null) return null
    const open = bundle.indexOf('{', m.index)
    let depth = 0
    let mode = null
    let tplDepth = 0
    for (let i = open; i < bundle.length; i += 1) {
      const c = bundle[i]
      const n = bundle[i + 1]
      if (mode === null) {
        if (c === "'" || c === '"') mode = c
        else if (c === '`') { mode = '`'; tplDepth = 0 }
        else if (c === '/' && n === '/') { mode = '//'; i += 1 }
        else if (c === '/' && n === '*') { mode = '/*'; i += 1 }
        else if (c === '{') depth += 1
        else if (c === '}') {
          depth -= 1
          if (depth === 0) return bundle.slice(m.index, i + 1)
        }
        continue
      }
      if (mode === '//') { if (c === '\n') mode = null }
      else if (mode === '/*') { if (c === '*' && n === '/') { mode = null; i += 1 } }
      else if (mode === "'" || mode === '"') { if (c === '\\') i += 1; else if (c === mode) mode = null }
      else if (c === '\\') i += 1
      else if (c === '$' && n === '{') { tplDepth += 1; i += 1 }
      else if (c === '}' && tplDepth > 0) tplDepth -= 1
      else if (c === '`' && tplDepth === 0) mode = null
    }
    return null
  }

  const cases = [
    ['buildWallCheckScript', []],
    ['buildFillScript', ['你好']],
    ['buildTriggerScript', [{}, '你好']],
  ]
  const outs = {}
  for (const [name, args] of cases) {
    const body = extract(name)
    check(`产物里能抠出 ${name}`, body !== null, true)
    if (body === null) continue
    // eslint-disable-next-line no-new-func
    const fn = new Function(`return (${body})`)()
    const out = fn(...args)
    outs[name] = out
    check(`${name} 生成的脚本自带 wall()`, /function wall\(\)/.test(out), true)
    check(`${name} 生成的脚本不引用 WALL_HELPER_SRC`, /WALL_HELPER_SRC/.test(out), false)
  }
  const gens = Object.values(outs).filter((x) => typeof x === 'string')
  check('三个生成器都产出了脚本', gens.length, 3)
  const genBlocks = gens.map((g) => helperBlocks(g)[0] ?? '')
  check('⭐ 产物里三份 helper 也一致', new Set(genBlocks.map((x) => x.trim())).size, 1)
  /**
   * ⚠️ 不能拿源码那份直接比：源码里的 helper 住在模板字符串里，写的是
   * `\\\\s+`（两层），注入页面后变成一层 `\\s+`。差的就是这层转义。
   * 所以两边都按「模板求值后」的形态归一化再比 —— 比的是**逻辑**，不是转义层数。
   */
  const unTpl = (t) => t.split(BS_ + BS_).join(BS_).trim()
  check('⭐ 产物的 helper 与源码等价（忽略模板转义层）', unTpl(genBlocks[0] ?? '') === unTpl(helperBlocks(chatSrc)[0] ?? ''), true)
}

console.log('\n[3] 闸门位置：填字前 / 点火前 / 探针内')
{
  const fill = new Function(`return (${extractSafe('buildFillScript')})`)()('你好')
  const trig = new Function(`return (${extractSafe('buildTriggerScript')})`)()({}, '你好')
  check('⭐ fill：有 stage captcha 分支', /stage: 'captcha'/.test(fill), true)
  /** typeHuman 的定义在脚本顶部，比的是**调用点**。 */
  check('⭐ fill：captcha 闸门在填字之前', fill.indexOf("stage: 'captcha'") < fill.indexOf('await typeHuman(node'), true)
  check('fill：错误话说清了「人工验证」', /需要人工在「网页版对话」标签里完成验证/.test(fill), true)
  check('⭐ trigger：点火前有 captcha 闸门', /reason: 'captcha'/.test(trig), true)
  check('⭐ trigger：两处（点火前 + 探针）', (trig.match(/reason: 'captcha'/g) ?? []).length, 2)
  check('trigger：探针里说的是「点发送之后」', /点发送后页面弹出验证墙/.test(trig), true)

  function extractSafe(name) {
    const re = new RegExp(`function ${name}\\(([^)]*)\\)\\s*\\{`)
    const m = re.exec(bundle)
    if (m === null) throw new Error(`not found: ${name}`)
    const open = bundle.indexOf('{', m.index)
    let depth = 0
    let mode = null
    let tplDepth = 0
    for (let i = open; i < bundle.length; i += 1) {
      const c = bundle[i]
      const n = bundle[i + 1]
      if (mode === null) {
        if (c === "'" || c === '"') mode = c
        else if (c === '`') { mode = '`'; tplDepth = 0 }
        else if (c === '/' && n === '/') { mode = '//'; i += 1 }
        else if (c === '/' && n === '*') { mode = '/*'; i += 1 }
        else if (c === '{') depth += 1
        else if (c === '}') { depth -= 1; if (depth === 0) return bundle.slice(m.index, i + 1) }
        continue
      }
      if (mode === '//') { if (c === '\n') mode = null }
      else if (mode === '/*') { if (c === '*' && n === '/') { mode = null; i += 1 } }
      else if (mode === "'" || mode === '"') { if (c === '\\') i += 1; else if (c === mode) mode = null }
      else if (c === '\\') i += 1
      else if (c === '$' && n === '{') { tplDepth += 1; i += 1 }
      else if (c === '}' && tplDepth > 0) tplDepth -= 1
      else if (c === '`' && tplDepth === 0) mode = null
    }
    throw new Error(`unbalanced: ${name}`)
  }
}

console.log('\n[4] 拟人键入')
{
  const fill = new Function(`return (${extractSafe4('buildFillScript')})`)()('你好世界')
  function extractSafe4(name) {
    const re = new RegExp(`function ${name}\\(([^)]*)\\)\\s*\\{`)
    const m = re.exec(bundle)
    if (m === null) throw new Error(`not found: ${name}`)
    const open = bundle.indexOf('{', m.index)
    let depth = 0
    let mode = null
    let tplDepth = 0
    for (let i = open; i < bundle.length; i += 1) {
      const c = bundle[i]
      const n = bundle[i + 1]
      if (mode === null) {
        if (c === "'" || c === '"') mode = c
        else if (c === '`') { mode = '`'; tplDepth = 0 }
        else if (c === '/' && n === '/') { mode = '//'; i += 1 }
        else if (c === '/' && n === '*') { mode = '/*'; i += 1 }
        else if (c === '{') depth += 1
        else if (c === '}') { depth -= 1; if (depth === 0) return bundle.slice(m.index, i + 1) }
        continue
      }
      if (mode === '//') { if (c === '\n') mode = null }
      else if (mode === '/*') { if (c === '*' && n === '/') { mode = null; i += 1 } }
      else if (mode === "'" || mode === '"') { if (c === '\\') i += 1; else if (c === mode) mode = null }
      else if (c === '\\') i += 1
      else if (c === '$' && n === '{') { tplDepth += 1; i += 1 }
      else if (c === '}' && tplDepth > 0) tplDepth -= 1
      else if (c === '`' && tplDepth === 0) mode = null
    }
    throw new Error(`unbalanced: ${name}`)
  }
  check('有 typeHuman', /async function typeHuman\(el, value\)/.test(fill), true)
  check('逐字派发 keydown', /fireKey\(el, 'keydown', ch\)/.test(fill), true)
  check('逐字派发 keyup', /fireKey\(el, 'keyup', ch\)/.test(fill), true)
  check('带 beforeinput', /beforeinput/.test(fill), true)
  check('带 inputType insertText', /insertText/.test(fill), true)
  /** 人工节奏：单字符间隔有抖动，不是固定 0ms。 */
  check('⭐ 字符间隔有随机抖动', /Math\.random\(\)/.test(fill), true)
  check('长文本有上限（否则一轮要打几分钟）', /MAX_TYPED = 400/.test(fill), true)
  check('超长走 fallback 并标注', /typed-skipped/.test(fill), true)
}

console.log('\n[5] 客户端接线 + 产物新鲜度')
{
  check('⭐ 客户端引入 buildWallCheckScript', /buildWallCheckScript/.test(clientSrc), true)
  check('⭐ 填字阶段 captcha 单独一路', /fill\.stage === 'captcha'/.test(clientSrc), true)
  check('⭐ 触发阶段 captcha 单独一路', /trig\.reason === 'captcha'/.test(clientSrc), true)
  check('⭐ 等回复期间轻量轮询', /WALL_CHECK_MS/.test(clientSrc), true)
  check('wallCheckAtRef 节流', /wallCheckAtRef/.test(clientSrc), true)
  check('captcha 错误前缀', /captcha: \$\{/.test(clientSrc), true)

  for (const [label, re] of [
    ['buildWallCheckScript', /buildWallCheckScript/],
    ['stage captcha', /stage: 'captcha'/],
    ['reason captcha', /reason: 'captcha'/],
    ['人工验证提示', /需要人工在「网页版对话」标签里完成验证/],
    ['轻量轮询', /WALL_CHECK_MS/],
  ]) {
    check(`⭐ 产物含「${label}」（说明已重新构建）`, re.test(bundle), true)
  }
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
process.exit(process.exitCode)
