import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const dir = join(ROOT, 'scripts')
const files = readdirSync(dir).filter((f) => /^verify-.*\.mjs$/.test(f) && f !== 'verify-coldstart.mjs').sort()
const rows = []
for (const f of files) {
  const r = spawnSync(process.execPath, [join(dir, f)], { cwd: ROOT, encoding: 'utf8', timeout: 180000 })
  const out = (r.stdout || '') + (r.stderr || '')
  const fails = out.split(/\r?\n/).filter((l) => /^\s*FAIL/.test(l))
  const skip = /SKIP/.test(out) && r.status === 0
  rows.push({ f, status: r.status, fails: fails.length, skip, tail: out.trim().split(/\r?\n/).slice(-1)[0] })
  console.log((r.status === 0 ? 'PASS ' : 'FAIL ') + f + '  fails=' + fails.length + '  ' + rows.at(-1).tail)
  fails.slice(0, 5).forEach((l) => console.log('    ' + l.trim()))
}
writeFileSync(join(ROOT, 'verify-all.log'), JSON.stringify(rows, null, 2))
const bad = rows.filter((r) => r.status !== 0 || r.fails > 0)
console.log('\nSUITES ' + rows.length + '  BAD ' + bad.length)
