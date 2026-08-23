# Sync backend

Both apps on the site — the weekly planner and Pocket Ledger — keep their data
in Google Drive instead of relying on `localStorage`, which was being cleared by
browsers and silently failing when it hit its quota.

`localStorage` is still used, but only as an offline cache. The Drive files are
the source of truth, and Drive keeps revision history, so a bad write is
recoverable.

## Multiple users, one deployment, one password

Everyone shares a single password. The **name** decides whose space you land in,
so each person gets a private planner and ledger:

| Who | Planner file | Ledger file |
| --- | --- | --- |
| linda | `neo-planner-data.json` * | `neo-ledger-data.json` * |
| anna | `neo-anna-planner.json` | `neo-anna-ledger.json` |
| elsa | `neo-elsa-planner.json` | `neo-elsa-ledger.json` |

\* Linda predates per-user filenames, so she stays on the originals and her
already-synced data is not stranded.

**Adding someone needs no configuration.** They type a new name at the login
screen and their space is created on first save.

### How the login works

The browser computes `sha256("<name>:<password>")` and sends that as the key.
The password itself never leaves the page and is never stored. The backend
recomputes the same digest from the name it was given and the stored `SECRET`,
so a key only works for the name it was made for.

Names are forced to lowercase and must match `^[a-z0-9]{1,20}$` — checked
*before* the name goes anywhere near a filename.

Being straight about what this does and does not protect: anyone who knows the
password can sign in as any name and read that person's data. It separates
Linda, Anna and Elsa from each other in normal use; it is not a defence between
people who all know the password.

## One-time setup

**1. Create the script**

<https://script.google.com> → **New project** → replace `Code.gs` with this
repo's `server/Code.gs`, then **Ctrl+S**.

**2. Set the password**

**Project Settings** → **Script properties**:

| Property | Value |
| --- | --- |
| `SECRET` | the shared password |

Not in this repo, ever — the repo is public.

**3. Deploy**

**Deploy** → **New deployment** → gear → **Web app**:

| Setting | Value |
| --- | --- |
| Execute as | **Me** |
| Who has access | **Anyone** |

Not *"Anyone with a Google account"* — that forces a Google login screen.

Google warns about an unverified app because it is yours and unpublished;
**Advanced** → **Go to (project name)** proceeds.

> **Every code change needs a fresh deployment.** "Manage deployments → New
> version" repeatedly served stale code during setup. Use **New deployment**,
> which always serves current code, and paste the new `/exec` URL into
> `index.html`. A response tells you which build is live via its `build` field —
> if that is missing or stale, nothing else you are seeing is meaningful.

**4. Wire it into the site**

`index.html` has **three** places holding the `/exec` URL — the login screen,
the planner block, and the ledger block. All three must match.

**5. Sign in**

Open <https://theneosystem.com>, enter a name and the password. The login is
remembered per browser, so it is asked once per device.

The **switch** button in the top bar signs out and offers the login again.

## How syncing behaves

Each save bumps a version number. A write is only accepted if its version beats
what is stored, so a stale tab left open on one device cannot overwrite newer
edits made on another — the stale tab pulls the newer data instead, and its own
copy is stashed under `weeklyPlanner_v2_presync` / `pocket_ledger_presync`
rather than discarded.

If the network is down, edits are saved locally and pushed on the next visit.

The planner footer shows `Saved 14:32, syncing...` → `Synced 14:32`; the ledger
shows the same in a small pill at the bottom right.

### First run for a given person

That person's space starts empty, so the first device they sign in on pushes
its copy up and becomes version 1. A second device that also has real data is
then behind — its push is refused and it adopts what the server holds. Nothing
is destroyed (the displaced copy is kept under the `*_presync` keys), but it is
less confusing to sign in first on the device holding the data worth keeping.

### Sharing a browser

Signing in as someone else swaps the whole local cache: the outgoing person's
data is parked under `neo_stash_<name>_*` and the incoming person's is restored.
Nobody sees anyone else's data, and switching back brings yours home.

### How the ledger differs

The ledger is a minified React bundle, so rather than editing its internals its
sync module snapshots the five `pocket_ledger_*` keys it owns and intercepts
`localStorage.setItem` to notice changes. `pocket_ledger_seq` is included, so id
counters stay consistent and two devices cannot mint the same transaction id.

A failed write still throws, because the app's own code depends on that — the
interception only adds the warning on top.

## Security model

The script runs as the account that deployed it, so it is written to be
incapable of touching anything else: filenames are built only from a name that
passed both the pattern check and the key check, plus a whitelisted document
kind. No request parameter names a file. If you want a smaller blast radius,
deploy from a throwaway Google account whose Drive holds nothing else.

Writes are rejected unless the body parses as a JSON object, so a broken client
cannot replace good data with garbage.

## Limits

Drive's revision history on a plain JSON file is a recovery window, not an
archive — roughly 30 days or 100 revisions unless revisions are pinned. The
planner's Export/Backup buttons remain the way to take a durable snapshot.
