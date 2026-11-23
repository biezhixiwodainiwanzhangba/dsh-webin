#!/usr/bin/env node
/**
 * ## 增量差分（answer 与提问对不上）—— 守住 `page` 快照 + `stripEcho` + 历史安全闸
 *
 * ## 用户报的现象
 *
 *     LDW · 豆包 · 已登录 · 模型 webin-doubao/doubao:doubao-fast
 *     用户：「生成一段诗句」
 *     交付：「解释分入保险…… AI 生成可能有误 请核实 / 2025年2月28日 16:20」
 *
 * 那是页面里一条**上个月的历史回复**。用户的原话：
 *
 *     「有问题，提示词和我输入的要求不对应」
 *
 * ## 根因（三层，缺一层都不成立）
 *
 *   1. 豆包 DOM 全是 Tailwind 工具类 + 哈希后缀（flex / content-cjRQVY /
 *      panel-fvxXfj），没有任何稳定语义类名 ⇒ `CANDIDATES` 全 0 命中
 *   2. 全 0 命中 ⇒ 落 `longest-div` 兜底 ⇒ `last` = **整段对话**（实测 1106 字）
 *   3. 交付判据只看「条数增长 / 内容变化」⇒ 兜底内容一变就交付
 *      而基线抓取失败时基线被重置成 0 ⇒ 第一次轮询就 `countGrew`
 *
 * ## 修法（结构上排除历史，而不是加判据）
 *
 *   - `buildScrapeScript` 多返回一份 `page`（主内容区整段文本）
 *   - 发送前存 `baselinePageRef`；tick 里只取**后缀增量**（历史必在增量之前）
 *   - `stripEcho` 把「本轮自己发出去的那条消息」剥掉，剩下才是回复
 *   - 基线**读不到就一条都不发**（fail-closed）：卡死用户看得见，交错内容看不见
 *   - 历史安全闸：增量有内容，或精确选择器命中 —— 兜底 + 增量为空一律不交
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const hookSrc = readFileSync(join(ROOT, 'src', 'client', 'hook.ts'), 'utf8')
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

console.log('=== 增量差分 / 历史安全闸 ===\n')

console.log('[1] 抓取脚本多给一份整段快照')
{
  check('hook 返回体含 page 字段', /page: \(function \(\)/.test(hookSrc))
  check('page 是 tidy(render(root))（与 last 同源同格式）', /return tidy\(render\(root\)\)/.test(hookSrc))
  check('page 读不到时给空串（不抛错拖死抓取）', /catch \(e\) \{ return ''; \}/.test(hookSrc))
  check('注释写清了 Tailwind 类名不可用这条依据', /Tailwind/.test(hookSrc))
}

console.log('[2] 客户端：基线快照 + 失败即拒发')
{
  check('有 baselinePageRef（整段快照）', /const baselinePageRef = useRef<string>\(''\)/.test(clientSrc))
  check('有 baselinePageOkRef（区分「没读到」与「页面为空」）', /const baselinePageOkRef = useRef<boolean>\(false\)/.test(clientSrc))
  check('⭐ 基线读不到就 return（不再重置成 0 继续跑）', /if \(!baseRead\) \{[\s\S]{0,900}?return\n/.test(clientSrc))
  check('⭐ 报错文案说清「本轮没有发送」', /没有发送/.test(clientSrc))
  check('⭐ 报错前先 clearPending（否则 job 挂着）', /if \(!baseRead\) \{[\s\S]{0,600}?clearPending\(\)[\s\S]{0,600}?api\/job\/\$\{id\}\/result/.test(clientSrc))
  check('解析基线时取 page', /typeof base\.page === 'string'/.test(clientSrc))
}

console.log('[3] stripEcho：剥掉自己发出去的那条')
{
  check('有 stripEcho 函数', /function stripEcho\(delta: string, sent: string\): string/.test(clientSrc))
  check('三档 needle（全文 / 尾 60 / 头 60）', /d\.lastIndexOf\(n\)/.test(clientSrc) && /s\.slice\(-60\)/.test(clientSrc) && /s\.slice\(0, 60\)/.test(clientSrc))
  check('取**最后**一次命中（多条消息里取最靠后的回显）', /at \+ n\.length > cut/.test(clientSrc))
  check('空白归一化后重试（页面会改写换行）', /replace\(\/\\s\+\/g, ' '\)/.test(clientSrc))
  check('归一化有「下标回映表」（保证切回原文位置）', /at2\.push\(i\)/.test(clientSrc))
  check('都找不到就原样返回增量（宁可带回显也不交历史）', /return d\.trim\(\)/.test(clientSrc))
}

console.log('[4] tick：只交付增量')
{
  check('算 deltaRaw 用 startsWith 校验（页面被重置就不瞎切）', /pageNow\.startsWith\(basePage\)/.test(clientSrc))
  check('增量切成 slice(basePage.length)', /pageNow\.slice\(basePage\.length\)/.test(clientSrc))
  check('增量过 stripEcho（拿 promptRef.current 当 sent）', /stripEcho\(deltaRaw, promptRef\.current\)/.test(clientSrc))
  check('交付正文优先用增量', /deltaReply !== '' \? deltaReply : last/.test(clientSrc))
}

console.log('[5] ⭐⭐ 历史安全闸')
{
  check('精确选择器判据（排除兜底 longest-div）', /selNow !== '' && selNow !== 'longest-div'/.test(clientSrc))
  check('historySafe = 增量 or (精确选择器 + 条数/内容)', /const historySafe = deltaUsed \|\| \(preciseSel && \(countGrew \|\| contentChanged\)\)/.test(clientSrc))
  check('arrived 同时要求「正文非空」与「历史安全」', /const arrived = lastClean\.length > 0 && historySafe/.test(clientSrc))
  check('⭐⭐ 兜底 + 增量为空 ⇒ 不交付', /if \(\(scrapedOk === true \|\| deltaUsed\) && arrived\)/.test(clientSrc))
  check('日志标了判据来源（增量差分 / 条数增长 / 内容变化）', /deltaUsed \? '增量差分'/.test(clientSrc))
  check('早期放弃改用 arrived（与交付闸门同口径）', /!arrived &&/.test(clientSrc))
  check('日志同时记 deltaChars 与 pageChars（排查用）', /deltaChars: deltaReply\.length/.test(clientSrc))
}

console.log('[6] 基线在收口处一并清掉')
{
  const iClear = clientSrc.indexOf('const clearPending = () => {')
  const iEnd = clientSrc.indexOf('\n      }', iClear)
  const body = iClear < 0 || iEnd < 0 ? '' : clientSrc.slice(iClear, iEnd)
  check('clearPending 清 baselinePageRef', /baselinePageRef\.current = ''/.test(body))
  check('clearPending 清 baselinePageOkRef', /baselinePageOkRef\.current = false/.test(body))
  check('取消任务处也清（防跨轮张冠李戴）', (clientSrc.match(/baselinePageOkRef\.current = false/g) ?? []).length >= 2)
}

console.log('[7] 产物已重新构建')
{
  check('client.js 含 stripEcho 的实现片段', /function stripEcho/.test(bundle))
  check('client.js 含 historySafe', /historySafe/.test(bundle))
  check('client.js 含 baselinePageOkRef', /baselinePageOkRef/.test(bundle))
  check('client.js 不再引用已删除的 WALL_HELPER_SRC', /WALL_HELPER_SRC/.test(bundle), false)
}

console.log('[8] stripEcho 的行为（真跑一遍，不看源码字符串）')
{
  /** 把 TS 函数原样抠出来跑 —— 只剥掉类型标注，逻辑一个字都不改。 */
  const from = clientSrc.indexOf('function stripEcho(')
  const to = clientSrc.indexOf('\n}\n', from)
  const raw = from < 0 || to < 0 ? '' : clientSrc.slice(from, to + 2)
  const js = raw
    .replace('(delta: string, sent: string): string {', '(delta, sent) {')
    .replace('const chars: string[] = []', 'const chars = []')
    .replace('const at2: number[] = []', 'const at2 = []')
    /** TS 的非空断言（\`d[i]!\`）在纯 JS 里是语法错误 —— 只去掉这些，逻辑不动。 */
    .replace(/\]!/g, ']')
  let stripEcho = null
  try {
    stripEcho = new Function(`${js}\nreturn stripEcho`)()
  } catch (e) {
    check('stripEcho 能被单独抠出来执行', String(e), '')
  }
  check('stripEcho 可执行', typeof stripEcho, 'function')
  if (typeof stripEcho === 'function') {
    /** ① 页面里没有回显（最理想）：原样返回。 */
    check('没有回显 ⇒ 原样返回', stripEcho('春风又绿江南岸', '生成一段诗句'), '春风又绿江南岸')
    /** ② 全文回显：切到回显之后。 */
    check('全文回显 ⇒ 只剩回复', stripEcho('生成一段诗句\n\n春风又绿江南岸', '生成一段诗句'), '春风又绿江南岸')
    /** ③ 长 prompt 只在页面上留尾段：靠尾 60 字 needle 兜。 */
    const long = '请你帮我写一段关于春天的诗句，'.repeat(6)
    check('长 prompt 只回显尾段 ⇒ 仍能切开', stripEcho(long.slice(-60) + '春风又绿江南岸', long), '春风又绿江南岸')
    /** ④ 页面把换行/缩进改写掉（列表项、代码块常见）。 */
    check('回显被改写空白 ⇒ 归一化后仍能切开', stripEcho('第一行 第二行 第三行\n\n回复正文', '第一行\n第二行\n  第三行'), '回复正文')
    /** ⑤ 一轮里出现两次回显（重试/引用）⇒ 取**最后**一次。 */
    check(
      '多次回显 ⇒ 取最后一次',
      stripEcho('请给我一段关于春天的诗句\n旧回复\n请给我一段关于春天的诗句\n新回复', '请给我一段关于春天的诗句'),
      '新回复',
    )
    /** ⑥ 太短的指令（< 4 字）认不出来 ⇒ 回显留在正文里，但**历史仍然进不来**。 */
    check('超短指令 ⇒ 原样返回（不硬切）', stripEcho('嗯\n回复正文', '嗯'), '嗯\n回复正文')
    /** ⑦ 一个都找不到 ⇒ 原样返回增量（带一点回显也比交历史好）。 */
    check('认不出回显 ⇒ 原样返回增量', stripEcho('完全无关的内容', '另一段'), '完全无关的内容')
    /** ⑧ 空输入不炸。 */
    check('空增量 ⇒ 空串', stripEcho('', '问题'), '')
  }
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
