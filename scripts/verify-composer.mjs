#!/usr/bin/env node
/**
 * **收起 / 弹出 DSH 输入框**测试（m01957）。
 *
 * ## 用户要求
 *
 * > 底下这个 dsh 对话框能不能选择隐藏或弹出？
 *
 * ## 为什么要做成插件自己关
 *
 * 宿主（`@deepseek-ai/dsh-client-ui-conversation`）没有这个开关：
 * `conversation.composer` 是个 slot，`ConversationRoot` 只有布局变量，
 * 快捷键里也没有 collapse。所以只能从外面用一条 `<style>` 关掉它。
 *
 * ## 断言分三组
 *
 *   1. **契约** —— 只按 data 属性选（`[data-composer-seat]` / `[data-composer-stat]`），
 *      **绝不能出现 CSS Modules 的 hash 类名** —— 那是每次改版都会变的东西。
 *   2. **行为** —— 真跑 `applyComposerHidden` / `read/writeComposerHidden`，
 *      幂等、可摘除、localStorage 抛异常不影响。
 *   3. **安全性** —— 效果必须挂在 `composerHidden && visible` 上：
 *      切走标签就恢复，否则用户切回普通对话会发现输入框没了、按钮又不在视野里。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const src = readFileSync(join(ROOT, 'src', 'client', 'index.ts'), 'utf8')

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

/** 源码里的常量，给求值出来的函数当作用域。 */
const CONSTANTS = {}
for (const key of ['COMPOSER_HIDE_KEY', 'COMPOSER_HIDE_STYLE_ID']) {
  const hit = new RegExp('const ' + key + " = '([^']*)'").exec(src)
  if (hit !== null) CONSTANTS[key] = hit[1]
}

/** 从源码里抠一个函数（花括号配平），去掉类型标注后求值。 */
function extractFn(name) {
  const start = src.indexOf('function ' + name + '(')
  if (start < 0) throw new Error('源码里没有 function ' + name)
  let depth = 0
  let i = src.indexOf('{', start)
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) break
    }
  }
  const body = src.slice(start, i + 1)
  return evalFn(body)
}

function evalFn(body) {
  const js = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: false,
  }).outputText
  return js
}

/** 假 document：只实现用到的四个方法/属性。 */
function makeDoc() {
  const head = { children: [], appendChild(el) { this.children.push(el) } }
  const doc = {
    head,
    getElementById(id) {
      return head.children.find((el) => el.id === id) ?? null
    },
    createElement(tag) {
      return { tag, id: '', textContent: '', remove() {
        const k = head.children.indexOf(this)
        if (k >= 0) head.children.splice(k, 1)
      } }
    },
  }
  return doc
}

/** 把函数体放进 `function` 包装里求值，注入假 document 与常量。 */
function runFn(fnBody, document) {
  const js = evalFn('function __f(document) ' + fnBody.slice(fnBody.indexOf('{')))
  const ctx = { ...CONSTANTS, document, window: globalThis.window }
  return vm.runInNewContext('(' + js + ')', ctx)(document)
}

console.log('=== 收起 / 弹出 DSH 输入框 ===\n')

console.log('[1] 常量与选择器契约')
{
  check('COMPOSER_HIDE_KEY 存在', src.includes("const COMPOSER_HIDE_KEY = 'dsh-webin:hide-composer'"))
  check('COMPOSER_HIDE_STYLE_ID 存在', src.includes("const COMPOSER_HIDE_STYLE_ID = 'dsh-webin-hide-composer'"))

  const region = src.slice(src.indexOf('function applyComposerHidden('))
  const body = region.slice(0, region.indexOf('\n}\n') + 2)
  check('隐藏输入区：data-composer-seat', body.includes('[data-composer-seat]{display:none !important}'))
  check('隐藏状态行：data-composer-stat', body.includes('[data-composer-stat]{display:none !important}'))
  check('⭐ 不依赖 CSS Modules hash 类名', !/an3WzG_|composerSeat\b/.test(body))
  check('⭐ 选择器里没有任何 .class 形式', !/\.[a-zA-Z][\w-]*\s*(,|\{)/.test(body))
  check('用 !important（宿主 sticky 布局里普通声明会被压回）', (body.match(/!important/g) ?? []).length, 2)
}

console.log('\n[2] applyComposerHidden 行为')
{
  const start = src.indexOf('function applyComposerHidden(')
  const fbody = src.slice(start, src.indexOf('\n}\n', start) + 2)
  const js = evalFn(fbody)
  /** 每次调用都新建一个 vm 上下文：document 是自由变量，只能这样注入。 */
  const call = (doc, hidden) =>
    vm.runInNewContext('(' + js + ')', { ...CONSTANTS, document: doc })(hidden)

  const doc1 = makeDoc()
  call(doc1, true)
  check('首次隐藏装了一条 style', doc1.head.children.length, 1)
  check('style 的 id 正确', doc1.head.children[0].id, CONSTANTS.COMPOSER_HIDE_STYLE_ID)
  check('规则同时命中输入区与状态行', /\[data-composer-seat\]/.test(doc1.head.children[0].textContent) && /\[data-composer-stat\]/.test(doc1.head.children[0].textContent))

  call(doc1, true)
  check('幂等：再隐藏一次仍是 1 条', doc1.head.children.length, 1)

  call(doc1, false)
  check('弹出后 style 被摘掉', doc1.head.children.length, 0)

  const doc2 = makeDoc()
  call(doc2, false)
  check('本来没有 style 时弹出是空操作（不抛）', doc2.head.children.length, 0)

  let threw = false
  try {
    call(undefined, true)
  } catch {
    threw = true
  }
  check('没有 document 时静默返回', threw, false)
}

console.log('\n[3] localStorage 读写')
{
  const rb = src.slice(src.indexOf('function readComposerHidden('))
  const readBody = rb.slice(0, rb.indexOf('\n}\n') + 2)
  const wb = src.slice(src.indexOf('function writeComposerHidden('))
  const writeBody = wb.slice(0, wb.indexOf('\n}\n') + 2)

  const store = new Map()
  const win = { localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  } }
  const ctx = { ...CONSTANTS, window: win }
  const read = vm.runInNewContext(evalFn(readBody) + '\nreadComposerHidden', ctx)
  const write = vm.runInNewContext(evalFn(writeBody) + '\nwriteComposerHidden', ctx)

  check('默认（没存过）是展开', read(), false)
  write(true)
  check('隐藏后写进 key=1', store.get(CONSTANTS.COMPOSER_HIDE_KEY), '1')
  check('读回来是收起', read(), true)
  write(false)
  check('弹出后 key 被删', store.has(CONSTANTS.COMPOSER_HIDE_KEY), false)
  check('读回来是展开', read(), false)

  const boom = { localStorage: { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() { throw new Error('denied') } } }
  const ctx2 = { ...CONSTANTS, window: boom }
  const read2 = vm.runInNewContext(evalFn(readBody) + '\nreadComposerHidden', ctx2)
  const write2 = vm.runInNewContext(evalFn(writeBody) + '\nwriteComposerHidden', ctx2)
  let t2 = false
  try {
    read2()
    write2(true)
  } catch {
    t2 = true
  }
  check('localStorage 抛异常时静默降级', t2, false)
}

console.log('\n[4] 挂载与安全边界')
{
  check('state 初值读 localStorage', /const \[composerHidden, setComposerHidden\] = useState<boolean>\(\(\) => readComposerHidden\(\)\)/.test(src))
  check(
    '⭐ effect 只在「收起 且 本标签在前台」时生效',
    /applyComposerHidden\(composerHidden && visible\)/.test(src),
  )
  check('effect 依赖含 composerHidden 与 visible', /\}, \[composerHidden, visible\]\)/.test(src))
  check('组件卸载时不主动恢复（用户选择要留着）', !/return \(\) => applyComposerHidden\(false\)/.test(src))

  check('工具条有收起/弹出按钮', src.includes("composerHidden ? '弹出对话栏' : '收起对话栏'"))
  check('点击时同时改 state 与持久化', /setComposerHidden\(next\)[\s\S]{0,80}writeComposerHidden\(next\)/.test(src))
  check('按钮 title 提示切标签会恢复', src.includes('切到其他标签会自动恢复'))
  check('按钮复用 webin-act 样式', /className: 'webin-act',\s*\n\s*key: 'h'/.test(src))
  check('按钮后面带分隔线（与刷新区分开）', /createElement\('span', \{ className: 'webin-sep', key: 'sep2' \}\)/.test(src))
}

console.log('\n' + (fail === 0 ? 'ALL CLEAN' : 'FAILURES: ' + fail) + ' (' + pass + ' passed)')
process.exit(fail === 0 ? 0 : 1)
