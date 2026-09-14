import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { mimeFromImagePath, normalizeLocalImagePath } from '../../../src/multimodal/resolve.js';
import { MAX_MULTIMODAL_DATA_SIZE } from '../../../src/multimodal/types.js';
import type { BlobToUriFn, PathToUriFn } from '../../../src/multimodal/types.js';

export const fakeBlobToUri: BlobToUriFn = (input) => {
  const mimeType = input.mime_type ?? 'image/png';
  const bytes = Buffer.from(input.content, 'base64');
  const digest = createHash('sha256').update(bytes).digest('hex');
  return {
    uri: `oss://test/${digest}.${mimeType === 'image/jpeg' ? 'jpg' : 'png'}`,
    mime_type: mimeType,
    modality: 'image',
    size: bytes.length,
    sha256: digest,
  };
};

export const fakePathToUri: PathToUriFn = async (filePath) => {
    const resolved = normalizeLocalImagePath(filePath);
  if (!resolved) return null;
  let st;
  try {
    st = fs.statSync(resolved);
  } catch {
    return null;
  }
  const mime = mimeFromImagePath(resolved);
  if (!st.isFile() || st.size <= 0 || st.size > MAX_MULTIMODAL_DATA_SIZE || !mime) return null;
  const bytes = fs.readFileSync(resolved);
  return {
    uri: `oss://test/${bytes.toString('utf8')}`,
    mime_type: mime,
    modality: 'image',
    size: st.size,
    sha256: 'deadbeef',
  };
};
