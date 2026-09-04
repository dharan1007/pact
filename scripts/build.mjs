import { cp, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

function stripExports(source) { return source.replace(/^export\s+/gm, ''); }
function stripImports(source) { return source.replace(/^import\s+.*?;\s*$/gm, ''); }
function moduleScope(source, names) {
  return `const { ${names.join(', ')} } = (() => {\n${stripExports(source)}\nreturn { ${names.join(', ')} };\n})();\n`;
}

const source = async file => readFile(path.join(root, file), 'utf8');
const bundles = {
  'engine.bundle.js': moduleScope(await source('src/engine.js'), ['createPactEngine']),
  'adapter.bundle.js': moduleScope(await source('src/adapter.js'), ['definePactAdapter', 'validateAdapterPlan']),
  'persistence.bundle.js': moduleScope(await source('src/persistence.js'), ['LocalStorageSnapshotStore']),
  'webmcp.bundle.js': moduleScope(await source('src/webmcp.js'), ['createWebMcpRegistry']),
  'http.bundle.js': moduleScope(await source('src/http.js'), ['createPactHttpConnector']),
  'orchestrator.bundle.js': moduleScope(await source('src/orchestrator.js'), ['createPactOrchestrator']),
  'site.bundle.js': stripImports(await source('src/site.js')),
  'workspace.bundle.js': stripImports(await source('src/main.js')),
  'demo.bundle.js': stripImports(await source('src/demo.js'))
};
for (const [name, contents] of Object.entries(bundles)) await writeFile(path.join(dist, name), contents);
await cp(path.join(root, 'src/styles.css'), path.join(dist, 'styles.css'));

// Ship source-compatible ESM modules as the reusable SDK. Keeping the module
// graph intact avoids hidden globals and lets consumers import only what they use.
await mkdir(path.join(dist, 'sdk'), { recursive: true });
for (const file of ['engine.js', 'adapter.js', 'runtime.js', 'authority.js', 'http.js', 'webmcp.js', 'persistence.js', 'orchestrator.js']) {
  await cp(path.join(root, 'src', file), path.join(dist, 'sdk', file));
}

const scriptMap = new Map([
  ['/src/site.js', '/site.bundle.js'],
  ['/src/main.js', '/workspace.bundle.js'],
  ['/src/demo.js', '/demo.bundle.js']
]);
const dependencyScripts = {
  '/workspace.bundle.js': ['/engine.bundle.js','/persistence.bundle.js','/webmcp.bundle.js'],
  '/demo.bundle.js': ['/engine.bundle.js','/persistence.bundle.js','/orchestrator.bundle.js']
};
function transformHtml(html) {
  html = html.replaceAll('href="/src/styles.css"', 'href="/styles.css"');
  for (const [from,to] of scriptMap) html = html.replaceAll(`src="${from}"`, `src="${to}"`).replaceAll('type="module" ', '');
  for (const [entry,deps] of Object.entries(dependencyScripts)) {
    const needle = `<script src="${entry}"></script>`;
    if (html.includes(needle)) html = html.replace(needle, [...deps.map(src=>`<script src="${src}"></script>`), needle].join(''));
  }
  return html;
}

const routes = [
  { src: 'index.html', out: 'index.html' },
  { src: 'pages/demo.html', out: 'demo/index.html' },
  { src: 'pages/workspace.html', out: 'workspace/index.html' },
  { src: 'pages/how-it-works.html', out: 'how-it-works/index.html' },
  { src: 'pages/security.html', out: 'security/index.html' },
  { src: 'pages/developers.html', out: 'developers/index.html' }
];
for (const route of routes) {
  const out = path.join(dist, route.out);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, transformHtml(await source(route.src)));
}
for (const file of ['vercel.json', 'README.md', 'LICENSE', 'pact-manifest.json']) await cp(path.join(root, file), path.join(dist, file));
await mkdir(path.join(dist, 'schema'), { recursive: true });
for (const file of ['pact-manifest.schema.json', 'pact-adapter.schema.json']) {
  await cp(path.join(root, `schema/${file}`), path.join(dist, `schema/${file}`));
}

async function walk(dir, prefix='') {
  const out=[];
  for (const entry of await readdir(dir, { withFileTypes:true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await walk(path.join(dir,entry.name), rel));
    else if (entry.name !== 'release-manifest.json') out.push(rel);
  }
  return out.sort();
}
const files = await walk(dist);
const hashes = {};
for (const file of files) hashes[file] = createHash('sha256').update(await readFile(path.join(dist,file))).digest('hex');
await writeFile(path.join(dist,'release-manifest.json'), JSON.stringify({ schema:8, files:hashes }, null, 2)+'\n');
console.log(`Built ${files.length + 1} release files into dist/`);
