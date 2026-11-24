import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const sourceRoots = ["app", "components", "context", "hooks", "lib"];
const extensions = [".ts", ".tsx", ".js", ".jsx"];
const files = [];
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (extensions.includes(path.extname(entry.name))) files.push(full);
  }
}
sourceRoots.forEach((dir) => walk(path.join(root, dir)));
const sources = new Map(files.map((file) => [file, fs.readFileSync(file, "utf8")]));
const clients = [...sources].filter(([, text]) => /^\s*["']use client["'];/m.test(text)).map(([file]) => file);
const violations = [];
const secretReference = /process\.env\.(?!NEXT_PUBLIC_|NODE_ENV|VALIDATE_PRODUCTION)[A-Z0-9_]+/g;
const importPattern = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
function resolveImport(from, specifier) {
  if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return null;
  const base = specifier.startsWith("@/") ? path.join(root, specifier.slice(2)) : path.resolve(path.dirname(from), specifier);
  for (const ext of extensions) if (fs.existsSync(base + ext)) return base + ext;
  for (const ext of extensions) if (fs.existsSync(path.join(base, "index" + ext))) return path.join(base, "index" + ext);
  return null;
}
function visit(file, seen, origin) {
  if (seen.has(file)) return;
  seen.add(file);
  const text = sources.get(file);
  if (!text) return;
  if (/lib[\\/]config[\\/]serverEnv|lib[\\/]supabase[\\/]server(Auth)?(?:\.|["'])/.test(file)) {
    violations.push(`${path.relative(root, origin)} imports server-only configuration (${path.relative(root, file)}).`);
  }
  importPattern.lastIndex = 0;
  for (const match of text.matchAll(importPattern)) {
    const resolved = resolveImport(file, match[1]);
    if (resolved) visit(resolved, seen, origin);
  }
}
for (const file of clients) {
  const text = sources.get(file);
  if (secretReference.test(text)) violations.push(`${path.relative(root, file)} reads a server environment variable directly.`);
  secretReference.lastIndex = 0;
  visit(file, new Set(), file);
}

const staticDir = path.join(root, ".next", "static");
const bundleFiles = [];
function walkBundles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkBundles(full);
    else if (/\.(?:js|json|css|html)$/.test(entry.name)) bundleFiles.push(full);
  }
}
walkBundles(staticDir);
const secrets = Object.keys(process.env).filter((name) => /(?:SECRET|PRIVATE|TOKEN|API_KEY|WEBHOOK|CREDENTIAL|PASSWORD)/i.test(name) && !name.startsWith("NEXT_PUBLIC_"));
for (const file of bundleFiles) {
  const text = fs.readFileSync(file, "utf8");
  for (const name of secrets) {
    const value = process.env[name];
    if (value && value.length >= 8 && text.includes(value)) violations.push(`${path.relative(root, file)} contains a configured server secret value.`);
  }
}
if (violations.length) {
  console.error("Environment boundary check failed:");
  for (const violation of [...new Set(violations)]) console.error(` - ${violation}`);
  process.exit(1);
}
console.log(`Environment boundary check passed (${clients.length} client entrypoints, ${bundleFiles.length} client bundle files).`);
