#!/usr/bin/env node
/**
 * **面板命名与工具条**测试（m01678）。
 *
 * ## 用户要求
 *
 * > 优化一下ldw界面，标签名改为贴切的中文解释
 *
 * 两件事，分开断言：
 *   A. **命名** —— 标签栏不再出现内部代号 LDW，换成「网页版对话」；
 *      但 DOM 文本匹配必须**新旧都认**（旧标签、文档里的 LDW 仍能命中），
 *      否则「去登录 / 切标签」这类流程会偶发失效。
 *   B. **界面** —— 工具条只留人话（状态胶囊 + 幽灵按钮），
 *      日志文案（\`已发送(click)\`）和「等待任务…」这种内部措辞必须消失。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const src = readFileSync(join(ROOT, 'src', 'client', 'index.ts'), 'utf8')
const cssStart = src.indexOf('const CSS = ')
/** CSS 模板的结束反引号（模板以「换行 + 反引号」收尾）⇒ 不能用注释头当终点。 */
const css = src.slice(cssStart, src.indexOf('\n`', cssStart))

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

/** 源码里的字符串常量（给函数体当作用域用）。 */
const CONSTANTS = {}
for (const key of ['VIEW_NAME', 'SETTINGS_NAME']) {
  const hit = new RegExp("const " + key + " = '([^']*)'").exec(src)
  if (hit !== null) CONSTANTS[key] = hit[1]
}

/** 从源码里抠一个函数（括号配平），去掉类型标注后求值。 */
function extractFn(name) {
  const start = src.indexOf('function ' + name + '(')
  if (start < 0) throw new Error('源码里没有 function ' + name)
  let depth = 0
  let i = src.indexOf('{', start)
  const from = i
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) break
    }
  }
  const body = src.slice(start, i + 1)
  const js = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: false,
  }).outputText
  return vm.runInNewContext('(' + js.trim() + ')', { ...CONSTANTS })
}

console.log('=== 面板命名 / 工具条 ===\n')

console.log('[1] 显示名常量')
{
  check('VIEW_NAME = 网页版对话', /const VIEW_NAME = '网页版对话'/.test(src))
  check('SETTINGS_NAME = 网页版对话设置', /const SETTINGS_NAME = '网页版对话设置'/.test(src))
  check('两个 label 都指向 VIEW_NAME（视图 + 输入框入口）', (src.match(/label: \(\) => VIEW_NAME/g) ?? []).length, 2)
  check('设置分区 label 指向 SETTINGS_NAME', src.includes('label: () => SETTINGS_NAME'))
  check('⭐ 没有残留 label: () => \'LDW\'', !/label: \(\) => 'LDW/.test(src))
}

console.log('\n[2] DOM 文本匹配：新旧都认')
{
  const isViewLabel = extractFn('isViewLabel')
  check('新名命中', isViewLabel('网页版对话'), true)
  check('设置行命中', isViewLabel('网页版对话设置'), true)
  check('旧代号仍命中', isViewLabel('LDW'), true)
  check('带徽标的文本命中', isViewLabel('网页版对话 3'), true)
  check('对话标签不误命中', isViewLabel('对话'), false)
  check('上下文标签不误命中', isViewLabel('上下文'), false)
  check('空文本不命中', isViewLabel(''), false)
  check('switchToLdwView 走同一判定', src.includes('if (!isViewLabel(text)) continue'))
  check('设置页导航也认中文名', src.includes("text.includes(VIEW_NAME)"))
}

console.log('\n[3] 工具条：只留人话')
{
  check('⭐ 不再把 how 直接拼进界面', !src.includes('已发送(${lastSend.how})'))
  check('how 走 howText()', src.includes('howText(lastSend.how)'))
  check('「等待任务…」已删除', !src.includes('等待任务…'))
  check('状态胶囊类名存在', src.includes("className: 'webin-status'"))
  check('状态圆点在等回复时脉动', src.includes("'webin-dot wait'") && src.includes("'webin-dot ok'"))
  check('动作按钮改幽灵样式', (src.match(/className: 'webin-act'/g) ?? []).length >= 2)
  check('动作组前有分隔线', src.includes("className: 'webin-sep'"))
  check('未登录提示条存在', src.includes("className: 'webin-tip'"))
  check('提示条只在未登录时出现', /ready && !loggedIn\s*\(/.test(src.replace('\n', ' ')) || src.includes('ready && !loggedIn'))
}

console.log('\n[4] howText 真的翻译')
{
  const howText = extractFn('howText')
  check('click → 点击发送', howText('click'), '点击发送')
  check('enter → 回车发送', howText('enter'), '回车发送')
  check('submit → 表单提交', howText('submit'), '表单提交')
  check('空值兜底', howText(''), '已发出')
  check('未知值原样透传（不吞信息）', howText('drag-drop'), 'drag-drop')
}

console.log('\n[5] CSS：圆角裁切 + 弱化 chrome')
{
  check('webview 用 clip-path 圆角', /clip-path:inset\(0 round 10px\)/.test(css))
  check('guest 四周留白', /\.webin-guest\{[^}]*padding:0 8px 8px/.test(css))
  check('下拉自绘箭头（去原生外观）', /appearance:none/.test(css) && /background-image:url\("data:image\/svg\+xml/.test(css))
  check('旧描边按钮样式已移除', !/\.webin-btn\{/.test(css))
  check('未就绪提示让开 40px 工具条', /\.webin-note\{[^}]*top:40px/.test(css))
  check('提示层不吃鼠标事件', /\.webin-note\{[^}]*pointer-events:none/.test(css))
  check('工具条 40px + layer-1 底', /\.webin-bar\{[^}]*height:40px/.test(css) && /background:var\(--dsw-alias-bg-layer-1\)/.test(css))
}

console.log('\n[6] 其余用户可见文案不再出现 LDW')
{
  check('设置页标题', src.includes("createElement('h2', null, '网页版对话接入')"))
  check('输入框入口按钮', src.includes("'网页版对话'"))
  check('验证墙提示改到标签', src.includes('请在「网页版对话」标签里人工完成验证'))
  check('没有「LDW 面板」残留', !src.includes('LDW 面板'))
}

console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + '：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
