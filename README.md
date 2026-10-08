# Herdr Command Palette

**Every Herdr action, one keystroke away. Built for working with coding agents.**

Press `prefix+t`, type a few letters, hit Enter. Jump to any running agent,
spin up a new Claude (or Codex, or Pi) tab in any project, launch your dev
server, or run any of Herdr's 100+ actions without remembering a single
command.

<!-- TODO: demo video -->
> 🎬 **Demo video coming soon.**

## Why you'll like it

- **One palette for everything.** Every action Herdr supports (panes, tabs,
  workspaces, agents, worktrees, plugins, and more) is in one fuzzy-searchable
  list.
- **Made for agent workflows.** Your running agents are at the top of the
  list, so you can jump straight to the one that needs you. Start a fresh agent
  tab in any project in two keystrokes.
- **Your projects, ready to go.** Save the folders you work in and open any of
  them as a new space instantly.
- **Per-project commands.** Attach commands like `pnpm dev` or
  `pnpm test --watch` to a project. They show up only when you're working in
  that project.
- **Smart prompts.** If an action needs a target, the palette asks for it and
  puts your current pane, tab, or space first.
- **Safe by default.** Closing, removing, or stopping anything asks you to
  confirm first.
- **Configure it from the palette.** Add projects and commands without
  opening a config file.

## Install

Requires Herdr 0.9.0+, Node.js, and macOS or Windows.

```bash
herdr plugin install doanhthong/atd-herdr-command-palette
herdr server stop   # restart Herdr to load the plugin and its keybinding
```

Then press **`prefix+t`** inside Herdr.

## What's in the palette

| Section | What it does |
| --- | --- |
| **Quick Actions** | New agent tab, new tab, new space |
| **Agents** | Every running agent, with the current one first. Select to jump to it |
| **Spaces** | Your open spaces. Select to switch |
| **New Space** | Your saved projects. Select to open one as a new space |
| **Space Commands** | Commands saved for the project you're in |
| **Space Config** | Add or remove projects and commands, or open the config file |
| **Everything else** | All of Herdr's actions, grouped by Agent, Pane, Tab, Workspace… |

Icons tell you what a row does: `+` creates, `−` closes or removes, `→`
switches to something.

## Make it yours

All settings live in one `config.json`. Run
`herdr plugin config-dir atd.command-palette` to find it, or just use
**Space Config → Open config.json** from the palette. Changes apply the next
time you open the palette.

### Jump to your projects

```json
{
  "spaces": [
    { "label": "my app", "path": "~/code/my-app" },
    { "path": "~/code/api" }
  ]
}
```

These appear under **New Space**. You can also add them from the palette with
**Add space to config…**.

### Per-project commands

```json
{
  "spaces": [
    {
      "label": "web",
      "path": "~/code/web",
      "commands": [
        { "label": "Dev server", "command": "pnpm dev -p 3001" },
        { "command": "pnpm test --watch" }
      ]
    }
  ]
}
```

When you're in `~/code/web`, these show up under **Space Commands**. Each
one opens in its own named tab. You can also add them from the palette with
**Add command to space…**.

### Your agents

By default, **New Claude tab** starts `claude`. Add your own agents:

```json
{
  "tabs": [
    { "label": "Claude", "command": "claude" },
    { "label": "Codex", "command": "codex" },
    { "label": "Pi", "command": "pi" }
  ]
}
```

Each one becomes a **New `<label>` tab** action. Once you set `tabs`, only
your entries are shown, so keep Claude in the list if you still want it.

## Good to know

- A few advanced actions aren't in the palette yet, such as sending key
  combos to a pane. Those take inputs the palette can't prompt for.
- The palette only asks for an action's required inputs. Optional settings
  use Herdr's defaults.
- It's tested on macOS and Windows. Linux isn't supported yet.

## Contributing

To see how it works, run it from source, or extend it, read
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). For local development, link a
checkout instead of installing:

```bash
herdr plugin link ~/code/atd-herdr-command-palette
```

## License

[MIT](LICENSE)
