# Vercel Deploy

Share HTML files and folders from Obsidian on Vercel. Every share lives in one Vercel project, one deployment and one subdomain each, so your Vercel account doesn't fill up with a project per page.

## Usage

Open what you want to share, then run **Share on Vercel**. The URL is copied to your clipboard when it's live.

- **An HTML file** (any name, not just `index.html`) is shared on its own, served at the root of its URL, with the local files it links to (images, CSS, scripts, other pages). The rest of its folder stays private.
- **A note inside a folder with an `index.html`** shares the whole folder as a static site.
- **A note inside a folder with a single HTML file** shares that file.

### URLs

Each share gets `<prefix><vault path>.vercel.app`, for example `🤖 Averos/Clients/KOM/Audit` → `sb-averos-clients-kom-audit.vercel.app`. Emojis, accents and special characters are stripped. Sharing the same file or folder again updates it in place and keeps its URL. If a subdomain is already taken on Vercel, a short hash is appended.

### Retention

Shares are preview deployments with a custom alias, which Vercel's retention policy never deletes. Superseded versions of a share lose their alias and expire on their own.

### Indexing

All deployments include a `X-Robots-Tag: noindex, nofollow` header to prevent search engine indexing.

## Settings

| Setting | Description |
|---|---|
| **Vercel token** | API token from [vercel.com/account/tokens](https://vercel.com/account/tokens). |
| **Team ID** | Optional. Only needed for Vercel Team deployments. |
| **Project** | Vercel project hosting every share. Defaults to `second-brain`. |
| **Subdomain prefix** | Prepended to each share's subdomain. Defaults to `sb-`. |

## Ignored files

The plugin skips hidden files, `.obsidian`, `.git`, `node_modules`, and all `.md`, `.canvas`, `.base` files.
