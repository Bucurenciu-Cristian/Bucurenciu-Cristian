import { readFile, writeFile } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';

const root = process.cwd();
const contentIndexUrl = process.env.CONTENT_INDEX_URL || 'https://raw.githubusercontent.com/Bucurenciu-Cristian/kicky-public/main/public/content-index.json';
const localContentIndex = process.env.CONTENT_INDEX_FILE || path.resolve(root, '../kicky-public/public/content-index.json');

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'kicky-profile-readme' } }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`GET ${url} failed: ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

function replaceBlock(readme, name, body) {
  const start = `<!-- ${name} starts -->`;
  const end = `<!-- ${name} ends -->`;
  const pattern = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!pattern.test(readme)) throw new Error(`README missing ${name} block`);
  return readme.replace(pattern, `${start}\n${body}\n${end}`);
}

function formatItems(items, type, limit) {
  const filtered = items.filter((item) => item.type === type).slice(0, limit);
  if (!filtered.length) return '- Nothing public yet.';
  return filtered.map((item) => `- [${item.title}](${item.url}) — ${item.summary} (${item.date})`).join('\n');
}

let content = { items: [] };
if (process.env.CI !== 'true') {
  try {
    content = JSON.parse(await readFile(localContentIndex, 'utf8'));
    console.warn(`Used local content index: ${localContentIndex}`);
  } catch (localError) {
    console.warn(`Local content index unavailable: ${localError.message}`);
  }
}

if (!content.items.length) {
  try {
    content = await getJson(contentIndexUrl);
  } catch (error) {
    console.warn(`Remote content index unavailable: ${error.message}`);
  }
}

const projects = JSON.parse(await readFile(path.join(root, 'data/projects.json'), 'utf8'));
const projectList = projects.map((project) => `- [${project.name}](${project.url}) — ${project.description}`).join('\n');

let readme = await readFile(path.join(root, 'README.md'), 'utf8');
readme = replaceBlock(readme, 'public_notes', formatItems(content.items, 'note', 5));
readme = replaceBlock(readme, 'current_builds', formatItems(content.items, 'build', 5));
readme = replaceBlock(readme, 'public_repos', projectList || '- Public repo list pending.');
await writeFile(path.join(root, 'README.md'), readme);
console.log(`Profile README updated from ${content.items.length} content item(s), ${projects.length} project(s).`);
