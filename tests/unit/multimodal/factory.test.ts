import { describe, expect, it } from 'vitest';
import { createUploader } from '../../../src/multimodal/uploader/factory.js';
import { OssUploader } from '../../../src/multimodal/uploader/oss-uploader.js';
import { SlsUploader } from '../../../src/multimodal/uploader/sls-uploader.js';

const slsAuth = {
  mode: 'ak' as const,
  accessKeyId: 'ak',
  accessKeySecret: 'sk',
};

describe('createUploader', () => {
  it('creates OssUploader when storage.type is oss', () => {
    const uploader = createUploader({
      storage: {
        type: 'oss',
        target: {
          endpoint: 'https://oss-cn-shanghai.aliyuncs.com',
          storageBasePath: 'oss://bucket/mm',
        },
        auth: slsAuth,
      },
      storageBasePath: 'oss://bucket/mm',
    });
    expect(uploader).toBeInstanceOf(OssUploader);
  });

  it('creates SlsUploader when storage.type is sls', () => {
    const uploader = createUploader({
      storage: {
        type: 'sls',
        target: {
          endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
          project: 'proj',
          logstore: 'logstore',
        },
        auth: slsAuth,
      },
      storageBasePath: 'sls://proj/logstore',
    });
    expect(uploader).toBeInstanceOf(SlsUploader);
  });

  it('creates SlsUploader when storage.type is delegatedOss', () => {
    const uploader = createUploader({
      storage: {
        type: 'delegatedOss',
        target: {
          endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
          project: 'proj',
          logstore: 'logstore',
          ossBucket: 'user-bucket',
        },
        auth: slsAuth,
      },
      storageBasePath: 'sls://proj/logstore',
    }, {
      expectedPresignOrigin: 'https://user-bucket.oss-cn-hangzhou.aliyuncs.com',
    });
    expect(uploader).toBeInstanceOf(SlsUploader);
  });

  it('throws when delegatedOss is missing expectedPresignOrigin', () => {
    expect(() => createUploader({
      storage: {
        type: 'delegatedOss',
        target: {
          endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
          project: 'proj',
          logstore: 'logstore',
        },
        auth: slsAuth,
      },
      storageBasePath: 'sls://proj/logstore',
    })).toThrow(/requires expectedPresignOrigin/);
  });

  it('creates SlsUploader for apiKey mode', () => {
    const uploader = createUploader({
      storage: {
        type: 'sls',
        target: {
          endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
          project: 'proj',
          logstore: 'logstore',
        },
        auth: {
          mode: 'apiKey',
          apiKey: 'edge-key',
        },
      },
      storageBasePath: 'sls://proj/logstore',
    });
    expect(uploader).toBeInstanceOf(SlsUploader);
  });

  it('throws when oss storageBasePath is invalid', () => {
    expect(() => createUploader({
      storage: {
        type: 'oss',
        target: {
          endpoint: 'https://oss-cn-shanghai.aliyuncs.com',
          storageBasePath: 'not-oss://bucket',
        },
        auth: slsAuth,
      },
      storageBasePath: 'not-oss://bucket',
    })).toThrow(/invalid oss storageBasePath/);
  });

  it('throws when sls project/logstore cannot be resolved', () => {
    expect(() => createUploader({
      storage: {
        type: 'sls',
        target: {
          endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
          project: '',
          logstore: '',
        },
        auth: slsAuth,
      },
      storageBasePath: 'sls://only-project',
    })).toThrow(/requires project and logstore/);
  });
});
