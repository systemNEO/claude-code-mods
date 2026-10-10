import { describe, expect, test } from 'claude-code/testing'
import { type Ctx, type Lang, isNewer, lang, newOut, within } from '../hooks/common'
import '../hooks/bash'
import '../hooks/ps'

const LINUX: Ctx = {
  root: '/home/u/proj', win: false, home: '/home/u',
  env: n => ({ TMPDIR: '/tmp', BUILD: 'build' } as Record<string, string>)[n],
}
const WIN: Ctx = {
  root: 'C:/Users/u/proj', win: true, home: 'C:/Users/u',
  env: n => ({ TEMP: 'C:\\Users\\u\\AppData\\Local\\Temp', USERPROFILE: 'C:\\Users\\u', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' } as Record<string, string>)[n.toUpperCase()],
}

/** Ziele außerhalb (lexikalisch) und Unbestimmbares, wie register.ts sie meldet. */
function check(src: string, which: Lang = 'bash', ctx: Ctx = LINUX, cwd = ctx.root) {
  const out = newOut()
  lang[which](src, { cwd, vars: new Map(), stack: [] }, { ctx, out, depth: 0 })
  const outside = out.targets.filter(t => !within(t.path, ctx.root, ctx.win, t.mode === 'children')).map(t => t.path)
  return { outside, unknowns: out.unknowns, flagged: outside.length + out.unknowns.length > 0, targets: out.targets, scripts: out.scripts }
}

const free = (src: string, which?: Lang, ctx?: Ctx, cwd?: string) =>
  test(`frei: ${src}`, () => { const r = check(src, which, ctx, cwd); expect({ src, ...r, targets: undefined, scripts: undefined }).toEqual({ src, outside: [], unknowns: [], flagged: false, targets: undefined, scripts: undefined }) })
const asks = (src: string, which?: Lang, ctx?: Ctx, cwd?: string) =>
  test(`fragt: ${src}`, () => { expect({ src, flagged: check(src, which, ctx, cwd).flagged }).toEqual({ src, flagged: true }) })

describe('bash innerhalb', () => {
  free('rm -rf build')
  free('rm -rf ./dist node_modules/.cache')
  free('rm *.log')
  free('rm -rf *')
  free('rm -f "a b.txt" \'c d\'')
  free('cd src && rm -rf gen')
  free('cd /home/u/proj/sub; rm x')
  free('rm -rf /home/u/proj/build')
  free('find . -name "*.pyc" -delete')
  free('find src -type f -exec rm {} \\;')
  free('find . -name x | xargs rm -f')
  free('git ls-files -z | xargs -0 rm')
  free('X=build; rm -rf "$X"')
  free('for f in a b c; do rm "$f.tmp"; done')
  free('rm -rf "$(pwd)/out"')
  free('rm -rf $BUILD')
  free('git clean -fdx')
  free('ls; echo rm -rf /')
  free('grep -r "rm -rf /" .')
  free('python3 -c "import os; os.remove(\'x.txt\')"')
  free('bash -c "rm -rf tmp"')
  free('sudo rm -rf target')
  free('rsync -a --delete src/ backup/')
  free('npx rimraf dist')
  free('rm -- -weird-name')
  free('cat > out.txt <<EOF\nrm -rf /\nEOF')
})

describe('bash außerhalb', () => {
  asks('rm -rf /tmp/x')
  asks('rm -rf ../other')
  asks('rm ~/notes.txt')
  asks('rm -rf ~')
  asks('rm -rf $HOME/x')
  asks('rm -rf "$TMPDIR/cache"')
  asks('rm -rf /home/*/x')
  asks('rm ../*.txt')
  asks('cd .. && rm -rf proj2')
  asks('cd /etc; rm passwd')
  asks('rm -rf /home/u/proj')
  asks('rm -rf .')
  asks('find / -name core -delete')
  asks('find .. -exec rm -rf {} +')
  asks('find /var/log -type f | xargs rm')
  asks('sudo rm -rf /opt/app')
  asks('env rm /x')
  asks('timeout 5 rm -rf /srv/data')
  asks('bash -c "rm -rf /data"')
  asks("sh -c 'rm -rf \"$1\"' _ /etc")
  asks('eval "rm -rf /x"')
  asks('echo "rm -rf /x" | bash')
  asks('bash <<EOF\nrm -rf /x\nEOF')
  asks('X=/etc; rm -rf "$X"/*')
  asks('rm -rf $UNSET_VAR/')
  asks('rm -rf "$(cat list.txt)"')
  asks('cat list | xargs rm')
  asks('cd - && rm -rf x')
  asks('rm -rf {a,../b}')
  asks('python3 -c "import shutil; shutil.rmtree(\'/var/www\')"')
  asks('node -e "require(\'fs\').rmSync(require(\'os\').homedir()+\'/x\',{recursive:true})"')
  asks('rsync -a --delete src/ /mnt/backup/')
  asks('git -C /other/repo clean -fdx')
  asks('shred -u /home/u/secret')
  asks('unlink /tmp/sock')
  asks('rmdir /tmp/empty')
  asks('trash-put ~/Downloads/x')
  asks('dd if=/dev/zero of=/dev/sda')
  asks('echo $(rm -rf /x)')
  asks('powershell.exe -Command "Remove-Item C:\\\\Windows\\\\Temp\\\\x -Recurse"')
  asks('cmd.exe /c "del /q C:\\\\x\\\\*"')
  asks('find .* -delete')
  asks('ls | rm -rf $(cat)')
})

describe('git bash und wsl unter windows', () => {
  free('rm -rf build', 'bash', WIN)
  free('rm -rf /c/Users/u/proj/out', 'bash', WIN)
  asks('rm -rf /c/Users/u/other', 'bash', WIN)
  asks('rm -rf /mnt/c/Windows', 'bash', WIN)
  asks('rm -rf "C:\\Users\\u\\Desktop"', 'bash', WIN)
  asks('rm -rf ~/AppData', 'bash', WIN)
  test('Groß/Klein egal', () => { expect(check('rm -rf /c/users/U/PROJ/x', 'bash', WIN).flagged).toBe(false) })
})

describe('powershell innerhalb', () => {
  free('Remove-Item build -Recurse -Force', 'ps', WIN)
  free('Remove-Item -Path .\\dist, .\\out -Recurse', 'ps', WIN)
  free('rm -r -fo node_modules', 'ps', WIN)
  free('Get-ChildItem -Filter *.log | Remove-Item', 'ps', WIN)
  free('gci .\\tmp -Recurse | ForEach-Object { Remove-Item $_.FullName }', 'ps', WIN)
  free('Remove-Item (Join-Path $PWD "out")', 'ps', WIN)
  free('$d = "build"; Remove-Item $d -Recurse', 'ps', WIN)
  free('Remove-Item C:\\Users\\u\\proj\\x', 'ps', WIN)
  free('del *.tmp', 'ps', WIN)
  free('cmd /c "rd /s /q build"', 'ps', WIN)
  free('Write-Host "Remove-Item C:\\\\"', 'ps', WIN)
})

describe('powershell außerhalb', () => {
  asks('Remove-Item C:\\Windows\\Temp\\* -Recurse', 'ps', WIN)
  asks('Remove-Item -LiteralPath "C:\\Users\\u\\Desktop\\a.txt"', 'ps', WIN)
  asks('Remove-Item ..\\other -Recurse -Force', 'ps', WIN)
  asks('Remove-Item ~\\Documents\\x', 'ps', WIN)
  asks('Remove-Item $env:TEMP\\* -Recurse', 'ps', WIN)
  asks('Remove-Item "$env:APPDATA\\Code"', 'ps', WIN)
  asks('Remove-Item $HOME\\.ssh', 'ps', WIN)
  asks('ri D:\\data -r', 'ps', WIN)
  asks('rd \\\\server\\share\\x', 'ps', WIN)
  asks('Set-Location ..; Remove-Item proj2 -Recurse', 'ps', WIN)
  asks('cd C:\\; del x', 'ps', WIN)
  asks('Get-ChildItem C:\\Temp | Remove-Item -Recurse', 'ps', WIN)
  asks('gci $env:TEMP | % { Remove-Item $_ -Recurse }', 'ps', WIN)
  asks('Get-Content list.txt | Remove-Item', 'ps', WIN)
  asks('[System.IO.File]::Delete("C:\\x.txt")', 'ps', WIN)
  asks('[IO.Directory]::Delete($p, $true)', 'ps', WIN)
  asks('(Get-Item C:\\x).Delete()', 'ps', WIN)
  asks('Remove-Item $unbekannt', 'ps', WIN)
  asks('Remove-Item HKCU:\\Software\\X -Recurse', 'ps', WIN)
  asks('Remove-ItemProperty HKLM:\\Software\\X -Name y', 'ps', WIN)
  asks('Clear-RecycleBin -Force', 'ps', WIN)
  asks('iex "Remove-Item C:\\x"', 'ps', WIN)
  asks('Invoke-Expression $cmd', 'ps', WIN)
  asks('cmd /c "del /s /q %USERPROFILE%\\x"', 'ps', WIN)
  asks('cmd /c rd /s /q C:\\x', 'ps', WIN)
  asks('powershell -NoProfile -Command "Remove-Item C:\\x"', 'ps', WIN)
  asks('pwsh -EncodedCommand UgBlAG0AbwB2AGUALQBJAHQAZQBtACAAQwA6AFwAeAA=', 'ps', WIN)
  asks('wsl rm -rf /mnt/c/x', 'ps', WIN)
  asks('$p = "C:\\x"; Remove-Item $p', 'ps', WIN)
  asks('Remove-Item -Path C:\\a,C:\\Users\\u\\proj\\b', 'ps', WIN)
})

describe('cmd', () => {
  free('del /q build\\*.obj', 'cmd', WIN)
  free('if exist out rd /s /q out', 'cmd', WIN)
  asks('del /f /s /q C:\\Windows\\Temp\\*', 'cmd', WIN)
  asks('rd /s /q %APPDATA%\\x', 'cmd', WIN)
  asks('for %i in (*.txt) do del %i', 'cmd', WIN)
  asks('cd .. & rd /s /q other', 'cmd', WIN)
})

describe('Skripte', () => {
  test('bash skript.sh wird zum Nachlesen gemeldet', () => {
    expect(check('bash scripts/clean.sh').scripts).toEqual([{ path: '/home/u/proj/scripts/clean.sh', lang: 'bash' }])
  })
  test('./x.sh ebenso', () => {
    expect(check('./x.sh').scripts).toEqual([{ path: '/home/u/proj/x.sh', lang: 'bash' }])
  })
  test('.\\x.ps1 in PowerShell', () => {
    expect(check('& .\\tools\\clean.ps1', 'ps', WIN).scripts).toEqual([{ path: 'C:/Users/u/proj/tools/clean.ps1', lang: 'ps' }])
  })
})

describe('Ziel-Arten', () => {
  test('rm link ohne Schrägstrich: nur der Link', () => {
    expect(check('rm -rf link').targets.map(t => t.mode)).toEqual(['exact'])
  })
  test('rm -rf link/: voll aufgelöst', () => {
    expect(check('rm -rf link/').targets.map(t => t.mode)).toEqual(['deep'])
  })
  test('rm *: Inhalt des Ordners', () => {
    expect(check('rm -rf *').targets).toEqual([{ path: '/home/u/proj', mode: 'children', via: 'rm' }])
  })
})

describe('Windows-Platzhalter und .Delete()', () => {
  test('C:\\Windows\\Temp\\* ist der Inhalt von C:/Windows/Temp', () => {
    expect(check('Remove-Item C:\\Windows\\Temp\\* -Recurse', 'ps', WIN).targets).toEqual([{ path: 'C:/Windows/Temp', mode: 'children', via: 'remove-item' }])
  })
  test('(Get-Item C:\\x).Delete() trifft C:/x', () => {
    const r = check('(Get-Item C:\\x).Delete()', 'ps', WIN)
    expect(r.outside).toEqual(['C:/x'])
    expect(r.unknowns).toEqual([])
  })
  test('[System.IO.File]::Delete ohne Nebenbefund', () => {
    expect(check('[System.IO.File]::Delete("C:\\x.txt")', 'ps', WIN).unknowns).toEqual([])
  })
})

describe('Pfad-Ausdrücke', () => {
  free('rm -rf "$(dirname "$PWD")/proj/out"')
  free('D="$(cd sub && pwd)"; rm -rf "$D/x"')
  asks('rm -rf "$(dirname "$PWD")/other"')
  asks('rm -rf "$(mktemp -d)"')
})

// Ein angehängtes `\*` oder `\` zeigt unter Windows auf die Wurzel des Laufwerks.
// Diese Tests werten nur Befehlstexte aus; nichts davon wird ausgeführt.
describe('Windows: Laufwerkswurzel', () => {
  const C = 'C:/'
  const hits = (src: string, which: Lang = 'ps') => check(src, which, WIN).outside
  test('Remove-Item \\* trifft C:/', () => { expect(hits('Remove-Item \\* -Recurse -Force')).toEqual([C]) })
  test('Remove-Item -Path "\\*"', () => { expect(hits('Remove-Item -Path "\\*" -Recurse')).toEqual([C]) })
  test('Remove-Item -LiteralPath \\', () => { expect(hits('Remove-Item -LiteralPath \\ -Recurse')).toEqual([C]) })
  test('Remove-Item / (PowerShell)', () => { expect(hits('Remove-Item / -Recurse -Force')).toEqual([C]) })
  test('Remove-Item C:\\*', () => { expect(hits('Remove-Item C:\\* -Recurse')).toEqual([C]) })
  test('Remove-Item C:', () => { expect(hits('Remove-Item C: -Recurse')).toEqual([C]) })
  test('Remove-Item C:*', () => { expect(hits('Remove-Item C:* -Recurse')).toEqual([C]) })
  test('Remove-Item D:\\*', () => { expect(hits('Remove-Item D:\\* -Recurse')).toEqual(['D:/']) })
  test('versehentliches Leerzeichen: Remove-Item build \\*', () => { expect(hits('Remove-Item build \\* -Recurse')).toEqual([C]) })
  test('mit -Path und freiem Argument: Remove-Item -Path build \\*', () => { expect(hits('Remove-Item -Path build \\* -Recurse')).toEqual([C]) })
  test('ri, rm, del, erase, rd, rmdir', () => {
    for (const a of ['ri', 'rm', 'del', 'erase', 'rd', 'rmdir']) expect({ a, o: hits(`${a} \\* -r`) }).toEqual({ a, o: [C] })
  })
  test('.. über die Wurzel hinaus', () => { expect(hits('Remove-Item ..\\..\\..\\..\\..\\* -Recurse')).toEqual([C]) })
  test('Projektpfad mit .. zurück zur Wurzel', () => { expect(hits('Remove-Item C:\\Users\\u\\proj\\..\\..\\..\\* -Recurse')).toEqual([C]) })
  test('erst cd \\, dann *', () => { expect(hits(`cd ${String.fromCharCode(92)}; Remove-Item * -Recurse`)).toEqual([C]) })
  test('Set-Location C:\\, dann *', () => { expect(hits(`Set-Location C:${String.fromCharCode(92)}; Remove-Item * -Recurse`)).toEqual([C]) })
  test('$env:SystemDrive\\*', () => {
    const ctx = { ...WIN, env: (n: string) => (n.toUpperCase() === 'SYSTEMDRIVE' ? 'C:' : WIN.env(n)) }
    expect(check('Remove-Item $env:SystemDrive\\* -Recurse', 'ps', ctx).outside).toEqual([C])
  })
  test('\\\\?\\C:\\* (Langpfad-Präfix)', () => { expect(check('Remove-Item "\\\\?\\C:\\*" -Recurse', 'ps', WIN).flagged).toBe(true) })
  test('\\\\.\\C:\\ (Gerätepfad)', () => { expect(check('Remove-Item "\\\\.\\C:\\" -Recurse', 'ps', WIN).flagged).toBe(true) })
  test('FileSystem::C:\\*', () => { expect(hits('Remove-Item Microsoft.PowerShell.Core\\FileSystem::C:\\* -Recurse')).toEqual([C]) })
  test('[IO.Directory]::Delete("\\", $true)', () => { expect(hits('[IO.Directory]::Delete("\\", $true)')).toEqual([C]) })
  test('Get-ChildItem \\ | Remove-Item', () => { expect(hits('Get-ChildItem \\ -Recurse | Remove-Item -Force')).toEqual([C]) })
  test('gci \\ | % { Remove-Item $_ }', () => { expect(hits('gci \\ | % { Remove-Item $_ -Recurse }')).toEqual([C]) })
  test('iex mit \\*', () => { expect(hits('iex "Remove-Item \\* -Recurse"')).toEqual([C]) })
  test('-EncodedCommand mit Remove-Item \\*', () => {
    const enc = btoa(Array.from('Remove-Item \\* -Recurse').map(ch => ch + '\u0000').join(''))
    expect(hits(`powershell -EncodedCommand ${enc}`)).toEqual([C])
  })
  test('cmd: del /s /q \\*', () => { expect(hits('del /s /q \\*', 'cmd')).toEqual([C]) })
  test('cmd: rd /s /q \\', () => { expect(hits('rd /s /q \\', 'cmd')).toEqual([C]) })
  test('cmd: del /q build \\*', () => { expect(hits('del /q build \\*', 'cmd')).toEqual([C]) })
  test('cmd: cd /d C:\\ & del /s /q *', () => { expect(hits('cd /d C:\\ & del /s /q *', 'cmd')).toEqual([C]) })
  test('cmd: %SystemDrive%\\*', () => {
    const ctx = { ...WIN, env: (n: string) => (n.toUpperCase() === 'SYSTEMDRIVE' ? 'C:' : WIN.env(n)) }
    expect(check('del /s /q %SystemDrive%\\*', 'cmd', ctx).outside).toEqual([C])
  })
  test('cmd /c aus PowerShell', () => { expect(hits('cmd /c "rd /s /q \\"')).toEqual([C]) })
  test('Git Bash: rm -rf /*', () => { expect(check('rm -rf /*', 'bash', WIN).outside).toEqual([C]) })
  test('Git Bash: rm -rf /c/*', () => { expect(check('rm -rf /c/*', 'bash', WIN).outside).toEqual([C]) })
  test('Git Bash: rm -rf build /*', () => { expect(check('rm -rf build /*', 'bash', WIN).outside).toEqual([C]) })
  test('Git Bash: rm -rf "C:\\\\"*', () => { expect(check('rm -rf "C:\\\\"*', 'bash', WIN).outside).toEqual([C]) })
  test('Git Bash: powershell -c "Remove-Item \\\\* -r"', () => { expect(check('powershell -c "Remove-Item \\\\* -r"', 'bash', WIN).outside).toEqual([C]) })
  test('innerhalb bleibt frei: Remove-Item .\\build\\* und build\\*', () => {
    expect(check('Remove-Item .\\build\\* -Recurse; Remove-Item build\\* -Recurse', 'ps', WIN).flagged).toBe(false)
  })
})

describe('cd, der nicht oder nur in einer eigenen Shell wirkt', () => {
  asks('(cd sub); rm -rf ../x')
  asks('(cd sub && true) && rm -rf ../x')
  asks('cd sub | true; rm -rf ../x')
  asks('cd sub & rm -rf ../x')
  asks('cd gibtsnicht; rm -rf ../x')
  asks('cd gibtsnicht || rm -rf ../x')
  asks('cd sub\nrm -rf ../x')
  asks('Set-Location sub; Remove-Item ..\\x -Recurse', 'ps', WIN)
  asks('cd sub & rd /s /q ..\\x', 'cmd', WIN)
  asks('(cd /tmp && rm -rf x)')
  free('cd sub && rm -rf ../build')
  free('(cd sub && rm -rf gen) && rm -rf out')
  free('cd sub && cd deeper && rm -rf ../../build')
  free('pushd sub && rm -rf x && popd && rm -rf y')
  free('Set-Location sub && Remove-Item ..\\build -Recurse', 'ps', WIN)
  free('X=1 | true; rm -rf build')
})

describe('Versionsvergleich für den Update-Hinweis', () => {
  test('neuer', () => {
    expect(isNewer('0.3.0', '0.2.0')).toBe(true)
    expect(isNewer('1.10.0', '1.9.3')).toBe(true)
    expect(isNewer('v1.0.0', '0.9.9')).toBe(true)
    expect(isNewer('1.0.0', '1.0.0-beta')).toBe(true)
  })
  test('nicht neuer', () => {
    expect(isNewer('0.2.0', '0.2.0')).toBe(false)
    expect(isNewer('0.1.9', '0.2.0')).toBe(false)
    expect(isNewer('1.0.0-beta', '1.0.0')).toBe(false)
  })
})

describe('Splatting, -Path:$x und viele Varianten', () => {
  asks("$p = @{ Path = 'C:\\'; Recurse = $true }; Remove-Item @p", 'ps', WIN)
  asks('Remove-Item -Path:$unbekannt -Recurse', 'ps', WIN)
  asks("Remove-Item -Path:'C:\\x' -Recurse", 'ps', WIN)
  asks('$d = "C:\\x"; Remove-Item -LiteralPath:$d', 'ps', WIN)
  free('$d = "build"; Remove-Item -Path:$d -Recurse', 'ps', WIN)
  asks(`rm -rf {${Array.from({ length: 70 }, (_, i) => `d${i}`).join(',')},/etc}`)
  asks(`for f in ${Array.from({ length: 70 }, (_, i) => `d${i}`).join(' ')} /etc; do rm -rf "$f"; done`)
  free('rm -rf {a,b,c}/{x,y}')
})
