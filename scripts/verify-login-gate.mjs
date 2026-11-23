#!/usr/bin/env node
/**
 * **登录门禁 + 输入框 LDW 入口** 测试。
 *
 * ## 用户的两条要求
 *
 * 1. 「每次新建会话的时候，应该在这里加个 LDW，让登录一下」
 *    → 早期是 `conversation.input.left` 的入口按钮；m02553 起搬进输入框「+」菜单
 *      （宿主 commandUi 客户端贡献，见 verify-command-menu.mjs）
 * 2. 「如果是已登录才能使用 LDW 那俩模型」
 *    → 未登录的平台**不列出模型**，且**调用时直接报错**
 *
 * ## 为什么判据是「登录快照」而不是「浏览器在线」
 *
 * 用「在线」会导致：重启 DSH 后、用户还没切到 LDW 标签时，模型从选择器里
 * 消失 —— 用户会以为插件坏了。快照是持久化的，记录「上次确实登录过」。
 *
 * ## 为什么不能只看「快照文件存在」
 *
 * DeepSeek 未登录时**也会写 `userToken` 键**，值是 `{"value":null}`。
 * 实测过这个坑：早期版本因此把空快照当成有效快照，覆盖了真快照。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isolate, enableModelPicker } from './lib/isolate.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

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

function makeHttp(method, url, body) {
  const chunks = []
  let resolveDone
  const done = new Promise((r) => {
    resolveDone = r
  })
  const req = {
    method,
    url,
    on(event, cb) {
      if (event === 'data' && body !== undefined) setTimeout(() => cb(Buffer.from(body)), 0)
      if (event === 'end')
        setTimeout(() => {
          cb()
          resolveDone()
        }, 1)
      return this
    },
    destroy() {},
  }
  const res = {
    statusCode: 200,
    headers: {},
    chunks,
    writeHead(code, headers) {
      this.statusCode = code
      Object.assign(this.headers, headers ?? {})
      return this
    },
    end(text) {
      if (text !== undefined) chunks.push(String(text))
      resolveDone()
    },
  }
  return { req, res, done }
}

async function call(handler, method, url, body) {
  const { req, res, done } = makeHttp(method, url, body)
  await handler(req, res)
  await Promise.race([done, new Promise((r) => setTimeout(r, 2000))])
  const text = res.chunks.join('')
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: res.statusCode, text, json }
}

function makeCtx() {
  const routes = new Map()
  const adapters = new Map()
  const ctx = {
    logger: () => ({ info() {}, warn() {}, debug() {} }),
    effect(cb) {
      cb()
      return () => {}
    },
    llm: {
      registerAdapter(providers, adapter) {
        for (const p of providers) adapters.set(p, adapter)
        return () => {}
      },
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => {}
      },
    },
    slots: { inject() {}, register: (o, c) => ({ o, c }) },
  }
  return { ctx, routes, adapters }
}

/** 写一份登录快照到 state 目录。 */
function writeSnapshot(platform, body) {
  const dir = join(process.env.DSH_HOME, 'webin', 'auth')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${platform}.json`), typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
}

console.log('=== 登录门禁 + 输入框 LDW 入口 测试 ===\n')

const cleanupState = isolate('webin-login-gate')
/** 默认关着模型展示；这里要验证 listModels 的真实清单。 */
enableModelPicker()
const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
const { apply } = mod

console.log('[1] 未登录时：不列出模型')
{
  const A = makeCtx()
  await apply(A.ctx)
  const adapter = A.adapters.get('webin-deepseek')
  const models = await adapter.listModels('webin-deepseek')
  check('⭐ 未登录 ⇒ 模型清单为空', models.length, 0)
}

console.log('\n[2] ⭐ 登录后：列出模型')
{
  writeSnapshot('deepseek', {
    localStorage: { userToken: '{"value":"tok-abc","__version":"0"}' },
    url: 'https://chat.deepseek.com/',
  })
  const A = makeCtx()
  await apply(A.ctx)
  const adapter = A.adapters.get('webin-deepseek')
  const models = await adapter.listModels('webin-deepseek')
  check('⭐ 已登录 ⇒ 有模型', models.length > 0, true)
  check('含 ldw-fast', models.some((m) => m.id.includes('ldw-fast')), true)
  check('含 ldw-think', models.some((m) => m.id.includes('ldw-think')), true)
}

console.log('\n[3] ⭐ 未登录快照（userToken=null）不算登录')
{
  /**
   * 实测坑：DeepSeek 未登录时也写 `userToken` 键，值是 `{"value":null}`。
   * 只看「键存在」会误判成已登录。
   */
  writeSnapshot('deepseek', {
    localStorage: {
      userToken: '{"value":null,"__version":"0"}',
      __appKit_userInfo: '{"value":{"id":null}}',
    },
    url: 'https://chat.deepseek.com/sign_in',
  })
  const A = makeCtx()
  await apply(A.ctx)
  const adapter = A.adapters.get('webin-deepseek')
  const models = await adapter.listModels('webin-deepseek')
  check('⭐ null token ⇒ 不算登录', models.length, 0)
}

console.log('\n[4] 坏快照文件不能让插件挂掉')
{
  writeSnapshot('deepseek', '{ 这不是合法 JSON')
  const A = makeCtx()
  let threw = null
  try {
    await apply(A.ctx)
  } catch (e) {
    threw = String(e)
  }
  check('⭐ 坏文件不影响加载', threw, null)
  const adapter = A.adapters.get('webin-deepseek')
  const models = await adapter.listModels('webin-deepseek')
  check('坏文件 ⇒ 视为未登录', models.length, 0)
}

console.log('\n[5] ⭐ 畸形 token（像 JSON 但解析失败）不能被当成有效')
{
  writeSnapshot('deepseek', { localStorage: { userToken: '{broken' } })
  const A = makeCtx()
  await apply(A.ctx)
  const adapter = A.adapters.get('webin-deepseek')
  const models = await adapter.listModels('webin-deepseek')
  check('⭐ 畸形值不算登录', models.length, 0)
}

console.log('\n[6] 裸字符串 token（旧版页面写法）算登录')
{
  writeSnapshot('deepseek', { localStorage: { userToken: 'raw-token-without-wrapper' } })
  const A = makeCtx()
  await apply(A.ctx)
  const adapter = A.adapters.get('webin-deepseek')
  const models = await adapter.listModels('webin-deepseek')
  check('裸 token 算登录', models.length > 0, true)
}

console.log('\n[7] ⭐ 未登录时调用模型 → 明确报错（不是莫名其妙的输入框错误）')
{
  writeSnapshot('deepseek', { localStorage: { userToken: '{"value":null}' } })
  const A = makeCtx()
  await apply(A.ctx)
  const adapter = A.adapters.get('webin-deepseek')

  const stream = adapter.stream({
    provider: 'webin-deepseek',
    model: 'deepseek:ldw-fast',
    sessionId: 'gate-1',
    messages: [{ role: 'user', content: '你好' }],
  })
  const chunks = []
  for await (const c of stream) chunks.push(c)
  const finish = chunks.find((c) => c.type === 'finish')
  check('⭐ 以 error 结束', finish?.reason?.kind, 'error')
  check('⭐ 错误码 WEBIN_NOT_LOGGED_IN', finish?.reason?.failure?.code, 'WEBIN_NOT_LOGGED_IN')
  check('⭐ 提示里说了怎么登录', /登录/.test(finish?.reason?.failure?.message ?? ''), true)
  check('⭐ 提示里提到「网页版对话」按钮或标签', /网页版对话/.test(finish?.reason?.failure?.message ?? ''), true)
  /** 不能真的派发任务（否则页面会跳登录页）。 */
  check('没有派发任务', chunks.some((c) => c.type === 'text-delta'), false)
}

console.log('\n[8] GET /status 暴露 loggedInPlatforms')
{
  writeSnapshot('deepseek', { localStorage: { userToken: '{"value":"tok"}' } })
  const A = makeCtx()
  await apply(A.ctx)
  const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
  const res = await call(route.handler, 'GET', '/dsh-webin/api/status')
  check('状态 200', res.status, 200)
  check('⭐ 有 loggedInPlatforms', Array.isArray(res.json?.loggedInPlatforms), true)
  check('⭐ deepseek 在里面', (res.json?.loggedInPlatforms ?? []).includes('deepseek'), true)
  check('qwen 不在（没登录过）', (res.json?.loggedInPlatforms ?? []).includes('qwen'), false)
}

console.log('\n[9] GET /providers 也带 loggedInPlatforms（设置页要用）')
{
  const A = makeCtx()
  await apply(A.ctx)
  const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
  const res = await call(route.handler, 'GET', '/dsh-webin/api/providers')
  check('有 loggedInPlatforms', Array.isArray(res.json?.loggedInPlatforms), true)
}

console.log('\n[10] ⭐ client 侧：入口在输入框「+」菜单里（不再占输入框左侧）')
{
  const client = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  /**
   * m02553：「能移动到这个加号里面吗？能不能加各个模型的选项？」
   * 「+」打开的就是斜杠命令菜单，宿主用 commandUi 合成候选 ⇒ 注册一条客户端贡献即可。
   */
  /**
   * ⚠️ 产物里保留着源码注释（含 conversation.input.left 这串字），
   * 所以判据必须看**注册三件套**，不是裸字符串。
   */
  check('⭐ 不再 inject conversation.input.left', /inject\("conversation\.input\.left"/.test(client), false)
  check('⭐ 不再 register conversation.input.left', /name:\s*"conversation\.input\.left"/.test(client), false)
  check('⭐ 不再导出 LdwLoginButton', client.includes('LdwLoginButton'), false)
  check('⭐ 不再有「网页版对话未就绪」文案', client.includes('网页版对话未就绪'), false)
  /** 作用域注入，不是顶层 inject —— 顶层写成硬依赖会把插件卡在 PENDING。 */
  check('⭐ 作用域注入 commandUi', /inject\(\["commandUi"\]/.test(client), true)
  check('⭐ 注册命令 webin', /name:\s*"webin"/.test(client), true)
  check('⭐ 用 popupSelect 弹二级列表', /kind:\s*"popupSelect"/.test(client), true)
  check('⭐ 模糊搜索平台与模型', /searchMode:\s*"fuzzy-label"/.test(client), true)
  check('⭐ 行由 webinMenuRows 生成', client.includes('webinMenuRows'), true)
  check('⭐ 行里有「打开网页版对话」', /打开网页版对话/.test(client), true)
  check('⭐ 平台行前缀 platform:', client.includes('"platform:" + p.id') || client.includes("'platform:' + p.id"), true)
  check('⭐ 模型行前缀 model:', client.includes('"model:" + p.id') || client.includes("'model:' + p.id"), true)
  check('⭐ 面板动作桥 panelBridge', client.includes('panelBridge'), true)
  check('⭐ 桥在卸载时摘掉', /panelBridge = null/.test(client), true)
  check('⭐ 打开失败退回设置页', /openSettingsAtLdwSection/.test(client), true)
  check('⭐ 切模型走 modelDirectories', client.includes('modelDirectories'), true)
  check('⭐ 切模型失败不打断', /切换网页版模型失败/.test(client), true)
  /** 命令贡献在插件作用域拿不到组件 state ⇒ 必须靠桥，不能直接 setPlatformId。 */
  check('⭐ 桥里才改 platformId', /setPlatformId\(platformId\)/.test(client), true)
  check('⭐ 宿主缺 commandUi 时只打日志', /宿主没有 commandUi 服务/.test(client), true)
}

console.log('\n[10b] ⭐ 设置页有登录按钮（用户要求的入口在这）')
{
  const client = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  /** 设置页从 /providers 读登录态。 */
  check('⭐ 读 loggedInPlatforms', client.includes('loggedInPlatforms'), true)
  /** 登录区：一行一个平台，带「去登录」。 */
  check('⭐ 有「登录」分区标题', /"登录"/.test(client), true)
  check('⭐ 有「去登录」按钮', client.includes('去登录'), true)
  check('⭐ 已登录时按钮变「打开浏览器」', client.includes('打开浏览器'), true)
  check('样式含 .ldw-loginrow', client.includes('.ldw-loginrow'), true)
  check('样式含 .ldw-loginrow-name', client.includes('.ldw-loginrow-name'), true)
  /** 说明登录态会持久化（用户最关心重启后还要不要重登）。 */
  check('⭐ 说明登录态会保存', /重启 DSH 后仍有效/.test(client), true)
  /**
   * ⭐ 「去登录」= 切到本插件的浏览器视图。
   * 那是**唯一**能真正输账号密码的地方。
   */
  check('⭐ 去登录会切视图', /switchToLdwView/.test(client), true)
  /** 切视图三条路依次试（精确 → 宽泛 → 兜底）。 */
  check('⭐ 先找标签栏内的 tab', client.includes('data-conversation-tabs'), true)
  /**
   * ⚠️ 产物里选择器是 `"[role=\"tab\"]"` —— 引号被转义了，
   * 所以判据不能写裸的 `[role="tab"]`（踩过）。用 `role=` + `tab` 两段找。
   */
  check('⭐ 兜底找 role=tab', /\[role=\\"tab\\"\]/.test(client), true)
  /** 输入框左侧那个按钮已撤掉，套娃判重也就不需要了。 */
  check('⭐ 不再有套娃判重（入口已撤）', /ldw-entry/.test(client), false)
  /** 找不到时说明下一步做什么。 */
  check('⭐ 找不到标签时给下一步', /先发一条消息让会话建立/.test(client), true)
}

console.log('\n[11] client 与 host 用同一套登录判断（不能各写一份）')
{
  const shared = readFileSync(join(ROOT, 'src', 'shared', 'auth-snapshot.ts'), 'utf8')
  check('共用模块存在', shared.includes('snapshotLooksLoggedIn'), true)
  check('有文本入口（host 用）', shared.includes('snapshotTextLooksLoggedIn'), true)
  const client = readFileSync(join(ROOT, 'src', 'client', 'index.ts'), 'utf8')
  check('⭐ client 从 shared 导入（不是本地副本）', /from '\.\.\/shared\/auth-snapshot'/.test(client), true)
  check('⭐ client 没有本地重复定义', /^function snapshotLooksLoggedIn/m.test(client), false)
}

console.log('\n[?] ⭐⭐⭐ 登录页的文字绝不能被当成回复交付')
{
  /**
   * ## 用户实测（真实事故）
   *
   * 会话掉线跳到登录页后，DOM 抓取把登录页内容读成了「最新回复」，交付给 DSH：
   *
   *     +86
   *     注册登录即代表已阅读并同意用户的 用户协议 与 隐私政策...
   *     密码登录使用 Apple 账号登录
   *     微信扫码登录
   *     浙ICP备2023025841号 · 联系我们
   *
   * ## 为什么危险
   *
   * DOM 抓取是**兜底**路径，只认「最后一个像回复的容器」。页面跳到登录页后，
   * 它读到的东西完全不是回复 —— 而这类内容交付后**看起来像正常文本**，
   * 比报错更难察觉。
   */
  const clientSrc = readFileSync(join(ROOT, 'src', 'client', 'index.ts'), 'utf8')

  check('⭐⭐⭐ 有登录页 URL 判据', /sign\[_-\]\?in|sign\[_-\]\?up/.test(clientSrc), true)
  check('⭐⭐ 命中后拒绝交付抓取内容', /拒绝把页面文字当回复交付/.test(clientSrc), true)
  check('⭐⭐ 改为明确报错', /网页版对话已掉线到登录页/.test(clientSrc), true)
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
cleanupState()
process.exitCode = fail === 0 ? 0 : 1
/** ⚠️ 显式退出 —— 防 handle 悬挂把 npm run check 卡死（verify-lifecycle 实测踩过）。 */
process.exit(process.exitCode)
