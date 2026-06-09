#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const PROXY_TYPES = new Set(["default", "pixiv", "github", "docker"]);
const MULTI_PART_TLDS = new Set(["co.uk", "com.cn", "net.cn", "org.cn"]);

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(rootDir, "proxies.config.json");

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  let siteInput = options.site;
  if (!siteInput && process.stdin.isTTY) {
    const rl = createInterface({ input, output });
    siteInput = await rl.question("Proxy target URL: ");
    rl.close();
  }

  if (!siteInput) {
    throw new Error("Missing target URL. Example: npm run proxy:add -- https://www.example.com");
  }

  const siteUrl = parseSiteUrl(siteInput);
  const type = options.type || "default";
  if (!PROXY_TYPES.has(type)) {
    throw new Error(`Invalid type "${type}". Valid types: ${[...PROXY_TYPES].join(", ")}`);
  }

  const config = await readConfig();
  const entries = Array.isArray(config) ? config : [config];
  const prefix = options.prefix
    ? ensureValidPrefix(options.prefix)
    : uniquePrefix(inferPrefix(siteUrl), entries);

  const newEntry = {
    prefix,
    site: trimTrailingSlash(siteUrl.href)
  };

  if (type !== "default") {
    newEntry.type = type;
  }

  const duplicate = entries.find((entry) => {
    return String(entry.prefix).toLowerCase() === prefix.toLowerCase() &&
      trimTrailingSlash(String(entry.site ?? "")) === newEntry.site &&
      String(entry.type ?? "default").toLowerCase() === type;
  });

  if (duplicate) {
    console.log(`Proxy already exists: /${prefix}/ -> ${newEntry.site}`);
    return;
  }

  const nextConfig = [...entries, newEntry];
  const outputJson = `${JSON.stringify(nextConfig, null, 2)}\n`;

  if (options.dryRun) {
    console.log(outputJson);
    return;
  }

  await writeFile(configPath, outputJson, "utf8");
  console.log(`Added proxy: /${prefix}/ -> ${newEntry.site}`);
}

function parseArgs(args) {
  const options = {
    dryRun: process.env.PROXY_ADD_DRY_RUN === "1",
    help: false,
    prefix: "",
    site: "",
    type: ""
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--dry-run" || arg === "dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg.startsWith("prefix=")) {
      options.prefix = arg.slice("prefix=".length);
      continue;
    }

    if (arg.startsWith("type=")) {
      options.type = arg.slice("type=".length);
      continue;
    }

    if (arg === "--prefix") {
      options.prefix = args[++index] ?? "";
      continue;
    }

    if (arg.startsWith("--prefix=")) {
      options.prefix = arg.slice("--prefix=".length);
      continue;
    }

    if (arg === "--type") {
      options.type = args[++index] ?? "";
      continue;
    }

    if (arg.startsWith("--type=")) {
      options.type = arg.slice("--type=".length);
      continue;
    }

    if (!options.site) {
      options.site = arg;
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  options.type = options.type.trim().toLowerCase();
  return options;
}

async function readConfig() {
  const content = await readFile(configPath, "utf8");
  const parsed = JSON.parse(content);

  if (!Array.isArray(parsed) && (!parsed || typeof parsed !== "object")) {
    throw new Error("proxies.config.json must contain an object or an array.");
  }

  return parsed;
}

function parseSiteUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw new Error("Target URL cannot be empty.");
  }

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withProtocol);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Target URL must use http or https.");
  }

  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";

  return url;
}

function inferPrefix(url) {
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  const hostParts = hostname.split(".").filter(Boolean);
  const pathParts = url.pathname.split("/").filter(Boolean).slice(0, 1);

  if (hostParts.length < 2 || isIpAddress(hostname)) {
    return ensureValidPrefix([hostname, ...pathParts].join("-"));
  }

  const tldLength = MULTI_PART_TLDS.has(hostParts.slice(-2).join(".")) ? 2 : 1;
  const baseIndex = Math.max(0, hostParts.length - tldLength - 1);
  const base = hostParts[baseIndex];
  const subdomains = hostParts.slice(0, baseIndex).filter((part) => part !== "www");
  const prefixParts = [base, ...subdomains, ...pathParts];

  return ensureValidPrefix(prefixParts.join("-"));
}

function uniquePrefix(basePrefix, entries) {
  const used = new Set(entries.map((entry) => String(entry.prefix ?? "").toLowerCase()));

  if (!used.has(basePrefix.toLowerCase())) {
    return basePrefix;
  }

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${basePrefix}-${index}`;
    if (!used.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  throw new Error(`Unable to find an unused prefix for "${basePrefix}".`);
}

function ensureValidPrefix(value) {
  const prefix = slugify(value);

  if (!/^[A-Za-z0-9_-]+$/.test(prefix)) {
    throw new Error(`Invalid prefix "${value}".`);
  }

  return prefix;
}

function slugify(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function isIpAddress(value) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) || value.includes(":");
}

function trimTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function printHelp() {
  console.log(`Usage:
  npm run proxy:add -- <target-url>
  npm run proxy:add -- <target-url> prefix=<prefix>
  npm run proxy:add -- <target-url> type=<default|pixiv|github|docker>
  npm run proxy:add -- <target-url> dry-run

Examples:
  npm run proxy:add -- https://www.google.com
  npm run proxy:add -- https://icons.duckduckgo.com
  npm run proxy:add -- https://i.pximg.net prefix=pixiv type=pixiv
`);
}
