# delete-guard

A Claude Code mod: **deleting anything outside the project folder requires your approval.**

## What this does

Before Claude runs a shell command (Bash, PowerShell, Monitor) or an MCP tool
that deletes, delete-guard works out which paths the call would delete. If all
of them lie inside the boundary folder (by default the folder the session was
started in, see [Configuration](#configuration)), nothing changes and
Claude decides as usual. If any of them lies outside, or cannot be determined,
delete-guard opens its own dialog with two options: *Erlauben* (allow) runs the
call, *Ablehnen* (deny) refuses it. Claude sees the refusal and the reason.
(The dialog text is currently in German.)

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

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `boundary` | empty | The folder inside which deleting needs no approval. Empty: the folder the session was started in. An absolute path or `~` for your home folder, e.g. `~`, `~/projects`, `/srv/work`; on Windows `~\projects` or `C:\Users\you\projects`. |

The boundary **replaces** the start folder; it does not add to it. With
`~/projects`, a session started in `~/projects/app` may delete anywhere in
`~/projects`, while a session started in `/tmp/demo` asks even for its own
files. The boundary folder itself, like the start folder, counts as outside:
deleting `~` with the boundary `~` asks. A relative path (`projects`) or a `~`
that cannot be resolved is ignored and the start folder applies.

Set it in one of three ways:

- In Claude Code: `/plugin configure delete-guard@claude-code-mods`.
- In a terminal:

  ```bash
  echo '{"boundary": "~/projects"}' | claude plugin configure delete-guard@claude-code-mods --values-stdin
  ```

  The same line works in PowerShell. In cmd, leave out the single quotes:
  `echo {"boundary": "~\\projects"} | claude plugin configure delete-guard@claude-code-mods --values-stdin`.
  In JSON, a backslash is written twice: `"C:\\Users\\you\\projects"`.
  `claude plugin configure delete-guard@claude-code-mods` alone shows the current value.
- In `~/.claude/settings.json`:

  ```json
  "pluginConfigs": {
    "delete-guard@claude-code-mods": { "options": { "boundary": "~/projects" } }
  }
  ```

An empty value (`""`) goes back to the start folder.

**The setting is global.** All three ways write it to your user settings
(`~/.claude/settings.json`, under `pluginConfigs`), so it applies to every
session in that environment, whichever folder it starts in:

- New sessions use the new value right away.
- Sessions that are already running pick it up with `/reload-plugins`.
- It is one value for all projects. A different boundary per project or per
  session is not possible yet (see [To do](#to-do)).
- Like the installation itself, it applies only to the environment whose
  `~/.claude` it was written to. WSL and native Windows on the same PC each
  need their own setting.

If `/plugin configure` answers *declares no userConfig options*, the running
session still has a version older than 0.4.0 loaded: update the plugin, run
`/reload-plugins`, and try again.

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

## Rules

"Start folder" below means the boundary folder: the folder the session was
started in, or the folder set in [Configuration](#configuration).

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

## Notes / limitations

**What it reads**

- It reads the command text, not what the command does when it runs.
  Programs that delete on their own are not seen: a Python or Node script
  file, a compiled binary, `make clean`, `npm run clean`, a Git hook.
- Shell scripts that the command starts (`bash x.sh`, `./x.sh`, `source x.sh`,
  `.\x.ps1`, `x.cmd`) are read one level deep, and only if they lie in the
  project or a temp folder. Scripts those scripts call, and scripts elsewhere
  (installed tools such as `~/.nvm/nvm.sh`), are not read.
- Inline code (`python -c`, `node -e` …) is checked by a heuristic: it looks
  for delete calls and takes every string in the code as a possible path.
  Paths built at run time count as unknown (dialog); deliberately obfuscated
  code can slip through.
- Aliases and shell functions from your shell profile are not known. A
  function defined in the same command is checked where its body appears.
- Unrecognised wrappers hide the command behind them, for example
  `chroot /mnt rm …`, `strace rm …`, `flock file rm …`.
- Commands that run elsewhere are not followed: `ssh host rm …`,
  `docker exec … rm …`, `kubectl exec …`. A container with a host folder
  mounted (`docker run -v /:/host … rm -rf /host`) can delete on this machine
  without a dialog.
- PowerShell is a subset: script blocks, functions and `foreach` loops are
  read as plain statements, so a variable they set is unknown (dialog).
  Splatting (`Remove-Item @params`) is unknown (dialog). `Start-Process` with
  an argument list is not followed.
- More than 64 variants of one word (long `for` lists, nested `{a,b}`) count as
  unknown (dialog) instead of being checked one by one. Nesting deeper than six
  levels (`bash -c` in `eval` in …) counts as unknown too.

**What counts as deleting**

- Only deleting. Other ways to lose data are not held: moving (`mv`),
  overwriting (`> file`, `cp` over a file, `sed -i`, `truncate`),
  `git reset --hard`, `git checkout -- .`, `git stash drop`, `chmod`,
  dropping a database.
- Only the Bash, PowerShell and Monitor tools and MCP tools whose name says
  they delete. Claude's file tools (Write, Edit) cannot delete, but can
  overwrite a file outside the project; Claude Code's own permission settings
  govern those.

**The boundary**

- The boundary is the folder the session was started in (where `/cd` or a
  worktree switch moves it), or the `boundary` option; never the shell's
  current folder. A session started in your home folder, or the boundary `~`,
  treats everything in your home folder as inside.
- Symlinks are resolved when the call is checked. If something changes the
  link between the check and the run, the run follows the new link. Hard links
  are not detected.
- `/tmp`, the Claude scratchpad and every other folder outside the project
  are outside: cleaning them up asks too.

**The dialog**

- The dialog text is in German. It lists up to eight findings (with a count
  of the rest) and shows the command cut to 400 characters.
- Allowing runs the whole command as written, not just the deleting part. It
  holds a call; it does not sandbox it.
- Some harmless commands ask too: a `cd` that might fail
  (`cd dir; rm ../x`), a variable whose value it cannot know (`rm -rf "$OUT"`
  with `OUT` set outside the command), `rm -rf "$(mktemp -d)"`.
- If the check itself fails, the call is denied. A rare parsing problem can
  therefore block a legitimate command.

**Other**

- Windows support (PowerShell, cmd, Git Bash, drive roots) is covered by tests
  of the analysis, which only read command text. It has not yet been run in a
  live Windows session.
- The update check sends one request a day to `raw.githubusercontent.com`.
- This is a safety net, not a permission system. Use permission deny rules for
  a hard block, and backups for what matters.

## To do

- **Boundary per project and per session.** Today the `boundary` option is
  one global value. Planned: a boundary per project (for example from the
  project's `.claude/settings.json`) and one for the current session only
  (for example a slash command), each overriding the global value.

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
  pure functions without `$`, tested with about 210 cases in `tests/`.
  Nothing in the tests is executed; they only analyse command text.

## Development

```bash
claude plugin validate .
claude plugin test .
```
