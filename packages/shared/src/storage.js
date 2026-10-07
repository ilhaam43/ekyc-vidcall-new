import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, CreateBucketCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Upload } from '@aws-sdk/lib-storage';
// The SDK speaks an open protocol to self-hosted SeaweedFS. No AWS service is used.
export class Storage {
  constructor(cfg, prefix = 'object') {
    this.client = new S3Client({ endpoint: cfg[`${prefix}Endpoint`], region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: cfg[`${prefix}Access`], secretAccessKey: cfg[`${prefix}Secret`] } });
  }
  async ensureBucket(Bucket) { try { await this.client.send(new CreateBucketCommand({ Bucket })); } catch (e) { if (!['BucketAlreadyExists', 'BucketAlreadyOwnedByYou'].includes(e.name)) throw e; } }
  async put(Bucket, Key, Body, ContentType = 'application/octet-stream', Metadata = {}) { return this.client.send(new PutObjectCommand({ Bucket, Key, Body, ContentType, Metadata })); }
  async get(Bucket, Key, Range) { return this.client.send(new GetObjectCommand({ Bucket, Key, Range })); }
  async head(Bucket, Key) { return this.client.send(new HeadObjectCommand({ Bucket, Key })); }
  async delete(Bucket, Key) { return this.client.send(new DeleteObjectCommand({ Bucket, Key })); }
  async copy(Bucket, SourceKey, Key) {
    const source = await this.get(Bucket, SourceKey);
    const upload = new Upload({ client: this.client, params: { Bucket, Key, Body: source.Body, ContentType: source.ContentType, Metadata: source.Metadata } });
    await upload.done();
  }
  async list(Bucket, ContinuationToken) { return this.client.send(new ListObjectsV2Command({ Bucket, ContinuationToken })); }
  async checksum(Bucket, Key) { const object = await this.get(Bucket, Key); const hash = createHash('sha256'); let bytes = 0; for await (const chunk of object.Body) { hash.update(chunk); bytes += chunk.length; } return { sha256: hash.digest('hex'), bytes }; }
  async uploadFile(Bucket, Key, file, sha256) {
    const upload = new Upload({ client: this.client, params: { Bucket, Key, Body: createReadStream(file), ContentType: 'video/mp4', Metadata: { sha256 } }, queueSize: 2, partSize: 16 * 1024 * 1024, leavePartsOnError: false });
    await upload.done();
  }
}
