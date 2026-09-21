# GitHub workspaces

A GitHub workspace keeps your notes in a git repository and mirrors them into
the browser, so notes open instantly and edits survive a dead connection. The
repo is the source of truth; the browser holds a working copy.

## Setting one up

### 1. Create a repository for your notes

Any repository works. An empty one is fine — it just needs at least one commit
on the branch you point at, because a branch with no commits has nothing to
sync against. If you made it empty, add a README from the GitHub UI first.

### 2. Create a fine-grained access token

Go to **Settings → Developer settings → Personal access tokens → Fine-grained
tokens**, or [create one directly][token-link].

- **Repository access**: *Only select repositories* → pick your notes repo
- **Permissions**: *Repository permissions → Contents → Read and write*
- **Expiration**: your call; the app reports clearly when a token has expired

Contents is the only permission needed. Do not grant a classic token with full
`repo` scope — it would reach every repository you own, and this app only ever
touches the one you name.

### 3. Connect it

In the app: **Create Workspace → GitHub repository**, then fill in the repo
(`owner/name`, or paste the GitHub URL), the branch, and the token. The app
verifies the repo, the branch, and write access before creating anything, so a
typo or an under-scoped token fails immediately with a usable message.

## Where the token is stored

In this browser's IndexedDB, in the workspace's own metadata. It is never sent
anywhere except `api.github.com`, and deleting the workspace deletes it.

This is the trade-off of having no backend: anything with access to your
browser profile can read the token. Scope it to the single notes repo, give it
an expiry, and revoke it from GitHub if a device is lost.

## Syncing

Nothing syncs automatically. Use the **Sync** button in the sidebar, the
command palette (*Sync Workspace*), or <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+
<kbd>Y</kbd>.

A sync pulls remote changes, then pushes every local change as a **single
commit** — not one commit per save. This keeps history readable and keeps the
app well inside GitHub's hourly rate limit, which per-save commits would
exhaust in minutes.

### What syncs

Only what the app treats as workspace content. Dotted paths (`.github/`,
`.gitignore`) and build directories (`node_modules/`, `dist/`, `build/`) are
skipped entirely: never pulled into the browser, never pushed, never deleted.
Pointing a workspace at a repo that also holds code leaves that code alone.

### Conflicts

When a note changed on both sides since the last sync, nothing is thrown away:

- the **remote** version takes the original path, locally and remotely
- **your** version is saved beside it as `note.conflict-<timestamp>.md`, and
  that file is pushed too

So the divergence ends up visible in the repo as a normal note you can open,
compare, and merge in the editor. The same principle covers the asymmetric
cases: a note you edited that was deleted upstream is pushed back rather than
lost, and a note you deleted that was edited upstream is restored.

### Offline

Reads and writes only touch the local mirror, so the app works fully offline.
A sync attempted without a connection reports that it could not reach GitHub
and changes nothing; your edits stay queued as local changes until the next
successful sync.

## Limits

- Files over 20MB are rejected (GitHub's blob API caps at 100MB; base64 over a
  mobile connection makes the practical limit much lower).
- Repositories whose tree is too large to list in one request are rejected
  rather than partially synced.
- Sync is manual by design. There is no background sync and no push
  notification when the repo changes elsewhere.

[token-link]: https://github.com/settings/personal-access-tokens/new

## Deploying

The app keeps route data in the URL hash but still serves from the `/ws` path
(`basePath` in the router setup), so a reload requests `/ws` from the host.
Any static host must therefore fall back to `index.html` for unmatched paths
or that reload is a 404. Cloudflare Pages does this by default; Vercel needs
the rewrite in `vercel.json` at the repository root.
