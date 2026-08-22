# Sync backend

Both apps on the site — the weekly planner and Pocket Ledger — keep their data
in Google Drive instead of relying on `localStorage`, which was being cleared by
browsers and silently failing when it hit its quota.

`localStorage` is still used, but only as an offline cache. The Drive files are
the source of truth, and Drive keeps revision history, so a bad write is
recoverable.

One script serves both apps, writing two separate files:

| App | `doc` | Drive file |
| --- | --- | --- |
| Weekly planner | `planner` | `neo-planner-data.json` |
| Pocket Ledger | `ledger` | `neo-ledger-data.json` |

A request can only pick from that list. It can never name a file.

## One-time setup

**1. Create the script**

Go to <https://script.google.com> → **New project** → replace the contents of
`Code.gs` with this repo's `server/Code.gs`.

**2. Set the secret**

**Project Settings** → **Script properties** → **Add script property**:

| Property | Value |
| --- | --- |
| `SECRET` | your 32-character key |

The key is *not* in this repo, and must not be. This repo is public — anything
committed here is readable by anyone.

**3. Deploy**

**Deploy** → **New deployment** → gear icon → **Web app**:

| Setting | Value |
| --- | --- |
| Execute as | **Me** |
| Who has access | **Anyone** |

Not *"Anyone with a Google account"* — that one forces a login screen.

Google will ask you to authorise Drive access. It shows an "unverified app"
warning because the script is yours and unpublished; **Advanced** → **Go to
(project name)** gets past it.

Copy the resulting URL. It ends in `/exec`.

**4. Wire it into the site**

`index.html` has **two** places to paste the `/exec` URL — one per app:

```js
const SYNC_URL = '';   // planner block
var SYNC_URL = '';     // ledger block
```

Paste the same URL into both, then commit and push. Either can be left blank;
that app just stays local-only.

**5. First run: start from the device that has the good data**

The server starts empty. The first device to sync pushes its copy up and
becomes version 1. A second device that also has real data is then *behind* —
its push is refused and it adopts what the server holds instead. Nothing is
destroyed (the displaced copy is kept under `weeklyPlanner_v2_presync` /
`pocket_ledger_presync`), but it is much less confusing to open the laptop or
phone that has the data worth keeping **first**, let it sync, and only then open
the others.

This only matters once. After that, the version numbers keep everything in
order on their own.

**6. Bookmark the planner with the key**

```
https://theneosystem.com/#k=YOUR_32_CHAR_KEY
```

Open that once on each device. The key is saved locally from then on, so
normal visits to `theneosystem.com` keep working. To set up a phone, make a QR
code of that URL and scan it.

## Changing the script later

Editing the code does **not** update the live URL. Re-deploy:

**Manage deployments** → pencil icon → **Version: New version** → **Deploy**.

The `/exec` URL stays the same, so `index.html` needs no change.

## How syncing behaves

Each save bumps a version number. A write is only accepted if its version beats
what is stored, so a stale tab left open on one device cannot overwrite newer
edits made on another — the stale tab pulls the newer data instead, and its own
copy is stashed under `weeklyPlanner_v2_presync` rather than discarded.

If the network is down, edits are saved locally and pushed on the next visit.
If `SYNC_URL` is blank or no key is present, the planner behaves exactly as it
did before, using local storage alone.

The status line in the planner footer shows what is happening: `Saved 14:32,
syncing...` → `Synced 14:32`, or a warning if something failed. The ledger shows
the same thing in a small pill at the bottom right, which fades once it settles.

The two apps share one key, stored under `weeklyPlanner_syncKey`. Setting it up
once covers both.

### How the ledger differs

The ledger is a minified React bundle, so rather than editing its internals its
sync module snapshots the five `pocket_ledger_*` keys it owns and intercepts
`localStorage.setItem` to notice changes. `pocket_ledger_seq` is included in the
snapshot, so the id counters stay consistent and two devices cannot mint the
same transaction id.

A failed write still throws, because the app's own code depends on that — the
interception only adds the warning on top.

## Security model

There is no login. The key in the bookmark URL is what grants access — like a
Google Doc share link.

The script runs as the account that deployed it, so it is written to be
incapable of touching anything else: the Drive file ID is discovered by the
script and stored in script properties, and is **never** read from a request.
There is no parameter that names a file. If you want a smaller blast radius,
deploy it from a throwaway Google account whose Drive holds nothing else.

Writes are rejected unless the body parses as a JSON object, so a broken client
cannot replace good data with garbage.

## Limits

Drive's revision history on a plain JSON file is a recovery window, not an
archive — roughly 30 days or 100 revisions unless revisions are pinned. The
planner's existing Export/Backup buttons are still the way to take a durable
snapshot.
