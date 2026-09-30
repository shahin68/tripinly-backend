import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Request } from 'express';

export const IS_PUBLIC = 'auth:isPublic';
export const ALLOW_DURING_ONBOARDING = 'auth:allowDuringOnboarding';

/** No access token required (auth, legal, health, public previews). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Signed-in users may call this before finishing onboarding or while they owe a
 * consent (profile completion, consents, username availability).
 */
export const AllowDuringOnboarding = () =>
  SetMetadata(ALLOW_DURING_ONBOARDING, true);

export interface AuthUser {
  id: string;
  role: 'user' | 'admin';
  /** When the user last signed in with Google or Apple. */
  authTime: Date;
}

export type AuthenticatedRequest = Request & { user?: AuthUser };

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) {
      throw new Error('CurrentUser used on a route without authentication');
    }
    return request.user;
  },
);
