import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ALLOW_DURING_ONBOARDING,
  type AuthenticatedRequest,
  IS_PUBLIC,
} from '../../common/auth/auth.decorators';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ConsentsService } from '../consents/consents.service';
import { AccessTokenService } from './access-token.service';

/**
 * Global guard: every route needs a valid access token unless marked @Public.
 * Routes also need a finished onboarding and current required consents, except
 * those marked @AllowDuringOnboarding.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessTokens: AccessTokenService,
    private readonly consents: ConsentsService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets))
      return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = bearerToken(request.headers.authorization);
    if (!token) {
      throw new AppException(
        ErrorCode.UNAUTHENTICATED,
        HttpStatus.UNAUTHORIZED,
      );
    }
    const claims = await this.accessTokens.verify(token);
    request.user = { id: claims.sub, role: claims.role };

    if (
      this.reflector.getAllAndOverride<boolean>(
        ALLOW_DURING_ONBOARDING,
        targets,
      )
    ) {
      return true;
    }
    // The claim is a snapshot; onboarding may have finished since the token was issued.
    if (!claims.onb) {
      const user = await this.prisma.user.findUnique({
        where: { id: claims.sub },
        select: { onboardedAt: true },
      });
      if (!user?.onboardedAt) {
        throw new AppException(
          ErrorCode.ONBOARDING_INCOMPLETE,
          HttpStatus.FORBIDDEN,
        );
      }
    }
    if (!(await this.consents.hasRequired(claims.sub))) {
      throw new AppException(ErrorCode.CONSENT_REQUIRED, HttpStatus.FORBIDDEN);
    }
    return true;
  }
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value : undefined;
}
