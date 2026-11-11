// PowerShell und cmd.exe: Set-Content, Out-File und Tee-Object ohne -Append,
// Copy-Item/Move-Item (copy/move) auf eine Datei, New-Item -Force,
// [IO.File]::WriteAllText, Umleitungen `>`, `2>`, `*>`. Anhängen (`>>`,
// Add-Content) bleibt frei. Bewusst eine Teilmenge: Skriptblöcke und
// Schleifen werden als einfache Anweisungen gelesen.

import { type Ctx, type Cwds, type Finding, type Run, MAX_DEPTH, addFile, addInto, inlineCode, interpreterFlags, lang, resolveAll } from './common'

/** Ein Wort: sein Wert, oder null, wenn eine Variable darin unbekannt ist. */
type Word = { value: string | null; raw: string }
type Stmt = { words: Word[]; redirects: { op: string; target: Word }[]; raw: string }

/** Bekannte Variablen; der Rest ist unbekannt. */
function variable(name: string, ctx: Ctx): string | null {
  const n = name.toLowerCase().replace(/^env:/, '')
  if (n === 'home' || n === 'userprofile') return ctx.home
  if (n === 'pwd') return null
  if (n === 'null') return ''
  const v = name.toLowerCase().startsWith('env:') ? ctx.env(n.toUpperCase()) : undefined
  return v ?? null
}

/** Anweisungen und ihre Wörter; `cmd`: Anführung nur mit `"`, Variablen als `%X%`. */
function statements(src: string, ctx: Ctx, cmd: boolean): Stmt[] {
  const out: Stmt[] = []
  let cur: Stmt = { words: [], redirects: [], raw: '' }
  let redir: string | null = null
  let start = 0
  const finish = (at: number) => {
    cur.raw = src.slice(start, at)
    if (cur.words.length || cur.redirects.length) out.push(cur)
    cur = { words: [], redirects: [], raw: '' }
    start = at
  }
  const push = (w: Word) => {
    if (redir !== null) cur.redirects.push({ op: redir, target: w })
    else cur.words.push(w)
    redir = null
  }
  let i = 0
  while (i < src.length) {
    const c = src[i] ?? ''
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue }
    if (c === '\n' || c === ';' || c === '|' || c === '&' || (!cmd && '{}()'.includes(c))) { finish(i); i++; start = i; continue }
    if (!cmd && c === '#') { while (i < src.length && src[i] !== '\n') i++; continue }
    const r = /^(\d|\*)?(>>|>)(&\d)?/.exec(src.slice(i))
    if (r) { i += r[0].length; if (!r[3]) redir = r[2] ?? '>'; continue }
    let value: string | null = ''
    const from = i
    while (i < src.length && !/[\s;|&<>]/.test(src[i] ?? '') && (cmd || !'{}()'.includes(src[i] ?? ''))) {
      const d = src[i] ?? ''
      if (d === "'" && !cmd) {
        const e = src.indexOf("'", i + 1)
        if (value !== null) value += src.slice(i + 1, e < 0 ? src.length : e)
        i = e < 0 ? src.length : e + 1
      } else if (d === '"') {
        let j = i + 1
        for (; j < src.length && src[j] !== '"'; j++) {
          const q = src[j] ?? ''
          if (!cmd && q === '`') { j++; if (value !== null) value += src[j] ?? ''; continue }
          if (!cmd && q === '$') { const m = /^\$\{?((?:env:)?\w+)\}?/i.exec(src.slice(j)); if (m) { const v = variable(m[1] ?? '', ctx); value = value === null || v === null ? null : value + v; j += m[0].length - 1; continue } }
          if (value !== null) value += q
        }
        i = j + 1
      } else if (!cmd && d === '$') {
        const m = /^\$\{?((?:env:)?\w+)\}?/i.exec(src.slice(i))
        const v = m ? variable(m[1] ?? '', ctx) : null
        value = value === null || v === null ? null : value + v
        i += m ? m[0].length : 1
      } else if (cmd && d === '%') {
        const m = /^%(\w+)%/.exec(src.slice(i))
        const v = m ? ctx.env((m[1] ?? '').toUpperCase()) ?? null : null
        value = value === null || v === null ? null : value + v
        i += m ? m[0].length : 1
      } else if (!cmd && d === '`') {
        if (value !== null) value += src[i + 1] ?? ''
        i += 2
      } else {
        if (value !== null) value += d
        i++
      }
    }
    if (i === from) { i++; continue }
    push({ value, raw: src.slice(from, i) })
  }
  finish(src.length)
  return out
}

type Params = { named: Map<string, Word | true>; positional: Word[] }

const VALUED = ['path', 'literalpath', 'pspath', 'filepath', 'destination', 'value', 'encoding', 'itemtype', 'type', 'name', 'filter',
  'include', 'exclude', 'credential', 'erroraction', 'warningaction', 'width', 'inputobject', 'stream', 'delimiter', 'variable']

/** Parameter lesen; PowerShell erlaubt Abkürzungen (`-Dest`), `-Name:Wert` und Schalter. */
function params(words: Word[]): Params {
  const named = new Map<string, Word | true>()
  const positional: Word[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (!w) continue
    const m = w.value === null ? null : /^-([A-Za-z]\w*)(?::(.*))?$/.exec(w.value)
    if (!m) { positional.push(w); continue }
    const given = (m[1] ?? '').toLowerCase()
    const name = VALUED.find(v => v.startsWith(given)) ?? given
    if (m[2] !== undefined) named.set(name, { value: m[2], raw: m[2] })
    else if (VALUED.includes(name)) named.set(name, words[++i] ?? true)
    else named.set(name, true)
  }
  return { named, positional }
}

const word = (p: Params, names: string[], pos: number): Word | undefined => {
  for (const n of names) { const v = p.named.get(n); if (v && v !== true) return v }
  return p.positional[pos]
}
const has = (p: Params, prefix: string) => [...p.named.keys()].some(k => prefix.startsWith(k) && k.length >= 2)

const PATH_PARAMS = ['path', 'literalpath', 'pspath']
const SET_CONTENT = new Set(['set-content', 'sc'])
const OUT_FILE = new Set(['out-file', 'tee-object', 'tee'])
const COPY = new Set(['copy-item', 'cp', 'copy', 'cpi', 'move-item', 'mv', 'move', 'mi', 'xcopy'])
const NEW_ITEM = new Set(['new-item', 'ni'])
const SET_LOCATION = new Set(['set-location', 'sl', 'cd', 'chdir', 'push-location', 'pushd'])
const SHELLS = new Set(['bash', 'sh', 'wsl', 'wsl.exe'])

function file(out: Finding[], w: Word | undefined, cwds: Cwds, ctx: Ctx, via: string): void {
  if (!w) return
  if (w.value === null) return void out.push({ kind: 'computed', hint: w.raw, via })
  addFile(out, w.value, cwds, ctx, via, true)
}

function runStmt(stmt: Stmt, st: { cwds: Cwds }, run: Run, cmd: boolean): void {
  const { ctx, out } = run
  for (const r of stmt.redirects) if (r.op === '>') file(out, r.target, st.cwds, ctx, '>')

  const [head, ...rest] = stmt.words
  const name = head?.value?.toLowerCase().replace(/\.exe$/, '').replace(/^.*[\\/]/, '') ?? ''
  const words = cmd ? rest.filter(w => !/^\/[a-z-]+(:.*)?$/i.test(w.value ?? '')) : rest
  const p = params(words)

  if (SET_LOCATION.has(name)) {
    const to = word(p, PATH_PARAMS, 0)?.value
    st.cwds = to === null || to === undefined ? null : resolveAll(to, st.cwds, ctx, true)
    return
  }
  if (SET_CONTENT.has(name)) return file(out, word(p, PATH_PARAMS, 0), st.cwds, ctx, 'Set-Content')
  if (OUT_FILE.has(name)) {
    if (has(p, 'append') || has(p, 'noclobber')) return
    return file(out, word(p, ['filepath', 'literalpath', 'path'], 0), st.cwds, ctx, name)
  }
  if (NEW_ITEM.has(name)) {
    const type = word(p, ['itemtype', 'type'], -1)?.value?.toLowerCase()
    if (!has(p, 'force') || (type !== undefined && type !== 'file')) return
    return file(out, word(p, PATH_PARAMS, 0), st.cwds, ctx, 'New-Item -Force')
  }
  if (COPY.has(name)) {
    const dest = word(p, ['destination'], 1)
    const src = word(p, PATH_PARAMS, 0)
    if (!dest) return
    if (dest.value === null) return void out.push({ kind: 'computed', hint: dest.raw, via: name })
    return addInto(out, dest.value, [src?.value ?? src?.raw ?? ''], st.cwds, ctx, name, true)
  }
  if (!cmd && SHELLS.has(name)) {
    const i = rest.findIndex(w => /^-[A-Za-z]*c$|^-e$|^--exec$/.test(w.value ?? ''))
    if (i >= 0) lang.bash(rest.slice(i + 1).map(w => w.value ?? w.raw).join(' '), st.cwds, run)
    return
  }
  if (name === 'cmd') {
    const i = rest.findIndex(w => /^\/[a-z]*[ck]$/i.test(w.value ?? ''))
    if (i >= 0) lang.cmd(rest.slice(i + 1).map(w => w.value ?? w.raw).join(' '), st.cwds, run)
    return
  }
  if (name === 'powershell' || name === 'pwsh') {
    const i = rest.findIndex(w => /^[-/](command|c)$/i.test(w.value ?? ''))
    if (i >= 0) lang.ps(rest.slice(i + 1).map(w => w.value ?? w.raw).join(' '), st.cwds, run)
    return
  }
  const flags = interpreterFlags(name)
  if (flags) {
    const i = rest.findIndex(w => flags.includes(w.value ?? ''))
    const code = rest[i + 1]
    if (i >= 0 && code) inlineCode(code.value ?? code.raw, st.cwds, ctx, out, name)
  }
}

function analyze(src: string, cwds: Cwds, run: Run, cmd: boolean): void {
  if (run.depth >= MAX_DEPTH) return
  const inner = { ...run, depth: run.depth + 1 }
  const st = { cwds }
  // Methodenaufrufe zerfallen beim Zerlegen an den Klammern: deshalb vorab im ganzen Text.
  if (!cmd) for (const m of src.matchAll(IO_FILE_CALL)) inlineCode(m[0], cwds, run.ctx, run.out, 'IO.File')
  for (const stmt of statements(src, run.ctx, cmd)) runStmt(stmt, st, inner, cmd)
}

const IO_FILE_CALL = /\[(?:System\.)?IO\.File\]::WriteAll\w*\([^\n]*/gi

lang.ps = (src, cwds, run) => analyze(src, cwds, run, false)
lang.cmd = (src, cwds, run) => analyze(src, cwds, run, true)
