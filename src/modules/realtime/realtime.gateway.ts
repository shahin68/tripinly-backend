import { HttpStatus, Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { isUUID } from 'class-validator';
import type { Namespace, Socket } from 'socket.io';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AccessTokenService } from '../auth/access-token.service';
import { ConsentsService } from '../consents/consents.service';
import { TripAccessService } from '../trips/trip-access.service';
import { REALTIME_NAMESPACE, tripRoom, userRoom } from './realtime.rooms';

interface SocketData {
  userId: string;
  expiresAt: number;
}

type AuthedSocket = Socket<
  Record<string, never>,
  Record<string, (...args: unknown[]) => void>,
  Record<string, never>,
  SocketData
>;

export interface SubscribeAck {
  ok: boolean;
  tripId?: string;
  error?: { code: string };
}

/**
 * The /v1/realtime namespace. The handshake must carry a valid access token in
 * `auth.token`; failures reject the connection with a `connect_error` whose
 * `data.code` is the API error code. Sockets close when the token expires.
 */
@WebSocketGateway({ namespace: REALTIME_NAMESPACE })
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly accessTokens: AccessTokenService,
    private readonly access: TripAccessService,
    private readonly prisma: PrismaService,
    private readonly consents: ConsentsService,
  ) {}

  afterInit(namespace: Namespace): void {
    namespace.use((socket, next) => {
      this.authenticate(socket as AuthedSocket).then(
        () => next(),
        (error: unknown) => {
          const code = errorCode(error);
          const rejection = new Error(code) as Error & {
            data: { code: string };
          };
          rejection.data = { code };
          next(rejection);
        },
      );
    });
  }

  async handleConnection(socket: AuthedSocket): Promise<void> {
    const { userId, expiresAt } = socket.data;
    await socket.join(userRoom(userId));
    const timer = setTimeout(
      () => {
        socket.emit('error', { code: ErrorCode.TOKEN_EXPIRED });
        socket.disconnect(true);
      },
      Math.max(0, expiresAt - Date.now()),
    );
    timer.unref();
    this.expiryTimers.set(socket.id, timer);
  }

  handleDisconnect(socket: AuthedSocket): void {
    clearTimeout(this.expiryTimers.get(socket.id));
    this.expiryTimers.delete(socket.id);
  }

  @SubscribeMessage('trip.subscribe')
  async subscribe(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: unknown,
  ): Promise<SubscribeAck> {
    const tripId = tripIdOf(body);
    if (!tripId) return this.fail(socket, ErrorCode.VALIDATION_FAILED);
    try {
      await this.access.assert(socket.data.userId, tripId, 'view');
    } catch (error) {
      return this.fail(socket, errorCode(error), tripId);
    }
    await socket.join(tripRoom(tripId));
    return { ok: true, tripId };
  }

  @SubscribeMessage('trip.unsubscribe')
  async unsubscribe(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: unknown,
  ): Promise<SubscribeAck> {
    const tripId = tripIdOf(body);
    if (!tripId) return this.fail(socket, ErrorCode.VALIDATION_FAILED);
    await socket.leave(tripRoom(tripId));
    return { ok: true, tripId };
  }

  private async authenticate(socket: AuthedSocket): Promise<void> {
    const auth = socket.handshake.auth as { token?: unknown } | undefined;
    if (typeof auth?.token !== 'string' || auth.token === '') {
      throw new AppException(
        ErrorCode.UNAUTHENTICATED,
        HttpStatus.UNAUTHORIZED,
      );
    }
    const claims = await this.accessTokens.verify(auth.token);
    const user = await this.prisma.user.findUnique({
      where: { id: claims.sub },
      select: { status: true, onboardedAt: true },
    });
    if (!user || user.status === 'deleting') {
      throw new AppException(
        ErrorCode.UNAUTHENTICATED,
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (user.status === 'suspended') {
      throw new AppException(ErrorCode.ACCOUNT_SUSPENDED, HttpStatus.FORBIDDEN);
    }
    if (!user.onboardedAt) {
      throw new AppException(
        ErrorCode.ONBOARDING_INCOMPLETE,
        HttpStatus.FORBIDDEN,
      );
    }
    if (!(await this.consents.hasRequired(claims.sub))) {
      throw new AppException(ErrorCode.CONSENT_REQUIRED, HttpStatus.FORBIDDEN);
    }
    socket.data = { userId: claims.sub, expiresAt: claims.expiresAt.getTime() };
  }

  private fail(
    socket: AuthedSocket,
    code: string,
    tripId?: string,
  ): SubscribeAck {
    socket.emit('error', { code, tripId });
    return { ok: false, tripId, error: { code } };
  }
}

function tripIdOf(body: unknown): string | undefined {
  const tripId = (body as { tripId?: unknown } | null)?.tripId;
  return typeof tripId === 'string' && isUUID(tripId) ? tripId : undefined;
}

function errorCode(error: unknown): string {
  if (error instanceof AppException) return error.code;
  new Logger(RealtimeGateway.name).error(
    { err: error },
    'Realtime request failed',
  );
  return ErrorCode.INTERNAL_ERROR;
}
