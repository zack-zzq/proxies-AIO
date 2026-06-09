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
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#e3f3f0"/>
  <path d="M19 44V25a9 9 0 0 1 9-9h17" fill="none" stroke="#0f766e" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M21 48h16a9 9 0 0 0 9-9V20" fill="none" stroke="#0f766e" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="19" cy="48" r="5" fill="#0f766e"/>
  <circle cx="45" cy="16" r="5" fill="#0f766e"/>
</svg>`;

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

    if (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") {
      return faviconResponse();
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

function faviconResponse() {
  return new Response(FAVICON_SVG, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=604800"
    }
  });
}

function renderHome(url, config, request) {
  const proxies = publicProxyList(url.origin, config.proxies);
  const specialCount = proxies.filter((proxy) => proxy.type !== "default").length;
  const defaultCount = proxies.length - specialCount;
  const typeFilters = ["default", "pixiv", "github", "docker"]
    .map((type) => {
      const count = proxies.filter((proxy) => proxy.type === type).length;
      return count > 0
        ? `<button class="filter-button" type="button" data-filter="${escapeAttribute(type)}">${escapeHtml(type)} <span>${count}</span></button>`
        : "";
    })
    .join("");
  const rows = proxies
    .map((proxy) => renderProxyRow(proxy))
    .join("");

  const configErrors = config.errors.length > 0
    ? `<section class="notice" aria-live="polite">
        <div class="notice-icon" aria-hidden="true">${renderIcon("alert")}</div>
        <div>
          <strong>Configuration errors</strong>
          <ul>${config.errors
        .map((error) => `<li>${escapeHtml(error)}</li>`)
        .join("")}</ul>
        </div>
      </section>`
    : "";

  return htmlResponse(
    `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Proxies AIO</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f7f8;
      --bg-strong: #eaf0f2;
      --surface: #ffffff;
      --surface-soft: #f8fbfb;
      --line: #d9e2e5;
      --line-soft: #e8eef0;
      --text: #101828;
      --muted: #667085;
      --muted-strong: #475467;
      --accent: #0f766e;
      --accent-strong: #0b5f59;
      --accent-soft: #e3f3f0;
      --blue: #2563eb;
      --blue-soft: #e8f0ff;
      --amber: #b7791f;
      --amber-soft: #fff6df;
      --danger: #b42318;
      --danger-soft: #fff1f0;
      --shadow: 0 18px 48px rgba(16, 24, 40, 0.08);
      --radius: 8px;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(180deg, rgba(234, 240, 242, 0.88) 0%, rgba(244, 247, 248, 0.92) 260px, var(--bg) 100%);
      color: var(--text);
      text-rendering: optimizeLegibility;
    }

    main {
      width: min(1180px, calc(100% - 32px));
      margin: 0 auto;
      padding: 34px 0 56px;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      margin-bottom: 24px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
      min-width: 0;
    }

    .brand-mark {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 46px;
      height: 46px;
      border: 1px solid rgba(15, 118, 110, 0.18);
      border-radius: var(--radius);
      background: linear-gradient(180deg, #ffffff 0%, #eef9f6 100%);
      color: var(--accent);
      box-shadow: 0 10px 24px rgba(15, 118, 110, 0.12);
      flex: 0 0 auto;
    }

    .brand svg,
    .icon-button svg,
    .search-box svg,
    .notice-icon svg,
    .empty-icon svg,
    .back-link svg {
      width: 18px;
      height: 18px;
      stroke-width: 1.8;
    }

    h1,
    h2,
    p {
      margin: 0;
      letter-spacing: 0;
    }

    h1 {
      font-size: clamp(26px, 4vw, 38px);
      line-height: 1.05;
      font-weight: 760;
    }

    .meta {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 7px;
      color: var(--muted);
      font-size: 14px;
    }

    .meta-dot {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: #16a34a;
      box-shadow: 0 0 0 4px rgba(22, 163, 74, 0.12);
    }

    .summary {
      display: grid;
      grid-template-columns: repeat(3, minmax(92px, 1fr));
      gap: 10px;
      min-width: min(420px, 42vw);
    }

    .stat {
      min-height: 72px;
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: rgba(255, 255, 255, 0.82);
      box-shadow: 0 10px 26px rgba(16, 24, 40, 0.05);
    }

    .stat-label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
      text-transform: uppercase;
    }

    .stat-value {
      margin-top: 6px;
      color: var(--text);
      font-size: 24px;
      font-weight: 760;
      line-height: 1;
    }

    .notice {
      display: flex;
      gap: 12px;
      margin-bottom: 18px;
      padding: 14px 16px;
      border: 1px solid #f0bbb4;
      border-radius: var(--radius);
      background: var(--danger-soft);
      color: var(--danger);
      font-size: 14px;
    }

    .notice-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      border-radius: var(--radius);
      background: #ffffff;
      flex: 0 0 auto;
    }

    .notice ul {
      margin: 8px 0 0;
      padding-left: 20px;
    }

    .panel {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      overflow: hidden;
      background: var(--surface);
      box-shadow: var(--shadow);
    }

    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      padding: 18px 20px;
      border-bottom: 1px solid var(--line-soft);
      background: rgba(255, 255, 255, 0.92);
    }

    h2 {
      font-size: 18px;
      line-height: 1.2;
      font-weight: 720;
    }

    .panel-subtitle {
      margin-top: 5px;
      color: var(--muted);
      font-size: 13px;
    }

    .toolbar {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
      flex-wrap: wrap;
    }

    .search-box {
      position: relative;
      display: flex;
      align-items: center;
      min-width: min(300px, 100%);
      color: var(--muted);
    }

    .search-box svg {
      position: absolute;
      left: 12px;
      pointer-events: none;
    }

    .search-box input {
      width: 100%;
      height: 38px;
      padding: 0 13px 0 38px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface-soft);
      color: var(--text);
      font: 14px/1.2 inherit;
      outline: none;
      transition: border-color 160ms ease, box-shadow 160ms ease, background 160ms ease;
    }

    .search-box input:focus {
      border-color: rgba(15, 118, 110, 0.55);
      background: #ffffff;
      box-shadow: 0 0 0 4px rgba(15, 118, 110, 0.11);
    }

    .filters {
      display: flex;
      gap: 6px;
      padding: 0 20px 16px;
      border-bottom: 1px solid var(--line-soft);
      background: #ffffff;
      overflow-x: auto;
    }

    .filter-button {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      height: 32px;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
      color: var(--muted-strong);
      font: 13px/1 inherit;
      white-space: nowrap;
      cursor: pointer;
      transition: border-color 160ms ease, background 160ms ease, color 160ms ease;
    }

    .filter-button span {
      color: var(--muted);
      font-size: 12px;
    }

    .filter-button:hover,
    .filter-button[aria-pressed="true"] {
      border-color: rgba(15, 118, 110, 0.28);
      background: var(--accent-soft);
      color: var(--accent-strong);
    }

    .proxy-table {
      width: 100%;
    }

    .table-head,
    .proxy-row {
      display: grid;
      grid-template-columns: minmax(190px, 0.9fr) minmax(250px, 1.25fr) minmax(260px, 1.2fr) 96px;
      gap: 16px;
      align-items: center;
    }

    .table-head {
      padding: 11px 20px;
      border-bottom: 1px solid var(--line-soft);
      background: var(--surface-soft);
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
    }

    .proxy-row {
      min-height: 74px;
      padding: 16px 20px;
      border-bottom: 1px solid var(--line-soft);
      transition: background 150ms ease;
    }

    .proxy-row:last-child {
      border-bottom: 0;
    }

    .proxy-row:hover {
      background: #fbfdfd;
    }

    .proxy-title {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .prefix-mark {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 38px;
      height: 38px;
      border-radius: var(--radius);
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 15px;
      font-weight: 760;
      text-transform: uppercase;
    }

    .proxy-main {
      min-width: 0;
    }

    .prefix {
      color: var(--text);
      font-size: 15px;
      font-weight: 710;
      overflow-wrap: anywhere;
    }

    .type {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      margin-top: 6px;
      padding: 3px 8px;
      border: 1px solid transparent;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 650;
      line-height: 1.2;
    }

    .type-default {
      border-color: var(--line);
      background: #f7f9fa;
      color: var(--muted-strong);
    }

    .type-pixiv {
      border-color: #f4c6dd;
      background: #fff0f7;
      color: #a51d5d;
    }

    .type-github {
      border-color: #c8d7ff;
      background: var(--blue-soft);
      color: var(--blue);
    }

    .type-docker {
      border-color: #f2d49b;
      background: var(--amber-soft);
      color: var(--amber);
    }

    .label {
      display: none;
      margin-bottom: 6px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }

    .url-stack {
      min-width: 0;
    }

    .url-link {
      display: inline-flex;
      max-width: 100%;
      min-width: 0;
      align-items: center;
      gap: 8px;
    }

    .domain {
      margin-top: 5px;
      color: var(--muted);
      font-size: 12px;
      overflow-wrap: anywhere;
    }

    a {
      color: var(--accent-strong);
      text-decoration: none;
      overflow-wrap: anywhere;
    }

    a:hover {
      text-decoration: underline;
    }

    code {
      color: #1d2939;
      font: 12.5px/1.45 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      overflow-wrap: anywhere;
    }

    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    .icon-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: #ffffff;
      color: var(--muted-strong);
      cursor: pointer;
      transition: transform 140ms ease, border-color 140ms ease, color 140ms ease, background 140ms ease;
    }

    .icon-button:hover,
    .icon-button:focus-visible {
      border-color: rgba(15, 118, 110, 0.32);
      background: var(--accent-soft);
      color: var(--accent-strong);
      outline: none;
    }

    .icon-button:active {
      transform: translateY(1px);
    }

    .icon-button.copied {
      border-color: rgba(22, 163, 74, 0.28);
      background: #ecfdf3;
      color: #15803d;
    }

    .empty,
    .empty-state {
      padding: 30px 20px;
      color: var(--muted);
      text-align: center;
    }

    .empty-state[hidden],
    .proxy-row[hidden] {
      display: none;
    }

    .empty-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 38px;
      height: 38px;
      margin-bottom: 10px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface-soft);
      color: var(--muted);
    }

    .empty-title {
      color: var(--text);
      font-weight: 700;
      margin-bottom: 5px;
    }

    @media (max-width: 760px) {
      html,
      body {
        overflow-x: hidden;
      }

      main {
        width: auto;
        margin: 0 12px;
        padding-top: 22px;
      }

      header {
        display: block;
      }

      .summary {
        display: block;
        width: 100%;
        margin-top: 18px;
      }

      .stat + .stat {
        margin-top: 10px;
      }

      .stat {
        min-height: 64px;
        padding: 11px 10px;
      }

      .stat-value {
        font-size: 21px;
      }

      .panel-head {
        display: block;
        padding: 16px;
      }

      .toolbar {
        justify-content: stretch;
        margin-top: 14px;
      }

      .search-box {
        width: 100%;
        min-width: 0;
      }

      .filters {
        padding: 0 16px 14px;
      }

      .table-head {
        display: none;
      }

      .proxy-row {
        grid-template-columns: 1fr;
        gap: 14px;
        padding: 17px 16px;
      }

      .label {
        display: block;
      }

      .actions {
        justify-content: flex-start;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      *,
      *::before,
      *::after {
        scroll-behavior: auto !important;
        transition-duration: 0.01ms !important;
        animation-duration: 0.01ms !important;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">${renderIcon("route")}</div>
        <div>
          <h1>Proxies AIO</h1>
          <div class="meta"><span class="meta-dot" aria-hidden="true"></span>${escapeHtml(url.host)}</div>
        </div>
      </div>
      <div class="summary" aria-label="Proxy summary">
        <div class="stat">
          <div class="stat-label">Total</div>
          <div class="stat-value" data-visible-count>${proxies.length}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Default</div>
          <div class="stat-value">${defaultCount}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Special</div>
          <div class="stat-value">${specialCount}</div>
        </div>
      </div>
    </header>
    ${configErrors}
    <section class="panel" aria-labelledby="proxy-list-title">
      <div class="panel-head">
        <div>
          <h2 id="proxy-list-title">Proxy endpoints</h2>
          <p class="panel-subtitle">Browse configured prefixes and upstream targets.</p>
        </div>
        <div class="toolbar">
          <label class="search-box">
            ${renderIcon("search")}
            <input type="search" placeholder="Search prefix, type, or URL" autocomplete="off" data-search-input>
          </label>
        </div>
      </div>
      <div class="filters" aria-label="Proxy type filters">
        <button class="filter-button" type="button" data-filter="all" aria-pressed="true">All <span>${proxies.length}</span></button>
        ${typeFilters}
      </div>
      <div class="proxy-table">
        <div class="table-head" aria-hidden="true">
          <div>Prefix</div>
          <div>Proxy URL</div>
          <div>Source</div>
          <div>Actions</div>
        </div>
        ${rows || '<div class="empty">No proxies configured.</div>'}
        <div class="empty-state" data-empty-state hidden>
          <div class="empty-icon" aria-hidden="true">${renderIcon("search")}</div>
          <div class="empty-title">No matching proxies</div>
          <p>Try a different prefix, type, or domain.</p>
        </div>
      </div>
    </section>
  </main>
  <script>
    const rows = Array.from(document.querySelectorAll("[data-proxy-row]"));
    const searchInput = document.querySelector("[data-search-input]");
    const filterButtons = Array.from(document.querySelectorAll("[data-filter]"));
    const visibleCount = document.querySelector("[data-visible-count]");
    const emptyState = document.querySelector("[data-empty-state]");
    let activeFilter = "all";

    function applyFilters() {
      const query = (searchInput?.value || "").trim().toLowerCase();
      let visible = 0;

      for (const row of rows) {
        const matchesText = !query || row.dataset.search.includes(query);
        const matchesType = activeFilter === "all" || row.dataset.type === activeFilter;
        const shouldShow = matchesText && matchesType;
        row.hidden = !shouldShow;
        if (shouldShow) {
          visible += 1;
        }
      }

      if (visibleCount) {
        visibleCount.textContent = String(visible);
      }

      if (emptyState) {
        emptyState.hidden = visible !== 0 || rows.length === 0;
      }
    }

    searchInput?.addEventListener("input", applyFilters);

    for (const button of filterButtons) {
      button.addEventListener("click", () => {
        activeFilter = button.dataset.filter || "all";
        for (const option of filterButtons) {
          option.setAttribute("aria-pressed", String(option === button));
        }
        applyFilters();
      });
    }

    async function copyText(text, button) {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          fallbackCopy(text);
        }
        button.classList.add("copied");
        const label = button.getAttribute("aria-label") || "Copy";
        button.setAttribute("aria-label", "Copied");
        button.title = "Copied";
        window.setTimeout(() => {
          button.classList.remove("copied");
          button.setAttribute("aria-label", label);
          button.title = label;
        }, 1200);
      } catch {
        fallbackCopy(text);
      }
    }

    function fallbackCopy(text) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.append(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }

    document.addEventListener("click", (event) => {
      const button = event.target.closest("[data-copy]");
      if (!button) {
        return;
      }
      copyText(button.dataset.copy, button);
    });
  </script>
</body>
</html>`,
    { request }
  );
}

function renderProxyRow(proxy) {
  const searchText = `${proxy.prefix} ${proxy.type} ${proxy.proxyUrl} ${proxy.site}`.toLowerCase();
  const prefixInitial = proxy.prefix.slice(0, 2) || "?";
  const sourceHost = displayHost(proxy.site);
  const proxyHost = displayHost(proxy.proxyUrl);

  return `<article class="proxy-row" data-proxy-row data-type="${escapeAttribute(proxy.type)}" data-search="${escapeAttribute(searchText)}">
  <div class="proxy-title">
    <span class="prefix-mark" aria-hidden="true">${escapeHtml(prefixInitial)}</span>
    <div class="proxy-main">
      <div class="prefix">/${escapeHtml(proxy.prefix)}/</div>
      <div class="type type-${escapeAttribute(proxy.type)}">${escapeHtml(proxy.type)}</div>
    </div>
  </div>
  <div class="url-stack">
    <span class="label">Proxy URL</span>
    <a class="url-link" href="${escapeAttribute(proxy.proxyUrl)}"><code>${escapeHtml(proxy.proxyUrl)}</code></a>
    <div class="domain">${escapeHtml(proxyHost)}</div>
  </div>
  <div class="url-stack">
    <span class="label">Source</span>
    <a class="url-link" href="${escapeAttribute(proxy.site)}" rel="noreferrer"><code>${escapeHtml(proxy.site)}</code></a>
    <div class="domain">${escapeHtml(sourceHost)}</div>
  </div>
  <div class="actions">
    <button class="icon-button" type="button" title="Copy proxy URL" aria-label="Copy proxy URL" data-copy="${escapeAttribute(proxy.proxyUrl)}">${renderIcon("copy")}</button>
    <a class="icon-button" href="${escapeAttribute(proxy.proxyUrl)}" target="_blank" rel="noreferrer" title="Open proxy URL" aria-label="Open proxy URL">${renderIcon("external")}</a>
  </div>
</article>`;
}

function renderIcon(name) {
  const icons = {
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 4.4 2.8 17.2A2 2 0 0 0 4.5 20h15a2 2 0 0 0 1.7-2.8L13.7 4.4a2 2 0 0 0-3.4 0Z"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/></svg>',
    route: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 17V9a4 4 0 0 1 4-4h6"/><path d="M8 19h6a4 4 0 0 0 4-4V7"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>'
  };

  return icons[name] ?? "";
}

function displayHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function renderNotFound(url, proxies) {
  const proxyNames = proxies.map((proxy) => `/${proxy.prefix}/`).join(", ");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Proxy not found</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
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
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
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
