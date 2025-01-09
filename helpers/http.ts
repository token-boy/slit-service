
export class Http400 extends Error {
  public readonly status: number = 400
  public readonly code: number

  constructor(message: string, code?: number) {
    super(message)
    this.code = code ?? this.status
  }
}

export class Http401 extends Error {
  public readonly status: number = 401
  public readonly code: number

  constructor(code: number = 401, message: string = 'unauthorized') {
    super(message)
    this.code = code
  }
}

export class Http403 extends Error {
  public readonly status: number = 403
  public readonly code: number

  constructor(code: number = 403, message: string = 'permission denied') {
    super(message)
    this.code = code
  }
}

export class Http404 extends Error {
  public readonly status: number = 404
  public readonly code: number = 404

  constructor(message: string) {
    super(message)
  }
}

export class Http500 extends Error {
  public readonly status: number = 500
  public readonly code: number = 500

  constructor(message: string) {
    super(message)
  }
}
