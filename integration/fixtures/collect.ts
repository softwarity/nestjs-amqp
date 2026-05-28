import { firstValueFrom, type Observable } from 'rxjs';
import { bufferCount, take, timeout } from 'rxjs/operators';

/** Collect the next `n` emissions from an Observable, with a timeout. */
export async function collectNext<T>(stream: Observable<T>, n: number, timeoutMs = 10_000): Promise<T[]> {
  return firstValueFrom(stream.pipe(bufferCount(n), take(1), timeout({ each: timeoutMs })));
}
