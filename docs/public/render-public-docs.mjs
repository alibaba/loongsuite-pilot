import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const docsDir = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(docsDir, 'pilot-integration.source.md');

const targets = {
  agentloop: {
    output: 'agentloop-integration.md',
    platformName: 'AgentLoop',
  },
  cms: {
    output: 'cms-integration.md',
    platformName: '云监控 2.0',
  },
};

function applyPlatformBlocks(source, platform) {
  return source.replace(
    /<!--\s*platform:([a-z0-9_-]+)\s*-->\n?([\s\S]*?)\n?<!--\s*\/platform\s*-->/gi,
    (_match, markerPlatform, body) => {
      return markerPlatform.toLowerCase() === platform ? `${body.trim()}\n` : '';
    },
  );
}

function applyVariables(source, config, platform) {
  return source.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (match, key) => {
    if (key !== 'platformName') {
      throw new Error(`Unsupported placeholder "${match}" for platform "${platform}". Only "{{platformName}}" is supported.`);
    }
    return config.platformName;
  });
}

function cleanupMarkdown(source) {
  let cleaned = source.replace(/\n{3,}/g, '\n\n');

  let previous;
  do {
    previous = cleaned;
    cleaned = cleaned
      .replace(/(\n\d+\. [^\n]+)\n\n(?=\d+\. )/g, '$1\n')
      .replace(/(\n[-*] [^\n]+)\n\n(?=[-*] )/g, '$1\n');
  } while (cleaned !== previous);

  return cleaned.trimEnd().concat('\n');
}

function renderPlatform(source, platform, config) {
  const withBlocks = applyPlatformBlocks(source, platform);
  const withVariables = applyVariables(withBlocks, config, platform);

  return cleanupMarkdown(
    `<!-- Generated from docs/public/pilot-integration.source.md. Do not edit by hand. -->\n\n${withVariables}`,
  );
}

const source = await readFile(sourcePath, 'utf8');

for (const [platform, config] of Object.entries(targets)) {
  const outputPath = path.join(docsDir, config.output);
  await writeFile(outputPath, renderPlatform(source, platform, config), 'utf8');
  console.log(`rendered docs/public/${config.output}`);
}
