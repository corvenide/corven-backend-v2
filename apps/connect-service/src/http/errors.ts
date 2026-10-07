// apps/connect-service/src/http/errors.ts

import { HttpException } from '@nestjs/common';

/** An error whose message is safe to show to the person using the modal. */
export function fail(status: number, message: string, code?: string): HttpException {
    return new HttpException({ statusCode: status, message, ...(code ? { code } : {}) }, status);
}
