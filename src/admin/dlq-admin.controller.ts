import { Body, Controller, Get, Param, ParseIntPipe, Post, Req } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { DlqBrowserService } from '../dlq-browser.service';
import { DlqSessionResponseDto, OpenSessionRequestDto, toSessionDto } from './dlq.dto';

const DEFAULT_PAGE_SIZE = 20;

/**
 * Admin endpoints to browse, replay or drop messages stuck in a DLQ.
 * Stateful — each open session holds messages un-settled on the broker
 * until the session is closed (explicitly, on TTL, or on backend crash).
 *
 * **Security**: this controller is NOT guarded by default. The host
 * application is responsible for adding its own auth — typically by applying
 * a Guard via `app.useGlobalGuards(...)` or by extending the controller in
 * the host app and re-decorating routes. See the README for examples.
 *
 * The `openedBy` field on a session is read from `req.user?.username ??
 * req.user?.id ?? 'anonymous'`. Plug your auth middleware so `req.user` is
 * populated before this controller runs.
 */
@Controller('admin/dlq')
export class DlqAdminController {
  constructor(private readonly browser: DlqBrowserService) {}

  @Post('sessions')
  openSession(
    @Body() body: OpenSessionRequestDto,
    @Req() req: { user?: { username?: string; id?: string } },
  ): Observable<DlqSessionResponseDto> {
    const pageSize = body.pageSize ?? DEFAULT_PAGE_SIZE;
    const openedBy = req.user?.username ?? req.user?.id ?? 'anonymous';
    return this.browser.openSession(body.dlqAddress, pageSize, openedBy).pipe(map(toSessionDto));
  }

  @Get('sessions/:token')
  getSession(@Param('token') token: string): DlqSessionResponseDto {
    return toSessionDto(this.browser.get(token));
  }

  @Post('sessions/:token/next-page')
  nextPage(@Param('token') token: string): Observable<DlqSessionResponseDto> {
    return this.browser.loadNextPage(token).pipe(map(toSessionDto));
  }

  @Post('sessions/:token/messages/:idx/replay')
  replay(@Param('token') token: string, @Param('idx', ParseIntPipe) idx: number): Observable<void> {
    return this.browser.replay(token, idx);
  }

  @Post('sessions/:token/messages/:idx/drop')
  drop(@Param('token') token: string, @Param('idx', ParseIntPipe) idx: number): Observable<void> {
    return this.browser.drop(token, idx);
  }

  @Post('sessions/:token/close')
  close(@Param('token') token: string): Observable<void> {
    return this.browser.close(token);
  }
}
