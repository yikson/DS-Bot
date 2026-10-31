# DS Bot release and rollback procedure

This is an out-of-band procedure for the DS Bot plugin in **DSH Desktop**.
The operator uses a separate terminal. A Bot Session must not replace the
plugin that is supervising that Session.

**Recommended live procedure: prepare and test first, drain work, fully quit
Desktop, back up, change the package with Desktop's bundled CLI, then reopen
Desktop once and verify.** Do not change the live Desktop profile from an
external CLI while Desktop owns it. The hot-reload rehearsal below establishes
Web Host behavior; it does not authorize concurrent maintenance of Desktop.

This procedure does not publish an npm package, update DSH itself, merge a
release PR, or enable task sessions. Those are separate decisions.

## Runtime and profile ownership

Use the `dsh.cmd` under the installed Desktop's
`resources/runtime/cli/bin/` on Windows. Check its `--version`; an npm-global
`dsh` can use a different runtime and cannot maintain Desktop's reserved
profile. Never execute a guessed entry point inside `app.asar`, patch DSH, or
try to boot `--profile desktop` with the CLI.

DSH's [Desktop command documentation][desktop-cli] requires Desktop to be
fully quit before `dsh plugin --profile desktop ...` runs. It also describes
the exclusive ownership of that profile. A CLI command returning zero is
not evidence that an externally maintained, running Desktop is safe.

DSH [HMR][hmr] watches profile/home patches and bundle selections. A
dependency-only manifest change does not trigger profile recomposition.
Recomposition can detect changes in installed files and linked targets with
source watching disabled. It stops the old plugin before loading its
replacement: a failed replacement can leave the Host alive **without DS Bot**.
A page reload refreshes browser code independently of Host replacement.

## Prepare before the maintenance window

Use a permanent, separate release checkout at an approved, recorded commit.
Do not build over a checkout already linked to a running profile. Keep the
previous checkout/package available until acceptance.

Run in the candidate's `ds-bot/`:

```sh
npm ci
npm run harness
npm run build
npm test
node scripts/build-client.mjs --check
npm run lint
```

Require natural test-process exit. Run the required host smoke/feature
acceptance tests when the release changes host behavior. Rehearse against
the exact Desktop runtime in an isolated `DSH_HOME`, with synthetic data and
the mock model, before the live window. Record commit, package version, DSH
version, test results and the approved rollback target's data compatibility.
A version in `package.json` alone does not identify the loaded code; preserve
the commit and verify runtime diagnostics after startup.

## Preflight and data compatibility

Stop admitting new user/Bot work and pause scheduled or external producers.
Let existing work finish; do not delete records to make the checks pass.
Before quitting, verify the running profile has:

- `works = 0`, including pending replies, delivery retries and recovery work;
- no open, creating, closing, failed-but-unresolved or otherwise unsettled
  task/legacy branch, and no unacknowledged conclusion/outbox;
- idle Bots, groups, task Sessions and managed Agent Sessions, with no active
  model/tool turn, compaction, handoff, memory review or pending approval.

Use the current UI/runtime work view as well as persisted state. An empty
activity indicator or a quiet sidebar alone is insufficient. Old, delivered
request receipts and closed historical branches may remain. Inspect ambiguous
statuses using the release's schema; unknown/malformed state is a stop condition.

For a v2-aware build, disable `taskSessionsEnabled` or remove capability
names from **both** `taskSessions` and legacy `workBranches` to stop new v2
tasks. Disabling the gate does not close existing tasks. Preserve other
configuration; Cordis config overrides replace the entire entry config.

**Once any v2 task exists in `state.tasks`, even a closed one, every rollback
target must be v2-aware.** The outer `state.version` does not prove task
compatibility. Use a target demonstrated to read the current task, receipt,
outbox and Session formats. Gate-off is the normal operational rollback:
keep a compatible build installed while tasks route and close. Never use a
pre-v2 build merely because it starts or ignores unfamiliar fields.

Non-empty `task.workers` also requires a worker-aware target, including when
all runs have settled or `nativeWorkers` is off. Absent/empty worker maps do
not add that requirement. Keep the current data and ownership tombstones.
Before switching, require drained admissions, idle workers, settled results
and confirmed terminal cleanup; an offline count alone cannot prove readiness.

After fully quitting Desktop and waiting for its Host/package operations to
finish normally, inspect the stopped state again. This read-only PowerShell
example prints counts, not Bot names, conversations or secrets:

```powershell
$HomeDir = '<DSH_HOME>'
$StatePath = Join-Path $HomeDir 'bot/state.json'
$State = Get-Content -LiteralPath $StatePath -Raw |
    ConvertFrom-Json -AsHashtable
if ($State -isnot [System.Collections.IDictionary] -or
    $State.bots -isnot [System.Collections.IDictionary] -or
    $State.works -isnot [System.Collections.IDictionary]) {
    throw 'Unknown state shape; inspect with the release schema.'
}
if ($State.Contains('tasks') -and
    $State.tasks -isnot [System.Collections.IDictionary]) {
    throw 'Unknown task shape; do not infer compatibility.'
}
$Branches = @($State.bots.Values | ForEach-Object {
    if ($_.workBranches) { $_.workBranches.Values }
})
$Workers = @($State.tasks.Values | ForEach-Object {
    if ($_.Contains('workers')) {
        if ($_.workers -isnot [System.Collections.IDictionary]) {
            throw 'Unknown workers shape; refuse an unaware rollback.'
        }
        $_.workers.Values
    }
})
[pscustomobject]@{
    Works = $State.works.Count
    TasksTotal = if ($State.tasks) { $State.tasks.Count } else { 0 }
    WorkersTotal = $Workers.Count
    RequiresWorkerAwareTarget = $Workers.Count -gt 0
    UnsettledLegacyBranches = @($Branches |
        Where-Object { $_.state -ne 'closed' }).Count
}
```

This is an inventory, not a readiness verdict: inspect every nonterminal task,
pending delivery and creation marker. Offline state cannot establish that a
running Host is idle. If v2 compatibility cannot be demonstrated, keep the
profile stopped for forward recovery.

## Private backup while Desktop is stopped

Set explicit operator paths in a separate terminal:

```powershell
$ErrorActionPreference = 'Stop'
$Dsh = '<Desktop install>/resources/runtime/cli/bin/dsh.cmd'
$env:DSH_HOME = '<DSH_HOME>'
$ProfileDir = Join-Path $env:DSH_HOME 'profiles/desktop'
$PackageDir = Join-Path $ProfileDir 'node_modules/ds-bot'
$Checkout = '<checkout>'
$Backup = '<private backup directory outside the profile and checkout>'
& $Dsh --version
if ($LASTEXITCODE -ne 0) { throw 'Runtime check failed; leave Desktop stopped.' }
```

Keep backups private, outside Git and public attachments. Do not dump profile
configuration or credentials into release logs.

Back up and verify all of the following before changing anything:

1. The exact installed `ds-bot` package directory. If it is a link, first
   record its real target and copy that target's contents into a **plain**
   backup directory; a backed-up junction alone is not a package backup.
   Preserve the linked checkout's local changes as well as its commit.
2. Profile `package.json`, `cordis.patch.yml`, `pnpm-workspace.yaml`,
   `pnpm-lock.yaml` and applicable profile configuration/exemption files.
   Record which files were absent. Also preserve any home patch or extra
   overlay used by this deployment.
3. An explicit copy of `<DSH_HOME>/bot/state.json`, plus the complete Bot data
   and relevant DSH Session/storage data. A stopped, protected snapshot of the
   whole `DSH_HOME` is preferable for disaster recovery. A lone state file
   cannot restore its referenced Sessions, attachments, memory and inboxes.
4. A tested reinstallable archive of the known-good package. For a plain
   package snapshot, `npm pack <package-snapshot> --ignore-scripts
   --pack-destination <backup>` creates a local tgz. Check its contents,
   hash and loaded behavior in isolation before treating it as a rollback
   artifact. Retain the original package snapshot too.

Verify source/destination real paths before copying and ensure destinations
are outside the source tree. Verify backup hashes/readability. Do not modify
the user's npm configuration.

## Switch the stopped profile

Before any package operation, inspect `node_modules/ds-bot`. If it is a
symlink/junction, **park that directory entry itself** outside `node_modules`
before asking the package manager to remove/reinstall it. Do not recursively
delete through it. Use PowerShell 7. Run the preparation below and the
release commands in **one script**, with the same variables. Any error must
terminate that script; do not catch an error and continue with package
operations.

Choose a fresh parking path directly inside the profile, on the same volume,
outside `node_modules`. Do not move the junction to a backup on another
volume. The plain package backup remains separate. For a linked package,
set the approved current target and its `index.js` SHA-256 recorded during
preflight, independently of the new release checkout:

```powershell
$ExpectedTarget = '<approved current linked ds-bot directory>'
$ExpectedMarkerHash = '<preflight SHA-256 of that directory/index.js>'
$ParkedLink = Join-Path $ProfileDir 'ds-bot-link-<unique-id>'
$PackageEntry = Get-Item -LiteralPath $PackageDir -Force -ErrorAction Stop
$HadLink = $PackageEntry.LinkType -in @('Junction', 'SymbolicLink')

function Assert-PackageOperationReady {
    $Entries = @(Get-ChildItem -LiteralPath (Split-Path $PackageDir -Parent) `
        -Force -ErrorAction Stop |
        Where-Object { $_.Name -eq (Split-Path $PackageDir -Leaf) })
    if ($HadLink) {
        # Enumeration also catches a dangling junction at the original path.
        if ($Entries.Count -ne 0) { throw 'Original package entry still exists.' }
        $Parked = Get-Item -LiteralPath $ParkedLink -Force -ErrorAction Stop
        if ($Parked.LinkType -notin @('Junction', 'SymbolicLink')) {
            throw 'Parked entry is not a link.'
        }
        $Target = $Parked.ResolveLinkTarget($true)
        if ($null -eq $Target -or $Target.FullName -ne $ExpectedTarget) {
            throw 'Parked link does not resolve to the approved checkout.'
        }
        $Hash = (Get-FileHash -LiteralPath (Join-Path $Target.FullName 'index.js') `
            -Algorithm SHA256 -ErrorAction Stop).Hash
        if ($Hash -ne $ExpectedMarkerHash) { throw 'Checkout marker changed.' }
    } elseif ($Entries | Where-Object {
        $_.Attributes -band [IO.FileAttributes]::ReparsePoint
    }) {
        throw 'Unexpected package link; repeat preparation.'
    }
}

if ($HadLink) {
    $Target = $PackageEntry.ResolveLinkTarget($true)
    if ($null -eq $Target -or $Target.FullName -ne $ExpectedTarget) {
        throw 'Current link target is not approved.'
    }
    $Hash = (Get-FileHash -LiteralPath (Join-Path $Target.FullName 'index.js') `
        -Algorithm SHA256 -ErrorAction Stop).Hash
    if ($Hash -ne $ExpectedMarkerHash) { throw 'Preflight marker mismatch.' }
    if (Get-ChildItem -LiteralPath $ProfileDir -Force -ErrorAction Stop |
        Where-Object { $_.Name -eq (Split-Path $ParkedLink -Leaf) }) {
        throw 'Parking destination already exists; choose a fresh name.'
    }
    Move-Item -LiteralPath $PackageDir -Destination $ParkedLink -ErrorAction Stop
}
Assert-PackageOperationReady
```

The rename is skipped for a normal copied package. A failed move, missing
entry, wrong target or changed marker stops the script before any package
operation. The readiness check runs again before **each** remove/add, so
neither a stale approval nor a native command's exit code substitutes for
checking the filesystem. Keep the parked link and plain package backup until
acceptance. Do not run a recursive cleanup against the parked link.

Then use the installation's package manager through DSH:

```powershell
Assert-PackageOperationReady
& $Dsh plugin --profile desktop remove ds-bot
if ($LASTEXITCODE -ne 0) { throw 'Remove failed; leave Desktop stopped.' }
Assert-PackageOperationReady
& $Dsh plugin --profile desktop add "link:$Checkout/ds-bot"
if ($LASTEXITCODE -ne 0) { throw 'Install failed; leave Desktop stopped.' }
```

This runs DSH's required pnpm installation/linking step; editing
`dependencies.ds-bot` alone does not create the link. Keep Desktop stopped
until **all** CLI commands finish.

Verify, before reopening:

- `dependencies["ds-bot"]` is `link:<checkout>/ds-bot`, the actual filesystem
  entry resolves to the approved checkout, and its files/hash/version match
  the built candidate. Inspect the lockfile's resolved target too.
- `dsh.profile.bundles` contains `ds-bot` exactly once, in its intended
  position; other bundle selections and profile settings match the backup.
  Restore the approved selection if remove/add changed its order.
- The bot patch preserves the approved work-branch/capability configuration
  and other options. Leave new rollout gates off until separately accepted.
- Bot state and the candidate checkout still match the recorded pre-switch
  data/source, except for explicitly approved configuration changes.

Do not accept an install exit code or a manifest string as proof. The
rehearsal found that an in-place change from `link:` to `file:` could return
zero while retaining the old link in both disk resolution and the lockfile.
Even `install --force` did not fix it.

## Reopen and verify

Reopen the same Desktop normally **once**. This startup supplies the new
composition; do not also poke patches or toggle the bundle to request HMR.
Measure downtime from full quit to successful health verification. The
seconds measured for Web HMR below are not a Desktop restart SLA.

Require all of:

1. DS Bot's diagnostics reports the expected **loaded** `botVersion` and DSH
   version, with no new activation, storage, delivery or migration errors.
   Pair this with the recorded source commit/hash when versions are equal.
2. The original roster, Bot/Session identities, groups, chat history, memory,
   preferences and delivery/task state remain intact. No bootstrap replacement
   team or read-only/competing-host warning appears.
3. Reload the page once using Desktop's page-reload action. Confirm candidate
   client behavior/assets and inspect a Bot/chat. A healthy server alone does
   not prove that the browser has refreshed.
4. Run one approved harmless test exchange and wait for it to finish. Recheck
   idle state, `works = 0` and pending deliveries before resuming producers.

Resume normal work only after the operator accepts these checks. Keep the
backup and the compatibility record.

## Roll back from outside the plugin

If loading or health verification fails, keep producers paused. Fully quit
Desktop again. Check the **current** data compatibility before choosing a
rollback target; new v2 data can invalidate a previously acceptable target.

In the rollback script, rerun the **entire preparation block** above with
the currently linked target, its preflight marker hash and a fresh same-volume
parking name. Do not reuse the release's `$HadLink` or prior verification.
A parking/verification failure terminates rollback before any package
operation. In that same script, continue with:

```powershell
Assert-PackageOperationReady
& $Dsh plugin --profile desktop remove ds-bot
if ($LASTEXITCODE -ne 0) { throw 'Remove failed; keep Desktop stopped.' }
Assert-PackageOperationReady
& $Dsh plugin --profile desktop add '<backup>/ds-bot-<known-good-version>.tgz'
if ($LASTEXITCODE -ne 0) { throw 'Rollback install failed; keep Desktop stopped.' }
```

Restore the approved bundle ordering and patch/config values from the backup.
Verify the actual package target, installed bytes and lockfile resolution
before reopening once and repeating the health checks. Preserve the
previous dependency specification and manifest for audit; a rollback installed
from the local tgz will correctly have a local archive spec rather than the original
registry spec. Do not overwrite the regenerated manifest/lockfile with an
inconsistent old pair. Exact full-profile snapshot restoration is an
alternative only when its package links/targets are complete and verified.

For a compatible code rollback, **retain current Bot/Session data**. Do not
automatically restore `state.json`. If a destructive migration or corruption
requires data recovery, preserve the failed current data first, keep the
profile stopped, obtain a recovery decision, then restore a consistent full
snapshot with explicit acceptance of lost post-snapshot work. Restoring just
the old state file can lose work and orphan newer Sessions.

## Isolated rehearsal evidence (2026-10-30)

No live Desktop profile or process was changed. No user npm configuration was
changed. All fixtures, package caches, logs, temporary browser profiles
and backups stayed in the isolated rehearsal worktree. Raw Host/authentication
logs and DSH data are private and are not committed.

Runtime: installed Desktop **DSH 0.2.1-rc.3**, launched with its documented
bundled `dsh.cmd`; the rc.2 source-launch fallback was not used. The ordinary
`s3-release` profile was initialized from `web`, because `desktop` is reserved
and cannot be booted by the CLI. It reproduced the relevant Desktop shape:

- `dependencies: { "ds-bot": "0.2.3" }`, initially a plain copied directory
  from `origin/main` commit `3afe21f532aa034258a95f2001f6e8bc775698d3`;
- the base/Web bundles followed by `ds-bot`, and a bot patch with
  `workBranches: [[Rehearsal, SampleProject]]`;
- HMR enabled with `root: []`, an isolated `DSH_HOME`, Web port **6196** and
  mock port **12196**.

A separate disposable Git checkout at the same commit carried a synthetic
`0.2.3-s3-linked` version, an apply/dispose trace and a browser marker added
to `src/client/index.js` and rebuilt normally. No marker, throwing code,
runtime patch or generated client change is part of this PR.

The fixture had three idle Bots. Expected Bot ids, Session ids, Main Bot ids
and preferences were captured before switching. There were no works, open
branches or tasks. Browser checks used authenticated Chromium page loads
and an actual page reload; they checked execution of the marker and changed
served `/plugins/` bytes, not merely a file timestamp.

Final measured cycle (times are **UTC+08:00**, 2026-10-30):

| Step | Command/action in the isolated profile | Measured result |
|---|---|---|
| Link installation, 07:53:38.083 | Park an existing link if present; `dsh plugin --profile s3-release remove ds-bot`, then `add link:<candidate>/ds-bot` | 1.161 s; no plugin replacement before the explicit patch |
| Switch trigger, 07:53:42.336 | One profile patch write, changing a harmless `bot.config.mainRole` rehearsal label while retaining the full bot/HMR config | 2.584 s to observed replacement; one installed dispose, one linked apply |
| Failure trigger, 07:53:57.310 | Add `throw new Error('S3 intentional load failure')` to the disposable linked entry; one new patch label | 2.123 s to API 404; one linked dispose, no replacement apply |
| Failed-state probe, 07:54:02.517 | Authenticated `POST /api/bot` and Web homepage request | Bot API 404; Web HTTP 200; old plugin did not remain available |
| Rollback installation, 07:54:02.547 | Rename junction entry to private backup; remove package; add known-good local tgz | 1.122 s; ordinary package restored; candidate files preserved; no activation before explicit patch |
| Recovery trigger, 07:54:06.736 | One new profile patch label | 2.146 s to installed apply; no live old instance remained to dispose |
| Recovery/browser probe, 07:54:21.165 | Diagnostics, state comparison and browser page reload | Version 0.2.3; linked browser marker absent; state preserved |

Host PID **48024** stayed unchanged from initial startup through both
successful and failed replacements. The successful linked page executed
`__S3_RELEASE_CLIENT__ = "linked"`; the recovered page did not. The recovered
state was byte-identical to the pre-switch copy (revision 6), without
restoring it. The mock and Host processes started for this rehearsal were
stopped after verification.

Earlier attempts are relevant to the procedure:

- The first switch also passed: link install 0.944 s, replacement 2.689 s.
- A failure waiter timed out because it expected a loader error on stdout.
  Independent authenticated probes confirmed Bot API 404 and Web HTTP 200;
  the final cycle measures the API result directly.
- In-place `add file:<snapshot-directory>`, `install --force`, and then
  `add file:<archive>` all returned zero while retaining the broken junction.
  The subsequent removal/reinstallation sequence also left the disposable
  linked package directory empty. Do not infer which operation is safe from
  its exit code. The final cycle parked the junction **before** package
  operations and verified that its target survived.

Repository checks passed: `npm ci`, `npm run harness`, `npm run build`,
`npm test`, generated-client `--check`, and lint. System npm 12.0.2 initially
failed `harness` with `EALLOWSCRIPTS`; rerunning that command under a temporary
npm 11.6.2, with a private empty userconfig and isolated cache, passed without
changing the user's npmrc. Tests exited naturally in 6.35 s: 1303 total,
1302 passed, one platform skip, zero failures. Lint passed with existing
warnings; no production source was changed.

Limits: this tested an idle Web composition under the production rc.3
runtime, not the Electron shell's restart lifecycle, live model calls,
in-flight work replacement, or v2 task migrations. The starting commit
predates v2 implementation; the v2 rollback restriction is the release
operator's required gate, not a claim that v2 compatibility was exercised.
No release-check helper was added: existing diagnostics plus the stopped-state
inventory cover this procedure without adding another release control path.

## Review correction: failed junction moves (2026-10-30)

The first public snippet used a native `node` command without checking its
exit status. PowerShell could continue to package removal after a failed
rename. The revised preparation uses native PowerShell
`Move-Item -LiteralPath ... -ErrorAction Stop` and rechecks both paths and
the approved checkout marker before each package operation. Both release
and rollback run that preparation in the same script as their package
commands; rollback repeats it with fresh current-target inputs.

The corrected PowerShell blocks were extracted from this document and
executed against the stopped, isolated profile with the installed rc.3
bundled CLI. Only placeholder values and `desktop` -> `s3-release` were
substituted. Results recorded at **08:25 UTC+08:00**:

| Scenario | Result | Package commands reached | Elapsed |
|---|---|---:|---:|
| Release from copied package to linked checkout | Passed; expected link/version installed | 2 | 1.175 s |
| Release with an injected junction move failure | Terminated at `Move-Item`; original link/target intact | 0 | 0.077 s |
| Release from an already-linked checkout | Passed; original junction parked, target preserved | 2 | 1.114 s |
| Rollback with an injected junction move failure | Terminated at `Move-Item`; original link/target intact | 0 | 0.067 s |
| Rollback from link to known-good archive | Passed; ordinary 0.2.3 package restored | 2 | 1.142 s |

Failure injection selected a nonexistent parking parent, producing a real
`MoveDirectoryItemIOError` under the default `Continue` error preference.
The explicit `-ErrorAction Stop` terminated the script before its remove/add
commands. A controlled CLI launcher counted invocations and refused to
execute package commands in failure cases. All candidate tracked-file hashes
and the Bot state hash stayed unchanged after every scenario. The profile
ended with the known-good ordinary package. These are stopped-profile
package/control-flow tests, not a repeat of the earlier HMR timing tests.
No live Desktop/profile or user npm configuration was touched.

[desktop-cli]: https://github.com/deepseek-ai/deepseek-harness/blob/main/apps/desktop/README.md#bundled-command-runtime
[hmr]: https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/boot/hmr/README.md
