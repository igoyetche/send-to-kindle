export class EpubDocument {
  constructor(
    readonly title: string,
    readonly buffer: Buffer,
  ) {}

  get sizeBytes(): number {
    return this.buffer.length;
  }
}
