import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import { ApiForbiddenResponse } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../../common/auth/auth.decorators';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Admins only. Checks the database, not the token's role claim, so removing
 * the role takes effect at once. Runs after the global auth guard.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) throw AppException.forbidden();
    const user = await this.prisma.user.findUnique({
      where: { id: request.user.id },
      select: { role: true, status: true },
    });
    if (user?.role !== 'admin' || user.status !== 'active') {
      throw AppException.forbidden();
    }
    return true;
  }
}

export const AdminOnly = () =>
  applyDecorators(
    UseGuards(AdminGuard),
    ApiForbiddenResponse({ description: 'Not an admin (FORBIDDEN)' }),
  );
