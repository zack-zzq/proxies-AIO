import proxyConfig from "../proxies.config.json" with { type: "json" };

const RESERVED_PREFIXES = new Set(["api", "_health"]);
const PROXY_TYPES = new Set(["default", "pixiv", "github", "docker"]);
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length"
];
const GITHUB_ALLOWED_HOSTS = new Set([
  "api.github.com",
  "codeload.github.com",
  "gist.github.com",
  "gist.githubusercontent.com",
  "github.com",
  "github-releases.githubusercontent.com",
  "objects.githubusercontent.com",
  "raw.github.com",
  "raw.githubusercontent.com",
  "www.github.com"
]);
const DOCKER_AUTH_ORIGIN = "https://auth.docker.io";

const CONFIG = normalizeProxyConfig(proxyConfig);

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return handleOptions(request);
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return renderHome(url, CONFIG, request);
    }

    if (url.pathname === "/api/proxies") {
      return jsonResponse(
        {
          proxies: publicProxyList(url.origin, CONFIG.proxies),
          errors: CONFIG.errors
        },
        request
      );
    }

    if (url.pathname === "/_health") {
      return jsonResponse({ ok: CONFIG.errors.length === 0 }, request);
    }

    if (CONFIG.errors.length > 0) {
      return htmlResponse(renderErrorPage("Configuration error", CONFIG.errors), {
        status: 500,
        request
      });
    }

    const proxy = findProxyForPath(url.pathname, CONFIG.proxies);
    if (!proxy) {
      return htmlResponse(renderNotFound(url, CONFIG.proxies), {
        status: 404,
        request
      });
    }

    return proxyRequest(request, url, proxy);
  }
};

export function normalizeProxyConfig(config) {
  const entries = Array.isArray(config) ? config : [config];
  const errors = [];
  const seen = new Set();
  const proxies = [];

  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") {
      errors.push(`Entry ${index + 1} must be an object.`);
      return;
    }

    const prefix = String(entry.prefix ?? "").trim().replace(/^\/+|\/+$/g, "");
    if (!/^[A-Za-z0-9_-]+$/.test(prefix)) {
      errors.push(`Entry ${index + 1} has an invalid prefix.`);
      return;
    }

    const prefixKey = prefix.toLowerCase();
    if (RESERVED_PREFIXES.has(prefixKey)) {
      errors.push(`Prefix "${prefix}" is reserved.`);
      return;
    }

    if (seen.has(prefixKey)) {
      errors.push(`Prefix "${prefix}" is duplicated.`);
      return;
    }

    const type = String(entry.type ?? "default").trim().toLowerCase();
    if (!PROXY_TYPES.has(type)) {
      errors.push(`Entry "${prefix}" has an invalid proxy type.`);
      return;
    }

    let siteUrl;
    try {
      siteUrl = new URL(String(entry.site ?? defaultSiteForType(type)));
    } catch {
      errors.push(`Entry "${prefix}" has an invalid site URL.`);
      return;
    }

    if (!["http:", "https:"].includes(siteUrl.protocol)) {
      errors.push(`Entry "${prefix}" must use http or https.`);
      return;
    }

    seen.add(prefixKey);
    proxies.push({
      prefix,
      site: trimTrailingSlash(siteUrl.href),
      type
    });
  });

  proxies.sort((a, b) => b.prefix.length - a.prefix.length);

  return { proxies, errors };
}

export function findProxyForPath(pathname, proxies = CONFIG.proxies) {
  return proxies.find((proxy) => {
    const routePrefix = `/${proxy.prefix}`;
    return pathname === routePrefix || pathname.startsWith(`${routePrefix}/`);
  }) ?? null;
}

export function buildTargetUrl(incomingUrl, proxy) {
  const targetUrl = new URL(proxy.site);
  const routePrefix = `/${proxy.prefix}`;
  const suffix = incomingUrl.pathname.slice(routePrefix.length) || "/";
  const basePath = targetUrl.pathname === "/" ? "" : targetUrl.pathname.replace(/\/+$/, "");

  targetUrl.pathname = `${basePath}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
  targetUrl.search = incomingUrl.search;
  targetUrl.hash = "";

  return targetUrl;
}

export function buildUrlPrefixedTargetUrl(incomingUrl, proxy) {
  const routePrefix = `/${proxy.prefix}`;
  const rawSuffix = incomingUrl.pathname.slice(routePrefix.length).replace(/^\/+/, "");
  const target = normalizeExternalTargetString(`${rawSuffix}${incomingUrl.search}`);
  return target ? new URL(target) : null;
}

export function buildDockerTargetUrl(incomingUrl, proxy) {
  const routePrefix = `/${proxy.prefix}`;
  const suffix = incomingUrl.pathname.slice(routePrefix.length) || "/";
  const targetPath = suffix.startsWith("/") ? suffix : `/${suffix}`;
  const base = targetPath.startsWith("/token") ? DOCKER_AUTH_ORIGIN : proxy.site;
  const targetUrl = new URL(base);

  targetUrl.pathname = normalizeDockerPath(targetPath, targetUrl);
  targetUrl.search = incomingUrl.search;
  targetUrl.hash = "";

  return targetUrl;
}

async function proxyRequest(request, incomingUrl, proxy) {
  if (proxy.type === "github") {
    return proxyUrlPrefixedRequest(request, incomingUrl, proxy);
  }

  if (proxy.type === "docker") {
    return proxyDockerRequest(request, incomingUrl, proxy);
  }

  return proxySiteRequest(request, incomingUrl, proxy);
}

async function proxySiteRequest(request, incomingUrl, proxy) {
  const targetUrl = buildTargetUrl(incomingUrl, proxy);
  const headers = new Headers(request.headers);
  removeHopByHopHeaders(headers);
  rewriteRequestNavigationHeaders(headers, incomingUrl, targetUrl, proxy);

  if (proxy.type === "pixiv") {
    headers.set("referer", "https://www.pixiv.net/");
    headers.set("user-agent", "Cloudflare Workers");
  }

  const upstreamResponse = await fetch(new Request(targetUrl, requestInitFrom(request, headers)));
  return proxyResponse(upstreamResponse, request, proxy, targetUrl);
}

async function proxyUrlPrefixedRequest(request, incomingUrl, proxy) {
  const redirect = redirectUrlPrefixedQuery(incomingUrl, proxy);
  if (redirect) {
    return redirect;
  }

  let targetUrl;
  try {
    targetUrl = buildUrlPrefixedTargetUrl(incomingUrl, proxy);
  } catch {
    targetUrl = null;
  }

  if (!targetUrl || !isGithubProxyTarget(targetUrl)) {
    return textResponse("Unsupported GitHub proxy target.", {
      status: 400,
      request
    });
  }

  if (targetUrl.hostname.toLowerCase() === "github.com") {
    targetUrl.pathname = targetUrl.pathname.replace("/blob/", "/raw/");
  }

  const headers = new Headers(request.headers);
  removeHopByHopHeaders(headers);
  rewriteExternalRequestNavigationHeaders(headers, incomingUrl, targetUrl, proxy);

  const upstreamResponse = await fetch(new Request(targetUrl, requestInitFrom(request, headers)));
  return proxyResponse(upstreamResponse, request, proxy, targetUrl, "url-prefix");
}

async function proxyDockerRequest(request, incomingUrl, proxy) {
  const targetUrl = buildDockerTargetUrl(incomingUrl, proxy);
  const headers = new Headers(request.headers);
  removeHopByHopHeaders(headers);

  const upstreamResponse = await fetch(new Request(targetUrl, requestInitFrom(request, headers)));
  return proxyDockerResponse(upstreamResponse, request, incomingUrl, proxy, targetUrl);
}

function requestInitFrom(request, headers) {
  const init = {
    method: request.method,
    headers,
    redirect: "manual"
  };

  if (!BODYLESS_METHODS.has(request.method)) {
    init.body = request.body;
  }

  return init;
}

function proxyResponse(upstreamResponse, request, proxy, targetUrl, mode = "site") {
  const headers = new Headers(upstreamResponse.headers);
  const contentType = headers.get("content-type") ?? "";

  removeHopByHopHeaders(headers);
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  headers.delete("x-frame-options");
  rewriteLocationHeader(headers, proxy, targetUrl, mode);
  applyCorsHeaders(headers, request);

  const response = new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers
  });

  if (contentType.toLowerCase().includes("text/html")) {
    return rewriteHtmlResponse(response, proxy, targetUrl, mode);
  }

  return response;
}

function proxyDockerResponse(upstreamResponse, request, incomingUrl, proxy, targetUrl) {
  const headers = new Headers(upstreamResponse.headers);

  removeHopByHopHeaders(headers);
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  headers.delete("x-frame-options");
  headers.delete("clear-site-data");
  headers.set("access-control-expose-headers", "*");
  rewriteDockerAuthenticateHeader(headers, incomingUrl, proxy);
  rewriteDockerLocationHeader(headers, incomingUrl, proxy, targetUrl);
  applyCorsHeaders(headers, request);

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers
  });
}

function rewriteRequestNavigationHeaders(headers, incomingUrl, targetUrl, proxy) {
  if (headers.get("origin") === incomingUrl.origin) {
    headers.set("origin", targetUrl.origin);
  }

  const referer = headers.get("referer");
  if (!referer) {
    return;
  }

  try {
    const refererUrl = new URL(referer);
    if (refererUrl.origin !== incomingUrl.origin) {
      return;
    }

    const refererProxy = findProxyForPath(refererUrl.pathname, [proxy]);
    if (!refererProxy) {
      return;
    }

    const upstreamReferer = buildTargetUrl(refererUrl, proxy);
    headers.set("referer", upstreamReferer.href);
  } catch {
    headers.delete("referer");
  }
}

function rewriteExternalRequestNavigationHeaders(headers, incomingUrl, targetUrl, proxy) {
  if (headers.get("origin") === incomingUrl.origin) {
    headers.set("origin", targetUrl.origin);
  }

  const referer = headers.get("referer");
  if (!referer) {
    return;
  }

  try {
    const refererUrl = new URL(referer);
    if (refererUrl.origin !== incomingUrl.origin) {
      return;
    }

    const refererTarget = buildUrlPrefixedTargetUrl(refererUrl, proxy);
    if (refererTarget && isGithubProxyTarget(refererTarget)) {
      headers.set("referer", refererTarget.href);
    }
  } catch {
    headers.delete("referer");
  }
}

function rewriteLocationHeader(headers, proxy, targetUrl, mode) {
  const location = headers.get("location");
  if (!location) {
    return;
  }

  headers.set("location", rewriteUrlForProxy(location, proxy, targetUrl, mode));
}

function rewriteDockerAuthenticateHeader(headers, incomingUrl, proxy) {
  const value = headers.get("www-authenticate");
  if (!value) {
    return;
  }

  const proxyBase = `${incomingUrl.origin}/${proxy.prefix}`;
  headers.set("www-authenticate", value.replaceAll(DOCKER_AUTH_ORIGIN, proxyBase));
}

function rewriteDockerLocationHeader(headers, incomingUrl, proxy, targetUrl) {
  const location = headers.get("location");
  if (!location) {
    return;
  }

  try {
    const absolute = new URL(location, targetUrl);
    const proxyBase = `${incomingUrl.origin}/${proxy.prefix}`;
    const dockerOrigin = new URL(proxy.site).origin;

    if (absolute.origin === dockerOrigin || absolute.origin === DOCKER_AUTH_ORIGIN) {
      headers.set("location", `${proxyBase}${absolute.pathname}${absolute.search}${absolute.hash}`);
    }
  } catch {
    headers.delete("location");
  }
}

function rewriteHtmlResponse(response, proxy, targetUrl, mode) {
  if (typeof HTMLRewriter === "undefined") {
    return response;
  }

  return new HTMLRewriter()
    .on("a[href]", new AttributeRewriter("href", proxy, targetUrl, mode))
    .on("area[href]", new AttributeRewriter("href", proxy, targetUrl, mode))
    .on("base[href]", new AttributeRewriter("href", proxy, targetUrl, mode))
    .on("link[href]", new AttributeRewriter("href", proxy, targetUrl, mode))
    .on("script[src]", new AttributeRewriter("src", proxy, targetUrl, mode))
    .on("img[src]", new AttributeRewriter("src", proxy, targetUrl, mode))
    .on("iframe[src]", new AttributeRewriter("src", proxy, targetUrl, mode))
    .on("source[src]", new AttributeRewriter("src", proxy, targetUrl, mode))
    .on("video[src]", new AttributeRewriter("src", proxy, targetUrl, mode))
    .on("audio[src]", new AttributeRewriter("src", proxy, targetUrl, mode))
    .on("form[action]", new AttributeRewriter("action", proxy, targetUrl, mode))
    .transform(response);
}

class AttributeRewriter {
  constructor(attributeName, proxy, targetUrl, mode) {
    this.attributeName = attributeName;
    this.proxy = proxy;
    this.targetUrl = targetUrl;
    this.mode = mode;
  }

  element(element) {
    const value = element.getAttribute(this.attributeName);
    if (!value) {
      return;
    }

    const rewritten = rewriteUrlForProxy(value, this.proxy, this.targetUrl, this.mode);
    if (rewritten !== value) {
      element.setAttribute(this.attributeName, rewritten);
    }
  }
}

function rewriteUrlForProxy(value, proxy, targetUrl, mode = "site") {
  const trimmed = value.trim();
  if (
    trimmed === "" ||
    trimmed.startsWith("#") ||
    /^(data|blob|mailto|tel|javascript):/i.test(trimmed)
  ) {
    return value;
  }

  if (mode === "url-prefix") {
    return rewriteUrlForUrlPrefixedProxy(value, proxy.prefix, targetUrl);
  }

  if (trimmed.startsWith("/")) {
    if (trimmed.startsWith("//")) {
      try {
        const absolute = new URL(`${targetUrl.protocol}${trimmed}`);
        return absolute.origin === targetUrl.origin
          ? toProxyPath(absolute, proxy.prefix)
          : value;
      } catch {
        return value;
      }
    }

    return `/${proxy.prefix}${trimmed}`;
  }

  try {
    const absolute = new URL(trimmed);
    return absolute.origin === targetUrl.origin ? toProxyPath(absolute, proxy.prefix) : value;
  } catch {
    return value;
  }
}

function rewriteUrlForUrlPrefixedProxy(value, prefix, targetUrl) {
  const trimmed = value.trim();

  if (
    trimmed.startsWith(`/${prefix}/http://`) ||
    trimmed.startsWith(`/${prefix}/https://`)
  ) {
    return value;
  }

  try {
    const absolute = trimmed.startsWith("//")
      ? new URL(`${targetUrl.protocol}${trimmed}`)
      : new URL(trimmed, targetUrl);

    return isGithubProxyTarget(absolute) ? toUrlPrefixedProxyPath(absolute, prefix) : value;
  } catch {
    return value;
  }
}

function toProxyPath(url, prefix) {
  return `/${prefix}${url.pathname}${url.search}${url.hash}`;
}

function toUrlPrefixedProxyPath(url, prefix) {
  return `/${prefix}/${url.href}`;
}

function redirectUrlPrefixedQuery(incomingUrl, proxy) {
  const routePrefix = `/${proxy.prefix}`;
  const normalizedPath = incomingUrl.pathname.replace(/\/+$/, "") || "/";
  const target = incomingUrl.searchParams.get("q");

  if (!target || normalizedPath !== routePrefix) {
    return null;
  }

  const normalizedTarget = normalizeExternalTargetString(target);
  if (!normalizedTarget) {
    return null;
  }

  return Response.redirect(`${incomingUrl.origin}/${proxy.prefix}/${normalizedTarget}`, 301);
}

function normalizeExternalTargetString(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return "";
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (/^https?:\/+/i.test(trimmed)) {
    return trimmed.replace(/^(https?:)\/+/i, "$1//");
  }

  if (/^(?:www\.)?(?:github\.com|raw\.githubusercontent\.com|raw\.github\.com|gist\.githubusercontent\.com|gist\.github\.com|api\.github\.com|codeload\.github\.com)\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }

  return "";
}

function isGithubProxyTarget(value) {
  const url = value instanceof URL ? value : new URL(normalizeExternalTargetString(value));
  const hostname = url.hostname.toLowerCase();
  return GITHUB_ALLOWED_HOSTS.has(hostname) || hostname.endsWith(".githubusercontent.com");
}

function normalizeDockerPath(pathname, targetUrl) {
  if (!pathname || pathname === "/") {
    return "/";
  }

  if (
    targetUrl.hostname === "registry-1.docker.io" &&
    /^\/v2\/[^/]+\/(?:manifests|blobs|tags)\//.test(pathname) &&
    !pathname.startsWith("/v2/library/")
  ) {
    return `/v2/library/${pathname.slice("/v2/".length)}`;
  }

  return pathname;
}

function handleOptions(request) {
  const headers = new Headers();
  applyCorsHeaders(headers, request);
  headers.set("access-control-max-age", "86400");

  return new Response(null, {
    status: 204,
    headers
  });
}

function jsonResponse(body, request, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  applyCorsHeaders(headers, request);

  return Response.json(body, {
    ...init,
    headers
  });
}

function textResponse(body, { status = 200, request } = {}) {
  const headers = new Headers({
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store"
  });

  if (request) {
    applyCorsHeaders(headers, request);
  }

  return new Response(body, {
    status,
    headers
  });
}

function htmlResponse(body, { status = 200, request } = {}) {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });

  if (request) {
    applyCorsHeaders(headers, request);
  }

  return new Response(body, {
    status,
    headers
  });
}

function renderHome(url, config, request) {
  const rows = publicProxyList(url.origin, config.proxies)
    .map((proxy) => renderProxyRow(proxy))
    .join("");

  const configErrors = config.errors.length > 0
    ? `<section class="notice"><strong>Configuration errors</strong><ul>${config.errors
        .map((error) => `<li>${escapeHtml(error)}</li>`)
        .join("")}</ul></section>`
    : "";

  return htmlResponse(
    `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Proxies AIO</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --line: #d9dee7;
      --text: #111827;
      --muted: #5f6b7a;
      --accent: #0f766e;
      --accent-soft: #d9f3ef;
      --danger: #b42318;
      --danger-soft: #fff1f0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
    }

    main {
      width: min(1080px, calc(100% - 32px));
      margin: 0 auto;
      padding: 40px 0 56px;
    }

    header {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 24px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--line);
    }

    h1 {
      margin: 0;
      font-size: clamp(30px, 6vw, 52px);
      line-height: 1;
      letter-spacing: 0;
    }

    .meta {
      margin-top: 10px;
      color: var(--muted);
      font-size: 15px;
    }

    .count {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      min-height: 36px;
      padding: 0 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      color: var(--muted);
      font-size: 14px;
      white-space: nowrap;
    }

    .notice {
      margin-top: 22px;
      padding: 14px 16px;
      border: 1px solid #f1b8b2;
      border-radius: 8px;
      background: var(--danger-soft);
      color: var(--danger);
    }

    .notice ul {
      margin: 8px 0 0;
      padding-left: 20px;
    }

    .proxy-list {
      margin-top: 24px;
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      background: var(--panel);
    }

    .proxy-row {
      display: grid;
      grid-template-columns: minmax(120px, 0.8fr) minmax(220px, 1.4fr) minmax(220px, 1.5fr);
      gap: 18px;
      align-items: center;
      padding: 18px;
      border-top: 1px solid var(--line);
    }

    .proxy-row:first-child {
      border-top: 0;
    }

    .proxy-title {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .badge {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 32px;
      height: 28px;
      padding: 0 9px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 13px;
      font-weight: 700;
    }

    .type {
      min-width: 0;
      color: var(--muted);
      font-size: 13px;
      overflow-wrap: anywhere;
    }

    .label {
      display: block;
      margin-bottom: 5px;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
    }

    a {
      color: var(--accent);
      text-decoration: none;
      overflow-wrap: anywhere;
    }

    a:hover {
      text-decoration: underline;
    }

    code {
      font: 13px ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      overflow-wrap: anywhere;
    }

    .empty {
      padding: 28px 18px;
      color: var(--muted);
    }

    @media (max-width: 760px) {
      main {
        width: min(100% - 24px, 1080px);
        padding-top: 28px;
      }

      header {
        display: block;
      }

      .count {
        margin-top: 16px;
      }

      .proxy-row {
        grid-template-columns: 1fr;
        gap: 12px;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Proxies AIO</h1>
        <div class="meta">${escapeHtml(url.host)}</div>
      </div>
      <div class="count">${config.proxies.length} proxies</div>
    </header>
    ${configErrors}
    <section class="proxy-list">
      ${rows || '<div class="empty">No proxies configured.</div>'}
    </section>
  </main>
</body>
</html>`,
    { request }
  );
}

function renderProxyRow(proxy) {
  return `<article class="proxy-row">
  <div>
    <span class="label">Prefix</span>
    <div class="proxy-title">
      <span class="badge">${escapeHtml(proxy.prefix)}</span>
      <span class="type">${escapeHtml(proxy.type)}</span>
    </div>
  </div>
  <div>
    <span class="label">Proxy URL</span>
    <a href="${escapeAttribute(proxy.proxyUrl)}"><code>${escapeHtml(proxy.proxyUrl)}</code></a>
  </div>
  <div>
    <span class="label">Source</span>
    <a href="${escapeAttribute(proxy.site)}" rel="noreferrer"><code>${escapeHtml(proxy.site)}</code></a>
  </div>
</article>`;
}

function renderNotFound(url, proxies) {
  const proxyNames = proxies.map((proxy) => `/${proxy.prefix}/`).join(", ");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Proxy not found</title>
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #f6f7f9; color: #111827; }
    main { width: min(720px, calc(100% - 32px)); margin: 12vh auto; }
    h1 { margin: 0 0 12px; font-size: 34px; letter-spacing: 0; }
    p { color: #5f6b7a; line-height: 1.6; }
    a { color: #0f766e; }
    code { overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <main>
    <h1>Proxy not found</h1>
    <p><code>${escapeHtml(url.pathname)}</code> does not match any configured prefix. Available prefixes: ${escapeHtml(proxyNames || "none")}</p>
    <p><a href="/">Back to home</a></p>
  </main>
</body>
</html>`;
}

function renderErrorPage(title, errors) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <ul>${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul>
</body>
</html>`;
}

function publicProxyList(origin, proxies) {
  return proxies.map((proxy) => ({
    prefix: proxy.prefix,
    site: proxy.site,
    type: proxy.type,
    proxyUrl: `${origin}/${proxy.prefix}/`
  }));
}

function removeHopByHopHeaders(headers) {
  for (const headerName of HOP_BY_HOP_HEADERS) {
    headers.delete(headerName);
  }
}

function applyCorsHeaders(headers, request) {
  const origin = request.headers.get("origin");
  headers.set("access-control-allow-origin", origin || "*");
  headers.set("access-control-allow-methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
  headers.set("access-control-allow-headers", request.headers.get("access-control-request-headers") || "*");
  headers.set("access-control-expose-headers", mergeHeaderValues(headers.get("access-control-expose-headers"), "location, content-type, content-length"));

  if (origin) {
    headers.set("access-control-allow-credentials", "true");
    appendVary(headers, "Origin");
  }
}

function appendVary(headers, value) {
  const vary = headers.get("vary");
  if (!vary) {
    headers.set("vary", value);
    return;
  }

  const values = vary.split(",").map((entry) => entry.trim().toLowerCase());
  if (!values.includes(value.toLowerCase())) {
    headers.set("vary", `${vary}, ${value}`);
  }
}

function mergeHeaderValues(current, next) {
  if (!current) {
    return next;
  }

  if (current === "*") {
    return current;
  }

  const values = new Set(current.split(",").map((value) => value.trim()).filter(Boolean));
  for (const value of next.split(",")) {
    values.add(value.trim());
  }

  return [...values].join(", ");
}

function defaultSiteForType(type) {
  if (type === "docker") {
    return "https://registry-1.docker.io";
  }

  if (type === "github") {
    return "https://github.com";
  }

  if (type === "pixiv") {
    return "https://i.pximg.net";
  }

  return "";
}

function trimTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
