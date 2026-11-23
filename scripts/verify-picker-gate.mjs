#!/usr/bin/env node
/**
 * **模型选择器开关**（exposeModelsInPicker）测试。
 *
 * ## 用户要求（m01479）
 *
 * > 把这个插件改一下吧，不要在模型选择里显示乱七八糟的东西，
 * > 我最开始的要求只要能打开其他 ai 的对话窗口就够了。
 *
 * 所以默认 `exposeModelsInPicker: false`：
 *   - 模型选择器里**不出现** webin-* 任何条目（listModels 返回 []）
 *   - LDW 标签页 / webview 面板照常（与 adapter 无关）
 *   - **老会话不受影响** —— resolveModel/prepareCall 不看这个开关，
 *     已经存了 `webin-doubao/...` 的会话继续能跑
 *   - 设置页打开开关 ⇒ 立刻出现；关掉 ⇒ 立刻消失（强制重注册）
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import { isolate } from './lib/isolate.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const configSrc = readFileSync(join(ROOT, 'src', 'shared', 'config.ts'), 'utf8')
const hostSrc = readFileSync(join(ROOT, 'src', 'host', 'index.ts'), 'utf8')
const adapterSrc = readFileSync(join(ROOT, 'src', 'host', 'adapter.ts'), 'utf8')
const clientSrc = readFileSync(join(ROOT, 'src', 'client', 'index.ts'), 'utf8')

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

function makeHttp(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.destroy = () => {}
  const chunks = []
  const res = {
    statusCode: 0,
    headers: {},
    chunks,
    writeHead(code, headers) {
      this.statusCode = code
      Object.assign(this.headers, headers ?? {})
    },
    end(text) {
      chunks.push(text ?? '')
      this.resolve?.()
    },
  }
  const done = new Promise((resolve) => {
    res.resolve = resolve
  })
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body, 'utf8'))
    req.emit('end')
  })
  return { req, res, done }
}

async function call(handler, method, url, body) {
  const { req, res, done } = makeHttp(method, url, body)
  await handler(req, res)
  await Promise.race([done, new Promise((r) => setTimeout(r, 2000))])
  const text = chunksText(res)
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: res.statusCode, text, json }
}

function chunksText(res) {
  return res.chunks.join('')
}

/** mock ctx：重复注册必须抛（证明 syncProviders 真的 dispose 了）。 */
function makeCtx() {
  const routes = new Map()
  const adapters = new Map()
  const disposers = []
  const ctx = {
    logger: () => ({ info() {}, warn() {}, debug() {} }),
    effect(cb) {
      const dispose = cb()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    llm: {
      registerAdapter(providers, adapter) {
        for (const p of providers) {
          if (adapters.has(p)) throw new Error('llm: provider "' + p + '" already registered')
        }
        for (const p of providers) adapters.set(p, adapter)
        return () => {
          for (const p of providers) adapters.delete(p)
        }
      },
    },
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error('webserver: duplicate route "' + route.path + '"')
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    slots: { inject() {}, register: (o, c) => ({ o, c }) },
  }
  return { ctx, routes, adapters, disposers }
}

function writeSnapshot(platform) {
  const dir = join(process.env.DSH_HOME, 'webin', 'auth')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, platform + '.json'),
    JSON.stringify({ localStorage: { userToken: '{"value":"tok","__version":"0"}' }, url: 'https://chat.deepseek.com/' }),
    'utf8',
  )
}

console.log('=== 模型选择器开关（exposeModelsInPicker）===\n')

const cleanupState = isolate('webin-picker-gate')
writeSnapshot('deepseek')

const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
const { apply } = mod

console.log('[1] 配置层：字段存在、默认关、注释记着用户原话')
{
  check('声明了 exposeModelsInPicker: boolean', /exposeModelsInPicker: boolean/.test(configSrc))
  check('默认值 false', /exposeModelsInPicker: false,/.test(configSrc))
  check('注释引用用户原话（可追溯）', /不要在模型选择里显示乱七八糟的东西/.test(configSrc))
  /**
   * m02087 曾经把设置页这个开关连同面板平台下拉一起注释掉 —— m02268 用户澄清
   * 「只让你删 DSH 对话窗口的模型选择选项」，所以开关是**要有的**：
   * 默认 false ⇒ host listModels() 返回空 ⇒ DSH 模型选择器里看不到网页版模型；
   * 需要把网页版当模型跑时，用户自己在设置页打开。
   */
  check(
    '设置页有这个开关（默认关，模型选择器里不显示网页版模型）',
    /key: 'exposeModelsInPicker',\s*\n\s*label: '在模型选择器里显示网页版模型'/.test(clientSrc),
  )
  check('adapter 有一处门禁', /deps\.exposeModels/.test(adapterSrc))
}

console.log('\n[2] 默认（关）：已登录也不列模型，但路由仍在')
const A = makeCtx()
await apply(A.ctx)
const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
{
  check('adapter 已注册（老会话要靠它继续跑）', A.adapters.has('webin-deepseek'))
  const adapter = A.adapters.get('webin-deepseek')
  const models = await adapter.listModels('webin-deepseek')
  check('⭐ 选择器清单为空', models.length, 0)
  const info = await adapter.resolveModel('webin-deepseek', 'deepseek:deepseek-fast')
  check('⭐ 老会话仍能解析模型', typeof info?.id, 'string')
}

console.log('\n[3] 配置打开 ⇒ 立刻出现（不重启；UI 已摘，接口仍可用）')
{
  const res = await call(route.handler, 'PUT', '/dsh-webin/api/config', JSON.stringify({ exposeModelsInPicker: true }))
  check('保存成功', res.json?.ok, true)
  const adapter = A.adapters.get('webin-deepseek')
  const models = await adapter.listModels('webin-deepseek')
  check('⭐ 打开后有模型', models.length > 0, true)
  check('路由没有重复注册（dispose 正常）', [...A.adapters.keys()].filter((k) => k === 'webin-deepseek').length, 1)
}

console.log('\n[4] 关掉 ⇒ 立刻消失')
{
  const res = await call(route.handler, 'PUT', '/dsh-webin/api/config', JSON.stringify({ exposeModelsInPicker: false }))
  check('保存成功', res.json?.ok, true)
  const adapter = A.adapters.get('webin-deepseek')
  check('⭐ 关掉后清单为空', (await adapter.listModels('webin-deepseek')).length, 0)
}

console.log('\n[5] 恢复默认 ⇒ 仍是关（不会被旧配置文件带回来）')
{
  await call(route.handler, 'PUT', '/dsh-webin/api/config', JSON.stringify({ exposeModelsInPicker: true }))
  const res = await call(route.handler, 'DELETE', '/dsh-webin/api/config')
  check('默认值 false', res.json?.config?.exposeModelsInPicker, false)
  const adapter = A.adapters.get('webin-deepseek')
  check('⭐ 恢复默认后清单为空', (await adapter.listModels('webin-deepseek')).length, 0)
}

console.log('\n[6] 面板不受影响：webview 注册仍指向 platform 路由')
{
  check('客户端仍只渲染 LDW 标签', /conversation\.view/.test(clientSrc))
  check(
    '面板注册不受影响（conversation.view / shell.overlay 仍在）',
    clientSrc.includes('conversation.view') && clientSrc.includes('shell.overlay'),
  )
}

console.log('\n[7] 门禁在 listModels 里，而不是靠删路由')
{
  check('host 传入函数（设置页改完立刻生效）', /exposeModels: \(\) => readConfig\(\)\.config\.exposeModelsInPicker/.test(hostSrc))
  check('配置写入后强制重注册', /syncProviders\(true\)/.test(hostSrc))
}

cleanupState()

console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + '：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
