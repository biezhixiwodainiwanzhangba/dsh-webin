#!/usr/bin/env node
/**
 * verify-command-menu.mjs —— 入口搬进输入框「+」菜单（宿主 commandUi 客户端贡献）
 *
 * 背景（用户要求）：「能移动到这个加号里面吗？能不能加各个模型的选项？」
 *
 * ## 宿主事实（读源码确认）
 *
 * 输入框那个加号 = InputBar 的 onToggleCommandMenu => toggleCommandMenu(...)，
 * 打开的是斜杠命令菜单；候选由 CommandUiRuntime.candidates() 合成：
 * 宿主命令目录 + 客户端贡献（ctx.commandUi.register）。所以插件只需要注册一条贡献，
 * 不需要任何 DOM 挂钩，也不产生会话消息。
 *
 * 断言的落点：
 *   1. 契约 —— 贡献形状（name / label / available / ui.kind='popupSelect'）
 *   2. 行为 —— webinMenuRows 的行结构；pickWebinMenuRow 的分发（平台 / 模型）
 *   3. 接线 —— 桥 panelBridge 由 LdwHost 挂载时赋值、卸载时置 null；失败退回设置页
 *   4. 产物 —— lib/client.js 里确实有这些东西
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const src = fs.readFileSync(path.join(root, 'src/client/index.ts'), 'utf8');
const bundle = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8');

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); }
};

/** 抠出一段函数源码（到行首的 "}" 为止）。 */
const pickFn = (head) => {
  const at = src.indexOf(head);
  if (at === -1) throw new Error('找不到源码段：' + head);
  const rest = src.slice(at);
  const stop = rest.indexOf('\n}\n');
  return stop === -1 ? rest : rest.slice(0, stop + 2);
};

console.log('=== 输入框「+」菜单入口 ===');

console.log('\n[1] 契约：用**作用域注入**，不把 commandUi 写成硬依赖');
check('顶层 inject 仍只有 slots（否则服务缺失会把整根 fiber 卡在 PENDING）', /export const inject = \['slots'\]/.test(src), true);
check('顶层 inject 不含 commandUi', /export const inject = \[[^\]]*commandUi/.test(src), false);
check('用 ctx.inject 作用域注入', /ctx\.inject\(\['commandUi'\]/.test(src), true);
check('apply 的 ctx 允许 inject', /inject\?\(names: string\[\], cb: \(scope: ScopeLike\) => unknown\): void/.test(src), true);
check('scope 形状有 commandUi', /interface ScopeLike \{\s*commandUi\?: CommandUiLike/.test(src), true);
check('注册句柄在作用域外可回收', /dispose = commandUi\.register\(/.test(src), true);
check('effect 卸载时调 dispose', /if \(dispose !== undefined\) dispose\(\)/.test(src), true);

console.log('\n[2] 契约：贡献形状');
const regAt = src.indexOf("name: 'webin',");
check('注册名为 webin', regAt !== -1, true);
check('label 指向 VIEW_NAME', /label: \(\) => VIEW_NAME/.test(src), true);
check('available 恒真（任何会话都能用）', /available: \(\) => true/.test(src), true);
check('用 popupSelect（弹二级列表）', /kind: 'popupSelect'/.test(src), true);
check('模糊搜索', /searchMode: 'fuzzy-label'/.test(src), true);
check('给三处搜索文案', /placeholder: '搜索平台或模型'[\s\S]{0,200}empty: '还没有可用的网页版平台'[\s\S]{0,200}noResults: '没有匹配的平台或模型'/.test(src), true);
check('options 走 webinMenuRows', /options: async \(\) => webinMenuRows\(\)/.test(src), true);
check('onSelect 走 pickWebinMenuRow', /pickWebinMenuRow\(option, session, modelDirectories\)/.test(src), true);
check('宿主没有 commandUi 时只打日志', src.includes('宿主没有 commandUi 服务'), true);

console.log('\n[3] 行为：webinMenuRows 的行结构（真跑）');
{
  const body = pickFn("function webinMenuRows(): WebinMenuRow[] {");
  const fakeRegistry = {
    current: 'doubao',
    providers: [
      { id: 'doubao', name: '豆包', homeUrl: 'https://www.doubao.com/chat/', models: [{ id: 'doubao-fast', name: '快速' }, { id: 'doubao-think', name: '深度思考', thinking: true }] },
      { id: 'deepseek', name: 'DeepSeek 网页版', homeUrl: 'https://chat.deepseek.com/', models: [{ id: 'ldw-fast', name: '快速' }] },
    ],
  };
  const sandbox = {
    readPlatformId: () => 'doubao',
    registryRef: {
      current: {
        all: () => fakeRegistry.providers,
        get: (id) => fakeRegistry.providers.find((p) => p.id === id),
      },
    },
  };
  const stripped = body
    .replace('function webinMenuRows(): WebinMenuRow[]', 'function webinMenuRows()')
    .replace('const rows: WebinMenuRow[] =', 'const rows =')
    .replace('const platformGroup: { name: string; label: string } =', 'const platformGroup =')
  const fn = vm.runInNewContext('(' + stripped.trim() + ')', sandbox);
  const rows = fn()
  check('第一行是打开面板', rows[0].id, 'open');
  check('第一行写出当前平台名', rows[0].detail, '当前平台：豆包');
  const platformRows = rows.filter((r) => r.id.startsWith('platform:'));
  check('每个平台一行', platformRows.length, 2);
  check('当前平台标 active', platformRows.filter((r) => r.active).map((r) => r.id), ['platform:doubao']);
  check('平台行说明当前平台', platformRows[0].detail, '当前平台');
  check('非当前平台显示域名', platformRows[1].detail, 'chat.deepseek.com');
  check('平台行有分组', platformRows[0].group.name, 'webin-platform');
  const modelRows = rows.filter((r) => r.id.startsWith('model:'));
  check('每个模型一行', modelRows.length, 3);
  check('模型行 id 带平台前缀', modelRows[0].id, 'model:doubao:doubao-fast');
  check('模型行标签带平台名', modelRows[0].label, '豆包 · 快速');
  check('深度思考标出来', modelRows.filter((r) => r.detail === '深度思考').length, 1);
  check('模型行有分组', modelRows[0].group.name, 'webin-model');
}

console.log('\n[4] 行为：pickWebinMenuRow 的分发（真跑）');
{
  const body = pickFn('function pickWebinMenuRow(');
  const calls = [];
  const sandbox = {
    console,
    openPanelFromMenu: (pid) => { calls.push({ open: pid === undefined ? null : pid }); return ''; },
    selectWebinModel: (dirs, session, pid, mid) => { calls.push({ model: [pid, mid] }); return Promise.resolve(); },
  };
  const stripped = body
    .replace('function pickWebinMenuRow(option: { id?: unknown }, session: unknown, modelDirectories: unknown): void', 'function pickWebinMenuRow(option, session, modelDirectories)')
  const fn = vm.runInNewContext('(' + stripped.trim() + ')', sandbox);
  fn({ id: 'open' }, { sessionId: 's1' }, 'DIRS');
  fn({ id: 'platform:deepseek' }, { sessionId: 's1' }, 'DIRS');
  fn({ id: 'model:doubao:doubao-think' }, { sessionId: 's1' }, 'DIRS');
  fn({ id: '' }, { sessionId: 's1' }, 'DIRS');
  check('open 只开面板（不传平台）', calls[0], { open: null });
  check('平台行带平台 id', calls[1], { open: 'deepseek' });
  check('模型行先开面板', calls[2], { open: 'doubao' });
  check('模型行再切模型', calls[3], { model: ['doubao', 'doubao-think'] });
  check('空 id 当「打开」处理', calls[4], { open: null });
  check('不认的行不动作', calls.length, 5);
}

console.log('\n[5] 接线：桥 + 兜底');
const openFrom = pickFn('function openPanelFromMenu(');
check('桥没挂载时给具体原因', openFrom.includes('面板还没挂载'), true);
check('先问桥要人话返回值', openFrom.includes('panelBridge.open(platformId)'), true);
check('失败才退回设置页', openFrom.indexOf('panelBridge.open') < openFrom.indexOf('openSettingsAtLdwSection()'), true);
check('失败原因打出来（不静默）', openFrom.includes('console.warn'), true);
const hostBridge = src.slice(src.indexOf('panelBridge = {'), src.indexOf('panelBridge = {') + 600);
check('桥里切平台', hostBridge.includes('setPlatformId(platformId)'), true);
check('桥里清掉上一轮状态', hostBridge.includes("setStatus('正在切换平台…')"), true);
check('桥里呼出标签', hostBridge.includes('return openWebinTab()'), true);
check('卸载时摘桥', /panelBridge = null/.test(src), true);

console.log('\n[6] 输入框左侧的旧按钮已撤掉');
check('不再导出 LdwLoginButton', src.includes('export function LdwLoginButton'), false);
check('不再注册 conversation.input.left', /inject\('conversation\.input\.left'/.test(src), false);
check('设置页入口函数还在（兜底用）', src.includes('function openSettingsAtLdwSection('), true);

console.log('\n[7] 产物');
check('bundle 含命令名', bundle.includes('"webin"'), true);
check('bundle 含 popupSelect', bundle.includes('"popupSelect"'), true);
check('bundle 含行前缀', bundle.includes('"platform:" + p.id'), true);
check('bundle 含桥', bundle.includes('panelBridge'), true);
check('bundle 不再有 LdwLoginButton', bundle.includes('LdwLoginButton'), false);

console.log('');
console.log(fail === 0 ? 'ALL CLEAN (' + pass + ' checks)' : pass + ' passed, ' + fail + ' FAILED');
process.exit(fail === 0 ? 0 : 1);
