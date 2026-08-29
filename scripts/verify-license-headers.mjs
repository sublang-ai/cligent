// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, extname, resolve } from 'node:path';

const COPYRIGHT_MARKER = 'SPDX-FileCopyrightText';
const LICENSE_MARKER = 'SPDX-License-Identifier';
const SPDX_MARKERS = [COPYRIGHT_MARKER, LICENSE_MARKER];

const commentStyles = new Map([
  ['.bash', 'hash'],
  ['.c', 'slash'],
  ['.cc', 'slash'],
  ['.cjs', 'slash'],
  ['.cpp', 'slash'],
  ['.css', 'block'],
  ['.cts', 'slash'],
  ['.h', 'slash'],
  ['.hpp', 'slash'],
  ['.htm', 'html'],
  ['.html', 'html'],
  ['.java', 'slash'],
  ['.js', 'slash'],
  ['.jsx', 'slash'],
  ['.md', 'html'],
  ['.mdx', 'html'],
  ['.mjs', 'slash'],
  ['.mts', 'slash'],
  ['.pl', 'hash'],
  ['.py', 'hash'],
  ['.rb', 'hash'],
  ['.sass', 'slash'],
  ['.scss', 'slash'],
  ['.sh', 'hash'],
  ['.toml', 'hash'],
  ['.ts', 'slash'],
  ['.tsx', 'slash'],
  ['.vue', 'html'],
  ['.xml', 'html'],
  ['.yaml', 'hash'],
  ['.yml', 'hash'],
  ['.zsh', 'hash'],
]);

const hashCommentBasenames = new Set(['Dockerfile', 'Makefile']);
const noCommentExtensions = new Set([
  '.7z',
  '.bin',
  '.bmp',
  '.csv',
  '.gif',
  '.gz',
  '.ico',
  '.jpeg',
  '.jpg',
  '.json',
  '.jsonl',
  '.ndjson',
  '.otf',
  '.pdf',
  '.png',
  '.tar',
  '.tgz',
  '.ttf',
  '.txt',
  '.wasm',
  '.webp',
  '.woff',
  '.woff2',
  '.zip',
]);

const generatedOrVendorSegments = new Set([
  'build',
  'coverage',
  'dist',
  'generated',
  'node_modules',
  'out',
  'vendor',
  'vendors',
]);

function usage(message) {
  if (message) console.error(message);
  console.error(
    'Usage: node scripts/verify-license-headers.mjs [--root PATH] [--upstream-ref REF]',
  );
  process.exitCode = 2;
}

function parseArguments(args) {
  let root = process.cwd();
  let upstreamRef;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== '--root' && argument !== '--upstream-ref') {
      usage(`Unknown argument: ${argument}`);
      return undefined;
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      usage(`Missing value for ${argument}`);
      return undefined;
    }
    index += 1;

    if (argument === '--root') root = value;
    else upstreamRef = value;
  }

  return { root: resolve(root), upstreamRef };
}

function runGit(root, args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', options.quiet ? 'ignore' : 'pipe'],
  });
}

function listRepositoryFiles(root) {
  const output = runGit(root, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
  ]);

  return output
    .toString('utf8')
    .split('\0')
    .filter((path) => path.length > 0);
}

function detectRootLicenses(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => {
      const matchesDirectory = entry.name === 'LICENSES';
      const matchesFile =
        /^(?:LICENSE(?:\.(?:txt|md)|-.+)?|COPYING|LICENCE(?:\.txt)?)$/.test(
          entry.name,
        );
      if (!matchesDirectory && !matchesFile) return false;

      if (matchesDirectory && entry.isDirectory()) return true;
      if (matchesFile && entry.isFile()) return true;
      if (!entry.isSymbolicLink()) return false;
      try {
        const target = statSync(resolve(root, entry.name));
        return matchesDirectory ? target.isDirectory() : target.isFile();
      } catch {
        return false;
      }
    })
    .map((entry) => entry.name)
    .sort();
}

function isConfiguration(path) {
  const segments = path.split('/');
  const basename = segments.at(-1) ?? path;

  if (segments[0] === '.github' || segments[0] === 'config') return true;
  if (basename === 'AGENTS.md' || basename === 'CLAUDE.md') return true;
  if (basename === '.editorconfig' || basename === '.gitignore') return true;
  if (basename === 'settings.json') return true;
  if (basename === 'npm-shrinkwrap.json') return true;
  if (/(?:^|[-.])lock(?:b|\.json|\.ya?ml)?$/i.test(basename)) return true;
  return /\.config\.[^.]+$/.test(basename);
}

function isGeneratedOrVendor(path) {
  return path
    .split('/')
    .some((segment) => generatedOrVendorSegments.has(segment));
}

function isLegalDocument(path) {
  const segments = path.split('/');
  if (segments.includes('LICENSES')) return true;
  const basename = (segments.at(-1) ?? path).toUpperCase();
  return /^(?:LICENSE|LICENCE|COPYING|LEGAL|NOTICE|PATENTS)(?:[._-].*)?$/.test(
    basename,
  );
}

function commentStyleFor(path, content) {
  const extensionStyle = commentStyles.get(extname(path).toLowerCase());
  if (extensionStyle) return extensionStyle;
  if (hashCommentBasenames.has(basename(path))) return 'hash';
  if (!content.startsWith('#!')) return undefined;

  const shebang = withoutLineEnding(splitRawLines(content)[0] ?? '');
  return /\b(?:bun|deno|node|tsx)(?:\s|$)/.test(shebang) ? 'slash' : 'hash';
}

function splitRawLines(content) {
  const lines = content.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? [];
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function withoutLineEnding(line) {
  return line.replace(/(?:\r\n|\r|\n)$/, '');
}

function startsComment(line, style) {
  if (style === 'hash') return /^\s*#/.test(line);
  if (style === 'html') return /^\s*<!--/.test(line);
  if (style === 'block') return /^\s*\/\*/.test(line);
  return /^\s*(?:\/\/|\/\*)/.test(line);
}

function consumeComment(lines, start, style) {
  const first = withoutLineEnding(lines[start]);

  if (style === 'hash' || (style === 'slash' && /^\s*\/\//.test(first))) {
    const prefix = style === 'hash' ? /^\s*#/ : /^\s*\/\//;
    let end = start;
    while (end < lines.length && prefix.test(withoutLineEnding(lines[end]))) {
      end += 1;
    }
    return end;
  }

  const closingToken = style === 'html' ? '-->' : '*/';
  let end = start;
  while (end < lines.length) {
    const line = withoutLineEnding(lines[end]);
    end += 1;
    if (line.includes(closingToken)) break;
  }
  return end;
}

function firstCommentBlock(content, style) {
  const lines = splitRawLines(content);
  let index = 0;

  if (lines.length > 0 && withoutLineEnding(lines[0]).startsWith('#!')) {
    index = 1;
  }
  while (
    index < lines.length &&
    /^\s*$/.test(withoutLineEnding(lines[index]))
  ) {
    index += 1;
  }
  if (
    index >= lines.length ||
    !startsComment(withoutLineEnding(lines[index]), style)
  ) {
    return [];
  }

  const block = [];
  while (
    index < lines.length &&
    startsComment(withoutLineEnding(lines[index]), style)
  ) {
    const end = consumeComment(lines, index, style);
    block.push(...lines.slice(index, end));
    index = end;
  }
  return block;
}

function spdxLines(block) {
  return block.filter((line) =>
    SPDX_MARKERS.some((marker) => line.includes(marker)),
  );
}

function readRefFile(root, ref, path) {
  try {
    return runGit(root, ['show', `${ref}:${path}`], { quiet: true }).toString(
      'utf8',
    );
  } catch {
    return undefined;
  }
}

function sameLines(left, right) {
  return (
    left.length === right.length &&
    left.every((line, index) => line === right[index])
  );
}

function audit(options) {
  const { root, upstreamRef } = options;
  let paths;
  let licenseFiles;

  try {
    paths = listRepositoryFiles(root);
    licenseFiles = detectRootLicenses(root);
    if (upstreamRef) {
      runGit(root, ['rev-parse', '--verify', `${upstreamRef}^{commit}`], {
        quiet: true,
      });
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      `Unable to inspect Git repository ${JSON.stringify(root)}: ${detail}`,
    );
    return 1;
  }

  const errors = [];
  let inspected = 0;
  let preserved = 0;

  for (const path of paths) {
    const absolutePath = resolve(root, path);
    if (!existsSync(absolutePath)) continue;

    let stat;
    try {
      stat = lstatSync(absolutePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    if (
      isConfiguration(path) ||
      isGeneratedOrVendor(path) ||
      isLegalDocument(path)
    ) {
      continue;
    }

    let content;
    try {
      content = readFileSync(absolutePath, 'utf8');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errors.push(`${JSON.stringify(path)}: cannot read file: ${detail}`);
      continue;
    }

    if (content.includes('\0')) continue;

    const style = commentStyleFor(path, content);
    if (!style) {
      const extension = extname(path).toLowerCase();
      if (extension === '' || noCommentExtensions.has(extension)) continue;
      errors.push(
        `${JSON.stringify(path)}: cannot classify whether ${JSON.stringify(extension)} supports comments`,
      );
      continue;
    }

    const currentBlock = firstCommentBlock(content, style);
    if (upstreamRef) {
      const upstreamContent = readRefFile(root, upstreamRef, path);
      if (upstreamContent !== undefined) {
        const upstreamSpdx = spdxLines(
          firstCommentBlock(upstreamContent, style),
        );
        if (upstreamSpdx.length > 0) {
          const currentSpdx = spdxLines(currentBlock);
          inspected += 1;
          if (!sameLines(currentSpdx, upstreamSpdx)) {
            errors.push(
              `${JSON.stringify(path)}: leading SPDX lines differ from ${JSON.stringify(upstreamRef)}; ` +
                `expected ${JSON.stringify(upstreamSpdx)}, received ${JSON.stringify(currentSpdx)}`,
            );
          } else {
            preserved += 1;
          }
          continue;
        }
      }
    }

    inspected += 1;
    const blockText = currentBlock.join('');
    if (!blockText.includes(COPYRIGHT_MARKER)) {
      errors.push(
        `${JSON.stringify(path)}: first comment block after any shebang lacks ${COPYRIGHT_MARKER}`,
      );
    }
    if (licenseFiles.length > 0 && !blockText.includes(LICENSE_MARKER)) {
      errors.push(
        `${JSON.stringify(path)}: first comment block after any shebang lacks ${LICENSE_MARKER}; ` +
          `root license detector matched ${licenseFiles.map((file) => JSON.stringify(file)).join(', ')}`,
      );
    }
  }

  if (errors.length > 0) {
    console.error(`SPDX header audit failed with ${errors.length} error(s):`);
    for (const error of errors) console.error(`- ${error}`);
    return 1;
  }

  const preservationNote = upstreamRef
    ? `; preserved ${preserved} upstream header block(s) from ${upstreamRef}`
    : '';
  console.log(
    `SPDX header audit passed: inspected ${inspected} file(s), detected ${licenseFiles.length} root license path(s)${preservationNote}.`,
  );
  return 0;
}

const options = parseArguments(process.argv.slice(2));
if (options) process.exitCode = audit(options);
