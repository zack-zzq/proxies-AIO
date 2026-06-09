import assert from "node:assert/strict";
import test from "node:test";
import worker, {
  buildDockerTargetUrl,
  buildTargetUrl,
  buildUrlPrefixedTargetUrl,
  findProxyForPath,
  normalizeProxyConfig
} from "../src/index.js";

test("homepage lists configured proxies", async () => {
  const response = await worker.fetch(new Request("https://proxy.ziqizhu.com/"));
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /Proxies AIO/);
  assert.match(html, /https:\/\/proxy\.ziqizhu\.com\/google\//);
  assert.match(html, /https:\/\/www\.google\.com/);
});

test("proxy route strips the configured prefix before forwarding", async (t) => {
  const originalFetch = globalThis.fetch;
  let upstreamRequest;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (request) => {
    upstreamRequest = request;
    return new Response("proxied", {
      headers: {
        "content-type": "text/plain"
      }
    });
  };

  const response = await worker.fetch(
    new Request("https://proxy.ziqizhu.com/google/search?q=codex", {
      headers: {
        origin: "https://client.example"
      }
    })
  );

  assert.equal(upstreamRequest.url, "https://www.google.com/search?q=codex");
  assert.equal(await response.text(), "proxied");
  assert.equal(response.headers.get("access-control-allow-origin"), "https://client.example");
});

test("bare proxy prefix maps to the upstream root", () => {
  const proxy = findProxyForPath("/google");
  const targetUrl = buildTargetUrl(new URL("https://proxy.ziqizhu.com/google"), proxy);

  assert.equal(targetUrl.href, "https://www.google.com/");
});

test("partial prefix matches are rejected", () => {
  assert.equal(findProxyForPath("/googledoc"), null);
});

test("upstream redirects back to the same origin stay under the proxy prefix", async (t) => {
  const originalFetch = globalThis.fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () =>
    new Response(null, {
      status: 302,
      headers: {
        location: "https://www.google.com/maps?q=codex"
      }
    });

  const response = await worker.fetch(new Request("https://proxy.ziqizhu.com/google/search"));

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/google/maps?q=codex");
});

test("config accepts a single proxy object as well as an array", () => {
  const config = normalizeProxyConfig({
    prefix: "docs",
    site: "https://developers.cloudflare.com"
  });

  assert.deepEqual(config.errors, []);
  assert.equal(config.proxies[0].prefix, "docs");
});

test("config supports special proxy types with default sites", () => {
  const config = normalizeProxyConfig({
    prefix: "gh",
    type: "github"
  });

  assert.deepEqual(config.errors, []);
  assert.equal(config.proxies[0].site, "https://github.com");
  assert.equal(config.proxies[0].type, "github");
});

test("pixiv proxy forwards to i.pximg.net with required headers", async (t) => {
  const originalFetch = globalThis.fetch;
  let upstreamRequest;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (request) => {
    upstreamRequest = request;
    return new Response("pixiv");
  };

  const response = await worker.fetch(
    new Request("https://proxy.ziqizhu.com/pixiv/img-original/foo.jpg")
  );

  assert.equal(upstreamRequest.url, "https://i.pximg.net/img-original/foo.jpg");
  assert.equal(upstreamRequest.headers.get("referer"), "https://www.pixiv.net/");
  assert.equal(upstreamRequest.headers.get("user-agent"), "Cloudflare Workers");
  assert.equal(await response.text(), "pixiv");
});

test("github proxy keeps the original URL after the proxy prefix", async (t) => {
  const originalFetch = globalThis.fetch;
  let upstreamRequest;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (request) => {
    upstreamRequest = request;
    return new Response("github", {
      status: 302,
      headers: {
        location: "https://github.com/owner/repo/releases/download/v2/app.zip"
      }
    });
  };

  const response = await worker.fetch(
    new Request("https://proxy.ziqizhu.com/github/https://github.com/owner/repo/releases/download/v1/app.zip")
  );

  assert.equal(upstreamRequest.url, "https://github.com/owner/repo/releases/download/v1/app.zip");
  assert.equal(response.headers.get("location"), "/github/https://github.com/owner/repo/releases/download/v2/app.zip");
});

test("github blob URLs are converted to raw URLs before forwarding", async (t) => {
  const originalFetch = globalThis.fetch;
  let upstreamRequest;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (request) => {
    upstreamRequest = request;
    return new Response("raw");
  };

  await worker.fetch(
    new Request("https://proxy.ziqizhu.com/github/https://github.com/owner/repo/blob/main/file.js")
  );

  assert.equal(upstreamRequest.url, "https://github.com/owner/repo/raw/main/file.js");
});

test("github target builder supports URLs without a scheme", () => {
  const proxy = findProxyForPath("/github/github.com/owner/repo/archive/main.zip");
  const targetUrl = buildUrlPrefixedTargetUrl(
    new URL("https://proxy.ziqizhu.com/github/github.com/owner/repo/archive/main.zip"),
    proxy
  );

  assert.equal(targetUrl.href, "https://github.com/owner/repo/archive/main.zip");
});

test("docker proxy targets registry and rewrites auth challenges", async (t) => {
  const originalFetch = globalThis.fetch;
  let upstreamRequest;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (request) => {
    upstreamRequest = request;
    return new Response(null, {
      status: 401,
      headers: {
        "www-authenticate": 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"'
      }
    });
  };

  const response = await worker.fetch(
    new Request("https://proxy.ziqizhu.com/docker/v2/alpine/manifests/latest")
  );

  assert.equal(upstreamRequest.url, "https://registry-1.docker.io/v2/library/alpine/manifests/latest");
  assert.equal(
    response.headers.get("www-authenticate"),
    'Bearer realm="https://proxy.ziqizhu.com/docker/token",service="registry.docker.io"'
  );
});

test("docker token requests target the docker auth service", () => {
  const proxy = findProxyForPath("/docker/token");
  const targetUrl = buildDockerTargetUrl(
    new URL("https://proxy.ziqizhu.com/docker/token?service=registry.docker.io"),
    proxy
  );

  assert.equal(targetUrl.href, "https://auth.docker.io/token?service=registry.docker.io");
});
