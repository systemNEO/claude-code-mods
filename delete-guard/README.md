# delete-guard

A Claude Code mod: **deleting anything outside the project folder requires your approval.**

## What this does

Before Claude runs a shell command (Bash, PowerShell, Monitor) or an MCP tool
that deletes, delete-guard works out which paths the call would delete. If all
of them lie inside the folder the session was started in, nothing changes and
Claude decides as usual. If any of them lies outside, or cannot be determined,
delete-guard opens its own dialog with two options: *Erlauben* (allow) runs the
call, *Ablehnen* (deny) refuses it. Claude sees the refusal and the reason.
(The dialog text is currently in German.)

## Rules

| Situation | What happens |
| --- | --- |
| Every target lies inside the start folder | No dialog. The usual rules and permission mode decide, as without the mod. |
| A target lies outside the start folder | Dialog listing the outside targets and the command. |
| A target cannot be determined (a variable without a value, `$(cat list)`, `cat list \| xargs rm`, `Invoke-Expression $x`, `cd -`) | Treated as outside: dialog. |
| The target is the start folder itself (`rm -rf .`, `rm -rf /path/to/project`) | Treated as outside: dialog. |
| Wildcards (`*`, `?`, `[…]`, `{a,b}`) | What counts is the folder before the first wildcard: `../*` is the contents of `..` (outside), `build/*` the contents of `build` (inside). |
| `.*` with `find` and others | May match `..` in some shells, so the parent folder counts too. |
| A path inside the project whose symlink leads outside | Outside where the deletion follows the link (`rm -rf link/`), inside where it only removes the link (`rm link`). |
| A path written outside that resolves into the project | Still outside. Resolving a path never turns it into "inside". |
| The command moves first (`cd`, `pushd`/`popd`, `Set-Location`, `env -C`, `git -C`) | Paths are measured from the new folder. |
| The move may fail (`cd dir; rm …`, `cd dir \|\| rm …`, a new line) | Paths are measured from both the old and the new folder; only `cd dir && …` counts as certain. |
| The move happens in its own shell (`( cd dir )`, a pipeline element, `cd dir &`) | It ends there, as in the shell: later commands are measured from the old folder. |
| Any permission mode (`default`, `acceptEdits`, `auto`, `bypassPermissions`) or an allow rule such as `Bash(rm:*)` | The dialog still opens for targets outside. |
| The usual rules already deny the call | Stays denied, no dialog. |
| Subagents | Same rules. The dialog says a subagent wants to delete. |
| *Erlauben* | The call runs, without a second permission prompt. |
| *Ablehnen* | The call is refused; Claude is told the user denied it. |
| Free text typed into the dialog ("Other") | Counts as a denial; the text is passed on to Claude as the reason. |
| Nobody can be asked (`claude -p`, the SDK, dialog dismissed) | Denied. |
| The check itself fails | Denied (fail closed). |
| Scripts started by the command (`bash x.sh`, `./x.sh`, `source x.sh`, `.\x.ps1`, `x.cmd`) | Read and checked one level deep if they lie in the project or a temp folder. Installed tools elsewhere (e.g. `~/.nvm/nvm.sh`) are not read. |
| MCP tools with `delete`/`remove`/`unlink`/`rmdir`/`trash`/`erase` in their name | Their path arguments are checked like `rm -r`. Such tools without path arguments (e.g. deleting a cloud document) are left alone. |

## Commands

| Environment | Commands that count as deleting |
| --- | --- |
| Bash (Linux, macOS, WSL, Git Bash) | `rm`, `rmdir`, `unlink`, `shred`, `trash`/`trash-put`, `gio trash`, `rimraf`, `find -delete` / `-exec rm`, `fd -x rm`, `xargs rm` (including the source of the pipeline), `rsync --delete` / `--remove-source-files`, `git clean`, `git rm`, `git worktree remove`, `dd of=`, `mkfs`, `wipefs` |
| PowerShell | `Remove-Item` and its aliases (`rm`, `ri`, `del`, `erase`, `rd`, `rmdir`) with `-Path`, `-LiteralPath`, arrays and every free argument; pipelines (`gci … \| Remove-Item`, `% { Remove-Item $_ }`); `.Delete()`, `[IO.File]::Delete`, `[IO.Directory]::Delete`; `Remove-ItemProperty` (registry); `Clear-RecycleBin`; `Invoke-Expression` |
| cmd.exe | `del`, `erase`, `rd`, `rmdir`, also behind `if exist …` and `for … do` |
| Wrappers and nesting | `sudo`, `doas`, `env`, `timeout`, `nice`, `nohup`, `npx`, `pnpm dlx` …; `bash -c`, `sh -c '…' _ arg`, `eval`, heredocs, here-strings, `echo … \| bash`, `$(…)`, backticks; `powershell -Command` / `-EncodedCommand`, `pwsh`, `cmd /c`, `wsl …` |
| Inline code | `python -c`, `node -e`, `perl -e`, `ruby -e`, `php -r`, `deno eval` with delete calls (`shutil.rmtree`, `os.remove`, `fs.rmSync`, `unlink` …) |

Paths are resolved the way the shell would: `~`, `$HOME`, `$env:TEMP`,
`%APPDATA%` and other environment variables, assignments earlier in the
command, `for` loops, `$(pwd)`, `$(dirname "$0")`, `$(cd dir && pwd)`,
`Join-Path`.

Every other command runs as normal.

## Windows: `\` and the drive root

On Windows, a path that starts with `\` is relative to the **root of the
current drive**, not to the current folder. A stray `\*` after a delete command
therefore points at `C:\`. delete-guard treats all of these as the drive root,
and so as outside:

| Written | What Windows does with it | delete-guard sees |
| --- | --- | --- |
| `Remove-Item \* -Recurse`, `del /s /q \*`, `rd /s /q \` | Root of the current drive | `C:\` → dialog |
| `Remove-Item build \*`, `del /q build \*` (stray space) | `build` **and** the drive root | `C:\` → dialog |
| `Remove-Item / -Recurse` (PowerShell) | Root of the current drive | `C:\` → dialog |
| `C:` | Current folder on drive C: | `C:\` → dialog (never "the project") |
| `C:*` | Contents of the current folder on C: | `C:\` → dialog |
| `cd \; Remove-Item *`, `cd /d C:\ & del /s /q *` | Moves to the root first | `C:\` → dialog |
| `..\..\..\..\*` | `..` stops at the root | `C:\` → dialog |
| `$env:SystemDrive\*`, `%SystemDrive%\*` | `C:\*` | `C:\` → dialog |
| `\\?\C:\*`, `\\.\C:\` | Long-path and device prefixes | outside → dialog |
| `Microsoft.PowerShell.Core\FileSystem::C:\*` | Provider-qualified path | `C:\` → dialog |
| `HKLM:\…`, `HKCU:\…`, `Env:\…`, `Cert:\…` | Registry and other providers | outside → dialog |
| `\\server\share\x` | Network share | outside → dialog |
| `D:\*` | Root of another drive | `D:\` → dialog |
| `rm -rf /*`, `rm -rf /c/*` (Git Bash) | Root of the Git install, or of drive C: | `C:\` → dialog |
| `C:\x`, `/c/x` (Git Bash), `/mnt/c/x` (WSL), `c:\X` | The same place | compared as the same path, case-insensitively |

The same holds inside nested calls: `powershell -Command "Remove-Item \*"`,
`pwsh -EncodedCommand …`, `cmd /c "rd /s /q \"`, `iex "Remove-Item \*"`.

## Limitations

This is static analysis of the command text: programs that delete on their own
(a Python script file, `make clean`, `npm run clean`) are not seen, nor are
scripts outside the project and temp folders. Moving (`mv`) does not count as
deleting.

## Installation

On any machine (Linux, macOS, Windows), in a terminal:

```bash
claude plugin marketplace add systemNEO/claude-code-mods
claude plugin install delete-guard@claude-code-mods
```

The first line adds this repository as a marketplace, the second installs the
mod for your user, i.e. for all projects and sessions on that machine. On
Windows this works the same in PowerShell, cmd or Git Bash; the mod runs inside
Claude Code itself and needs neither Node nor Python.

Alternatively, inside a running Claude Code session:

```
/plugin install delete-guard --marketplace systemNEO/claude-code-mods
```

Sessions that are already running pick up the mod with `/reload-plugins`.

## Updates

**Update by hand** (on every machine that has the mod):

```bash
claude plugin marketplace update claude-code-mods
claude plugin update delete-guard@claude-code-mods
```

The first line fetches the current state of this repository, the second
installs the newer version. Then run `/reload-plugins` in sessions that are
already running (or restart them); new sessions load it automatically.

**Update hint from the mod itself:** once a day, shortly after a session
starts, delete-guard reads the version on GitHub. If it is newer than the
installed one, it shows a notice with the two commands above. It never
installs anything on its own: a deletion guard that silently loads new code
would be a risk of its own. To turn the hint off, set
`DELETE_GUARD_NO_UPDATE_CHECK=1` (it is also off with
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`).

**Automatic updates by Claude Code:** Claude Code can keep a marketplace and
its plugins up to date by itself. For marketplaces like this one it is off by
default. To turn it on, open `/plugin` → *Marketplaces* → `claude-code-mods` →
*Enable auto-update*, or add `"autoUpdate": true` to the marketplace entry in
`~/.claude/settings.json`:

```json
"extraKnownMarketplaces": {
  "claude-code-mods": {
    "source": { "source": "github", "repo": "systemNEO/claude-code-mods" },
    "autoUpdate": true
  }
}
```

Claude Code then checks in the background during a session and reports
"Plugin updated … Run /reload-plugins to apply". Turning it on means new
versions of this repository are installed without asking you each time.

**For maintainers:** Claude Code installs a new copy only when the `version` in
`.claude-plugin/plugin.json` changes. Bump it with every change you publish,
otherwise `claude plugin update` reports "already at the latest version".

## Disable or remove

```bash
claude plugin disable delete-guard@claude-code-mods
claude plugin uninstall delete-guard@claude-code-mods
```

## Where it applies

Once installed, the mod applies to every Claude Code session on that machine,
in every project and folder (it is installed with the `user` scope).

- **New sessions** load it automatically.
- **Sessions that are already running** need `/reload-plugins` once.
- **Subagents** are covered within every session.
- **`claude -p` (scripts, automation):** the mod is active, but nobody can be
  asked there, so deleting outside the start folder is denied.
- **Desktop app:** local Code sessions of the desktop app load plugins
  installed for the user as well.

One exception: each environment with its own Claude Code configuration
(`~/.claude`) needs its own installation. On a Windows PC that runs Claude Code
both inside WSL and natively on Windows (PowerShell or cmd), these are two
separate installations; run the two install commands once in each of them.
Cloud sessions on claude.ai do not run on your machine and are not covered.

## How it works

- A `tool.check` hook, the permission decision itself: it runs for every tool
  call, subagents included, and its verdict holds in every permission mode.
- `$.ui.ask` holds the call until the user answers; the hook then returns
  `allow` or `deny` with a reason Claude can act on.
- `$.fs.stat(path, { resolve: true })` resolves symlinks; a path is outside if
  either the written or the resolved form is.
- A `session.start` hook schedules the daily update check with `$.clock.after`,
  so it never delays the start of a session; `$.store` remembers the last check.
- The parsers for Bash, PowerShell and cmd (`hooks/bash.ts`, `hooks/ps.ts`) are
  pure functions without `$`, tested with about 200 cases in `tests/`.
  Nothing in the tests is executed; they only analyse command text.

## Development

```bash
claude plugin validate .
claude plugin test .
```
