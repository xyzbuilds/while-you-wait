# While you wait

A Claude Code mod for the minutes Claude spends working. After two minutes of a turn, the status line shows what is waiting for you on GitHub; `/wait` opens it in the side panel:

- **Review requested:** pull requests waiting for your review. **Diff** shows the changes in the panel, file by file. **Pre-review** asks Claude Haiku for a one-line summary and up to five places worth a closer look.
- **Your pull requests:** changes requested, failing checks, approved and ready to merge, new comments since you last opened them.
- **Assigned issues.**

Everything comes from GitHub through the `gh` CLI, for the account it is signed in to. Work untouched for 90 days and archived repositories are left out. The status line clears when Claude finishes.

## Install

Needs the [GitHub CLI](https://cli.github.com), signed in (`gh auth login`), and a Claude Code build with mods. Any terminal, on macOS, Linux or Windows. No keys to set up: GitHub calls go through `gh`'s own sign-in, and Pre-review through your Claude Code login.

```bash
git clone https://github.com/xyzbuilds/while-you-wait.git
claude --plugin-dir ./while-you-wait
```

To load it in every session, add the folder's full path to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json` (folders separated by `:`):

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/Users/you/mods/while-you-wait" } }
```

## Tests

```bash
claude plugin validate .
claude plugin test .
```

## Settings

In `/config`:

| Setting | Default |
|---|---|
| Minutes before the hint | 2 |
| Open the side panel by itself | off |
| This repository only | off |

## Commands

`/wait` opens the panel; `/wait refresh` fetches again first. The panel refreshes every 10 minutes.

MIT License · © 2026 XYZ Makes LLC
