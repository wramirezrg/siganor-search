# Publishing your own copy

No build step, no dependencies. This is just static files. Any static host works: GitHub Pages, Cloudflare Pages, Netlify, Vercel, or your own server. This guide covers GitHub Pages since it's built into a fork of this repo already.

## Files needed

`index.html`, `app.js`, `README.md`, `LICENSE`, `_headers` (optional, see below), plus the `img/` and `vendor/` folders with their contents.

## GitHub Pages (from your fork/copy of this repo)

1. Fork or download this repo into your own GitHub account.
2. In your copy: **Settings → Pages** → Source: **Deploy from a branch** → Branch `main`, folder **/ (root)** → **Save**.
3. After about a minute, your copy is live at `https://YOUR-USERNAME.github.io/YOUR-REPO/`.

## Security headers (optional, host-dependent)

The `_headers` file sets a strict Content Security Policy, HSTS, and a few other hardening headers. It only works on hosts that read that specific format, like Cloudflare Pages or Netlify. GitHub Pages ignores it, so a plain GitHub Pages deployment runs without those extra headers. If you want them, host on Cloudflare Pages or Netlify instead: drag-and-drop the same files through that host's dashboard ("Upload assets" or manual deploy), then confirm the headers are being sent with `curl -I` or your browser's dev tools.

## Updating it later

- **GitHub Pages**: edit a file directly on GitHub (pencil icon) for small changes, or use **Add file → Upload files** again to swap a whole file. It redeploys automatically within a minute or two.
- **Other static hosts**: re-upload the changed files through that host's dashboard.
