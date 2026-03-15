# Vercel Deploy

Deploy the current folder as a static site to Vercel directly from Obsidian.

## Usage

1. Open any file inside the folder you want to deploy (must contain an `index.html`).
2. Click the rocket icon in the ribbon, or run the command **Deploy active folder to Vercel**.
3. The plugin uploads all web files and gives you a live URL when ready.

### Project naming

The Vercel project name is derived from the full vault path of the folder. For example, `Game/ads` becomes `game-ads`. Emojis and special characters are stripped automatically.

### Indexing

All deployments include a `X-Robots-Tag: noindex, nofollow` header to prevent search engine indexing.

## Settings

| Setting | Description |
|---|---|
| **Vercel token** | API token from [vercel.com/account/tokens](https://vercel.com/account/tokens). |
| **Team ID** | Optional. Only needed for Vercel Team deployments. |

## Ignored files

The plugin skips hidden files, `.obsidian`, `.git`, `node_modules`, and all `.md`, `.canvas`, `.base` files.
