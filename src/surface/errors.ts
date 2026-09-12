export class SurfaceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SurfaceError';
  }
}
