import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

interface ErrorBody {
  statusCode: number;
  timestamp: string;
  path: string;
  method: string;
  message: string | string[];
  error?: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';
    let errorName: string | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse() as any;
      message = typeof res === 'string' ? res : res.message ?? exception.message;
      errorName = typeof res === 'object' ? res.error : exception.name;
    } else if (exception instanceof Error) {
      message = exception.message;
      errorName = exception.name;
      // PostgreSQL error forwarding
      const pgCode = (exception as any)?.code;
      if (pgCode === '23505') {
        status = HttpStatus.CONFLICT;
        message = 'Duplicate entry — this record already exists';
      } else if (pgCode === '23503') {
        status = HttpStatus.BAD_REQUEST;
        message = 'Foreign-key violation — related record not found';
      } else if (pgCode === '23502') {
        status = HttpStatus.BAD_REQUEST;
        message = 'Required field is missing';
      }
    }

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} → ${status}`,
        (exception as Error)?.stack,
      );
    } else {
      this.logger.warn(`${request.method} ${request.url} → ${status} (${message})`);
    }

    const body: ErrorBody = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      message,
      error: errorName,
    };

    response.status(status).json(body);
  }
}
