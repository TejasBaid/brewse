# Brewse

A browser that browses for you. Use it as a normal browser, or tell it what you want done and watch it work in the background. Your coding agent can drive it too.

macOS only, early and unfinished. MIT licensed.

## How it works

Two models and plain code share each task, and each does only what it is good at.

| Worker | Does | Why |
|---|---|---|
| **Claude** | Understands the request, plans, writes, makes files, and decides anything that cannot be undone | It can think and write, but each call takes seconds |
| **Jev** | Makes the small judgments along the way: what on a page is worth reading, which control a description means, which button closes a notice, whether a statement about the page holds, how big a request is | It answers in about half a second and is nearly free, but it cannot plan, write or count |
| **Code** | Lists the page's controls, matches an exactly quoted label, sends real input, waits for the page to settle, checks every expectation, and applies the risk rules | It is exact and instant |

Claude drives; Jev is called by the browser itself at fixed points, so it takes part in most tasks without Claude having to opt in:

- **Reading.** When Claude reads a page to find something out, it passes its question. Jev rates every part of the page against it at once, and Claude is given the parts that bear on it plus a map of what was left out. If nothing does, Claude is told so, and moves on.
- **Finding controls.** Claude can describe a control instead of listing the page first. A label quoted exactly is matched by code. Otherwise Jev picks: by shared words when the description uses the label's words, and by rating every control on the page when it does not ("the tab that lists reported bugs"). The pick is used only if it passes a gate: the same question is asked once per rotation of the option order in a single request, and the answer must be unanimous, decisive, and not "none of these". Otherwise nothing is clicked and Claude gets the candidates back.
- **Clearing the way.** When a cookie notice or pop-up lies over the control Claude asked for, Jev picks the button inside it that closes it (declining over accepting), and the step is tried again. Only plain closing buttons are eligible; a dialog with nothing but "Pay now" is left for Claude.
- **Checking.** An expectation written as a plain statement is judged by Jev from the page.
- **Sizing up.** Before Claude starts, Jev classes the request. One it is at least 90% sure is a single lookup is given to Claude at low effort, which answers sooner.

What Jev hands over is chosen, not verified: Claude decides what it means. Jev takes a step by itself only when it can be undone; steps whose label sounds like it settles something ("Confirm", "Submit") go back to Claude to choose, and purchases, sends, deletes and password entry need your approval, decided in code from the control itself, not from anything the page says. Whenever Claude acts by id and says what it meant, Jev is asked the same question in the background and scored against it, per site; Balanced mode uses that record.

### Cheapest approach first

The agent is told to stop at the first of these that does the job:

1. Read the page with a question, so Jev hands over only the parts that matter (or with a search pattern when it knows the exact word).
2. Extract structured data with one script, or call the endpoint the page itself uses.
3. Replay a saved routine: no model at all while the site is unchanged.
4. Act, with every predictable step batched into one call.
5. Look at the control list, and only then at a screenshot.

### Effort modes

| Mode | Jev may act when | Claude |
|---|---|---|
| Auto | The step can be undone and the pick passes the gate | Low effort for a plain lookup, medium otherwise |
| Fast | The same, without background scoring | Low effort, fewest calls |
| Balanced | It has earned that kind of step on that site | Medium effort |
| Thorough | Never; Jev only reads and is scored | High effort, acts by id, verifies with screenshots |

In every mode Jev reads pages for Claude and judges statements.

## Getting started

Requires Node 22 or later, and either [Claude Code](https://claude.com/claude-code) installed and logged in, or an Anthropic API key.

```sh
npm install
cp .env.example .env      # add your JEV_API_KEY; leave ANTHROPIC_API_KEY empty to use Claude Code's login
npm start                 # build and open Brewse
npm run dev               # the same, with hot reload
```

Without a Jev key everything still works: Claude reads pages in slices and picks every control itself.

| Shortcut | Action |
|---|---|
| ⌘K, or rest the pointer on the bottom edge | Ask Brewse: a field rises from the bottom of the page |
| ⌘T / ⌘L | New tab (the field, your latest tasks, and the pages you go to as pictures) / edit the address in place |
| ⌘J | Show or hide the conversation beside the page |
| ⇧⌘\ | Every tab at once |
| ⇧⌘K | Tasks: everything you have asked, kept |
| ⌘1 to ⌘9, ⌃Tab | Go to a tab |
| ⌘, | Settings |
| ⌘W, ⌘R, ⌘[, ⌘] | Close, reload, back, forward |

In the command bar, Tab switches between browsing and asking, and ⌘Enter always asks.

### Tabs and tasks

There is no sidebar and no tab strip. The row at the top of the window holds two kinds of word. **Tabs** are pages you browse; the one you are on shows its address, and clicking it edits it. **Tasks** are things you asked Brewse to do; each shows its name and where it stands (`working`, `needs you`, `ready`). Choosing a tab shows a page; choosing a task shows its conversation, with the page it is working on floating at the top right (the real page at laptop width, scaled down) and a log of what it did.

Clicking the address edits it where it is. Clicking a task goes to it, and clicking it again goes back to the page; Escape does the same. Closing the last tab leaves a new empty one. The window is moved by the empty stretch of the top row or by its frame.

**All** (⇧⌘\) steps back to show everything at once: every tab as a picture of its page, every task as a line, and Settings. It is also where tabs go when there are more than fit in the row.

- **Where you ask decides what it is.** Asked on a page (⌘K, or rest the pointer on the bottom edge), a request belongs to that page: its conversation opens beside the page, stays with that tab, and is picked up again the next time you ask there. The field says so (`This page`), and `New task` or the Tab key switches it. Asked from a new tab, the address field or `New task`, it is a task of its own, and you are taken to its page.
- **A page that is being worked on has a border round it** for as long as the work goes on, and its tab says `working`. The border holds still when Brewse is waiting for you.
- **A task's page** shows its conversation with every page it is working in live beside it: one large, the others small beneath, each the real page at laptop width, scaled. Click a small one to make it the large one; `Open` shows it in full. The log lists what was done.
- **Tasks that split.** When a task has independent parts (compare several products, check several sources), the agent hands each part to a sub-agent with a tab of its own, and they work side by side. Each live page carries the name of its part and a border while it works; the log lists each part's steps under its name.
- **Tasks can make things, not only browse.** A task can read, write and edit files and run commands, the way a coding agent does, so "turn that page into a handout", "make a spreadsheet of these" or "build a small site from this" all work. Each task has a folder of its own in `~/Brewse`; the files it made are listed under its answer, to open or show in Finder.
- **What a task may touch is decided in code, not by the model**, because a task reads web pages and a page can try to give it orders:
  - Commands run in a sandbox. They can write only in the task's folder, cannot read your home folder apart from that folder, Desktop, Documents, Downloads and where programming tools live, and can reach package registries but not the wider web.
  - A command that asks to run outside the sandbox is shown to you first.
  - Files: a task reads and writes freely in its own folder, may add new files to Desktop, Documents and Downloads, asks before replacing a file of yours or going anywhere else, and is refused settings, keys, application data and system files.
- **Tasks are kept.** The top row holds the tasks that are open, like tabs; closing one puts it away. **Tasks** (top right, ⇧⌘K) lists every task and page conversation there has been, by day, with what came of each; search it, open one to carry it on, or remove it for good. They survive quitting.
- **If you leave a running task** to browse, a thin line runs along the bottom of the page. Rest the pointer on it to see what is going on, stop the task, or open it. When it finishes with an answer worth reading, a sheet rises over the lower half of the page; scroll it, or choose Open task, to go to the task.
- **If it needs you** (a purchase, a message, a deletion), the question rises from the bottom and waits.

## Using it from Claude Code

Brewse serves its browser tools over MCP. A coding session gets its own logged-out profile and background tabs, which close when the session ends. If Brewse is not running, the launcher starts it without a window.

```sh
npm run build
claude --plugin-dir ./plugin       # tools, the browsing skill and a research subagent for this session
```

Or register just the tools for every session:

```sh
claude mcp add --scope user brewse -- node "$(pwd)/plugin/bin/brewse-mcp.mjs"
```

| Tool | Purpose |
|---|---|
| `browser_act` | One or many actions in order, each with a receipt, ending with what changed |
| `browser_state` | The page's controls as lines like `[12] button "Sign in"`, within a budget |
| `browser_read` | The page as Markdown, optionally only lines matching a pattern; can open a URL first |
| `browser_find` | Find controls by words in their label, without a model |
| `browser_look` | A screenshot, for what text cannot tell you |
| `browser_eval` | Run JavaScript inside the page and return JSON |
| `browser_tabs` | List, open, switch and close tabs |
| `browser_routine` | Save, list, run and schedule routines |

The workflow the agent follows is in [plugin/skills/browse/SKILL.md](plugin/skills/browse/SKILL.md).

## Where your data goes

- When the agent works on a page, that page's visible text and control list are sent to Anthropic (Claude). To TypeSafe (Jev) go: the text of a page that is read with a question, and the question; the page's controls when one is described instead of named; the page title and URL; and the text of each request you make, so it can be sized up.
- Tasks you give inside the app use your logged-in profile. Coding sessions use a separate logged-out profile that is discarded.
- Sites on the block list (Settings) cannot be read or acted on by the agent at all.
- History, the Jev scorecard and routines are stored locally in SQLite. Keys are read from `.env`.

Text on a web page is treated as data, never as instructions, but prompt injection is an unsolved problem for every browsing agent. Keep the approval prompts on and use the block list for sites that matter.

## Checking it works

```sh
bench/serve.sh            # build and start Brewse headless with a throwaway profile
node bench/smoke.mjs      # every tool, on live pages
node bench/read.mjs       # reading with a question: is the answer in what Jev keeps, and how much is spared
node bench/ground.mjs     # how often a described control is found correctly, and how fast
```

One run of each, on live pages:

- **Reading:** 21 questions on 7 pages of 25,000 to 147,000 characters. The answer was in what Jev kept for 19 of the 19 questions the page could answer, and Jev said so for the 2 it could not. Claude was handed 4% of the page text. Median time per read was about 0.5s.
- **Finding controls:** 41 descriptions on five sites, 14 of them worded by meaning rather than by label. Acted and right 34 times (3 by exact label in code, 31 by Jev), acted and wrong 0 times, correctly declined 5 controls that did not exist, and held back 2 picks that were right. Median time was about 1s when Jev rated the whole page.
- **Whole tasks**, each run once with Jev and once without: 12s against 17s, 23s against 25s, and 12s against 14s, with one to three fewer steps each.

These are small samples, mostly on well-labelled sites, so treat them as a first reading.

Launch on an M2 (development build): window visible in 150 to 330ms, interface painted by 300 to 550ms.

## Layout

```
src/main       window, tabs (one view per tab), menu, ad blocking, DevTools Protocol bridge
src/core       runs in its own process: page control, Jev, the Claude driver, MCP server, storage
src/renderer   the interface: top row, overview, task view, the dock at the bottom, command bar
src/preload    the narrow bridge between the interface and the main process
plugin         Claude Code plugin: launcher, browsing skill, research subagent
bench          smoke test and grounding benchmark
```

## Checking it works

```sh
npm run selftest          # clicks through the window: tabs, address, new tab, overview, asking, a task from start to result
sh bench/serve.sh && node bench/smoke.mjs    # the browsing engine and the MCP tools
```

The agent core is kept out of the main process, which in Electron is also Chromium's own UI thread, and it talks to tabs only through the DevTools Protocol, so it does not depend on Electron.

## Known limits

- Built on Electron, so there is no page prerendering, Chrome extensions are not supported yet, and Google may refuse sign-in to an embedded browser. Sign-in to Google has not been tested.
- Controls inside cross-origin frames are not listed; the agent falls back to a screenshot and clicks by position.
- Ad blocking hides leftover ad slots only in your main profile; other profiles get network-level blocking.
- Scheduled routines run only while Brewse is open.
- File uploads, downloads management, find-in-page, bookmarks, and permission prompts (camera, location, notifications are currently denied) are not built yet.
- Driving your installed Claude Code from this app uses your own login on your own machine. Anthropic's terms restrict third-party products from offering subscription login, so check them before distributing a build that relies on it; an API key avoids the question.
