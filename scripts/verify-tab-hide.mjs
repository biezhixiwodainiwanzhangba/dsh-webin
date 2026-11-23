#!/usr/bin/env node
/**
 * **「网页版对话」标签平时收起 + 输入框左边按钮呼出**测试（m02344）。
 *
 * ## 用户要求
 *
 * > 能不能再优化一下，平时隐藏标签页，在 dsh 的对话窗口加一个按钮呼出对应网页的标签页
 *
 * ## 宿主的硬事实（决定只能这么做）
 *
 *     showTabs = !hideChrome && tabs.length > 1
 *     visibleTabs.map(viewTab => <button role="tab" aria-selected={...}
 *       onClick={() => selectView(viewTab.id)} />)
 *
 *   - 没有「隐藏某个 view 的标签」注册选项；
 *   - 标签栏要求 **多于一个视图**，注销条目会把整条标签栏带走；
 *   - `selectView` 是宿主内部 hook，插件 slot 拿不到（`conversation.input.left`
 *     是 list slot，只有通用 props）。
 *
 * 所以实现是：条目照注册 + CSS 藏**非激活**的网页版标签 + 按钮里**点那个
 * 真实的 tab 按钮**（`HTMLElement.click()` 对 `display:none` 同样派发事件）。
 *
 * ## 断言分三组
 *
 *   1. **常量与选择器契约** —— data 属性名、隐藏规则只作用于「标记 + 非激活」。
 *   2. **行为** —— 真跑 `syncWebinTabMarks` / `applyTabHidden`（假 document）：
 *      标记、激活跟随 aria-selected、幂等、可摘除。
 *   3. **接线** —— 宿主常驻里定时打标记；按钮常驻且点击走呼出，失败才退回设置页。
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
for (const key of ['VIEW_NAME', 'SETTINGS_NAME', 'TAB_MARK_ATTR', 'TAB_ACTIVE_ATTR', 'TAB_HIDE_STYLE_ID']) {
  const hit = new RegExp('const ' + key + " = '([^']*)'").exec(src)
  if (hit !== null) CONSTANTS[key] = hit[1]
}

function transpile(body) {
  return ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: false,
  }).outputText
}

/** 从源码里抠一个函数（花括号配平）。 */
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
  return transpile(src.slice(start, i + 1))
}

/** 假按钮：只实现用到的属性方法。 */
function makeButton(text, selected) {
  const attrs = new Map()
  return {
    textContent: text,
    _clicks: 0,
    classList: { contains: () => false },
    getAttribute(name) {
      if (name === 'aria-selected') return selected ? 'true' : 'false'
      return attrs.has(name) ? attrs.get(name) : null
    },
    hasAttribute(name) {
      return attrs.has(name)
    },
    setAttribute(name, value) {
      attrs.set(name, String(value))
    },
    removeAttribute(name) {
      attrs.delete(name)
    },
    click() {
      this._clicks += 1
    },
    setSelected(next) {
      selected = next
    },
  }
}

/** 假 document：head 里装 style，标签栏里装 tab 按钮。 */
function makeDoc(buttons) {
  const head = {
    children: [],
    appendChild(el) {
      this.children.push(el)
    },
  }
  const strip = {
    querySelectorAll(selector) {
      if (selector !== 'button[role="tab"]') return []
      return buttons
    },
  }
  const doc = {
    head,
    querySelector(selector) {
      return selector === '[data-conversation-tabs]' ? strip : null
    },
    getElementById(id) {
      return head.children.find((el) => el.id === id) ?? null
    },
    createElement() {
      return {
        tag: 'style',
        id: '',
        textContent: '',
        remove() {
          const k = head.children.indexOf(this)
          if (k >= 0) head.children.splice(k, 1)
        },
      }
    },
  }
  return doc
}

/** 把四个函数拼起来求值，返回 { document, api }。 */
function makeRuntime(buttons) {
  const document = makeDoc(buttons)
  const code = [
    extractFn('isViewLabel'),
    extractFn('conversationTabButtons'),
    extractFn('syncWebinTabMarks'),
    extractFn('applyTabHidden'),
    'globalThis.__api = { isViewLabel, conversationTabButtons, syncWebinTabMarks, applyTabHidden }',
  ].join('\n')
  const ctx = { document, globalThis: {} }
  Object.assign(ctx, CONSTANTS)
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  return { document, api: ctx.globalThis.__api }
}

console.log('=== 网页版对话：标签收起 + 按钮呼出 ===\n')

console.log('[1] 常量与隐藏规则')
{
  check('TAB_MARK_ATTR = data-dsh-webin-tab', CONSTANTS.TAB_MARK_ATTR, 'data-dsh-webin-tab')
  check('TAB_ACTIVE_ATTR = data-dsh-webin-tab-active', CONSTANTS.TAB_ACTIVE_ATTR, 'data-dsh-webin-tab-active')
  check('TAB_HIDE_STYLE_ID = dsh-webin-hide-tab', CONSTANTS.TAB_HIDE_STYLE_ID, 'dsh-webin-hide-tab')

  const region = src.slice(src.indexOf('function applyTabHidden('))
  const body = region.slice(0, region.indexOf('\n}\n') + 2)
  check('隐藏规则只看标记 + 非激活', body.includes("'[' + TAB_MARK_ATTR + '=\"1\"][' + TAB_ACTIVE_ATTR + '=\"false\"]{display:none !important}'"))
  check('用 !important（宿主 tab 有 inline 级别的 flex 样式）', body.includes('!important'))
  check('不依赖 CSS Modules hash 类名', !/[a-zA-Z]{6}_(tab|tabs)\b/.test(body))
}

console.log('[2] 行为：标记 / 激活跟随 / 样式幂等')
{
  const chat = makeButton('对话', true)
  const webin = makeButton(CONSTANTS.VIEW_NAME, false)
  const { document, api } = makeRuntime([chat, webin])

  check('找得到网页版标签', api.syncWebinTabMarks(), true)
  check('网页版标签被标记', webin.getAttribute(CONSTANTS.TAB_MARK_ATTR), '1')
  check('未激活 ⇒ active=false', webin.getAttribute(CONSTANTS.TAB_ACTIVE_ATTR), 'false')
  check('「对话」标签不被标记', chat.hasAttribute(CONSTANTS.TAB_MARK_ATTR), false)
  check('标记不会误伤「对话」的 active', chat.hasAttribute(CONSTANTS.TAB_ACTIVE_ATTR), false)

  webin.setSelected(true)
  chat.setSelected(false)
  api.syncWebinTabMarks()
  check('切到网页版后 active=true（CSS 随即放它出来）', webin.getAttribute(CONSTANTS.TAB_ACTIVE_ATTR), 'true')

  api.applyTabHidden(true)
  const styles = () => document.head.children.filter((el) => el.id === CONSTANTS.TAB_HIDE_STYLE_ID)
  check('装上隐藏样式', styles().length, 1)
  check('样式内容正确', styles()[0].textContent, '[data-dsh-webin-tab="1"][data-dsh-webin-tab-active="false"]{display:none !important}')
  api.applyTabHidden(true)
  check('幂等：重复调用不叠样式', styles().length, 1)
  api.applyTabHidden(false)
  check('可摘除', styles().length, 0)

  const empty = makeRuntime([])
  check('没有标签栏时不炸、返回 false', empty.api.syncWebinTabMarks(), false)
  check('空标签栏返回空数组', empty.api.conversationTabButtons().length, 0)
}

console.log('[3] 接线：常驻定时打标记 + 按钮呼出')
{
  const hostEffect = src.slice(src.indexOf('标签栏里的「网页版对话」平时收起'))
  const body = hostEffect.slice(0, hostEffect.indexOf('}, [])') + 6)
  check('宿主常驻里装隐藏样式', body.includes('applyTabHidden(true)'))
  check('首次渲染就打标记', body.includes('syncWebinTabMarks()'))
  check('定时重打（宿主重渲染会换节点）', body.includes('window.setInterval'))
  check('间隔 1s', body.includes('1_000'))
  check('卸载时摘掉样式（插件停用要恢复原样）', body.includes('applyTabHidden(false)'))

  check('不再「有标签栏就不渲染」', src.includes('if (hasTabs) return null'), false)
  check('输入框左侧按钮已撤掉（入口移进「+」菜单）', src.includes('export function LdwLoginButton'), false)

  const fn = src.slice(src.indexOf('function openWebinTab('))
  const fnBody = fn.slice(0, fn.indexOf('\n}\n') + 2)
  check('呼出前先打激活标记（避免「点了没反应」）', fnBody.indexOf('TAB_ACTIVE_ATTR') < fnBody.indexOf('switchToLdwView()'))
  check('真正点击复用 switchToLdwView', fnBody.includes('switchToLdwView()'))
  check('呼出后重新同步标记', fnBody.includes('syncWebinTabMarks()'))

  /**
   * m02553：入口搬进输入框「+」菜单（宿主 commandUi 的客户端命令贡献）。
   * 打开面板时先切平台、再呼出标签；呼出失败退回设置页并打原因。
   */
  const openFrom = src.slice(src.indexOf('function openPanelFromMenu('))
  const openFromBody = openFrom.slice(0, openFrom.indexOf('\n}\n') + 2)
  check('菜单入口先把平台交给面板桥', openFromBody.includes('panelBridge.open(platformId)'))
  check('呼出失败才退回设置页', openFromBody.indexOf('panelBridge.open') < openFromBody.indexOf('openSettingsAtLdwSection()'))
  check('失败原因打出来（不静默）', openFromBody.includes('console.warn'))

  const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  check('产物里有隐藏样式 id', bundle.includes('dsh-webin-hide-tab'))
  check('产物里有激活标记', bundle.includes('data-dsh-webin-tab-active'))
  check('产物里没有 hasTabs 门禁', bundle.includes('if (hasTabs) return null'), false)
}

console.log('\n通过 ' + pass + ' / 失败 ' + fail)
if (fail > 0) process.exit(1)
