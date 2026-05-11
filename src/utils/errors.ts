export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
    this.name = "HttpError";
  }
}

export const BadRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const NotFound = (msg = "not found") => new HttpError(404, msg);
export const Conflict = (msg: string) => new HttpError(409, msg);
