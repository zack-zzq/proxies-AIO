# Proxies AIO

A Cloudflare Worker that exposes multiple reverse proxies behind one domain.

## Configure proxies

Edit `proxies.config.json`. A normal proxy only needs `prefix` and `site`:

```json
[
  {
    "prefix": "google",
    "site": "https://www.google.com"
  }
]
```

With the Worker bound to `proxy.ziqizhu.com`, the entry above will:

- Show on `https://proxy.ziqizhu.com/`
- Proxy `https://proxy.ziqizhu.com/google/*` to `https://www.google.com/*`
- Strip `/google` before forwarding upstream

## Add a proxy quickly

Use the npm helper and pass only the upstream URL:

```bash
npm run proxy:add -- https://www.google.com
npm run proxy:add -- https://icons.duckduckgo.com
```

The command infers the `prefix` from the URL and appends the new entry to
`proxies.config.json`. You can override the prefix when needed:

```bash
npm run proxy:add -- https://www.google.com prefix=google
```

## Special proxy types

Normal entries use `type: "default"` implicitly. Special proxies can add a
`type` field:

```json
[
  {
    "prefix": "pixiv",
    "site": "https://i.pximg.net",
    "type": "pixiv"
  },
  {
    "prefix": "github",
    "site": "https://github.com",
    "type": "github"
  },
  {
    "prefix": "docker",
    "site": "https://registry-1.docker.io",
    "type": "docker"
  }
]
```

- `pixiv` forwards to `i.pximg.net` and adds the required Pixiv referer.
- `github` keeps the original URL after the proxy prefix, for example:
  `https://proxy.ziqizhu.com/github/https://github.com/owner/repo/releases/download/v1/file.zip`.
- `docker` handles Docker Registry requests and rewrites Docker auth challenges
  back through the proxy prefix.

## Local commands

```bash
npm install
npm run dev
npm test
npm run check
```

## Credits

[hunshcn/gh-proxy](https://github.com/hunshcn/gh-proxy): for GitHub proxy. 

