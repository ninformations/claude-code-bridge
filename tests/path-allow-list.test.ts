import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { validateMcpConfigPath } from '../src/security/path-allow-list.js';

let tmpRoot: string;
let allowedDir: string;
let elsewhereDir: string;
let goodConfig: string;
let badShapeConfig: string;
let bigConfig: string;
let nonJsonFile: string;

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccb-pal-'));
  allowedDir = path.join(tmpRoot, 'allowed');
  elsewhereDir = path.join(tmpRoot, 'elsewhere');
  await fs.mkdir(allowedDir, { recursive: true });
  await fs.mkdir(elsewhereDir, { recursive: true });

  goodConfig = path.join(allowedDir, 'good.json');
  await fs.writeFile(
    goodConfig,
    JSON.stringify({ mcpServers: { x: { command: 'echo' } } }),
  );

  badShapeConfig = path.join(allowedDir, 'badshape.json');
  await fs.writeFile(badShapeConfig, JSON.stringify({ notMcpServers: {} }));

  nonJsonFile = path.join(allowedDir, 'not-json.json');
  await fs.writeFile(nonJsonFile, 'this is not json {{{');

  bigConfig = path.join(allowedDir, 'big.json');
  await fs.writeFile(
    bigConfig,
    JSON.stringify({ mcpServers: { x: 'y'.repeat(1_200_000) } }),
  );
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('validateMcpConfigPath', () => {
  it('accepts an absolute path inside an allowed dir with valid contents', async () => {
    const got = await validateMcpConfigPath(goodConfig, [allowedDir]);
    assert.equal(got, await fs.realpath(goodConfig));
  });

  it('rejects relative paths', async () => {
    await assert.rejects(
      validateMcpConfigPath('./relative.json', [allowedDir]),
      /absolute path/,
    );
  });

  it('rejects empty string', async () => {
    await assert.rejects(validateMcpConfigPath('', [allowedDir]), /non-empty/);
  });

  it('rejects when no allowed dirs are configured', async () => {
    await assert.rejects(
      validateMcpConfigPath(goodConfig, []),
      /No mcp_config_path directories/,
    );
  });

  it('rejects paths outside the allowed dirs', async () => {
    const evil = path.join(elsewhereDir, 'cfg.json');
    await fs.writeFile(evil, JSON.stringify({ mcpServers: {} }));
    await assert.rejects(
      validateMcpConfigPath(evil, [allowedDir]),
      /not inside any allowed directory/,
    );
  });

  it('rejects parent-traversal attempts that escape the allow-list', async () => {
    const evilName = path.join(allowedDir, '..', 'elsewhere', 'cfg.json');
    await fs.writeFile(
      path.join(elsewhereDir, 'cfg.json'),
      JSON.stringify({ mcpServers: {} }),
    );
    await assert.rejects(
      validateMcpConfigPath(evilName, [allowedDir]),
      /not inside any allowed directory/,
    );
  });

  it('rejects symlinks pointing outside the allow-list', async () => {
    const target = path.join(elsewhereDir, 'real.json');
    await fs.writeFile(target, JSON.stringify({ mcpServers: {} }));
    const link = path.join(allowedDir, 'link.json');
    try {
      await fs.symlink(target, link);
    } catch {
      // Symlinks may not be permitted on some Windows test runners; skip cleanly.
      return;
    }
    await assert.rejects(
      validateMcpConfigPath(link, [allowedDir]),
      /not inside any allowed directory/,
    );
  });

  it('rejects nonexistent files', async () => {
    await assert.rejects(
      validateMcpConfigPath(path.join(allowedDir, 'missing.json'), [allowedDir]),
      /does not exist/,
    );
  });

  it('rejects non-JSON content', async () => {
    await assert.rejects(
      validateMcpConfigPath(nonJsonFile, [allowedDir]),
      /could not be parsed as JSON/,
    );
  });

  it('rejects JSON that does not match the MCP config shape', async () => {
    await assert.rejects(
      validateMcpConfigPath(badShapeConfig, [allowedDir]),
      /expected \{ mcpServers: \{\.\.\.\} \} shape/,
    );
  });

  it('rejects files larger than 1MB', async () => {
    await assert.rejects(
      validateMcpConfigPath(bigConfig, [allowedDir]),
      /larger than 1MB/,
    );
  });

  it('accepts when the allow-dir itself contains a symlinked path component', async () => {
    // Regression: on macOS, os.tmpdir() returns /var/folders/... whose
    // realpath is /private/var/folders/... Without realpath'ing the allow-dir
    // too, every legitimate file would be rejected as "outside the allow-list"
    // because the file's realpath has been canonicalized but the dir hasn't.
    const realDir = path.join(tmpRoot, 'real-target');
    await fs.mkdir(realDir, { recursive: true });
    const linkDir = path.join(tmpRoot, 'link-to-target');
    try {
      await fs.symlink(realDir, linkDir);
    } catch {
      // Some platforms (Windows non-admin) can't create symlinks; skip cleanly.
      return;
    }
    const cfgViaLink = path.join(linkDir, 'cfg.json');
    await fs.writeFile(cfgViaLink, JSON.stringify({ mcpServers: {} }));
    const got = await validateMcpConfigPath(cfgViaLink, [linkDir]);
    assert.equal(got, await fs.realpath(cfgViaLink));
  });
});
