import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import https from 'node:https';
import path from 'node:path';

const root = process.cwd();
const login = process.env.GITHUB_LOGIN || 'Bucurenciu-Cristian';
const contentIndexUrl = process.env.CONTENT_INDEX_URL || `https://raw.githubusercontent.com/${login}/kicky-public/main/public/content-index.json`;
const localContentIndex = process.env.CONTENT_INDEX_FILE || path.resolve(root, '../kicky-public/public/content-index.json');

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: options.method || 'GET',
      headers: {
        'user-agent': 'kicky-profile-readme',
        'accept': 'application/json',
        ...options.headers,
      },
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`${options.method || 'GET'} ${url} failed: ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  const gh = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  if (gh.status === 0) return gh.stdout.trim();
  return '';
}

async function githubGraphql(query, variables) {
  const token = githubToken();
  if (!token) throw new Error('No GITHUB_TOKEN/GH_TOKEN and `gh auth token` unavailable');
  const result = await requestJson('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (result.errors?.length) throw new Error(result.errors.map((error) => error.message).join('; '));
  return result.data;
}

async function fetchPublicRepos() {
  const query = `
    query($login: String!, $after: String) {
      user(login: $login) {
        repositories(first: 100, after: $after, privacy: PUBLIC, ownerAffiliations: OWNER, orderBy: {field: UPDATED_AT, direction: DESC}) {
          pageInfo { hasNextPage endCursor }
          nodes {
            name
            url
            description
            stargazerCount
            isFork
            updatedAt
            releases(last: 1) {
              nodes { name tagName publishedAt url }
            }
          }
        }
      }
    }
  `;

  const repos = [];
  let after = null;
  do {
    const data = await githubGraphql(query, { login, after });
    const page = data.user.repositories;
    repos.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return repos;
}

function replaceBlock(readme, name, body) {
  const start = `<!-- ${name} starts -->`;
  const end = `<!-- ${name} ends -->`;
  const pattern = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!pattern.test(readme)) throw new Error(`README missing ${name} block`);
  return readme.replace(pattern, `${start}\n${body}\n${end}`);
}

function shorten(text, max = 74) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trim()}…`;
}

function formatDate(value) {
  return String(value || '').slice(0, 10);
}

function formatBlog(items) {
  const latest = items.slice(0, 5);
  if (!latest.length) return '- Nothing published yet.';
  return latest.map((item) => `[${item.title}](${item.url}) - ${item.date}`).join('\n\n');
}

function formatReleases(repos) {
  const releases = repos
    .filter((repo) => !repo.isFork)
    .flatMap((repo) => repo.releases.nodes.map((release) => ({ repo, release })))
    .filter(({ release }) => release?.url && release?.publishedAt)
    .sort((a, b) => b.release.publishedAt.localeCompare(a.release.publishedAt))
    .slice(0, 8);

  if (!releases.length) return '- No public releases yet.';
  return releases.map(({ repo, release }) => {
    const name = release.name || release.tagName;
    return `[${repo.name} ${name}](${release.url}) - ${formatDate(release.publishedAt)}`;
  }).join('\n\n');
}

function formatProjects(repos, overrides) {
  const byName = new Map(repos.filter((repo) => !repo.isFork).map((repo) => [repo.name, repo]));
  const include = Array.isArray(overrides.include) ? overrides.include : [];
  const projects = include
    .map((name) => byName.get(name))
    .filter(Boolean)
    .map((repo) => ({
      ...repo,
      description: overrides.descriptions?.[repo.name] || repo.description,
    }));

  if (!projects.length) return 'No public projects yet.';
  const rows = projects.map((repo) => `| [${repo.name}](${repo.url}) | ${shorten(repo.description)} | ${repo.stargazerCount || ''} |`);
  return ['| Project | What it does | ★ |', '|---------|-------------|---|', ...rows].join('\n');
}

async function loadContentIndex() {
  if (process.env.CI !== 'true') {
    try {
      const local = JSON.parse(await readFile(localContentIndex, 'utf8'));
      console.warn(`Used local content index: ${localContentIndex}`);
      return local;
    } catch (localError) {
      console.warn(`Local content index unavailable: ${localError.message}`);
    }
  }

  try {
    return await requestJson(contentIndexUrl);
  } catch (error) {
    console.warn(`Remote content index unavailable: ${error.message}`);
    return { items: [] };
  }
}

const [content, repos, projectOverrides] = await Promise.all([
  loadContentIndex(),
  fetchPublicRepos().catch((error) => {
    console.warn(`GitHub repo sync unavailable: ${error.message}`);
    return [];
  }),
  readFile(path.join(root, 'data/project-overrides.json'), 'utf8')
    .then(JSON.parse)
    .catch(() => ({ include: [], descriptions: {} })),
]);

const items = Array.isArray(content.items) ? content.items : [];
let readme = await readFile(path.join(root, 'README.md'), 'utf8');
readme = replaceBlock(readme, 'blog', formatBlog(items));
readme = replaceBlock(readme, 'releases', formatReleases(repos));
readme = replaceBlock(readme, 'projects', formatProjects(repos, projectOverrides));
await writeFile(path.join(root, 'README.md'), readme);
console.log(`Profile README updated from ${items.length} blog item(s), ${repos.length} public repo(s).`);
