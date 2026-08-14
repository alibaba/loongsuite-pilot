import type { UploadItem, Uploader } from '../../../src/multimodal/types.js';

export class FakeUploader implements Uploader {
  readonly items: UploadItem[] = [];
  failPaths = new Set<string>();
  failNext = false;
  throwOnUpload = false;
  shutdownCalls = 0;
  closed = false;
  /** When set, upload() waits on this promise before completing (for pending backpressure tests). */
  hold?: Promise<void>;

  async upload(item: UploadItem): Promise<boolean> {
    if (this.closed) return false;
    if (this.hold) await this.hold;
    if (this.closed) return false;
    if (this.throwOnUpload) throw new Error('fake uploader boom');
    this.items.push(item);
    if (this.failNext) {
      this.failNext = false;
      return false;
    }
    if (this.failPaths.has(item.targetPath)) return false;
    return true;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.shutdownCalls += 1;
  }
}
