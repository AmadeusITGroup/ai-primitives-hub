import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  FileWriteJournal,
} from '../../../src/domain/install/file-write-journal';

const missing = (): Error => Object.assign(new Error('missing'), { code: 'ENOENT' });

class JournalFileSystem {
  public readonly files = new Map<string, Uint8Array>();

  public exists(filePath: string): Promise<boolean> {
    return Promise.resolve(this.files.has(filePath));
  }

  public readFileBytes(filePath: string): Promise<Uint8Array> {
    const bytes = this.files.get(filePath);
    if (bytes === undefined) {
      return Promise.reject(missing());
    }
    return Promise.resolve(bytes.slice());
  }

  public writeFileBytes(filePath: string, bytes: Uint8Array): Promise<void> {
    this.files.set(filePath, bytes.slice());
    return Promise.resolve();
  }

  public lstat(filePath: string): Promise<{ isSymbolicLink: boolean }> {
    if (!this.files.has(filePath)) {
      return Promise.reject(missing());
    }
    return Promise.resolve({ isSymbolicLink: false });
  }

  public remove(filePath: string): Promise<void> {
    this.files.delete(filePath);
    return Promise.resolve();
  }
}

const encodeBytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (value: Uint8Array): string => new TextDecoder().decode(value);

describe('FileWriteJournal', () => {
  it('removes a partial new file after a write fails', async () => {
    const fs = new JournalFileSystem();
    const journal = new FileWriteJournal(fs);
    const failure = new Error('partial write');

    await expect(journal.write('/target/file.md', encodeBytes('complete'), async () => {
      await fs.writeFileBytes('/target/file.md', encodeBytes('part'));
      throw failure;
    })).rejects.toBe(failure);
    await journal.rollback();

    expect(fs.files.has('/target/file.md')).toBe(false);
  });

  it('restores an overwritten original after a truncated write fails', async () => {
    const fs = new JournalFileSystem();
    fs.files.set('/target/file.md', encodeBytes('original bytes'));
    const journal = new FileWriteJournal(fs);

    await expect(journal.write('/target/file.md', encodeBytes('complete'), async () => {
      await fs.writeFileBytes('/target/file.md', encodeBytes('truncated'));
      throw new Error('write failed');
    })).rejects.toThrow('write failed');
    await journal.rollback();

    expect(text(await fs.readFileBytes('/target/file.md'))).toBe('original bytes');
  });

  it('restores an original removed by a failed write attempt', async () => {
    const fs = new JournalFileSystem();
    fs.files.set('/target/file.md', encodeBytes('original bytes'));
    const journal = new FileWriteJournal(fs);

    await expect(journal.write('/target/file.md', encodeBytes('complete'), async () => {
      await fs.remove('/target/file.md');
      throw new Error('write failed after unlink');
    })).rejects.toThrow('write failed after unlink');
    await journal.rollback();

    expect(text(await fs.readFileBytes('/target/file.md'))).toBe('original bytes');
  });

  it('reports an incomplete rollback when the failed state cannot be read', async () => {
    class UnreadableJournalFileSystem extends JournalFileSystem {
      public unreadable = false;

      public override async readFileBytes(filePath: string): Promise<Uint8Array> {
        if (this.unreadable) {
          throw Object.assign(new Error('read denied'), { code: 'EACCES' });
        }
        return super.readFileBytes(filePath);
      }
    }
    const fs = new UnreadableJournalFileSystem();
    const journal = new FileWriteJournal(fs);
    const failure = new Error('write failed');

    await expect(journal.write('/target/file.md', encodeBytes('intended'), async () => {
      await fs.writeFileBytes('/target/file.md', encodeBytes('partial'));
      fs.unreadable = true;
      throw failure;
    })).rejects.toBe(failure);

    await expect(journal.rollback()).rejects.toThrow(/incomplete/i);
  });

  it('preserves a file changed by the user after a failed write', async () => {
    const fs = new JournalFileSystem();
    fs.files.set('/target/file.md', encodeBytes('original bytes'));
    const journal = new FileWriteJournal(fs);

    await expect(journal.write('/target/file.md', encodeBytes('complete'), async () => {
      await fs.writeFileBytes('/target/file.md', encodeBytes('partial'));
      throw new Error('write failed');
    })).rejects.toThrow('write failed');
    await fs.writeFileBytes('/target/file.md', encodeBytes('user edit'));
    await journal.rollback();

    expect(text(await fs.readFileBytes('/target/file.md'))).toBe('user edit');
  });

  it('preserves a completed file that the user changes before rollback', async () => {
    const fs = new JournalFileSystem();
    const journal = new FileWriteJournal(fs);

    await journal.write('/target/file.md', encodeBytes('intended'), async () => {
      await fs.writeFileBytes('/target/file.md', encodeBytes('intended'));
    });
    await fs.writeFileBytes('/target/file.md', encodeBytes('user edit'));
    await journal.rollback();

    expect(text(await fs.readFileBytes('/target/file.md'))).toBe('user edit');
  });

  it('restores the original when post-write verification fails on unexpected bytes', async () => {
    const fs = new JournalFileSystem();
    fs.files.set('/target/file.md', encodeBytes('original bytes'));
    const journal = new FileWriteJournal(fs);

    await expect(journal.write('/target/file.md', encodeBytes('intended bytes'), async () => {
      await fs.writeFileBytes('/target/file.md', encodeBytes('unexpected bytes'));
      throw new Error('verification failed');
    })).rejects.toThrow('verification failed');
    await journal.rollback();

    expect(text(await fs.readFileBytes('/target/file.md'))).toBe('original bytes');
  });
});
