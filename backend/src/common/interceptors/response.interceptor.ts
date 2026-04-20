import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Wraps all successful responses in `{ success, data, meta }` envelope
 * unless the controller already returned an object with `success` key.
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, any> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const started = Date.now();

    return next.handle().pipe(
      map((data) => {
        if (data && typeof data === 'object' && 'success' in (data as any)) {
          return data;
        }
        return {
          success: true,
          data,
          meta: {
            path: req.url,
            method: req.method,
            durationMs: Date.now() - started,
            timestamp: new Date().toISOString(),
          },
        };
      }),
    );
  }
}
