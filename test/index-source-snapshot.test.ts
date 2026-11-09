import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, it, vi } from 'vitest';
import { ContentFilterError, type ContentFilter } from '../src/indexing/content-filter.js';

const vault = mkdtempSync(path.join(tmpdir(), 'ohs-source-snapshot-'));
vi.stubEnv('OBSIDIAN_VAULT_PATH', vault);
vi.stubEnv('OBSIDIAN_RESPECT_GITIGNORE', 'false');
vi.stubEnv('OPENAI_BASE_URL', 'http://127.0.0.1:1/v1');
vi.stubEnv('OPENAI_EMBEDDING_MODEL', 'snapshot-fixture');
const embedder = await import('../src/inference/embedder.js');
vi.spyOn(embedder, 'getEmbeddingDim').mockResolvedValue(4);
vi.spyOn(embedder, 'getContextLength').mockResolvedValue(512);
vi.spyOn(embedder, 'getDocumentTokenPolicy').mockResolvedValue({
  limit: 512,
  count: (text) => text.length,
});
vi.spyOn(embedder, 'embedDetailed').mockImplementation((texts) =>
  Promise.resolve(
    texts.map(() => ({ ok: true as const, embedding: new Float32Array([1, 0, 0, 0]) })),
  ),
);
const sourceReaders = await import('../src/vault/note-source.js');
const createSourceReader = sourceReaders.createNoteSourceReader;
const readSource = vi.fn((reader: ReturnType<typeof createSourceReader>, notePath: string) =>
  reader.readWithStat(notePath),
);
vi.spyOn(sourceReaders, 'createNoteSourceReader').mockImplementation((root) => {
  const reader = createSourceReader(root);
  return { ...reader, readWithStat: (notePath) => readSource(reader, notePath) };
});
const storage = await import('./helpers/owned-storage.js');
const writes = await import('../src/storage/db.js');
const { indexFile, resetIndexingState, startBackgroundIndexing } =
  await import('../src/indexing/indexer.js');
const { createIndexService } = await import('../src/indexing/index-service.js');
const originalRead = readSource.getMockImplementation()!;
const file = path.join(vault, 'a.md');
const toxic = 'Source that fails content filtering.';
const timeout = () => new ContentFilterError(new Error('Fixture source timeout'), 'job');
const filter: ContentFilter = {
  signature: 'none',
  project: (text) =>
    text === toxic ? Promise.reject(timeout()) : Promise.resolve({ text, segments: null }),
  close: () => Promise.resolve(),
};

beforeEach(() => {
  storage.closeDb();
  rmSync(vault, { recursive: true, force: true });
  mkdirSync(vault);
  storage.openDb();
  storage.initVecTable(4);
  resetIndexingState();
  readSource.mockReset().mockImplementation(originalRead);
  writeFileSync(file, 'Original safe snapshot.');
  utimesSync(file, 1, 1);
});
afterAll(() => {
  storage.closeDb();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(vault, { recursive: true, force: true });
});

it.each(['before', 'after'] as const)(
  'keeps a failed source idle after an edit %s the asynchronous read',
  async (when) => {
    await storage.withTestIndexRun(async (owner) => {
      const run = { ...owner, contentFilter: filter };
      assert.equal(await indexFile(run, file, 512), 'indexed');
      // The unchanged hash must only be trusted after the read is validated.
      utimesSync(file, 2, 2);
      readSource.mockImplementationOnce(async (...args) => {
        if (when === 'before') writeFileSync(file, toxic);
        const raw = await originalRead(...args);
        if (when === 'after') writeFileSync(file, toxic);
        return raw;
      });

      const result = await indexFile(run, file, 512);
      assert.equal(typeof result, 'object');
      const failed = storage.getIndexFailures();
      assert.equal(failed[0]?.attempts, 1);
      assert.equal(failed[0]?.message, 'Fixture source timeout');
      writeFileSync(path.join(vault, 'b.md'), 'Untouched sibling remains searchable.');
      await startBackgroundIndexing(run, 512);
      assert.deepEqual(storage.getIndexFailures(), failed);
      assert.equal(storage.getNoteByPath('a.md')?.content, 'Original safe snapshot.');
      assert.equal(storage.getNoteByPath('b.md')?.content, 'Untouched sibling remains searchable.');

      writeFileSync(file, 'Healthy edited source.');
      await startBackgroundIndexing(run, 512);
      assert.equal(storage.getNoteByPath('a.md')?.content, 'Healthy edited source.');
      assert.deepEqual(storage.getIndexFailures(), []);
    });
  },
);

it('rereads a replaced descriptor snapshot before trusting an unchanged hash', async () => {
  await storage.withTestIndexRun(async (run) => {
    assert.equal(await indexFile(run, file, 512), 'indexed');
    utimesSync(file, 2, 2);
    readSource.mockClear();
    let replacementContent = '';
    readSource.mockImplementationOnce(async (...args) => {
      const source = await originalRead(...args);
      assert.ok(source);
      replacementContent = 'X'.repeat(source.raw.length);
      const replacement = path.join(vault, 'replacement.tmp');
      writeFileSync(replacement, replacementContent);
      utimesSync(replacement, source.stat.atime, source.stat.mtime);
      renameSync(replacement, file);
      return source;
    });

    assert.equal(await indexFile(run, file, 512), 'indexed');
    assert.equal(readSource.mock.calls.length, 2);
    assert.equal(storage.getNoteByPath('a.md')?.content, replacementContent);
  });
});

it('preserves the index when a pinned source is replaced by an external symlink', async (context) => {
  await storage.withTestIndexRun(async (run) => {
    assert.equal(await indexFile(run, file, 512), 'indexed');
    writeFileSync(file, 'Safe edited source.');
    const external = `${vault}-private.md`;
    writeFileSync(external, 'Private external source.');
    vi.mocked(embedder.embedDetailed).mockClear();
    let symlinkUnavailable = false;
    readSource.mockImplementationOnce(async (...args) => {
      const source = await originalRead(...args);
      unlinkSync(file);
      try {
        symlinkSync(external, file, 'file');
      } catch (error) {
        symlinkUnavailable =
          process.platform === 'win32' &&
          error instanceof Error &&
          'code' in error &&
          ['EPERM', 'EACCES'].includes(String(error.code));
        throw error;
      }
      return source;
    });
    try {
      const result = await indexFile(run, file, 512);
      if (symlinkUnavailable) context.skip('File symlink creation requires Windows privileges.');
      assert.equal(typeof result, 'object');
      if (typeof result === 'object') assert.match(result.error, /symbolic links/);
      assert.equal(storage.getNoteByPath('a.md')?.content, 'Original safe snapshot.');
      assert.equal(vi.mocked(embedder.embedDetailed).mock.calls.length, 0);
    } finally {
      rmSync(external, { force: true });
    }
  });
});

it('does not attach an old filtering failure to an edit made during filtering', async () => {
  await storage.withTestIndexRun(async (owner) => {
    const run = { ...owner, contentFilter: filter };
    assert.equal(await indexFile(run, file, 512), 'indexed');
    writeFileSync(file, toxic);
    let entered!: () => void;
    let reject!: (error: Error) => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    const pending = indexFile(
      {
        ...run,
        contentFilter: {
          ...filter,
          project() {
            entered();
            return held;
          },
        },
      },
      file,
      512,
    );
    await started;
    writeFileSync(file, 'Healthy edit while the old filter is running.');
    reject(timeout());
    assert.equal(typeof (await pending), 'object');
    assert.equal(storage.getIndexFailures()[0]?.attempts, 1);
    await startBackgroundIndexing(run, 512);
    assert.equal(
      storage.getNoteByPath('a.md')?.content,
      'Healthy edit while the old filter is running.',
    );
    assert.deepEqual(storage.getIndexFailures(), []);
  });
});

it('records publication failures against the snapshot obtained by rereading a changed file', async () => {
  await storage.withTestIndexRun(async (run) => {
    assert.equal(await indexFile(run, file, 512), 'indexed');
    utimesSync(file, 2, 2);
    readSource.mockClear();
    readSource.mockImplementationOnce(async (...args) => {
      const source = await originalRead(...args);
      writeFileSync(file, 'Edited source consumed after the read race.');
      return source;
    });
    const commit = vi.spyOn(writes, 'commitIndexedNote').mockImplementation(() => {
      throw new Error('Fixture publication unavailable');
    });
    try {
      assert.equal(typeof (await indexFile(run, file, 512)), 'object');
      assert.equal(readSource.mock.calls.length, 2);
      const failed = storage.getIndexFailures();
      assert.equal(failed[0]?.attempts, 1);
      await startBackgroundIndexing(run, 512);
      assert.deepEqual(storage.getIndexFailures(), failed);
      assert.equal(storage.getNoteByPath('a.md')?.content, 'Original safe snapshot.');
    } finally {
      commit.mockRestore();
    }
    // An explicit foreground request can retry even if the source is unchanged.
    assert.equal(await indexFile(run, file, 512), 'indexed');
    assert.equal(
      storage.getNoteByPath('a.md')?.content,
      'Edited source consumed after the read race.',
    );
    assert.deepEqual(storage.getIndexFailures(), []);
  });
});

it('bounds changing reads, preserves the indexed snapshot and recovers once edits settle', async () => {
  await storage.withTestIndexRun(async (owner) => {
    const run = { ...owner, contentFilter: filter };
    assert.equal(await indexFile(run, file, 512), 'indexed');
    writeFileSync(file, 'Unstable edited source.');
    let reads = 0;
    readSource.mockImplementation(async (...args) => {
      const raw = await originalRead(...args);
      writeFileSync(file, `Unstable edited source. ${'x'.repeat(++reads)}`);
      return raw;
    });
    const result = await indexFile(run, file, 512);
    assert.equal(typeof result, 'object');
    if (typeof result === 'object') assert.match(result.error, /kept changing/i);
    assert.ok(reads > 0 && reads <= 2, `Read ${reads} changing snapshots`);
    assert.equal(storage.getNoteByPath('a.md')?.content, 'Original safe snapshot.');
    assert.equal(storage.getIndexFailures()[0]?.attempts, 1);
    readSource.mockImplementation(originalRead);
    writeFileSync(file, 'Settled source.');
    await startBackgroundIndexing(run, 512);
    assert.equal(storage.getNoteByPath('a.md')?.content, 'Settled source.');
    assert.deepEqual(storage.getIndexFailures(), []);
  });
});

it('preserves the original preparation error and its diagnostic code during a full rebuild', async () => {
  await storage.withTestIndexRun(async (run) => {
    assert.equal(await indexFile(run, file, 512), 'indexed');
  });
  writeFileSync(file, 'Candidate source for the rebuild.');
  const failure = Object.assign(new Error('Fixture provider unavailable'), { code: 'ECONNRESET' });
  vi.mocked(embedder.embedDetailed).mockRejectedValueOnce(failure);
  const service = createIndexService();
  try {
    let caught: unknown;
    try {
      await service.reindex({ force: true });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught, failure);
    const failures = storage.getIndexFailures();
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.operation, 'rebuild');
    assert.equal(failures[0]?.code, 'ECONNRESET');
    assert.equal(storage.getNoteByPath('a.md')?.content, 'Original safe snapshot.');
  } finally {
    await service.close();
  }
});
