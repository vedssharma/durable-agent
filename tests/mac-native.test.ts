import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { decodeAttributedBody } from '../src/mac-bridge.ts';

// Pure synthetic archives: never read the user's Messages or launch the app.
test('native decoder reads a macOS attributed-body archive with Unicode', {
  skip: process.platform !== 'darwin' || !existsSync('.build/decode-message'), timeout: 60_000,
}, async () => {
  const { stdout } = await promisify(execFile)('/usr/bin/swift', ['-e',
    'import Foundation; import AppKit; let text = NSAttributedString(string: "hello 🌉\\nsecond line"); print(NSArchiver.archivedData(withRootObject: text).base64EncodedString())',
  ]);
  assert.equal(await decodeAttributedBody(resolve('.build/decode-message'), Buffer.from(stdout.trim(), 'base64')), 'hello 🌉\nsecond line');
});
