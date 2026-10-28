# Publishing checklist

Everything below is written for **you** to run — this repository is already
committed and ready to push. Total time: about 10 minutes.

> **Never pushed to GitHub before?** Follow [`docs/UPLOAD-GUIDE.md`](docs/UPLOAD-GUIDE.md)
> instead — same steps, in Chinese, with the browser dialogs spelled out.

## TL;DR — five commands

```bash
cd dsh-spend-meter
sed -i 's|github.com/USER/|github.com/YOURNAME/|g' package.json README.md CHANGELOG.md PUBLISHING.md docs/*.md docs/*.html
git config user.name "Your Name" && git config user.email "you@example.com"
git commit --amend --reset-author --no-edit
gh repo create dsh-spend-meter --public --source=. --remote=origin --push
npm publish --access public        # after `npm login`
```

Then in GitHub: set the 11 topics and upload `docs/social-preview.png` as the social
preview, create the `v0.4.4` release from `docs/release-notes-0.4.4.md`, and post one
announcement from `docs/announcement.md`. The sections below explain each step and the
things that actually drive discovery.

Placeholder note: `USER` has **already been replaced with `lx950`** for this checkout, so step 2 is a verification-only pass. If you fork this to another account, `USER`-style replacement still applies to `github.com/lx950`. Original wording: `USER` (your GitHub username) and, if you want a
different npm scope, `dsh-spend-meter`.

---

## 0. Pre-flight (1 minute)

```bash
cd /path/to/dsh-spend-meter
npm test                      # 28 assertions + 5 integration suites, all green
npm pack --dry-run            # confirm only the runtime files ship
```

`npm pack --dry-run` must list `lib/*.js`, `cordis.patch.yml`, `icon.svg`, `README.md`,
`DEVELOPMENT.md`, `docs/preview.svg`, `LICENSE` — and **not** `test/`, `.github/`, or any
local state file.

Check that no secrets are in the tree before the first push:

```bash
git status --short            # after step 1
git grep -n "sk-" || echo "no API keys found"
```

`.credentials.yaml`, `diag.json` and `ledger.json` are already in `.gitignore`.
`docs/social-preview.png` is tracked on purpose — it is the image you upload in step 3.

---

## 1. Replace the placeholder (30 seconds)

The placeholder is `github.com/USER` and it appears in **7 files** — `package.json`,
`README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `PUBLISHING.md`,
`docs/release-notes-0.4.4.md` and `.github/ISSUE_TEMPLATE/config.yml`. Replace all of them
in one shot rather than by hand:

```bash
# macOS / Linux
grep -rl "github.com/USER" . --exclude-dir=.git --exclude-dir=node_modules   | xargs sed -i 's|github.com/USER|github.com/YOURNAME|g'

# verify — must print nothing
grep -rn "github.com/USER" . --exclude-dir=.git --exclude-dir=node_modules
```

```powershell
# Windows (PowerShell)
Get-ChildItem -Recurse -File | Where-Object { $_.FullName -notmatch '\\.git\' -and $_.Extension -ne '.png' } |
  ForEach-Object { $c = Get-Content -Raw $_; if ($c -match 'github\.com/USER') { Set-Content -NoNewline $_ ($c -replace 'github\.com/USER','github.com/YOURNAME') } }
Select-String -Path (Get-ChildItem -Recurse -File -Include *.md,*.json,*.yml).FullName -Pattern 'github.com/USER'   # must print nothing
```

If `USER` remains, npm still publishes but every link 404s — 30 seconds well spent.

---

## 2. Create the GitHub repository and push

This checkout is already a git repository with its history in place — the only thing to fix
first is the commit author (it was created with a placeholder identity):

```bash
git config user.name  "Your Name"
git config user.email "you@example.com"
git commit --amend --reset-author --no-edit
```

Option A — GitHub CLI (fastest):

```bash
gh repo create dsh-spend-meter --public --source=. --remote=origin --push
```

Option B — web UI:

1. <https://github.com/new> → name `dsh-spend-meter` → Public → **do not** add a README,
   licence or .gitignore (they already exist here).
2. Then:

```bash
git remote add origin https://github.com/YOURNAME/dsh-spend-meter.git
git push -u origin main
```

---

## 3. Repository settings that actually drive discovery

- **About** (right sidebar, gear icon):
  - Description: `Live DeepSeek balance, per-turn charge and today's spend in a draggable DSH panel — measured from the billing counter.`
  - Website: leave empty (or your demo link).
  - **Topics** (these are the search surface, add all of them):
    `deepseek`, `deepseek-harness`, `dsh`, `dsh-plugin`, `llm-cost`, `token-usage`,
    `billing`, `electron`, `plugin`, `cost-tracker`, `observability`
- **Social preview**: Settings → General → Social preview → upload
  `docs/social-preview.png` (1280×640, already generated; re-render
  `docs/social-preview.html` if you change the wording). This is the single
  highest-leverage image for click-through on X / HN / Reddit.
- **Releases**: enable Discussions only if you want a Q&A channel (Settings → Features).

---

## 4. Tag and publish the GitHub release

```bash
git tag -a v0.4.4 -m "v0.4.4 — accurate to 1e-8: billing-counter meter"
git push origin v0.4.4
```

Then GitHub → Releases → *Draft a new release* → choose tag `v0.4.4` → title
`v0.4.4 — accurate to 1e-8` → paste the body from
[`docs/release-notes-0.4.4.md`](docs/release-notes-0.4.4.md) → **Publish release**.

---

## 5. Publish to npm

```bash
npm login                     # once per machine
npm whoami                    # must print your npm username
npm publish --access public
```

Verify: `npm view dsh-spend-meter version` → `0.4.4`, and
<https://www.npmjs.com/package/dsh-spend-panel> shows the README.

Releases after the first one:

```bash
npm version patch             # or minor / major — bumps package.json + git tag
git push --follow-tags
npm publish --access public
```

> If the name is taken, everything still works: rename `"name"` in `package.json`
> (e.g. `@yourname/dsh-spend-panel`) and update the install line in the README.
>
> **npm is optional.** The plugin installs straight from GitHub
> (`dsh plugin --profile <name> add github:lx950/dsh-spend-meter`), so this whole page only
> matters if you also want the npm-registry install path and the badge.

---

## 6. CI badge (2 minutes, makes the repo look maintained)

`.github/workflows/ci.yml` is already included; it runs the full suite on Node 20 and 22
for every push and pull request. Push once and the badge lights up. Then add to the top of
`README.md`:

```markdown
[![CI](https://github.com/YOURNAME/dsh-spend-meter/actions/workflows/ci.yml/badge.svg)](https://github.com/YOURNAME/dsh-spend-meter/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-spend-panel.svg)](https://www.npmjs.com/package/dsh-spend-panel)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
```

(The README already carries these badges with the `USER` placeholder — just replace it.)

---

## 7. Tell people (the part that produces stars)

Copy-paste text lives in [`docs/announcement.md`](docs/announcement.md): Show HN, Reddit,
X thread, V2EX, 掘金. Order that has worked:

1. **Show HN** (Tuesday–Thursday, 08:00–10:00 UTC) — lead with the number, not the plugin:
   "I got tired of not knowing what one turn costs, so I read the 8-decimal billing counter."
2. **Reddit** r/LocalLLaMA and r/DeepSeek — same body, no marketing voice, answer every
   comment for the first 6 hours.
3. **X** — a 4-tweet thread with the panel GIF/screenshot in tweet 1.
4. **Product Hunt** — optional, same day as HN if you have someone to help reply.
5. **V2EX / 掘金 / 少数派** — Chinese copy is in the same file.

Two rules that matter more than the copy: *answer questions for 24 h*, and *ship one
visible improvement the same week people arrive* (an issue they filed, fixed, is the best
second impression).

---

## 8. Definition of done

- [ ] `npm test` green; `npm pack --dry-run` clean
- [ ] `git grep -n "USER/dsh-spend-meter"` → empty
- [ ] GitHub repo public, 11 topics set, social preview uploaded
- [ ] `v0.4.4` tag + release with notes published
- [ ] `npm view dsh-spend-meter version` → `0.4.4`
- [ ] CI badge green on `main`
- [ ] One announcement posted, comments answered for 24 h
