import { describe, expect, it } from 'vitest';
import { createUploader } from '../../../src/multimodal/uploader/factory.js';
import { OssUploader } from '../../../src/multimodal/uploader/oss-uploader.js';
import { SlsUploader } from '../../../src/multimodal/uploader/sls-uploader.js';

describe('createUploader', () => {
  it('creates OssUploader when oss config is present', () => {
    const uploader = createUploader({
      uploader: 'oss',
      storageBasePath: 'oss://bucket/mm',
      oss: {
        endpoint: 'https://oss-cn-shanghai.aliyuncs.com',
        accessKeyId: 'ak',
        accessKeySecret: 'sk',
      },
    });
    expect(uploader).toBeInstanceOf(OssUploader);
  });

  it('creates SlsUploader when sls config is present', () => {
    const uploader = createUploader({
      uploader: 'sls',
      storageBasePath: 'sls://proj/logstore',
      sls: {
        endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
        project: 'proj',
        logstore: 'logstore',
        accessKeyId: 'ak',
        accessKeySecret: 'sk',
      },
    });
    expect(uploader).toBeInstanceOf(SlsUploader);
  });

  it('throws when oss credentials block is missing', () => {
    expect(() => createUploader({
      uploader: 'oss',
      storageBasePath: 'oss://bucket/mm',
    })).toThrow(/multimodal\.oss config is required/);
  });

  it('throws when sls credentials block is missing', () => {
    expect(() => createUploader({
      uploader: 'sls',
      storageBasePath: 'sls://proj/logstore',
    })).toThrow(/multimodal\.sls config is required/);
  });

  it('throws for unsupported uploader kind', () => {
    expect(() => createUploader({
      uploader: 's3' as 'oss',
      storageBasePath: 'oss://bucket/mm',
      oss: {
        endpoint: 'https://oss-cn-shanghai.aliyuncs.com',
        accessKeyId: 'ak',
        accessKeySecret: 'sk',
      },
    })).toThrow(/unsupported multimodal\.uploader/);
  });

  it('throws when oss storageBasePath is invalid', () => {
    expect(() => createUploader({
      uploader: 'oss',
      storageBasePath: 'not-oss://bucket',
      oss: {
        endpoint: 'https://oss-cn-shanghai.aliyuncs.com',
        accessKeyId: 'ak',
        accessKeySecret: 'sk',
      },
    })).toThrow(/invalid oss storageBasePath/);
  });

  it('throws when sls project/logstore cannot be resolved', () => {
    expect(() => createUploader({
      uploader: 'sls',
      storageBasePath: 'sls://only-project',
      sls: {
        endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
        project: '',
        logstore: '',
        accessKeyId: 'ak',
        accessKeySecret: 'sk',
      },
    })).toThrow(/requires project and logstore/);
  });
});
