import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { crc32, inflateSync } from 'node:zlib';
import { BOARD_SIZE, buildRadar, recordsTradingToken } from './lib/model.ts';
import type { BoardRow, Snapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const caps = {
  text_max_bytes: 65_536,
  screenshots: { max: 4, max_bytes: 524_288 },
  dashboard: { max_files: 400, max_bytes: 4_194_304 },
};
const boardLimit = 8 * 1024 * 1024;
const dossierLimit = 1.5 * 1024 * 1024;
const maxValue = 100_000_000_000_000;
const plainName = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u;

function requireGate(passes: unknown, gate: string, detail: string): asserts passes {
  if (!passes) throw new Error(`${gate}: ${detail}`);
}

function verifyBoard(rows: BoardRow[], boardText: string, snapshot: Snapshot) {
  const protocols = new Map(snapshot.protocols.map((protocol) => [protocol.slug, protocol]));
  const seen = new Set<string>();
  requireGate(rows.length === BOARD_SIZE, 'board_file', `expected ${BOARD_SIZE} rows, got ${rows.length}`);
  requireGate(Buffer.byteLength(boardText) <= boardLimit, 'board_file', 'board.json exceeds 8 MiB');
  for (const [index, row] of rows.entries()) {
    const { slug, name, rank, implied_value_usd: value, farm_steps: steps } = row;
    const protocol = protocols.get(slug);
    requireGate(protocol && !seen.has(slug) && /^[^\s]{1,128}$/u.test(slug), 'board_file', `invalid or repeated slug ${slug}`);
    requireGate(!recordsTradingToken(protocol), 'board_file', `trading record on ranked board: ${slug}`);
    requireGate(typeof name === 'string' && name.trim(), 'board_file', `empty name for ${slug}`);
    requireGate(Number.isSafeInteger(rank) && rank > 0, 'board_file', `invalid rank for ${slug}`);
    requireGate(Number.isSafeInteger(value) && value > 0 && value <= maxValue, 'board_file', `invalid value for ${slug}`);
    requireGate(Array.isArray(steps), 'board_file', `farm_steps is missing for ${slug}`);
    requireGate(rank === index + 1 && (index === 0 || rows[index - 1].implied_value_usd >= value),
      'sorted_by_value', `rank or value out of sequence at ${slug}`);
    requireGate(steps.length >= 3 && steps.length <= 12 && steps.every((step) => {
      if (typeof step !== 'string') return false;
      const length = Array.from(step.trim()).length;
      return length >= 20 && length <= 600;
    }), 'farm_steps', `invalid farm plan at ${slug}`);
    seen.add(slug);
  }
  requireGate(new Set(rows.map((row) => row.implied_value_usd)).size > 1, 'sorted_by_value', 'all implied values are equal');
  const missing = snapshot.watchlist.filter((slug) => !seen.has(slug));
  requireGate(missing.length === 0, 'coverage', `missing ${missing.join(', ')}`);

  // Check the cohort before trusting the model's ranks. The highest-value rows may
  // differ from the highest-TVL rows, but only the TVL cut determines who gets in.
  const watchlist = new Set(snapshot.watchlist);
  const additions = snapshot.protocols.filter((protocol) =>
    !watchlist.has(protocol.slug) && protocol.tvl_usd < snapshot.floor_usd && !recordsTradingToken(protocol)
  ).sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : Number(a.slug > b.slug)))
    .slice(0, BOARD_SIZE - watchlist.size);
  const omitted = additions.find((protocol) => !seen.has(protocol.slug));
  requireGate(additions.length + watchlist.size === BOARD_SIZE && !omitted, 'board_file',
    omitted ? `TVL cut omitted ${omitted.slug}` : 'insufficient eligible protocols below the floor');
}

const httpAddress = /https?:\/\//iu;
const cssComments = /\/\*[\s\S]*?\*\//gu;
const jsSpecifier = /\b(?:import\s*(?:\(\s*|(?=['"`]))|(?:import|export)\b[^;"'`]*?\bfrom\s*|require\s*\(\s*)(['"`])\s*https?:\/\//iu;

function decodeAttribute(value: string): string {
  return value.replace(/&#(?:x([\da-f]+)|(\d+));?|&(colon|sol|Tab|NewLine);/giu, (entity, hex, dec, named) => {
    if (named) return ({ colon: ':', sol: '/', tab: '\t', newline: '\n' } as Record<string, string>)[named.toLowerCase()];
    const code = hex ? parseInt(hex, 16) : Number(dec);
    return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

function hasNetworkAddress(extension: string, source: string): boolean {
  if (extension === '.css') return httpAddress.test(source.replace(cssComments, ''));
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return jsSpecifier.test(source);
  if (extension !== '.html' && extension !== '.svg') return false;
  let markup = source.replace(/<!--[\s\S]*?-->/gu, '');
  for (const style of markup.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/giu)) {
    if (hasNetworkAddress('.css', style[1])) return true;
  }
  for (const script of markup.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/giu)) {
    if (hasNetworkAddress('.js', script[1])) return true;
  }
  markup = markup.replace(/(<(?:script|style)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>)[\s\S]*?<\/(?:script|style)\s*>/giu, '$1');
  const tags = markup.matchAll(/<[a-z][a-z\d:_-]*\s*((?:[^"'<>]|"[^"]*"|'[^']*')*)>/giu);
  for (const [, attributes] of tags) {
    for (const attr of attributes.matchAll(/[^\s=/>]+(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu)) {
      if (httpAddress.test(decodeAttribute(attr[1] ?? attr[2] ?? attr[3] ?? ''))) return true;
    }
  }
  return false;
}

function verifyDashboard(directory: string) {
  let count = 0;
  let bytes = 0;
  const extensions = new Set<string>();
  function visit(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      requireGate(plainName.test(entry.name), 'dashboard_files', `invalid name ${entry.name}`);
      if (entry.isDirectory()) {
        visit(file);
        continue;
      }
      requireGate(entry.isFile(), 'dashboard_files', `not a regular file: ${file}`);
      const ext = extname(entry.name).toLowerCase();
      count += 1;
      bytes += lstatSync(file).size;
      requireGate(count <= caps.dashboard.max_files && bytes <= caps.dashboard.max_bytes, 'dashboard_files', 'file or byte cap exceeded');
      extensions.add(ext);
      if (['.css', '.js', '.mjs', '.cjs', '.html', '.svg'].includes(ext)) {
        requireGate(!hasNetworkAddress(ext, readFileSync(file, 'utf8')), 'dashboard_files', `network address in ${file}`);
      }
    }
  }
  requireGate(lstatSync(directory).isDirectory(), 'dashboard_files', 'dashboard must be a regular directory');
  visit(directory);
  requireGate(readdirSync(directory, { withFileTypes: true }).some((entry) => entry.name === 'index.html' && entry.isFile())
    && extensions.has('.css') && extensions.has('.js'), 'dashboard_files', 'index.html, CSS and JS are required');
  requireGate(bytes < caps.text_max_bytes, 'dashboard_files', 'dashboard source must be under 64 KiB');
}

type Dimensions = { width: number; height: number };

function pngDimensions(bytes: Buffer): Dimensions | null {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!bytes.subarray(0, 8).equals(signature)) return null;
  let dimensions: Dimensions | null = null;
  const compressed: Buffer[] = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    const next = offset + size + 12;
    if (next > bytes.length) break;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, next - 4)) !== bytes.readUInt32BE(next - 4)) break;
    if (offset === 8) {
      if (type !== 'IHDR' || size !== 13) break;
      dimensions = { width: bytes.readUInt32BE(offset + 8), height: bytes.readUInt32BE(offset + 12) };
    }
    if (type === 'IDAT') compressed.push(bytes.subarray(offset + 8, next - 4));
    if (type === 'IEND') {
      if (size !== 0 || next !== bytes.length || compressed.length === 0) break;
      if (!inflateSync(Buffer.concat(compressed), { maxOutputLength: 20 * 1024 * 1024 }).length) break;
      return dimensions;
    }
    offset = next;
  }
  throw new Error('screenshots: incomplete or corrupt PNG');
}

function jpegDimensions(bytes: Buffer): Dimensions | null {
  if (bytes.readUInt16BE(0) !== 0xffd8) return null;
  const frames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let dimensions: Dimensions | null = null;
  let scan = false;
  let hasScan = false;
  let offset = 2;
  while (offset < bytes.length) {
    if (scan) offset = bytes.indexOf(0xff, offset);
    if (offset < 0 || bytes[offset++] !== 0xff) break;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (scan && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) continue;
    if (marker === 0xd9 && offset === bytes.length && hasScan && dimensions) return dimensions;
    if (offset + 2 > bytes.length || marker === 0 || marker === 0xd8) break;
    const size = bytes.readUInt16BE(offset);
    if (size < 2 || offset + size > bytes.length) break;
    if (frames.has(marker)) {
      if (size < 8) break;
      dimensions = { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    }
    scan = marker === 0xda;
    hasScan ||= scan;
    offset += size;
  }
  throw new Error('screenshots: incomplete or corrupt JPEG');
}

function verifyScreenshots(directory: string) {
  requireGate(lstatSync(directory).isDirectory(), 'screenshots', 'screenshots must be a regular directory');
  const files = readdirSync(directory, { withFileTypes: true }).filter((entry) => !entry.name.startsWith('.'));
  requireGate(files.length === 3, 'screenshots', `expected exactly 3 images, got ${files.length}`);
  for (const file of files) {
    const path = join(directory, file.name);
    const size = lstatSync(path).size;
    requireGate(file.isFile() && plainName.test(file.name) && size >= 8 && size <= caps.screenshots.max_bytes,
      'screenshots', `invalid file or size for ${file.name}`);
    const bytes = readFileSync(path);
    const dimensions = pngDimensions(bytes) ?? jpegDimensions(bytes);
    requireGate(dimensions && Math.max(dimensions.width, dimensions.height) <= 1440
      && Math.min(dimensions.width, dimensions.height) >= 800, 'screenshots', `invalid format or dimensions for ${file.name}`);
  }
}

function run() {
  const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' } } });
  const input = resolve(values.input ?? '/input');
  const inputFile = statSync(input).isDirectory() ? join(input, 'snapshot.json') : input;
  const out = resolve(values.output ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
  const root = fileURLToPath(new URL('.', import.meta.url));
  const snapshot = JSON.parse(readFileSync(inputFile, 'utf8')) as Snapshot;
  const { rows, data } = buildRadar(snapshot);
  const boardText = JSON.stringify({ rows }) + '\n';
  verifyBoard(rows, boardText, snapshot);

  const dashboard = join(root, 'dashboard');
  const screenshots = join(root, 'screenshots');
  verifyDashboard(dashboard);
  verifyScreenshots(screenshots);
  mkdirSync(out, { recursive: true });
  cpSync(dashboard, join(out, 'dashboard'), { recursive: true });
  cpSync(screenshots, join(out, 'screenshots'), { recursive: true });
  verifyDashboard(join(out, 'dashboard'));
  verifyScreenshots(join(out, 'screenshots'));

  const dossier = Buffer.from(buildDossier(out, caps));
  const rebuilt = buildDossier(out, { text_max_bytes: caps.text_max_bytes });
  requireGate(dossier.length <= dossierLimit && dossier.equals(rebuilt), 'dossier_matches', 'dossier differs from the gate build or exceeds 1.5 MiB');

  writeFileSync(join(out, 'board.json'), boardText);
  writeFileSync(join(out, 'data.js'), `globalThis.RADAR_DATA = ${JSON.stringify(data).replace(/</gu, '\\u003c')};\n`);
  writeFileSync(join(out, 'dossier.json'), dossier);
  console.log(`Token launch radar wrote ${rows.length} rows and ${data.trading.length} trading references to ${out}`);
}

try {
  run();
} catch (error) {
  console.error(`Token launch radar: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
