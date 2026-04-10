export class ValidationError {
  readonly kind = "validation" as const;
  constructor(
    readonly field: string,
    readonly message: string,
  ) {}
}

export class SizeLimitError {
  readonly kind = "size_limit" as const;
  constructor(
    readonly actualBytes: number,
    readonly limitBytes: number,
  ) {}

  get message(): string {
    return `Content exceeds the ${this.limitBytes / (1024 * 1024)} MB limit.`;
  }
}

export class ConversionError {
  readonly kind = "conversion" as const;
  constructor(readonly message: string) {}
}

export class DeliveryError {
  readonly kind = "delivery" as const;
  constructor(
    readonly cause: "auth" | "connection" | "rejection",
    readonly message: string,
  ) {}
}

export class FrontmatterError {
  readonly kind = "frontmatter" as const;
  constructor(readonly message: string) {}
}

export type DomainError =
  | ValidationError
  | SizeLimitError
  | ConversionError
  | DeliveryError
  | FrontmatterError;

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
